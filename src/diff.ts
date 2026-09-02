// Line-diffing engine (LCS-based), grouped into reviewable hunks.
// ROUND 2: deleted the old header comments above and rewrote them here, so this
// hunk removes several lines and adds several — a mixed change with ghost text.

export interface Hunk {
	id: number;
	// 0-based line indices into the BASELINE (original) text.
	origStart: number;
	origEnd: number; // exclusive
	// 0-based line indices into the CURRENT document text.
	curStart: number;
	curEnd: number; // exclusive
	origLines: string[];
	curLines: string[];
}

function splitLines(text: string): string[] {
	// Normalize CRLF so the diff is content-based, not line-ending-based.
	if (text === '') { return []; }
	return text.replace(/\r\n/g, '\n').split('\n');
}

type Op = { t: 'eq' | 'del' | 'ins'; };

// Classic LCS over lines, then backtrack into an ordered op list.
function lcsOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	// dp[i][j] = LCS length of a[i..], b[j..]
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ t: 'eq' });
			i++; j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ t: 'del' });
			i++;
		} else {
			ops.push({ t: 'ins' });
			j++;
		}
	}
	while (i < n) { ops.push({ t: 'del' }); i++; }
	while (j < m) { ops.push({ t: 'ins' }); j++; }
	return ops;
}

export function computeHunks(baseline: string, current: string): Hunk[] {
	const a = splitLines(baseline);
	const b = splitLines(current);
	const ops = lcsOps(a, b);

	const hunks: Hunk[] = [];
	let ai = 0; // index into baseline lines
	let bi = 0; // index into current lines
	let id = 0;

	let i = 0;
	while (i < ops.length) {
		if (ops[i].t === 'eq') {
			ai++; bi++; i++;
			continue;
		}
		// Start of a change run: collect consecutive del/ins.
		const origStart = ai;
		const origLines: string[] = [];
		const curLines: string[] = [];
		let curStart = bi;
		let curStartSet = false;
		while (i < ops.length && ops[i].t !== 'eq') {
			if (ops[i].t === 'del') {
				origLines.push(a[ai]);
				ai++;
			} else {
				if (!curStartSet) { curStart = bi; curStartSet = true; }
				curLines.push(b[bi]);
				bi++;
			}
			i++;
		}
		if (!curStartSet) { curStart = bi; } // pure deletion: anchor at current position
		hunks.push({
			id: id++,
			origStart,
			origEnd: ai,
			curStart,
			curEnd: curStart + curLines.length,
			origLines,
			curLines,
		});
	}
	return hunks;
}

// Apply an "accept" to the baseline: the given hunk's baseline region becomes
// the current lines, so the hunk disappears on the next recompute.
export function acceptIntoBaseline(baseline: string, hunk: Hunk): string {
	const a = splitLines(baseline);
	const next = a.slice(0, hunk.origStart).concat(hunk.curLines, a.slice(hunk.origEnd));
	return next.join('\n');
}

// Produce the document text that results from "rejecting" the given hunk:
// the current region is replaced by the baseline's original lines.
export function rejectInCurrent(current: string, hunk: Hunk): string {
	const b = splitLines(current);
	const next = b.slice(0, hunk.curStart).concat(hunk.origLines, b.slice(hunk.curEnd));
	return next.join('\n');
}
