import * as fs from 'fs';
import { LineHighlighter } from './LineHighlighter';

let M = {
	hasData: false,
	data: {} as PerfData,
	events: [] as string[],
	current_event: "",
	callgraphs: {} as { 
		[key: string]: {
			nodeInfo: { [key: string]: { [key: number]: { count: number; rec_count: number; out_counts: { [key: string]: number; }; in_counts: { [key: string]: number; }; }; }; };
			symbols: { [key: string]: { count: number; min_line: number | null; max_line: number | null; }; };
			totalCount: number;
			maxCount: number;
		}; 
	},

	config: {} as { [key: string]: any }
};

M.config = {
	eventOutputType: "percentage",
	localRelative: false,
	highlightColor: [255, 0, 0],
	minimumThreshold: 0
};

let realNames = {} as { [key: string]: string };

export interface Frame {
	symbol?: string;
	file?: string;
	linenr?: number;
}

export interface TraceData {
	count: number;
	frames: Frame[];
}

export interface PerfData {
	[key: string]: TraceData[];
}

// Reads a perf callgraph file and returns the data.
//	@param perfDataPath Path to perf callgraph file.
//	@return Table with the following fields:
//		- event: List of tables with the following fields:
//			- count: Number of times this stack trace occurred.
//			- frames: List of frames in the stack trace with the following fields:
//				- symbol: Symbol name.
//				- file: File name.
//				- linenr: Line number.
export function perfCallgraphFile(perfDataPath: string): PerfData {
	const result: PerfData = {};
	let currentEvent: string | undefined;

	const lines = fs.readFileSync(perfDataPath, 'utf-8').split('\n');
	for (const line of lines) {
		const numEventMatch = line.match(/# Samples: (\d+[KMB]?)\s+of event '(.*)'/);

		if (numEventMatch) {
			const [, num, event] = numEventMatch;
			result[event] = [];
			currentEvent = event;
		} else {
			const countTraceMatch = line.match(/^(\d+) (.*)$/);

			if (countTraceMatch) {
				const [, countStr, traceLine] = countTraceMatch;
				const count = parseInt(countStr, 10);

				if (count > 0) {
					const traceData: TraceData = { count: count, frames: [] };

					const funcs = traceLine.split(';');
					for (const func of funcs) {
						const funcMatch = func.match(/^(.*?)\s*(\/.*):(\d+)$/);

						if (funcMatch) {
							const [, symbol, file, linenrStr] = funcMatch;
							const linenr = parseInt(linenrStr, 10);
							traceData.frames.push({ symbol: symbol || undefined, file, linenr });
						} else {
							traceData.frames.push({ symbol: func });
						}
					}

					if (currentEvent) {
						result[currentEvent].push(traceData);
					}
				}
			}
		}
	}

	M.data = result;
	M.hasData = true;
	return M.data;
}

// Separates frame into symbol, file, and line number.
//	@param frame Either a string of the form "{symbol} {file}:{linenr}" where file is a full file
//       path, or a table with entries for symbol, file, and linenr.
//	@return symbol, file, line number File will be cleaned up into canonical
//        format.
export function frame_unpack(frame: Frame | string): [string | undefined, string, number | string] {
	if (typeof frame !== 'string') {
		if (!frame.file || !frame.linenr) {
			if (!frame.symbol) {
				throw new Error("frame_unpack: frame must have symbol");
			}
			return [undefined, "symbol", frame.symbol];
		}

		if (!realNames[frame.file]) {
			try {
				realNames[frame.file] = fs.realpathSync(frame.file);
			} catch (e) {
				// path resolution failed, just use the original path
				realNames[frame.file] = frame.file;
			}
		}

		return [frame.symbol, realNames[frame.file], frame.linenr];
	}

	// frame is a string
	const match = frame.match(/^(.*?)\s*(\/.*):(\d+)$/);
	if (match) {
		const [, symbol, file, linenrStr] = match;
		const linenr = parseInt(linenrStr, 10);

		return [symbol || undefined, fs.realpathSync(file), linenr];
	}

	return [undefined, "symbol", frame];
}

// Processes a list of stack traces into the call graph information.
//	@param traces List of tables of the form {count = 15, frames = {f1, f2, f3, ...}}. The count
//       represents how many times this exact stack trace occurs and each frame should be in the
//       format expected by frame_unpack.
//	@return node info, total count, max count, symbols
export function processTraces(traces: TraceData[]): any {
	let nodeInfo: any = { symbol: {} };
	let total_count = 0;
	let max_count = 0;
	let symbols: any = {};

	for (const trace of traces) {
		const visitedLines: { [key: string]: boolean } = {}; // needed to get sane results with recursion
		const visitedSymbols: { [key: string]: boolean } = {}; // ditto

		total_count += trace.count;

		// Compute basic node counts for annotations.
		for (const frame of trace.frames) {
			const [symbol, file, linenr] = frame_unpack(frame);

			if (!visitedLines[file + ":" + linenr]) {
				visitedLines[file + ":" + linenr] = true;

				if (!nodeInfo[file]) {
					nodeInfo[file] = {};
				}

				if (!nodeInfo[file][linenr]) {
					nodeInfo[file][linenr] = { count: 0, rec_count: 0, out_counts: {}, in_counts: {} };
				}

				nodeInfo[file][linenr].count += trace.count;
				max_count = Math.max(max_count, nodeInfo[file][linenr].count);
			}

			// This counts how many times a line is called *including* recursive calls.
			nodeInfo[file][linenr].rec_count += trace.count;

			if (symbol && typeof linenr === 'number') {
				// Symbol counts need to be done separately because of potential recursion.
				if (!visitedSymbols[file + ":" + symbol]) {
					visitedSymbols[file + ":" + symbol] = true;

					if (!symbols[file]) {
						symbols[file] = {};
					}

					if (!symbols[file][symbol]) {
						symbols[file][symbol] = { count: 0, min_line: null, max_line: null };
					}

					symbols[file][symbol].count += trace.count;

					// Useful to jump to the symbol later.
					symbols[file][symbol].min_line = Math.min(symbols[file][symbol].min_line, linenr);
					symbols[file][symbol].max_line = Math.max(symbols[file][symbol].max_line, linenr);
				}
			}
		}

		// Compute in / out neighbor counts for caller / callee lookup.
		// Note: we *don't* do any recursion detection here because we will compare these numbers to
		// rec_count later!
		for (let i = 0; i < trace.frames.length - 1; i++) {
			const frame1 = trace.frames[i];
			const frame2 = trace.frames[i + 1];

			const [, file1, linenr1] = frame_unpack(frame1);
			const [, file2, linenr2] = frame_unpack(frame2);

			if (!nodeInfo[file1][linenr1].out_counts[file2]) {
				nodeInfo[file1][linenr1].out_counts[file2] = {};
			}

			if (!nodeInfo[file1][linenr1].out_counts[file2][linenr2]) {
				nodeInfo[file1][linenr1].out_counts[file2][linenr2] = 0;
			}

			nodeInfo[file1][linenr1].out_counts[file2][linenr2] += trace.count;

			if (!nodeInfo[file2][linenr2].in_counts[file1]) {
				nodeInfo[file2][linenr2].in_counts[file1] = {};
			}

			if (!nodeInfo[file2][linenr2].in_counts[file1][linenr1]) {
				nodeInfo[file2][linenr2].in_counts[file1][linenr1] = 0;
			}

			nodeInfo[file2][linenr2].in_counts[file1][linenr1] += trace.count;
		}
	}

	realNames = {};
	return [nodeInfo, symbols, total_count, max_count];
}

// Loads given list of stack traces into call graph.
// 	@param traces Stack traces to be loaded. For format see :help perfanno-extensions.
//	@return Total number of traces loaded.
export function loadTraces(traces: PerfData): number {
	M.events = [];
	M.callgraphs = {};

	let total = 0;

	for (const event in traces) {
		M.events.push(event);

		const [nodeInfo, symbols, totalCount, maxCount] = processTraces(traces[event]);
		M.callgraphs[event] = { nodeInfo, symbols, totalCount, maxCount };

		total += totalCount;
	}
	return total;
}

// Highlights a line in a buffer.
//	@param uriPath Path to buffer.
//  @param event Event to use for annotation.
//	@param linenr Line number to highlight.
//	@param info Table with the following fields:
//		- count: Number of times this line was hit.
//		- rec_count: Number of times this line was hit including recursive calls.
//		- out_counts: Table describing how many times child lines were called.
//    - in_counts: Table showing how many times the enclosing symbol was called.
//  @param total_count Total number of traces.
//  @param max_count Maximum count of a single line.
export function add_annotation(filePath: string, event: string, linenr: number, info: { count: number; rec_count: number; out_counts: { [key: string]: number; }; in_counts: { [key: string]: number; }; }, total_count: number, max_count: number): void {
	if(M.config.localRelative) {
		let t_count = 0;
		for (const [filename, line_and_counts] of Object.entries(info.in_counts)) {
			for(const [lr, count] of Object.entries(line_and_counts)) {
				if(!M.callgraphs[event].nodeInfo[filename][parseInt(lr)]) {	
					continue;
				}
				t_count += M.callgraphs[event].nodeInfo[filename][parseInt(lr)].rec_count;
			}
		}
		if(t_count > 0) {
			total_count = t_count;
			max_count = total_count;
		}
	}

	if(info.count / total_count < M.config.minimumThreshold) {
		return;
	}

	// https://github.com/alexdalat/perfanno-vscode/issues/1
	// fix when line2addr can't determine line number
	if(linenr <= 0) {
		return;
	}

	// virtual text
	const count = info.count;
	const col = M.config.highlightColor ? M.config.highlightColor : [255, 0, 0];
	let opts = {
		after: {
			contentText: '',
			color: 'rgba(177, 177, 177, 0.7)',
			margin: '0 0 0 15px',
		},
		backgroundColor: `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${count / max_count})`,
	};
	switch(M.config.eventOutputType) {
		case "percentage":
			opts.after.contentText = Math.round(count / total_count * 10000) / 100 + '%';
			break;
		case "percentage and count":
			opts.after.contentText = Math.round(count / total_count * 10000) / 100 + '% (' + count + '/' + total_count + ')';
			break;
	};

	LineHighlighter.highlightLine(filePath, linenr - 1, opts);
}

// Annotates a buffer with call graph information.
//	@param filePath Path to buffer.
//	@param event Event to use for annotation.
// Precondition: M.callgraphs[event] must exist.
export function annotateBuffer(filePath: any, event: string): void {
	if (!filePath) {
		return; // Buffer is not a file.
	}

	if (!M.callgraphs[event].nodeInfo[filePath]) {
		return; // No annotations for this file.
	}

	const total_count = M.callgraphs[event].totalCount;
	const max_count = M.callgraphs[event].maxCount;

	for (const [linenr, info] of Object.entries(M.callgraphs[event].nodeInfo[filePath])) {
		add_annotation(filePath, event, parseInt(linenr), info, total_count, max_count);
	}
}

// Annotates an array of buffers with call graph information.
//	@param buffers Array of buffer paths to annotate.
//	@param event Event to use for annotation. If not given, uses the first event.
// Precondition: M.callgraphs[event] must exist.
export function addAnnotations(): void {
	let e = (M.current_event !== "" ? M.current_event : M.events[0]);
	if(!M.callgraphs[e]) {
		throw new Error(`addAnnotations: event ${e} does not exist`);
	}
	for (const file in M.callgraphs[e].nodeInfo) {
		annotateBuffer(file, e);
	}
}

export function isLoaded(): boolean {
	return M.hasData;
}

export function getEvents(): string[] {
	return M.events;
}

export function selectEvent(event: string): void {
	if (!M.callgraphs[event]) {
		throw new Error(`selectEvent: event ${event} does not exist`);
	}

	M.current_event = event;
}

export function setConfig(key: string, value: any): void {
	M.config[key] = value;
}

export function getConfig(key: string): any {
	return M.config[key];
}
