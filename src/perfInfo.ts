import * as fs from 'fs';
import * as path from 'path';
import { LineHighlighter } from './LineHighlighter';
import { workspace } from 'vscode';

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

export enum EventOutputType {
	count,
	percentage,
	percentage_and_count
};

let realNames = {} as { [key: string]: string };

/** Use one path representation for profiler frames and VS Code document URIs. */
function normalizePath(filePath: string): string {
	const normalized = filePath.replaceAll('\\', '/');
	return /^[A-Z]:\//.test(normalized) ? normalized[0].toLowerCase() + normalized.slice(1) : normalized;
}

function existingCanonicalPath(filePath: string): string | undefined {
	try {
		return normalizePath(fs.realpathSync(filePath));
	} catch {
		return undefined;
	}
}

/**
 * Translate a file stored in a profile into the local workspace when possible.
 * This covers profiles copied from another machine, provided the repository's
 * directory name and relative source layout were kept. Explicit pathMappings
 * take precedence for layouts where that is not true.
 */
function sourceFileKey(profilePath: string): string {
	const normalizedProfilePath = normalizePath(profilePath);
	if (realNames[normalizedProfilePath]) {
		return realNames[normalizedProfilePath];
	}

	const directPath = existingCanonicalPath(profilePath);
	if (directPath) {
		return realNames[normalizedProfilePath] = directPath;
	}

	const mappings = M.config.pathMappings;
	if (mappings && typeof mappings === 'object' && !Array.isArray(mappings)) {
		for (const [from, to] of Object.entries(mappings).sort(([a], [b]) => b.length - a.length)) {
			const sourceRoot = normalizePath(from).replace(/\/$/, '');
			if (normalizedProfilePath === sourceRoot || normalizedProfilePath.startsWith(sourceRoot + '/')) {
				const localRoot = (to as string).replaceAll('${workspaceFolder}', workspace.workspaceFolders?.[0].uri.fsPath || '');
				const mappedPath = path.join(localRoot, normalizedProfilePath.slice(sourceRoot.length));
				const canonicalPath = existingCanonicalPath(mappedPath);
				if (canonicalPath) {
					return realNames[normalizedProfilePath] = canonicalPath;
				}
			}
		}
	}

	const workspacePath = workspace.workspaceFolders?.[0].uri.fsPath;
	if (workspacePath) {
		const localRoot = existingCanonicalPath(workspacePath) || normalizePath(workspacePath);
		const projectName = path.posix.basename(localRoot);
		const pathParts = normalizedProfilePath.split('/');
		const projectIndex = pathParts.lastIndexOf(projectName);
		if (projectIndex >= 0) {
			const candidate = path.join(localRoot, ...pathParts.slice(projectIndex + 1));
			const canonicalPath = existingCanonicalPath(candidate);
			if (canonicalPath) {
				return realNames[normalizedProfilePath] = canonicalPath;
			}
		}
	}

	return realNames[normalizedProfilePath] = normalizedProfilePath;
}

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
	const workspaceDir = workspace.workspaceFolders?.[0].uri.fsPath;

	const lines = fs.readFileSync(perfDataPath, 'utf-8').split(/\r?\n/);
	for (const line of lines) {
		const numEventMatch = line.match(/^\s*#\s*Samples:\s+[\d.,]+(?:[KMB])?\s+of event\s+'(.+?)'/);

		if (numEventMatch) {
			const [, event] = numEventMatch;
			result[event] ??= [];
			currentEvent = event;
		} else {
			const countTraceMatch = line.match(/^\s*(\d+)\s+(.+?)\s*$/);

			if (countTraceMatch) {
				const [, countStr, traceLine] = countTraceMatch;
				const count = parseInt(countStr, 10);

				if (count > 0) {
					const traceData: TraceData = { count: count, frames: [] };

					const funcs = traceLine.split(';');
					let lastLocalLeaf;
					for (const func of funcs) {
						const funcMatch = func.match(/^(.*?)\s+((?:[a-z]:)?[\\/].+):(\d+)\s*(?:\(inlined\))?$/i);

						if (funcMatch) {
							const [, symbol, rawFile, linenrStr] = funcMatch;
							const file = sourceFileKey(rawFile);
							const linenr = parseInt(linenrStr, 10);
							if (!M.config.onlyLocalLeaf) {
								traceData.frames.push({ symbol: symbol || undefined, file, linenr });
							} else if (workspaceDir && file.startsWith(sourceFileKey(workspaceDir))) {
								// Only push last leaf (self() trace) if this is a project file
								lastLocalLeaf = { symbol: symbol || undefined, file, linenr };
							} else {
								// For all other project-external files, push all traces
								traceData.frames.push({ symbol: symbol || undefined, file, linenr });
							}
						} else {
							traceData.frames.push({ symbol: func });
						}
					}
					if (M.config.onlyLocalLeaf && lastLocalLeaf !== undefined) {
						traceData.frames.push(lastLocalLeaf);
					}

					if (currentEvent) {
						result[currentEvent].push(traceData);
					}
				}
			}
		}
	}

	M.data = result;
	return M.data;
}


