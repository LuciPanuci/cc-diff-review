import * as vscode from 'vscode';
import * as fs from 'fs';
import {
	computeHunks, acceptIntoBaseline, rejectInCurrent, Hunk,
} from './diff';
import {
	readSnapshot, updateBaseline, deleteSnapshot, writeSnapshot, listSnapshotPaths,
} from './store';

// Virtual scheme used to feed the baseline (pre-edit) content into VS Code's
// native diff editor. The real file's absolute path rides in the URI's `query`.
const BASELINE_SCHEME = 'ccdiffs-baseline';

// Where the heart button and the Marketplace "Sponsor" link point. Keep this in
// sync with the `sponsor.url` field in package.json.
const DONATE_URL = 'https://ko-fi.com/lucipanuci';

function baselineUri(fsPath: string): vscode.Uri {
	return vscode.Uri.parse(`${BASELINE_SCHEME}:${fsPath}`).with({ query: fsPath });
}

// fsPath -> current hunks (baseline lives on disk in the snapshot store).
const stateByPath = new Map<string, Hunk[]>();

// Paths that currently have a snapshot on disk. Kept in sync by refreshAll so
// onDidChangeTextDocument can cheaply decide whether a keystroke is worth a
// re-diff without hitting disk on every change.
const snapshotPaths = new Set<string>();

// Paths whose snapshot has shown at least one hunk since it appeared. A snapshot
// is only auto-deleted once it has been *reconciled* down to zero (accept/reject,
// or a manual revert) — never on its first recompute, when the edit that the
// PreToolUse hook is racing may not have landed yet.
const seenHunks = new Set<string>();

