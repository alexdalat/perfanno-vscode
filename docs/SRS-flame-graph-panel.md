# Software Requirements Specification

## Flame Graph Visualizer Panel

**Project:** perfanno-vscode
**Component:** `perfanno.showFlameGraph`
**Status:** Draft → Implemented (v1)
**Date:** 2026-08-12

---

## 1. Introduction

### 1.1 Purpose

Perfanno currently exposes profiling data (from `perf` and `py-spy`) only as
per-line heatmap annotations in the active editor, plus two "go to hottest
line" commands. There is no way to see the *shape* of the call stacks that
produced those counts. This document specifies a **flame graph visualizer
panel**: a webview that renders the aggregated call stacks as an interactive
icicle-style flame graph, where clicking a frame jumps the editor to the
source line that frame represents.

### 1.2 Scope

In scope for v1:

- A VS Code webview panel, opened via a command, that renders a flame graph
  for the currently selected profiling event.
- Click-to-navigate: clicking a frame with known source location opens that
  file and moves the cursor/viewport to the line.
- Hover tooltip with symbol, file:line, sample count, and percentage.
- An in-panel event selector when more than one profiling event is loaded,
  kept in sync with the event used for editor annotations.
- Automatic refresh when perf/py-spy data is (re)loaded, the auto-reload
  watcher fires, or the user changes the selected event (from the panel or
  from the existing `perfanno.pickEvent` command).
- Empty/loading state when no data is loaded yet.
- Theme-aware styling (light/dark/high-contrast) using VS Code CSS variables.

Out of scope for v1 (noted as future work):

- Zoom-to-subtree / breadcrumb navigation.
- Search/highlight-by-symbol-name.
- Differential flame graphs (comparing two profiles).
- Exporting the graph as an image/SVG file.
- Multi-root workspace support beyond `workspaceFolders[0]` (matches the
  existing limitation of the rest of the extension).
- Virtualized rendering for extremely large graphs beyond the width-based
  pruning described in NFR-2.

### 1.3 Definitions

| Term | Meaning |
|---|---|
| Frame | One entry in a stack trace: a symbol plus, optionally, a resolved source file and line number. |
| Flame graph / icicle graph | A visualization where each row is a stack depth, each box is a frame, box width is proportional to sample count, and children are stacked directly below their parent, left-aligned within the parent's span. |
| Event | A profiling counter/event (e.g. `cycles:P`, `cpu_cycles`) — perf/py-spy reports can contain more than one. |
| Root | A synthetic node representing "all samples"; its direct children are the outermost stack frames (e.g. `_start`, `main`). |

### 1.4 Existing system context

Relevant existing pieces this feature builds on (`src/perfInfo.ts`,
`src/extension.ts`, `src/LineHighlighter.ts`):

- `perfInfo.loadTraces(PerfData)` parses raw traces per event and builds
  `M.callgraphs[event]`, currently containing `nodeInfo`, `symbols`,
  `totalCount`, `maxCount`.
- Traces are ordered **root-first, leaf-last** (`frames[0]` is the outermost
  caller, `frames[frames.length - 1]` is the sampled leaf) — confirmed from
  `perf report -g folded,0,caller,...` output.
- `perfInfo.frame_unpack(frame)` resolves a frame into
  `[symbol, file, linenrOrText]`; when no source location is resolvable,
  `file === 'symbol'` and the third element is the raw symbol text instead of
  a line number.
- `extension.ts#reannotate()` is the single choke point already called after
  every load, reload, config change, and event switch — the natural place to
  trigger a panel refresh.
- `extension.ts#goToHottestLine()` already implements "open file, move
  cursor, reveal in center" — the flame graph's click-to-navigate behavior
  reuses the same approach.

---

## 2. Overall description

### 2.1 User-facing entry points

- Command palette: **"Perfanno: Show Flame Graph"** (`perfanno.showFlameGraph`).
- Opening the command when a panel already exists reveals the existing panel
  instead of creating a second one (singleton).

### 2.2 User interaction flow

1. User loads a perf/py-spy report (existing commands/auto-load).
2. User runs **"Perfanno: Show Flame Graph"**.
3. Panel opens beside the active editor showing the flame graph for the
   currently selected event, root frames on top, deeper frames below.
4. User hovers a frame → tooltip shows full symbol, file:line (or
   "no source location" for library/kernel frames), sample count, and
   percentage of total samples.
5. User clicks a frame that has a resolved file/line → the corresponding
   file opens (or is focused) in the editor group beside the panel, cursor
   moves to that line, and the line is revealed centered — mirroring
   `perfanno.goToHottestLineInFile`.
6. User clicks a frame with no resolved source location → nothing happens
   (cursor shows `default`, not `pointer`, on such frames).
7. If multiple events are loaded, the user can switch events from a
   dropdown in the panel header; this updates both the flame graph and the
   editor's line annotations (equivalent to `perfanno.pickEvent`).
8. If the user reloads perf data (manually or via auto-reload) while the
   panel is open, the panel updates automatically without needing to be
   reopened.

### 2.3 Constraints

- Must work fully offline / air-gapped: no CDN or remote resources (VS Code
  webview CSP forbids this anyway).
- Must respect the existing single-workspace-folder assumption used
  elsewhere in the codebase.
- Must not block the UI thread on large graphs (NFR-2).

---

