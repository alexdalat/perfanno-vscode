import * as vscode from 'vscode';
import * as perfInfo from './perfInfo';
import { LineHighlighter } from './LineHighlighter';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// from: https://stackoverflow.com/questions/70346445/how-to-get-all-opened-files-with-vscode-api
export function getAllActiveBuffers(): vscode.TextEditor[] {
	const editors: vscode.TextEditor[] = [];
	vscode.window.visibleTextEditors.forEach((editor) => {
		editors.push(editor);
	});
	return editors;
}

function hexToRgb(hex: string) {
	let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result ? [
		parseInt(result[1], 16),
		parseInt(result[2], 16),
		parseInt(result[3], 16)
	] : null;
}

const outputTypeMap: Record<string, perfInfo.EventOutputType> = {
	'count': perfInfo.EventOutputType.count,
	'percentage': perfInfo.EventOutputType.percentage,
	'percentage and count': perfInfo.EventOutputType.percentage_and_count
};

function strToOutputType(str: string): perfInfo.EventOutputType {
	const outputType = outputTypeMap[str];
	if (outputType === undefined) {
		throw new Error('Invalid eventOutputType');
	}
	return outputType;
}

const config_keys = ['eventOutputType', 'localRelative', 'highlightColor', 'minimumThreshold', 'perfFile', 'pyspyFile', 'onlyLocalLeaf', 'pathMappings', 'autoLoad', 'autoReload'];
const config_mod_funcs = [strToOutputType, null, hexToRgb, null, null, null, null, null, null, null];

let autoLoadRunning = false;
let queuedPerfData: vscode.Uri | undefined;

function is_affected(event: vscode.ConfigurationChangeEvent): boolean {
	for (let key of config_keys) {
		if (event.affectsConfiguration(`perfanno.${key}`)) {
			return true;
		}
	}
	return false;
}

function syncConfig() {
	for (let i = 0; i < config_keys.length; i++) {
		let val = vscode.workspace.getConfiguration('perfanno').get(config_keys[i]);
		if (typeof config_mod_funcs[i] === 'function') {
			val = config_mod_funcs[i]?.(val as string);
		}
		perfInfo.setConfig(config_keys[i], val);
	}
}

function reannotate() {
	try {
		syncConfig();
		LineHighlighter.clear();  // clears annotations
		perfInfo.addAnnotations();  // stores annotations in LineHighlighter
		LineHighlighter.applyMultiHighlights(getAllActiveBuffers());  // draw annotations on active tabs
	} catch (e) {
		vscode.window.showErrorMessage(String(e));
	}
}

type ProgressReporter = vscode.Progress<{ message?: string; increment?: number }>;