let addedDeco: vscode.TextEditorDecorationType;
let deletedDeco: vscode.TextEditorDecorationType;
// Red seam drawn at the top of a *mixed* hunk (lines removed AND added) — the
// added lines are already green, so this marks that content was also removed
// there. No gutter icon, to avoid clashing with the green add icon.
let removedSeamDeco: vscode.TextEditorDecorationType;
let statusItem: vscode.StatusBarItem;
const codeLensChanged = new vscode.EventEmitter<void>();
const baselineChanged = new vscode.EventEmitter<vscode.Uri>();
const recomputeTimers = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext) {
	const icon = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'media', name);
	addedDeco = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		gutterIconPath: icon('gutter-added.svg'),
		gutterIconSize: 'contain',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full,
	});
	deletedDeco = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderWidth: '2px 0 0 0',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		gutterIconPath: icon('gutter-deleted.svg'),
		gutterIconSize: 'contain',
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full,
	});
	removedSeamDeco = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderWidth: '2px 0 0 0',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusItem.command = 'ccdiffs.openDiff';
	context.subscriptions.push(addedDeco, deletedDeco, removedSeamDeco, statusItem);

	// CodeLens: Accept / Reject buttons per hunk, plus file-level Accept/Reject all.
	const lensProvider: vscode.CodeLensProvider = {
		onDidChangeCodeLenses: codeLensChanged.event,
		provideCodeLenses(document) {
			const hunks = stateByPath.get(document.uri.fsPath);
			if (!hunks || hunks.length === 0) { return []; }
			const uri = document.uri.toString();
			const lastLine = Math.max(0, document.lineCount - 1);
			const lenses: vscode.CodeLens[] = [];

			const top = new vscode.Range(0, 0, 0, 0);
			lenses.push(new vscode.CodeLens(top, {
				title: '$(diff) Open diff',
				command: 'ccdiffs.openDiff',
				arguments: [],
			}));
			lenses.push(new vscode.CodeLens(top, {
				title: `$(check-all) Accept all (${hunks.length})`,
				command: 'ccdiffs.acceptAll',
				arguments: [uri],
			}));
			lenses.push(new vscode.CodeLens(top, {
				title: '$(discard) Reject all',
				command: 'ccdiffs.rejectAll',
				arguments: [uri],
			}));

			for (const h of hunks) {
				const line = Math.min(Math.max(0, h.curStart), lastLine);
				const range = new vscode.Range(line, 0, line, 0);
				const label = `−${h.origLines.length}/+${h.curLines.length}`;
				lenses.push(new vscode.CodeLens(range, {
					title: '$(check) Accept',
					command: 'ccdiffs.acceptHunk',
					arguments: [uri, h.id],
				}));
				lenses.push(new vscode.CodeLens(range, {
					title: '$(x) Reject',
					command: 'ccdiffs.rejectHunk',
					arguments: [uri, h.id],
				}));
				lenses.push(new vscode.CodeLens(range, {
					title: label,
					command: '',
					arguments: [],
				}));
			}
			return lenses;
		},
	};
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
	);

	// Serve the baseline (pre-edit) text so VS Code's native diff editor can show
	// a true side-by-side red/green comparison of baseline -> current.
	const baselineProvider: vscode.TextDocumentContentProvider = {
		onDidChange: baselineChanged.event,
		provideTextDocumentContent(uri) {
			const fsPath = uri.query;
			const root = rootFor(fsPath);
			if (!root) { return ''; }
			return readSnapshot(root, fsPath)?.original ?? '';
		},
	};
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, baselineProvider),
	);

	// Watch the snapshot store for new/updated baselines (written by the hook).
	const watcher = vscode.workspace.createFileSystemWatcher('**/.ccdiffs/snapshots/*.json');
	const refresh = debounce(refreshAll, 120);
	watcher.onDidCreate(refresh);
	watcher.onDidChange(refresh);
	watcher.onDidDelete(refresh);
	context.subscriptions.push(watcher);

	// Re-apply decorations when editors change.
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => renderVisible()),
		vscode.window.onDidChangeVisibleTextEditors(() => renderVisible()),
		vscode.workspace.onDidSaveTextDocument((doc) => {
			// A save may reflect CC's write landing; re-diff if we track this file.
			if (snapshotPaths.has(doc.uri.fsPath)) { scheduleRecompute(doc.uri.fsPath); }
		}),
		// Live-diff as the source file changes — CC editing an already-open file,
		// or a hand-edit during review. External disk writes reload the document
		// and fire this too, so decorations stay current without a save.
		vscode.workspace.onDidChangeTextDocument((e) => {
			const p = e.document.uri.fsPath;
			if (e.document.uri.scheme === 'file' && snapshotPaths.has(p)) {
				scheduleRecompute(p);
			}
		}),
	);

	// Commands.
	context.subscriptions.push(
		vscode.commands.registerCommand('ccdiffs.acceptHunk', (uri: string, hunkId: number) =>
			acceptHunk(vscode.Uri.parse(uri).fsPath, hunkId)),
		vscode.commands.registerCommand('ccdiffs.rejectHunk', (uri: string, hunkId: number) =>
			rejectHunk(vscode.Uri.parse(uri).fsPath, hunkId)),
		vscode.commands.registerCommand('ccdiffs.acceptAll', (arg?: string | vscode.Uri) => {
			const p = resolveFsPath(arg); if (p) { acceptAll(p); }
		}),
		vscode.commands.registerCommand('ccdiffs.rejectAll', (arg?: string | vscode.Uri) => {
			const p = resolveFsPath(arg); if (p) { rejectAll(p); }
		}),
		vscode.commands.registerCommand('ccdiffs.reviewCurrent', () => {
			const ed = vscode.window.activeTextEditor;
			if (ed) { recompute(ed.document.uri.fsPath); }
		}),
		vscode.commands.registerCommand('ccdiffs.snapshotCurrent', () => snapshotCurrent()),
		vscode.commands.registerCommand('ccdiffs.openDiff', () => openDiff()),
		vscode.commands.registerCommand('ccdiffs.donate', () =>
			vscode.env.openExternal(vscode.Uri.parse(DONATE_URL))),
		// Cursor-style keyboard flow: accept/reject the hunk under the cursor.
		vscode.commands.registerCommand('ccdiffs.acceptHunkAtCursor', () => hunkAtCursor(acceptHunk)),
		vscode.commands.registerCommand('ccdiffs.rejectHunkAtCursor', () => hunkAtCursor(rejectHunk)),
	);

	refreshAll();
}

