#!/usr/bin/env node
// Claude Code PreToolUse hook.
// Before CC edits a file, save its current (pre-edit) content as a baseline so
// the extension can show a persistent diff afterward. First touch wins, so the
// baseline survives a whole batch of edits until you accept/reject in the UI.
// It always exits 0 (allow) — it never blocks or gates the edit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readStdin() {
	try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
	let payload;
	try { payload = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

	const tool = payload.tool_name || '';
	if (!/^(Edit|Write|MultiEdit)$/.test(tool)) { process.exit(0); }

	const input = payload.tool_input || {};
	let file = input.file_path;
	if (!file) { process.exit(0); }

	const root = payload.cwd || process.cwd();
	if (!path.isAbsolute(file)) { file = path.resolve(root, file); }

	const dir = path.join(root, '.ccdiffs', 'snapshots');
	const key = crypto.createHash('sha1').update(file).digest('hex');
	const snapFile = path.join(dir, key + '.json');

	// First touch wins: keep the original baseline across a batch of edits.
	if (fs.existsSync(snapFile)) { process.exit(0); }

	let original = '';
	try { original = fs.readFileSync(file, 'utf8'); } catch { original = ''; }

	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(snapFile, JSON.stringify({ path: file, original, ts: Date.now() }), 'utf8');
	} catch { /* best-effort; never block the edit */ }

	process.exit(0);
}

main();