function yieldToProgressUi(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function writeParsedReportJson(filePath: string, data: perfInfo.PerfData): Promise<void> {
	try {
		await fs.promises.writeFile(`${filePath}.json`, JSON.stringify(data, null, 2));
	} catch (error) {
		console.error(`Perfanno: failed to write parsed report JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadPerfReport(filePath: string, workspaceFolder: string, progress?: ProgressReporter): Promise<number> {
	progress?.report({ message: 'Reading report…' });
	await yieldToProgressUi();
	syncConfig();
	progress?.report({ message: 'Parsing stack traces…' });
	const perfData = perfInfo.perfCallgraphFile(filePath);
	progress?.report({ message: 'Writing parsed report…' });
	await writeParsedReportJson(filePath, perfData);
	const totalCount = perfInfo.loadTraces(perfData);
	progress?.report({ message: 'Applying annotations…' });
	reannotate();
	if (filePath.startsWith(workspaceFolder)) {
		progress?.report({ message: 'Saving report path…' });
		await vscode.workspace.getConfiguration('perfanno').update(
			'perfFile',
			path.relative(workspaceFolder, filePath),
			vscode.ConfigurationTarget.Workspace
		);
	}
	return totalCount;
}

async function loadPySpyReport(filePath: string, workspaceFolder: string, progress: ProgressReporter): Promise<number> {
	progress.report({ message: 'Reading py-spy report…' });
	await yieldToProgressUi();
	syncConfig();
	progress.report({ message: 'Parsing stack traces…' });
	const totalCount = perfInfo.loadTraces(perfInfo.pyspyCallgraphFile(filePath));
	progress.report({ message: 'Applying annotations…' });
	reannotate();
	if (filePath.startsWith(workspaceFolder)) {
		progress.report({ message: 'Saving report path…' });
		await vscode.workspace.getConfiguration('perfanno').update(
			'pyspyFile',
			path.relative(workspaceFolder, filePath),
			vscode.ConfigurationTarget.Workspace
		);
	}
	return totalCount;
}

function convertPerfData(perfDataPath: string, outputPath: string, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
		const output = fs.createWriteStream(temporaryPath);
		const args = ['report', '-g', 'folded,0,caller,srcline,branch,count', '--no-children', '--full-source-path', '--stdio', '-i', perfDataPath];
		const perfProcess = spawn('perf', args, { cwd: path.dirname(perfDataPath) });
		let stderr = '';
		let cancelled = false;

		const cancellation = token.onCancellationRequested(() => {
			cancelled = true;
			perfProcess.kill();
		});
		perfProcess.stdout.pipe(output);
		perfProcess.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
		perfProcess.on('error', error => finish(error));
		perfProcess.on('close', code => {
			if (cancelled) {
				finish(new Error('Perf report conversion cancelled.'));
			} else if (code !== 0) {
				finish(new Error(`perf report failed (exit ${code}): ${stderr.trim() || 'no error output'}`));
			} else {
				finish();
			}
		});
		output.on('error', error => finish(error));

		let finished = false;
		function finish(error?: Error): void {
			if (finished) {
				return;
			}
			finished = true;
			cancellation.dispose();
			output.end(async () => {
				if (error) {
					try { await fs.promises.unlink(temporaryPath); } catch { /* no temporary file to remove */ }
					reject(error);
					return;
				}
				try {
					await fs.promises.rename(temporaryPath, outputPath);
					resolve();
				} catch (renameError) {
					reject(renameError);
				}
			});
		}
	});
}

const PERF_MAX_SAMPLE_RATE_PATH = '/proc/sys/kernel/perf_event_max_sample_rate';

async function getMaxSampleRate(): Promise<number | undefined> {
	if (process.platform !== 'linux') {
		return undefined;
	}
	try {
		const contents = await fs.promises.readFile(PERF_MAX_SAMPLE_RATE_PATH, 'utf-8');
		const value = parseInt(contents.trim(), 10);
		return Number.isNaN(value) ? undefined : value;
	} catch {
		return undefined;
	}
}

function getRequestedSampleRate(perfDataPath: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		const perfProcess = spawn('perf', ['evlist', '-v', '-i', perfDataPath], { cwd: path.dirname(perfDataPath) });
		let stdout = '';
		perfProcess.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
		perfProcess.on('error', () => resolve(undefined));
		perfProcess.on('close', () => {
			const matches = [...stdout.matchAll(/sample_freq\s*\}:\s*(\d+)/g)];
			if (matches.length === 0) {
				resolve(undefined);
				return;
			}
			resolve(Math.max(...matches.map(m => parseInt(m[1], 10))));
		});
	});
}

// Warns (with a fix-it action) when perf.data was recorded at a sample rate that exceeds
// kernel.perf_event_max_sample_rate, since perf silently caps the rate in that case,
// reducing sample coverage.
async function warnIfSampleRateCapped(perfDataPath: string): Promise<void> {
	const [requested, max] = await Promise.all([
		getRequestedSampleRate(perfDataPath),
		getMaxSampleRate(),
	]);
	if (requested === undefined || max === undefined || requested <= max) {
		return;
	}

	const fixAction = 'Open terminal to fix';
	const selection = await vscode.window.showWarningMessage(
		`Perfanno: perf.data was recorded at ${requested}Hz, but kernel.perf_event_max_sample_rate is ${max}Hz. Samples were likely capped, reducing coverage.`,
		fixAction
	);
	if (selection === fixAction) {
		const terminal = vscode.window.createTerminal('Perfanno: fix sample rate');
		terminal.show();
		terminal.sendText(`sudo sysctl kernel.perf_event_max_sample_rate=${requested}`, false);
	}
}

async function findPerfData(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
	const files = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspaceFolder, '**/perf.data'),
		'**/{.git,node_modules,.venv}/**',
		20
	);
	if (files.length === 0) {
		return undefined;
	}
	files.sort((a, b) => a.fsPath.length - b.fsPath.length);
	return files[0];
}

async function autoLoadPerfData(showMissingFileMessage: boolean, requestedPerfData?: vscode.Uri): Promise<void> {
	if (autoLoadRunning) {
		queuedPerfData = requestedPerfData;
		return;
	}
	autoLoadRunning = true;
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		if (showMissingFileMessage) {
			vscode.window.showErrorMessage('Perfanno: open a workspace to search for perf.data.');
		}
		autoLoadRunning = false;
		return;
	}

	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Perfanno: loading perf.data',
			cancellable: true
		}, async (progress, token) => {
			progress.report({ message: 'Searching workspace…', increment: 10 });
			const perfData = requestedPerfData || await findPerfData(workspaceFolder);
			if (!perfData) {
				if (showMissingFileMessage) {
					vscode.window.showInformationMessage('Perfanno: no perf.data found in this workspace.');
				}
				return;
			}
			if (token.isCancellationRequested) {
				return;
			}

			void warnIfSampleRateCapped(perfData.fsPath);

			const perfReport = path.join(path.dirname(perfData.fsPath), 'perf.out');
			progress.report({ message: `Converting ${path.relative(workspaceFolder.uri.fsPath, perfData.fsPath)}…` });
			await convertPerfData(perfData.fsPath, perfReport, token);
			if (token.isCancellationRequested) {
				return;
			}
			progress.report({ message: 'Conversion complete', increment: 65 });
			const totalCount = await loadPerfReport(perfReport, workspaceFolder.uri.fsPath, progress);
			progress.report({ message: 'Complete', increment: 25 });
			vscode.window.showInformationMessage(`Perfanno: converted and loaded ${totalCount} traces from ${perfData.fsPath}`);
		});
	} catch (error) {
		vscode.window.showErrorMessage(`Perfanno: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		autoLoadRunning = false;
		if (queuedPerfData) {
			const nextPerfData = queuedPerfData;
			queuedPerfData = undefined;
			void autoLoadPerfData(false, nextPerfData);
		}
	}
}

async function goToHottestLine(hottest: perfInfo.HottestLine | undefined, scopeDescription: string): Promise<void> {
	if (!perfInfo.isLoaded()) {
		vscode.window.showInformationMessage('Perfanno: no perf data loaded');
		return;
	}
	if (!hottest) {
		vscode.window.showInformationMessage(`Perfanno: no hot line found ${scopeDescription}`);
		return;
	}

	const doc = await vscode.workspace.openTextDocument(hottest.file);
	const editor = await vscode.window.showTextDocument(doc);
	const line = hottest.linenr - 1;
	const position = new vscode.Position(line, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

export function activate(context: vscode.ExtensionContext) {
	let perfDataWatcher: vscode.FileSystemWatcher | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const configureAutoReload = () => {
		perfDataWatcher?.dispose();
		perfDataWatcher = undefined;
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = undefined;
		}
		if (!vscode.workspace.getConfiguration('perfanno').get<boolean>('autoReload')) {
			return;
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return;
		}
		perfDataWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceFolder, '**/perf.data'),
			false,
			false,
			false
		);
		const scheduleReload = (perfData: vscode.Uri) => {
			if (reloadTimer) {
				clearTimeout(reloadTimer);
			}
			// perf record may emit several close-together writes; wait for it to settle.
			reloadTimer = setTimeout(() => {
				reloadTimer = undefined;
				void autoLoadPerfData(false, perfData);
			}, 1000);
		};
		context.subscriptions.push(perfDataWatcher.onDidCreate(scheduleReload));
		context.subscriptions.push(perfDataWatcher.onDidChange(scheduleReload));
	};

	configureAutoReload();
	context.subscriptions.push({ dispose: () => {
		perfDataWatcher?.dispose();
		if (reloadTimer) {
			clearTimeout(reloadTimer);
		}
	} });

	if (vscode.workspace.getConfiguration('perfanno').get<boolean>('autoLoad')) {
		void autoLoadPerfData(false);
	}

	// when changing text editor, apply highlights
	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor && perfInfo.isLoaded()) {
			LineHighlighter.applyHighlights(editor);
		}
	}, null, context.subscriptions);

	// when changing configuration, reapply highlights
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('perfanno.autoReload')) {
			configureAutoReload();
		}
		if (is_affected(event) && perfInfo.isLoaded()) {
			reannotate();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.highlightLine', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const line = editor.selection.active.line;
			LineHighlighter.highlightLineEditor(editor, line);
			vscode.window.showInformationMessage(`Line ${line + 1} highlighted`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.goToHottestLineInFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Perfanno: no active editor');
			return;
		}
		await goToHottestLine(perfInfo.getHottestLineInFile(editor.document.uri.fsPath), 'in this file');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.goToHottestLineInWorkspace', async () => {
		await goToHottestLine(perfInfo.getHottestLineInWorkspace(), 'in the workspace');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.pickEvent', () => {
		if (!perfInfo.isLoaded()) {
			vscode.window.showInformationMessage("Can't select: no perf data loaded");
			return;
		}
		let events = perfInfo.getEvents();
		let events_formatted = events.map((event) => {
			return {
				label: event,
				event: event
			};
		});
		vscode.window.showQuickPick(events_formatted, {
			placeHolder: 'Select event to highlight'
		}).then((selected) => {
			if (selected) {
				try {
					perfInfo.selectEvent(selected.event);
					reannotate();
				} catch (e) {
					vscode.window.showErrorMessage(String(e));
				}
			}
		});

	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.readFile', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : process.cwd();
		let fileStr = undefined;

		// if file defined by `perfFile` setting exists, load it. Else, fallback to prompting
		// check using workspace root, or cwd root
		try {
			if (!workspaceFolder) {
				throw new Error('No workspace or active folder found');
			}

			syncConfig();
			const relFilePath = perfInfo.getConfig('perfFile');
			if (!relFilePath) {
				throw new Error('No file defined in configuration');
			}

			const absFilePath = path.join(workspaceFolder, relFilePath);
			if (!fs.existsSync(absFilePath)) {
				throw new Error(`File ${absFilePath} not found`);
			}

			fileStr = absFilePath;
		} catch (e) {
			fileStr = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select perf report file' }).then((uris) => {
				if (uris === undefined) {
					return;
				}
				return uris[0].fsPath;
			});
		}

		if (fileStr === undefined) {
			vscode.window.showErrorMessage('No file selected');
			return;
		}

		const totalCount = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Perfanno: loading perf report',
			cancellable: false
		}, async progress => {
			progress.report({ increment: 10 });
			const count = await loadPerfReport(fileStr, workspaceFolder, progress);
			progress.report({ message: 'Complete', increment: 90 });
			return count;
		});
		vscode.window.showInformationMessage(`Loaded ${totalCount} traces from ${fileStr}`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.autoLoadPerfData', async () => {
		await autoLoadPerfData(true);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.readPySpyFile', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : process.cwd();
		let fileStr = undefined;

		// if file defined by `pyspyFile` setting exists, load it. Else, fallback to prompting
		// check using workspace root, or cwd root
		try {
			if (!workspaceFolder) {
				throw new Error('No workspace or active folder found');
			}

			syncConfig();
			const relFilePath = perfInfo.getConfig('pyspyFile');
			if (!relFilePath) {
				throw new Error('No file defined in configuration');
			}

			const absFilePath = path.join(workspaceFolder, relFilePath);
			if (!fs.existsSync(absFilePath)) {
				throw new Error(`File ${absFilePath} not found`);
			}

			fileStr = absFilePath;
		} catch (e) {
			fileStr = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select raw py-spy file' }).then((uris) => {
				if (uris === undefined) {
					return;
				}
				return uris[0].fsPath;
			});
		}

		if (fileStr === undefined) {
			vscode.window.showErrorMessage('No file selected');
			return;
		} else if (fileStr.startsWith(workspaceFolder)) {
			// Store the file we loaded traces from for easy re-use in the future
			await vscode.workspace.getConfiguration('perfanno').update(
				'pyspyFile',
				path.relative(workspaceFolder, fileStr),
				vscode.ConfigurationTarget.Workspace
			);
		}

		const totalCount = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Perfanno: loading py-spy report',
			cancellable: false
		}, async progress => {
			progress.report({ increment: 10 });
			const count = await loadPySpyReport(fileStr, workspaceFolder, progress);
			progress.report({ message: 'Complete', increment: 90 });
			return count;
		});
		vscode.window.showInformationMessage(`Loaded ${totalCount} traces from ${fileStr}`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.clearHighlights', () => {
		LineHighlighter.clear();
		vscode.window.showInformationMessage('Perfanno highlights cleared');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.clearStoredFilePaths', async () => {
		await vscode.workspace.getConfiguration('perfanno').update(
			'perfFile',
			undefined,
			vscode.ConfigurationTarget.Workspace
		);
		await vscode.workspace.getConfiguration('perfanno').update(
			'pyspyFile',
			undefined,
			vscode.ConfigurationTarget.Workspace
		);
		vscode.window.showInformationMessage('Cleared default paths to report files');
	}));
}

export function deactivate() {
	LineHighlighter.clear();
}