export function deactivate() { /* decorations disposed via subscriptions */ }

// ---- core ----

// Commands may be invoked from a CodeLens (string uri), the editor title bar
// (a vscode.Uri), or a keybinding (nothing) — resolve all three to an fsPath.
function resolveFsPath(arg?: string | vscode.Uri): string | undefined {
	if (typeof arg === 'string') { return vscode.Uri.parse(arg).fsPath; }
	if (arg instanceof vscode.Uri) { return arg.fsPath; }
	return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function rootFor(fsPath: string): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
	if (folder) { return folder.uri.fsPath; }
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function currentText(fsPath: string): string | undefined {
	const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath);
	if (doc) { return doc.getText(); }
	try { return fs.readFileSync(fsPath, 'utf8'); } catch { return undefined; }
}

// Recompute hunks for one file from its on-disk baseline vs the current text.
function recompute(fsPath: string) {
	const root = rootFor(fsPath);
	if (!root) { return; }
	const snap = readSnapshot(root, fsPath);
	const cur = currentText(fsPath);
	if (!snap || cur === undefined) {
		stateByPath.delete(fsPath);
		renderVisible();
		codeLensChanged.fire();
		baselineChanged.fire(baselineUri(fsPath));
		return;
	}
	const hunks = computeHunks(snap.original, cur);
	if (hunks.length === 0) {
		stateByPath.delete(fsPath);
		if (seenHunks.has(fsPath)) {
			// Reconciled: had changes, now resolved — drop the baseline so the
			// file goes quiet, and close any diff we opened for it.
			deleteSnapshot(root, fsPath);
			snapshotPaths.delete(fsPath);
			seenHunks.delete(fsPath);
			void closeDiffFor(fsPath);
		}
		// Else: snapshot exists but no diff yet. The PreToolUse hook writes the
		// baseline *before* CC edits, so this is almost always the edit not having
		// landed — keep the snapshot and wait for the change to arrive.
	} else {
		seenHunks.add(fsPath);
		stateByPath.set(fsPath, hunks);
	}
	renderVisible();
	codeLensChanged.fire();
	baselineChanged.fire(baselineUri(fsPath));
}

function refreshAll() {
	const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
	const live = new Set<string>();
	for (const root of roots) {
		for (const p of listSnapshotPaths(root)) { live.add(p); }
	}
	// Sync the in-memory index of on-disk snapshots.
	snapshotPaths.clear();
	for (const p of live) { snapshotPaths.add(p); }
	// Drop state for files whose snapshot is gone.
	for (const known of [...stateByPath.keys()]) {
		if (!live.has(known)) { stateByPath.delete(known); }
	}
	for (const gone of [...seenHunks]) {
		if (!live.has(gone)) { seenHunks.delete(gone); }
	}
	for (const p of live) { recompute(p); }
	if (live.size === 0) { renderVisible(); codeLensChanged.fire(); }
}

function acceptHunk(fsPath: string, hunkId: number) {
	const root = rootFor(fsPath);
	if (!root) { return; }
	const snap = readSnapshot(root, fsPath);
	const hunks = stateByPath.get(fsPath);
	if (!snap || !hunks) { return; }
	const h = hunks.find(x => x.id === hunkId);
	if (!h) { return; }
	// Fold this change into the baseline; it stops being a diff.
	updateBaseline(root, fsPath, acceptIntoBaseline(snap.original, h));
	recompute(fsPath);
}

async function rejectHunk(fsPath: string, hunkId: number) {
	const hunks = stateByPath.get(fsPath);
	if (!hunks) { return; }
	const h = hunks.find(x => x.id === hunkId);
	if (!h) { return; }
	const cur = currentText(fsPath);
	if (cur === undefined) { return; }
	await applyFullText(fsPath, rejectInCurrent(cur, h));
	recompute(fsPath);
}