## 3. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | The extension SHALL register a command `perfanno.showFlameGraph` that opens a flame graph webview panel, creating it if it does not exist and revealing it otherwise (singleton). |
| FR-2 | The panel SHALL render the call-stack tree for the currently selected profiling event as an icicle graph: rows = stack depth, box width ∝ sample count, children left-aligned and stacked directly under their parent's span. |
| FR-3 | Each frame box SHALL display a truncated label (symbol name, or `file:line` when no symbol is available) that fits the box width, without wrapping or overflowing into neighboring boxes. |
| FR-4 | Hovering a frame SHALL show a tooltip containing: full symbol/label, source file and line (if resolved) or an explicit "no source location" indicator, absolute sample count, and percentage of the event's total sample count. |
| FR-5 | Clicking a frame that has a resolved source file and line SHALL open that file in the editor (reusing an already-open editor if the file is already open) and move the selection/viewport to that line, centered, exactly as `perfanno.goToHottestLineInFile` does. |
| FR-6 | Clicking a frame with no resolved source file/line SHALL be a no-op and SHALL be visually distinguished (non-pointer cursor) from clickable frames. |
| FR-7 | If the loaded data contains more than one profiling event, the panel SHALL show a dropdown of event names; selecting one SHALL call the same underlying `perfInfo.selectEvent` + re-annotate logic used by `perfanno.pickEvent`, then re-render the flame graph for that event. |
| FR-8 | The panel SHALL refresh automatically whenever `reannotate()` runs (i.e., after `perfanno.readFile`, `perfanno.readPySpyFile`, `perfanno.autoLoadPerfData`, auto-reload-on-file-change, `perfanno.pickEvent`, or a relevant configuration change), without requiring the user to reopen it. |
| FR-9 | If no perf data is loaded when the panel is opened (or becomes unloaded), the panel SHALL show an explanatory empty state instead of an empty/blank graph. |
| FR-10 | Frame background color SHALL scale with the frame's sample count (heat), using the user's configured `perfanno.highlightColor` so the panel's palette matches the editor heatmap. |
| FR-11 | The panel title and icon SHALL identify it as belonging to Perfanno (e.g. title `Perfanno: Flame Graph`). |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | The panel SHALL use only VS Code theme CSS variables for chrome (background, foreground, borders, dropdown) so it adapts automatically to light, dark, and high-contrast themes. |
| NFR-2 | Rendering SHALL remain responsive for graphs with tens of thousands of aggregated frames. The renderer prunes recursion into any subtree whose width would fall below a minimum visible fraction of the panel, bounding the number of DOM nodes created (standard flame-graph practice). |
| NFR-3 | The panel SHALL NOT load any remote/CDN resource; all HTML/CSS/JS is inlined and served under a nonce-scoped CSP, consistent with VS Code webview security guidance. |
| NFR-4 | Building the flame tree from a loaded report SHALL be O(total frames across all traces) — the same order of work already done by `processTraces` for line annotations — so opening the panel does not introduce a new asymptotic cost. |
| NFR-5 | The feature SHALL degrade gracefully: parse/build errors surface as a `vscode.window.showErrorMessage`, matching the error handling style already used by `reannotate()`. |

## 5. Data design

`perfInfo.ts` gains a per-event flame tree, built once when traces are
loaded (same lifecycle as `nodeInfo`/`symbols`):

```ts
export interface FlameNode {
  label: string;      // symbol name, or "file:line" / raw text when no symbol
  file?: string;       // resolved source file, absent for unresolved frames
  linenr?: number;      // 1-based line number, present iff `file` is present
  count: number;         // aggregated sample count for this call path
  children: FlameNode[]; // sorted by count, descending
}

export function buildFlameGraph(traces: TraceData[]): FlameNode;
export function getFlameGraph(event?: string): FlameNode | undefined;
```

The tree is built by walking each trace's frames root-to-leaf and merging
identical `(file, linenr)` (or raw label, for unresolved frames) children at
each level — the standard flame-graph aggregation algorithm. `root.count`
equals the event's `totalCount`, so no separate total needs to be threaded
through.

## 6. Interaction contract (extension ↔ webview)

The extension owns all state; the webview is a pure renderer plus input
capture. On every refresh the extension regenerates the panel's full HTML
(data embedded inline) rather than diff-patching over `postMessage` — this
trades a full webview reload on refresh (infrequent: data load / event
switch) for eliminating "webview script not ready yet" race conditions,
which was judged the better trade-off for v1's complexity budget.

Webview → extension messages:

| type | payload | effect |
|---|---|---|
| `navigate` | `{ file: string, linenr: number }` | Extension opens `file`, moves cursor to `linenr`, reveals it centered. |
| `selectEvent` | `{ event: string }` | Extension calls `perfInfo.selectEvent`, re-annotates, and refreshes the panel. |

## 7. Acceptance criteria

- AC-1: With `perf.out` loaded, running "Perfanno: Show Flame Graph" opens a
  panel showing a non-empty graph whose top-level boxes match the roots seen
  in the raw report.
- AC-2: Clicking a box for a frame with a known `main.cpp:NN` location opens
  `main.cpp` with the cursor on line `NN`.
- AC-3: Clicking a kernel/library box with no resolved file does nothing and
  shows a non-pointer cursor on hover.
- AC-4: Running `perfanno.pickEvent` (or the panel's own dropdown) changes
  which event's graph is displayed, and both stay in sync.
- AC-5: Reloading `perf.data` (auto-reload) while the panel is open updates
  it without user action.
- AC-6: Opening the command with no data loaded shows an empty state, not an
  error or a blank panel.
