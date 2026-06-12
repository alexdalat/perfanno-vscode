import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as perfInfo from '../perfInfo';

// test inside .vscode/launch.json should have "args": ["src/test ..."]
suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	// fixtures live in src/test, but tests run compiled from out/test
	const fixturesDir = path.resolve(__dirname, '../../src/test');
	const perfDataPath = path.join(fixturesDir, 'example_cpp_project/perf.out');
	const pyspyDataPath = path.join(fixturesDir, 'example_py_project/pyspy.txt');

	// Set some mock configs for the test context
	suiteSetup(() => {
		perfInfo.setConfig('onlyLocalLeaf', false);
	});

	suite('C++ perf parser', () => {
		test('Load perf.out', () => {
			const parsedData = perfInfo.perfCallgraphFile(perfDataPath);
			
			assert.ok(parsedData !== undefined, 'Should return parsed data');
			assert.deepStrictEqual(Object.keys(parsedData), ['cycles:P'], "Parsed data should contain only event 'cycles:P'");
			assert.strictEqual(parsedData['cycles:P'].length, 85, "cycles:P should have 85 traces");

			// matches '# Samples: 105' in the perf.out header
			const totalTraces = perfInfo.loadTraces(parsedData);
			assert.strictEqual(totalTraces, 105, "Loaded sample count should be 105");
		});

		test('Hotspots', () => {
			const parsedData = perfInfo.perfCallgraphFile(perfDataPath);
			const [nodeInfo, , , maxCount] = perfInfo.processTraces(parsedData['cycles:P']);

			const mainCpp = '/home/alex/code/perfanno-vscode/src/test/example_cpp_project/main.cpp';
			assert.strictEqual(nodeInfo[mainCpp][94].count, 40, "time_function body should have 40 samples");
			assert.strictEqual(nodeInfo[mainCpp][103].count, 35);
			assert.strictEqual(nodeInfo[mainCpp][46].count, 28);
			assert.strictEqual(maxCount, 42, "_start symbol frame should be the hottest node");
		});

		test('Trace structure', () => {
			const parsedData = perfInfo.perfCallgraphFile(perfDataPath);

			for (const trace of parsedData['cycles:P']) {
				assert.ok(trace.count > 0, "Every trace should have count > 0");
				assert.ok(trace.frames.length > 0, "Every trace should have frames");

				for (const frame of trace.frames) {
					if (frame.file) {
						assert.ok(frame.linenr !== undefined && frame.linenr > 0, "File frames should have a line number");
					} else {
						assert.ok(frame.symbol, "Non-file frames should at least have a symbol");
					}
				}
			}

			// raw addresses should be kept as symbol-only frames
			const hasAddrFrame = parsedData['cycles:P'].some(t => t.frames.some(f => f.symbol?.startsWith('0x') && !f.file));
			assert.ok(hasAddrFrame, "Hex addresses should be parsed as symbol-only frames");
		});

		test('loadTraces total matches sum of counts', () => {
			const parsedData = perfInfo.perfCallgraphFile(perfDataPath);
			const sum = parsedData['cycles:P'].reduce((acc, t) => acc + t.count, 0);

			const totalTraces = perfInfo.loadTraces(parsedData);
			assert.strictEqual(totalTraces, sum, "loadTraces should return sum of all trace counts");
			assert.ok(perfInfo.isLoaded(), "isLoaded should be true after loading");
		});
	});

	suite('Python pyspy parser', () => {
		test('Load pyspy.txt', () => {
			const parsedData = perfInfo.pyspyCallgraphFile(pyspyDataPath);
			
			assert.ok(parsedData !== undefined, 'Should return parsed data');
			assert.deepStrictEqual(Object.keys(parsedData), ['cpu_cycles'], "Parsed data should contain only event 'cpu_cycles'");
			assert.strictEqual(parsedData['cpu_cycles'].length, 89, "cpu_cycles should have 89 traces");

			const totalTraces = perfInfo.loadTraces(parsedData);
			assert.strictEqual(totalTraces, 222, "Loaded sample count should be 222");
		});

		test('Hotspots', () => {
			const parsedData = perfInfo.pyspyCallgraphFile(pyspyDataPath);
			const [nodeInfo, , , maxCount] = perfInfo.processTraces(parsedData['cpu_cycles']);

			const mainPy = '/home/alex/code/perfanno-vscode/src/test/example_py_project/main.py';
			assert.strictEqual(nodeInfo[mainPy][62].count, 194, "main() body should have 194 samples");
			assert.strictEqual(nodeInfo[mainPy][15].count, 194);
			assert.strictEqual(nodeInfo[mainPy][27].count, 90);
			assert.strictEqual(maxCount, 222, "Native interpreter frames should be the hottest nodes");
		});

		test('Trace structure', () => {
			const parsedData = perfInfo.pyspyCallgraphFile(pyspyDataPath);

			for (const trace of parsedData['cpu_cycles']) {
				assert.ok(trace.count > 0, "Every trace should have count > 0");
				assert.ok(trace.frames.length > 0, "Every trace should have frames");

				for (const frame of trace.frames) {
					if (frame.file) {
						assert.ok(!frame.file.includes('\\'), "File paths should be normalized to forward slashes");
						assert.ok(frame.linenr !== undefined && frame.linenr > 0, "File frames should have a line number");
					}
				}
			}

			const hasProjectFrame = parsedData['cpu_cycles'].some(t => t.frames.some(f => f.file?.endsWith('main.py')));
			assert.ok(hasProjectFrame, "Some trace should hit main.py");
		});
	});

	suite('frame_unpack', () => {
		test('Symbol-only frame', () => {
			const [symbol, file, linenr] = perfInfo.frame_unpack({ symbol: 'foo' });
			assert.strictEqual(symbol, undefined);
			assert.strictEqual(file, 'symbol');
			assert.strictEqual(linenr, 'foo');
		});

		test('Full frame with unresolvable path falls back', () => {
			const [symbol, file, linenr] = perfInfo.frame_unpack({ symbol: 'foo', file: '/fake/path/main.cpp', linenr: 12 });
			assert.strictEqual(symbol, 'foo');
			assert.strictEqual(file, '/fake/path/main.cpp', "Should keep original path when realpath fails");
			assert.strictEqual(linenr, 12);
		});

		test('String frame without path stays symbol-only', () => {
			const [symbol, file, linenr] = perfInfo.frame_unpack('0x75425a40d59f');
			assert.strictEqual(symbol, undefined);
			assert.strictEqual(file, 'symbol');
			assert.strictEqual(linenr, '0x75425a40d59f');
		});

		test('Empty frame throws', () => {
			assert.throws(() => perfInfo.frame_unpack({}), /frame must have symbol/);
		});
	});

	suite('processTraces', () => {
		test('Counts across traces', () => {
			const traces: perfInfo.TraceData[] = [
				{ count: 10, frames: [
					{ symbol: 'main', file: '/fake/main.cpp', linenr: 5 },
					{ symbol: 'work', file: '/fake/main.cpp', linenr: 20 },
				]},
				{ count: 5, frames: [
					{ symbol: 'main', file: '/fake/main.cpp', linenr: 5 },
				]},
			];

			const [nodeInfo, symbols, totalCount, maxCount] = perfInfo.processTraces(traces);

			assert.strictEqual(totalCount, 15, "Total count should be sum of trace counts");
			assert.strictEqual(maxCount, 15, "Max count should be the hottest line");
			assert.strictEqual(nodeInfo['/fake/main.cpp'][5].count, 15, "Shared line should accumulate counts");
			assert.strictEqual(nodeInfo['/fake/main.cpp'][20].count, 10);
			assert.strictEqual(symbols['/fake/main.cpp']['main'].count, 15);
			assert.strictEqual(symbols['/fake/main.cpp']['work'].count, 10);
		});

		test('Caller/callee counts', () => {
			const traces: perfInfo.TraceData[] = [
				{ count: 7, frames: [
					{ symbol: 'main', file: '/fake/main.cpp', linenr: 5 },
					{ symbol: 'work', file: '/fake/util.cpp', linenr: 3 },
				]},
			];

			const [nodeInfo] = perfInfo.processTraces(traces);

			assert.strictEqual(nodeInfo['/fake/main.cpp'][5].out_counts['/fake/util.cpp'][3], 7, "Caller should have out_count to callee");
			assert.strictEqual(nodeInfo['/fake/util.cpp'][3].in_counts['/fake/main.cpp'][5], 7, "Callee should have in_count from caller");
		});

		test('Recursion deduped in count but not rec_count', () => {
			const traces: perfInfo.TraceData[] = [
				{ count: 3, frames: [
					{ symbol: 'recurse', file: '/fake/r.cpp', linenr: 7 },
					{ symbol: 'recurse', file: '/fake/r.cpp', linenr: 7 },
					{ symbol: 'recurse', file: '/fake/r.cpp', linenr: 7 },
				]},
			];

			const [nodeInfo, symbols] = perfInfo.processTraces(traces);

			assert.strictEqual(nodeInfo['/fake/r.cpp'][7].count, 3, "Recursive line should only be counted once per trace");
			assert.strictEqual(nodeInfo['/fake/r.cpp'][7].rec_count, 9, "rec_count should include recursive hits");
			assert.strictEqual(symbols['/fake/r.cpp']['recurse'].count, 3, "Symbol count should be deduped per trace");
		});
	});

	suite('Events', () => {
		test('getEvents reflects loaded data', () => {
			perfInfo.loadTraces(perfInfo.perfCallgraphFile(perfDataPath));
			assert.deepStrictEqual(perfInfo.getEvents(), ['cycles:P']);

			perfInfo.loadTraces(perfInfo.pyspyCallgraphFile(pyspyDataPath));
			assert.deepStrictEqual(perfInfo.getEvents(), ['cpu_cycles']);
		});

		// test('selectEvent rejects unknown events', () => {
		// 	perfInfo.loadTraces(perfInfo.pyspyCallgraphFile(pyspyDataPath));

		// 	assert.doesNotThrow(() => perfInfo.selectEvent('cpu_cycles'));
		// 	assert.throws(() => perfInfo.selectEvent('not_an_event'), /does not exist/);
		// });
	});

	suite('Update settings', () => {
		test('Toggle onlyLocalLeaf', () => {
			perfInfo.setConfig('onlyLocalLeaf', true);
			assert.strictEqual(perfInfo.getConfig('onlyLocalLeaf'), true, "onlyLocalLeaf should be true");

			perfInfo.setConfig('onlyLocalLeaf', false);
			assert.strictEqual(perfInfo.getConfig('onlyLocalLeaf'), false, "onlyLocalLeaf should be false");
		});

		test('Select event', () => {
			perfInfo.setConfig('selectedEvent', 'cpu_cycles');
			assert.strictEqual(perfInfo.getConfig('selectedEvent'), 'cpu_cycles', "selectedEvent should be 'cpu_cycles'");

			perfInfo.setConfig('selectedEvent', 'cycles:P');
			assert.strictEqual(perfInfo.getConfig('selectedEvent'), 'cycles:P', "selectedEvent should be 'cycles:P'");
		});

	});
});
