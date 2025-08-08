import * as vscode from 'vscode';
import * as perfInfo from './perfInfo';
import { LineHighlighter } from './LineHighlighter';
import * as fs from 'fs';
import * as path from 'path';

// from: https://stackoverflow.com/questions/70346445/how-to-get-all-opened-files-with-vscode-api
export function getAllActiveBuffers(): vscode.TextEditor[] {
	const editors: vscode.TextEditor[] = [];
	vscode.window.visibleTextEditors.forEach((editor) => {
		editors.push(editor);
	});
	return editors;
}

function hexToRgb(hex: string) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16)
  ] : null;
}

function strToOutputType(str: string) {
	switch (str) {
		case 'count':
			return perfInfo.EventOutputType.count;
		case 'percentage':
			return perfInfo.EventOutputType.percentage;
		case 'percentage and count':
			return perfInfo.EventOutputType.percentage_and_count;
		default:
			throw new Error('Invalid eventOutputType');
	}
}

const config_keys = 		 ['eventOutputType', 'localRelative', 'highlightColor', 'minimumThreshold', 'file', 'onlyLocalLeaf'];
const config_mod_funcs = [ strToOutputType, 	null,            hexToRgb,         null,               null,	null];

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
		if(typeof config_mod_funcs[i] === 'function') {
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

export function activate(context: vscode.ExtensionContext) {

	// when changing text editor, apply highlights
	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor && perfInfo.isLoaded()) {
			LineHighlighter.applyHighlights(editor);
		}
	}, null, context.subscriptions);

	// when changing configuration, reapply highlights
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
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

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.pickEvent', () => {
		if(!perfInfo.isLoaded()) {
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
		var fileStr = undefined;

		// if file defined by `file` setting exists, load it. Else, fallback to prompting
		// check using workspace root, or cwd root
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : process.cwd();
			if (!workspaceFolder) {
				throw new Error('No workspace or active folder found');
			}

			syncConfig();
			const relFilePath = perfInfo.getConfig('file');
			if (!relFilePath) {
				throw new Error('No file defined in configuration');
			}

			const absFilePath = path.join(workspaceFolder, relFilePath);
			if (!fs.existsSync(absFilePath)) {
				throw new Error(`File ${absFilePath} not found`);
			}

			fileStr = absFilePath;
		} catch (e) {
			fileStr = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select perf.out file' }).then((uris) => {
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

		const totalCount = perfInfo.loadTraces(perfInfo.perfCallgraphFile(fileStr));
		reannotate();
		vscode.window.showInformationMessage(`Loaded ${totalCount} traces from ${fileStr}`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('perfanno.clearHighlights', () => {
		LineHighlighter.clear();
		vscode.window.showInformationMessage('Perfanno highlights cleared');
	}));
}

export function deactivate() {
	LineHighlighter.clear();
}
