import * as vscode from 'vscode';
import * as perfInfo from './perfInfo';

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

interface NavigateMessage { type: 'navigate'; file: string; linenr: number; }
interface SelectEventMessage { type: 'selectEvent'; event: string; }
type WebviewMessage = NavigateMessage | SelectEventMessage;

// Webview panel that renders the currently loaded profiling data as an
// interactive icicle-style flame graph. Clicking a frame with a resolved
// source location navigates the editor to that line. See
// docs/SRS-flame-graph-panel.md for the full specification.
export class FlameGraphPanel {
	public static currentPanel: FlameGraphPanel | undefined;
	private static onEventSelected: ((event: string) => void) | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	public static createOrShow(): void {
		const column = vscode.window.activeTextEditor?.viewColumn;

		if (FlameGraphPanel.currentPanel) {
			FlameGraphPanel.currentPanel.panel.reveal(column);
			FlameGraphPanel.currentPanel.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'perfannoFlameGraph',
			'Perfanno: Flame Graph',
			column ?? vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		FlameGraphPanel.currentPanel = new FlameGraphPanel(panel);
	}

	// Called from extension.ts whenever perf data is (re)loaded so the panel
	// stays in sync without needing to be reopened.
	public static refreshIfVisible(): void {
		FlameGraphPanel.currentPanel?.refresh();
	}

	// Lets extension.ts hook the panel's in-webview event dropdown into the
	// same selectEvent + reannotate flow used by perfanno.pickEvent, without
	// FlameGraphPanel needing to import extension.ts (would be circular).
	public static setEventSelectedHandler(handler: (event: string) => void): void {
		FlameGraphPanel.onEventSelected = handler;
	}

	private constructor(panel: vscode.WebviewPanel) {
		this.panel = panel;
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => this.handleMessage(message),
			null,
			this.disposables
		);
		this.refresh();
	}

	private handleMessage(message: WebviewMessage): void {
		switch (message.type) {
			case 'navigate':
				void this.navigateToFrame(message.file, message.linenr);
				break;
			case 'selectEvent':
				FlameGraphPanel.onEventSelected?.(message.event);
				break;
		}
	}