function acceptAll(fsPath: string) {
	const root = rootFor(fsPath);
	if (!root) { return; }
	// Accepting everything just means the current text becomes the baseline.
	deleteSnapshot(root, fsPath);
	stateByPath.delete(fsPath);
	snapshotPaths.delete(fsPath);
	seenHunks.delete(fsPath);
	renderVisible();
	codeLensChanged.fire();
	void closeDiffFor(fsPath);
}

async function rejectAll(fsPath: string) {
	const root = rootFor(fsPath);
	if (!root) { return; }
	const snap = readSnapshot(root, fsPath);
	if (!snap) { return; }
	await applyFullText(fsPath, snap.original);
	recompute(fsPath);
}

// Dev/testing loop with no hook or agent: snapshot the active file as baseline.
function snapshotCurrent() {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { return; }
	const fsPath = ed.document.uri.fsPath;
	const root = rootFor(fsPath);
	if (!root) { return; }
	writeSnapshot(root, { path: fsPath, original: ed.document.getText(), ts: Date.now() });
	snapshotPaths.add(fsPath);
	vscode.window.showInformationMessage('CC Diffs: baseline captured. Edit the file, then review.');
	recompute(fsPath);
}

// Open VS Code's native diff editor in stacked (unified) mode: removed lines in
// red directly above the added lines in green — the review layout, using VS
// Code's real diff engine (accurate intra-line highlights, syntax, big files).
async function openDiff() {
	const ed = vscode.window.activeTextEditor;
	if (!ed) {
		vscode.window.showWarningMessage('CC Diffs: open a file first.');
		return;
	}
	const fsPath = ed.document.uri.fsPath;
	const root = rootFor(fsPath);
	if (!root || !readSnapshot(root, fsPath)) {
		vscode.window.showInformationMessage('CC Diffs: no baseline for this file — nothing to diff.');
		return;
	}
	// Force the unified/inline layout so deleted lines stack above inserted ones.
	// (This is the diff editor's own setting; we only flip it if it isn't already.)
	const cfg = vscode.workspace.getConfiguration('diffEditor');
	if (cfg.get<boolean>('renderSideBySide') !== false) {
		await cfg.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);
	}
	const name = fsPath.split(/[\\/]/).pop() ?? fsPath;
	await vscode.commands.executeCommand(
		'vscode.diff',
		baselineUri(fsPath),
		vscode.Uri.file(fsPath),
		`${name} · deleted (red) above inserted (green)`,
	);
}

// ---- rendering ----

// Drives the `ccdiffs.hasChanges` when-clause, so the title-bar Accept-all /
// Reject-all buttons show only on the active file when it actually has changes.
function updateContext() {
	const fsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
	const has = !!fsPath && (stateByPath.get(fsPath)?.length ?? 0) > 0;
	vscode.commands.executeCommand('setContext', 'ccdiffs.hasChanges', has);

	// Status bar: pending hunks across all reviewed files, so you notice edits
	// landing in files you don't have open.
	let files = 0;
	let hunks = 0;
	for (const list of stateByPath.values()) {
		if (list.length > 0) { files++; hunks += list.length; }
	}
	if (hunks === 0) {
		statusItem.hide();
	} else {
		statusItem.text = `$(git-compare) ${hunks} change${hunks === 1 ? '' : 's'}` +
			(files > 1 ? ` · ${files} files` : '');
		statusItem.tooltip = 'CC Diffs: pending edits to review — click to open the diff';
		statusItem.show();
	}
}

