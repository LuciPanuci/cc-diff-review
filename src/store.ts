import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ROUND 2: removed the old MULTI-FILE TEST line above, and rewrote this block —
// a snapshot holds the baseline (pre-edit) content of a file, keyed on disk by
// sha1 of its absolute path. The PreToolUse hook writes this exact shape.

export interface Snapshot {
	path: string;      // absolute file path this baseline belongs to
	original: string;  // baseline content
	ts: number;
}

export function snapshotsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.ccdiffs', 'snapshots');
}

export function keyForPath(absPath: string): string {
	return crypto.createHash('sha1').update(absPath).digest('hex');
}

function fileForPath(workspaceRoot: string, absPath: string): string {
	return path.join(snapshotsDir(workspaceRoot), keyForPath(absPath) + '.json');
}

export function readSnapshot(workspaceRoot: string, absPath: string): Snapshot | undefined {
	const f = fileForPath(workspaceRoot, absPath);
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8')) as Snapshot;
	} catch {
		return undefined;
	}
}

export function readSnapshotFile(file: string): Snapshot | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
	} catch {
		return undefined;
	}
}

export function writeSnapshot(workspaceRoot: string, snap: Snapshot): void {
	const dir = snapshotsDir(workspaceRoot);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(fileForPath(workspaceRoot, snap.path), JSON.stringify(snap), 'utf8');
}

// Update just the baseline (used on "accept", which folds a change into it).
export function updateBaseline(workspaceRoot: string, absPath: string, original: string): void {
	const existing = readSnapshot(workspaceRoot, absPath);
	writeSnapshot(workspaceRoot, {
		path: absPath,
		original,
		ts: existing?.ts ?? Date.now(),
	});
}

export function deleteSnapshot(workspaceRoot: string, absPath: string): void {
	try { fs.unlinkSync(fileForPath(workspaceRoot, absPath)); } catch { /* already gone */ }
}

export function listSnapshotPaths(workspaceRoot: string): string[] {
	const dir = snapshotsDir(workspaceRoot);
	let files: string[];
	try { files = fs.readdirSync(dir); } catch { return []; }
	const out: string[] = [];
	for (const f of files) {
		if (!f.endsWith('.json')) { continue; }
		const snap = readSnapshotFile(path.join(dir, f));
		if (snap) { out.push(snap.path); }
	}
	return out;
}