	private async navigateToFrame(file: string, linenr: number): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(file);
			const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
			const line = Math.max(0, linenr - 1);
			const position = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		} catch (e) {
			vscode.window.showErrorMessage(`Perfanno: could not open ${file}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	public refresh(): void {
		try {
			this.panel.webview.html = this.render();
		} catch (e) {
			vscode.window.showErrorMessage(`Perfanno: failed to render flame graph: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private render(): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

		if (!perfInfo.isLoaded()) {
			return this.shell(csp, nonce, '<div class="empty">No perf data loaded. Load a report, then reopen this panel.</div>');
		}

		const currentEvent = perfInfo.getCurrentEvent();
		const root = perfInfo.getFlameGraph(currentEvent);
		if (!root || root.children.length === 0) {
			return this.shell(csp, nonce, '<div class="empty">No call stacks found for the selected event.</div>');
		}

		const events = perfInfo.getEvents();
		const color = (perfInfo.getConfig('highlightColor') as [number, number, number] | undefined) ?? [255, 0, 0];

		const payload = { root, color };
		const json = JSON.stringify(payload).replace(/</g, '\\u003c');

		const header = `
			<strong>Flame Graph</strong>
			${this.renderEventSelect(events, currentEvent)}
			<span class="stat">${root.count.toLocaleString()} samples</span>
		`;

		const body = `
			<header>${header}</header>
			<div id="scroll"><div id="flamegraph"></div></div>
			<div id="tooltip"></div>
			<script nonce="${nonce}">
				const flameData = ${json};
				${this.clientScript()}
			</script>
		`;

		return this.shell(csp, nonce, body);
	}

	private renderEventSelect(events: string[], currentEvent: string): string {
		if (events.length <= 1) {
			return '';
		}
		const options = events
			.map(e => `<option value="${escapeHtml(e)}"${e === currentEvent ? ' selected' : ''}>${escapeHtml(e)}</option>`)
			.join('');
		return `<select id="event-select">${options}</select>`;
	}

	private shell(csp: string, nonce: string, bodyHtml: string): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Perfanno Flame Graph</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-editor-foreground);
		background: var(--vscode-editor-background);
		margin: 0;
		padding: 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--vscode-panel-border);
		position: sticky;
		top: 0;
		background: var(--vscode-editor-background);
	}
	header .stat { opacity: 0.75; font-size: 0.85em; margin-left: auto; }
	select {
		background: var(--vscode-dropdown-background);
		color: var(--vscode-dropdown-foreground);
		border: 1px solid var(--vscode-dropdown-border, transparent);
		padding: 2px 4px;
	}
	#scroll { overflow: auto; height: calc(100vh - 38px); }
	#flamegraph { position: relative; width: 100%; }
	.frame {
		position: absolute;
		border: 1px solid var(--vscode-editor-background);
		font-size: 11px;
		line-height: 19px;
		height: 19px;
		padding: 0 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: #fff;
		text-shadow: 0 0 2px rgba(0, 0, 0, 0.85);
		cursor: default;
	}
	.frame.clickable { cursor: pointer; }
	.frame.clickable:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	#tooltip {
		position: fixed;
		display: none;
		pointer-events: none;
		background: var(--vscode-editorHoverWidget-background);
		color: var(--vscode-editorHoverWidget-foreground);
		border: 1px solid var(--vscode-editorHoverWidget-border, transparent);
		padding: 6px 8px;
		font-size: 12px;
		border-radius: 3px;
		max-width: 480px;
		z-index: 10;
	}
	.tooltip-title { font-weight: 600; margin-bottom: 2px; word-break: break-all; }
	.tooltip-loc { opacity: 0.85; word-break: break-all; margin-bottom: 2px; }
	.empty { padding: 24px; opacity: 0.75; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
	}

	// Returned as a raw string (rather than a separate .js file) so it can be
	// inlined under the nonce-scoped CSP without a webview localResourceRoots
	// setup; kept as plain, dependency-free DOM code.
	private clientScript(): string {
		return `
(function () {
	const vscode = acquireVsCodeApi();
	const ROW_HEIGHT = 20;
	const MIN_WIDTH_FRACTION = 0.0015; // prunes sub-pixel frames; bounds DOM size (NFR-2)

	const container = document.getElementById('flamegraph');
	const tooltip = document.getElementById('tooltip');
	const eventSelect = document.getElementById('event-select');

	function frameColor(count, total) {
		const [r, g, b] = flameData.color;
		const frac = total > 0 ? count / total : 0;
		const alpha = 0.15 + 0.65 * Math.min(1, frac);
		return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
	}

	function pct(count, total) {
		return total > 0 ? (count / total * 100).toFixed(2) : '0.00';
	}

	function showTooltip(evt, node, total) {
		tooltip.innerHTML = '';

		const title = document.createElement('div');
		title.className = 'tooltip-title';
		title.textContent = node.label;
		tooltip.appendChild(title);

		const loc = document.createElement('div');
		loc.className = 'tooltip-loc';
		loc.textContent = node.file ? (node.file + ':' + node.linenr) : 'no source location';
		tooltip.appendChild(loc);

		const stats = document.createElement('div');
		stats.textContent = node.count.toLocaleString() + ' samples (' + pct(node.count, total) + '%)';
		tooltip.appendChild(stats);

		tooltip.style.display = 'block';
		positionTooltip(evt);
	}

	function positionTooltip(evt) {
		tooltip.style.left = (evt.clientX + 12) + 'px';
		tooltip.style.top = (evt.clientY + 12) + 'px';
	}

	function hideTooltip() {
		tooltip.style.display = 'none';
	}

	let maxDepth = 0;

	function layout(node, x0, x1, depth, total) {
		if (depth > 0) {
			maxDepth = Math.max(maxDepth, depth);

			const el = document.createElement('div');
			el.className = 'frame';
			el.style.left = (x0 * 100) + '%';
			el.style.width = ((x1 - x0) * 100) + '%';
			el.style.top = ((depth - 1) * ROW_HEIGHT) + 'px';
			el.style.backgroundColor = frameColor(node.count, total);
			el.textContent = node.label;

			if (node.file) {
				el.classList.add('clickable');
				el.addEventListener('click', function () {
					vscode.postMessage({ type: 'navigate', file: node.file, linenr: node.linenr });
				});
			}

			el.addEventListener('mouseenter', function (evt) { showTooltip(evt, node, total); });
			el.addEventListener('mousemove', positionTooltip);
			el.addEventListener('mouseleave', hideTooltip);

			container.appendChild(el);
		}

		if (node.count <= 0 || node.children.length === 0) {
			return;
		}

		let childX = x0;
		for (const child of node.children) {
			const width = (x1 - x0) * (child.count / node.count);
			if (width >= MIN_WIDTH_FRACTION) {
				layout(child, childX, childX + width, depth + 1, total);
			}
			childX += width;
		}
	}

	function render() {
		container.innerHTML = '';
		maxDepth = 0;
		layout(flameData.root, 0, 1, 0, flameData.root.count);
		container.style.height = (Math.max(maxDepth, 1) * ROW_HEIGHT) + 'px';
	}

	if (eventSelect) {
		eventSelect.addEventListener('change', function () {
			vscode.postMessage({ type: 'selectEvent', event: eventSelect.value });
		});
	}

	render();
})();
`;
	}

	public dispose(): void {
		FlameGraphPanel.currentPanel = undefined;
		this.panel.dispose();
		while (this.disposables.length) {
			const d = this.disposables.pop();
			d?.dispose();
		}
	}
}