/**
 * 
 * @param pyspyDataPath Path to pyspy raw callgraph file.
 * @returns Table with the following fields:
 *		- event: List of tables with the following fields:
 *			- count: Number of times this stack trace occurred.
 *			- frames: List of frames in the stack trace with the following fields:
 *				- symbol: Symbol name.
 *				- file: File name.
 *				- linenr: Line number.
 */
export function pyspyCallgraphFile(pyspyDataPath: string): PerfData {
	let currentEvent: string | undefined = "cpu_cycles";
	const result: PerfData = { [currentEvent]: [] };
	const workspaceDir = workspace.workspaceFolders?.[0].uri.fsPath;

	const lines = fs.readFileSync(pyspyDataPath, 'utf-8').split(/\r?\n/);
	for (const line of lines) {

		const countTraceMatch = line.match(/^\s*(.+?)\s+(\d+)\s*$/);

		if (countTraceMatch) {
			const [, traceLine, countStr] = countTraceMatch;
			const count = parseInt(countStr, 10);

			if (count > 0) {
				const traceData: TraceData = { count: count, frames: [] };

				const funcs = traceLine.split(';');
				let lastLocalLeaf;
				for (const func of funcs) {
					const funcMatch = func.match(/^(.*?)\s+\(((?:[a-z]:)?[\\/].+):(\d+)\)$/i);

					if (funcMatch) {
						const [, symbol, rawFile, linenrStr] = funcMatch;
						const file = sourceFileKey(rawFile);

						const linenr = parseInt(linenrStr, 10);
						if (!M.config.onlyLocalLeaf) {
							traceData.frames.push({ symbol: symbol || undefined, file, linenr });
						} else if (workspaceDir && file.startsWith(sourceFileKey(workspaceDir)) && !/\/\.?venv\//.test(file)) {
							// Only push last leaf (self() trace) if this is a project file,
							// that is related to this project (not in venv for python code)
							lastLocalLeaf = { symbol: symbol || undefined, file, linenr };
						} else {
							// For all other project-external files, push all traces
							traceData.frames.push({ symbol: symbol || undefined, file, linenr });
						}
					} else {
						traceData.frames.push({ symbol: func });
					}
				}
				if (M.config.onlyLocalLeaf && lastLocalLeaf !== undefined) {
					traceData.frames.push(lastLocalLeaf);
				}

				result[currentEvent].push(traceData);
			}
		}
	}

	M.data = result;
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

		return [frame.symbol, sourceFileKey(frame.file), frame.linenr];
	}

	// frame is a string
	const match = frame.match(/^(.*?)\s+((?:[a-z]:)?[\\/].+):(\d+)\s*(?:\(inlined\))?$/i);
	if (match) {
		const [, symbol, file, linenrStr] = match;
		const linenr = parseInt(linenrStr, 10);

		return [symbol || undefined, sourceFileKey(file), linenr];
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
	M.current_event = '';

	let total = 0;
	let defaultEvent: string | undefined;
	let defaultEventCount = -1;

	for (const event in traces) {
		M.events.push(event);

		const [nodeInfo, symbols, totalCount, maxCount] = processTraces(traces[event]);
		M.callgraphs[event] = { nodeInfo, symbols, totalCount, maxCount };

		total += totalCount;

		// Default to the event with the most samples: an event's samples can be dominated by
		// unresolved kernel/library frames (e.g. an idle CPU cluster on a hybrid CPU), leaving it
		// with no annotations for the file the user has open even though other events have data.
		if (totalCount > defaultEventCount) {
			defaultEvent = event;
			defaultEventCount = totalCount;
		}
	}
	if (M.events.length === 0 || total === 0) {
		M.hasData = false;
		throw new Error('No stack traces found. Check that the report was generated in folded/raw format.');
	}
	M.hasData = true;
	M.current_event = defaultEvent ?? '';
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
	if (M.config.localRelative) {
		let t_count = 0;
		for (const [filename, line_and_counts] of Object.entries(info.in_counts)) {
			for (const [lr, count] of Object.entries(line_and_counts)) {
				if (!M.callgraphs[event].nodeInfo[filename][parseInt(lr)]) {
					continue;
				}
				t_count += M.callgraphs[event].nodeInfo[filename][parseInt(lr)].rec_count;
			}
		}
		if (t_count > 0) {
			total_count = t_count;
			max_count = total_count;
		}
	}

	if (info.count / total_count < M.config.minimumThreshold) {
		return;
	}

	// https://github.com/alexdalat/perfanno-vscode/issues/1
	// fix when line2addr can't determine line number
	if (linenr <= 0) {
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
		backgroundColor: `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${count / max_count * 0.7})`,
	};
	switch (M.config.eventOutputType) {
		case EventOutputType.percentage:
			opts.after.contentText = Math.round(count / total_count * 10000) / 100 + '%';
			break;
		case EventOutputType.percentage_and_count:
			opts.after.contentText = Math.round(count / total_count * 10000) / 100 + '% (' + count + '/' + total_count + ')';
			break;
		case EventOutputType.count:
			opts.after.contentText = count.toString() + '/' + total_count;
			break;
		default:
			throw new Error(`add_annotation: unknown eventOutputType ${M.config.eventOutputType}`);
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

	const sourcePath = sourceFileKey(filePath);
	if (!M.callgraphs[event].nodeInfo[sourcePath]) {
		return; // No annotations for this file.
	}

	const total_count = M.callgraphs[event].totalCount;
	const max_count = M.callgraphs[event].maxCount;

	for (const [linenr, info] of Object.entries(M.callgraphs[event].nodeInfo[sourcePath])) {
		add_annotation(sourcePath, event, parseInt(linenr), info, total_count, max_count);
	}
}

// Annotates an array of buffers with call graph information.
//	@param buffers Array of buffer paths to annotate.
//	@param event Event to use for annotation. If not given, uses the first event.
// Precondition: M.callgraphs[event] must exist.
export function addAnnotations(): void {
	let e = (M.current_event !== "" ? M.current_event : M.events[0]);
	if (!M.callgraphs[e]) {
		throw new Error(`addAnnotations: event ${e} does not exist`);
	}
	for (const file in M.callgraphs[e].nodeInfo) {
		annotateBuffer(file, e);
	}
}

export interface HottestLine {
	file: string;
	linenr: number;
	count: number;
}

// Finds the line with the highest sample count in the given file.
//	@param filePath Path to the file to search within.
//	@param event Event to use. Defaults to the currently selected event.
//	@return The hottest line's file, line number, and count, or undefined if the file has no data.
export function getHottestLineInFile(filePath: string, event?: string): HottestLine | undefined {
	const e = event ?? (M.current_event !== "" ? M.current_event : M.events[0]);
	const fileInfo = M.callgraphs[e]?.nodeInfo[sourceFileKey(filePath)];
	if (!fileInfo) {
		return undefined;
	}

	let best: HottestLine | undefined;
	for (const [linenr, info] of Object.entries(fileInfo)) {
		const line = parseInt(linenr, 10);
		if (line > 0 && (!best || info.count > best.count)) {
			best = { file: sourceFileKey(filePath), linenr: line, count: info.count };
		}
	}
	return best;
}

// Finds the line with the highest sample count across all known files.
//	@param event Event to use. Defaults to the currently selected event.
//	@return The hottest line's file, line number, and count, or undefined if there is no data.
export function getHottestLineInWorkspace(event?: string): HottestLine | undefined {
	const e = event ?? (M.current_event !== "" ? M.current_event : M.events[0]);
	const nodeInfo = M.callgraphs[e]?.nodeInfo;
	if (!nodeInfo) {
		return undefined;
	}

	let best: HottestLine | undefined;
	for (const [file, lines] of Object.entries(nodeInfo)) {
		if (file === 'symbol') {
			continue; // pseudo-file for frames without a source location
		}
		for (const [linenr, info] of Object.entries(lines)) {
			const line = parseInt(linenr, 10);
			if (line > 0 && (!best || info.count > best.count)) {
				best = { file, linenr: line, count: info.count };
			}
		}
	}
	return best;
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