function renderVisible() {
	updateContext();
	for (const editor of vscode.window.visibleTextEditors) {
		// Only real files carry snapshots; skip output/diff/other panes.
		if (editor.document.uri.scheme !== 'file') { continue; }
		const hunks = stateByPath.get(editor.document.uri.fsPath);
		if (!hunks || hunks.length === 0) {
			editor.setDecorations(addedDeco, []);
			editor.setDecorations(deletedDeco, []);
			editor.setDecorations(removedSeamDeco, []);
			continue;
		}
		const lastLine = Math.max(0, editor.document.lineCount - 1);
		const added: vscode.DecorationOptions[] = [];
		const deleted: vscode.DecorationOptions[] = [];
		const seams: vscode.DecorationOptions[] = [];
		for (const h of hunks) {
			// Hover shows the removed text; the full red/green view is a click away
			// on "Open diff".
			const removedHover = h.origLines.length
				? new vscode.MarkdownString(
					`**${h.origLines.length} line${h.origLines.length === 1 ? '' : 's'} removed** — ` +
					`_click “Open diff” to review_\n\`\`\`\n${h.origLines.join('\n')}\n\`\`\``)
				: undefined;
			const anchor = Math.min(Math.max(0, h.curStart), lastLine);
			if (h.curLines.length > 0) {
				const end = Math.min(h.curEnd - 1, lastLine);
				added.push({
					range: new vscode.Range(h.curStart, 0, Math.max(h.curStart, end), 0),
					hoverMessage: removedHover,
				});
				// Mixed hunk: mark that content was also removed here with a red seam.
				if (h.origLines.length > 0) {
					seams.push({ range: new vscode.Range(anchor, 0, anchor, 0), hoverMessage: removedHover });
				}
			} else {
				// Pure deletion — mark the seam where content used to be.
				deleted.push({ range: new vscode.Range(anchor, 0, anchor, 0), hoverMessage: removedHover });
			}
		}
		editor.setDecorations(addedDeco, added);
		editor.setDecorations(deletedDeco, deleted);
		editor.setDecorations(removedSeamDeco, seams);
	}
}

// ---- helpers ----

// Close any open "Open diff" tab for this file — used when the file is fully
// reconciled (all hunks accepted/rejected), so the review view tidies itself
// away instead of lingering with nothing left to compare.
async function closeDiffFor(fsPath: string) {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (input instanceof vscode.TabInputTextDiff
				&& input.original.scheme === BASELINE_SCHEME
				&& input.modified.fsPath === fsPath) {
				try { await vscode.window.tabGroups.close(tab); } catch { /* already gone */ }
			}
		}
	}
}

// Per-path debounce so a burst of keystrokes (or CC streaming edits) collapses
// into a single re-diff, without one file's edits delaying another's.
function scheduleRecompute(fsPath: string) {
	const existing = recomputeTimers.get(fsPath);
	if (existing) { clearTimeout(existing); }
	recomputeTimers.set(fsPath, setTimeout(() => {
		recomputeTimers.delete(fsPath);
		recompute(fsPath);
	}, 120));
}

// Resolve the hunk containing the active editor's cursor and run an action on it.
// Falls back to the first hunk in the file so a keypress anywhere still does
// something sensible when the cursor isn't parked on a change.
function hunkAtCursor(action: (fsPath: string, hunkId: number) => void) {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { return; }
	const fsPath = ed.document.uri.fsPath;
	const hunks = stateByPath.get(fsPath);
	if (!hunks || hunks.length === 0) { return; }
	const line = ed.selection.active.line;
	const hit = hunks.find(h => line >= h.curStart && line < Math.max(h.curEnd, h.curStart + 1));
	action(fsPath, (hit ?? hunks[0]).id);
}

async function applyFullText(fsPath: string, newText: string) {
	const uri = vscode.Uri.file(fsPath);
	const doc = await vscode.workspace.openTextDocument(uri);
	const full = new vscode.Range(0, 0, doc.lineCount, 0);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(uri, full, newText);
	await vscode.workspace.applyEdit(edit);
	await doc.save();
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
	let timer: NodeJS.Timeout | undefined;
	return ((...args: never[]) => {
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => fn(...args), ms);
	}) as T;
}
