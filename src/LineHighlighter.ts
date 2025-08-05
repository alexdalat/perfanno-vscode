import { get } from 'http';
import * as vscode from 'vscode';

export namespace LineHighlighter {

	interface HighlightInfo {
		range: vscode.Range;
		decorationType: vscode.TextEditorDecorationType;
	}

	const highlightsStore: Map<string, HighlightInfo[]> = new Map();

	// Apply stored highlights when a text editor is activated
	export function applyHighlights(editor: vscode.TextEditor): void {
		const uri = editor.document.uri.fsPath.replaceAll("\\", "\\");
		const highlights = highlightsStore.get(uri);
		if (highlights) {
			highlights.forEach(highlight => {
				editor.setDecorations(highlight.decorationType, [highlight.range]);
			});
		}
	}

	export function applyMultiHighlights(editors: vscode.TextEditor[]): void {
		editors.forEach(editor => {
			applyHighlights(editor);
		});
	}

	function getDecoration(add_opts?: {} | undefined): vscode.TextEditorDecorationType {
		let opts:any = {
			backgroundColor: 'rgba(255, 255, 255, 0.3)',
			isWholeLine: true,
		};
		opts = { ...opts, ...add_opts};
		return vscode.window.createTextEditorDecorationType(opts);
	}

	// Function to highlight a single line with transparency
	export function highlightLineEditor(editor: vscode.TextEditor, line: number, add_opts?: {}|undefined): void {
		const decorationType = getDecoration(add_opts);

		const range = new vscode.Range(line, 0, line, 0);
		editor.setDecorations(decorationType, [range]);

		// Store decoration type for later access
		const uri = editor.document.uri;
		const existingHighlights = highlightsStore.get(uri.fsPath) || [];
		existingHighlights.push({ range, decorationType });
		highlightsStore.set(uri.fsPath, existingHighlights);
	}

	// Function to highlight a single line with transparency in a specific document
	export function highlightLine(uriPath:string, line: number, add_opts?: {}|undefined): void {
		const decorationType = getDecoration(add_opts);
		const range = new vscode.Range(line, 0, line, 0);

		const existingHighlights = highlightsStore.get(uriPath) || [];
		existingHighlights.push({ range, decorationType });
		highlightsStore.set(uriPath, existingHighlights);
	}

	// Clean up highlights on extension deactivation
	export function clear(): void {
		highlightsStore.forEach(highlights => {
			highlights.forEach(highlight => {
				highlight.decorationType.dispose();
			});
		});
		highlightsStore.clear();
	}
}
