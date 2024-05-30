import * as vscode from 'vscode';
import * as perfInfo from './perfInfo';
import { LineHighlighter } from './LineHighlighter';

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

function syncConfig() {
	perfInfo.setConfig('eventOutputType', vscode.workspace.getConfiguration('perfanno').get('eventOutputType', "percentage"));
	perfInfo.setConfig('hcolor', hexToRgb(vscode.workspace.getConfiguration('perfanno').get('highlightColor', "#FF0000")));
	perfInfo.setConfig('minThreshold', vscode.workspace.getConfiguration('perfanno').get('minimumThreshold', 0));
}

function reannotate() {
	syncConfig();
	LineHighlighter.clear();  // clears annotations
	perfInfo.addAnnotations();  // stores annotations in LineHighlighter
	LineHighlighter.applyMultiHighlights(getAllActiveBuffers());  // draw annotations on active tabs
}

export function activate(context: vscode.ExtensionContext) {

	// when changing text editor, apply highlights
	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			LineHighlighter.applyHighlights(editor);
		}
	}, null, context.subscriptions);

	// when changing configuration, reapply highlights
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		let affected = event.affectsConfiguration("perfanno.eventOutputType") || event.affectsConfiguration("perfanno.highlightColor") || event.affectsConfiguration("perfanno.minimumThreshold");
		if (affected) {
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


	context.subscriptions.push(vscode.commands.registerCommand('perfanno.readFile', () => {
		vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Select perf.out file' }).then((uris) => {
			if (uris === undefined) {
				vscode.window.showErrorMessage('No file selected');
				return;
			}
			const fileStr = uris[0].fsPath;
			const totalCount = perfInfo.loadTraces(perfInfo.perfCallgraphFile(fileStr));

			reannotate();

			vscode.window.showInformationMessage(`Loaded ${totalCount} traces from ${fileStr}`);
		});
	}));


	context.subscriptions.push(vscode.commands.registerCommand('perfanno.clearHighlights', () => {
		LineHighlighter.clear();
		vscode.window.showInformationMessage('Perfanno highlights cleared');
	}));
}

export function deactivate() {
	LineHighlighter.clear();
}
