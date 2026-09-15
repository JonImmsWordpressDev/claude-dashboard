'use strict';
// Line diff with no dependencies: Myers O(ND) shortest edit script, then
// unified hunks. Inputs are capped so a pasted vendor bundle can't stall the
// server; beyond maxChanges the result is a truncated replacement block.

const DEFAULTS = { context: 3, maxChanges: 2000, maxBytes: 400 * 1024 };

function splitLines(s) {
  const lines = String(s).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  return lines;
}

// Shortest edit script as ops: [' ', aIdx, bIdx] | ['-', aIdx] | ['+', bIdx].
// Returns null when the edit distance exceeds maxD.
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const v = new Int32Array(2 * max + 3); // index k + max + 1
  const off = max + 1;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    // Keep only the band this step reads (k-1..k+1 for k in -d..d).
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    if (d >= maxD) return null;
  }
  return null;
}

function backtrack(trace, a, b, dFinal) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dFinal; d >= 0; d--) {
    const band = trace[d];
    const at = (k) => band[k + d + 1];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = k;
    else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push([' ', x, y]); }
    if (d > 0) {
      if (x === prevX) { y--; ops.push(['+', y]); }
      else { x--; ops.push(['-', x]); }
    }
  }
  ops.reverse();
  return ops;
}

// Ops → unified hunks with `context` unchanged lines around each change.
function buildHunks(ops, a, b, context) {
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === ' ') { i++; continue; }
    // Change run starts at i; extend while gaps of unchanged lines ≤ 2*context.
    let start = i, end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j][0] !== ' ') { end = j; j++; continue; }
      let gap = 0, k = j;
      while (k < ops.length && ops[k][0] === ' ') { gap++; k++; }
      if (k < ops.length && gap <= 2 * context) { j = k; continue; }
      break;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + 1 + context);
    const lines = [];
    let aStart = null, bStart = null, aLines = 0, bLines = 0;
    for (let p = from; p < to; p++) {
      const op = ops[p];
      if (op[0] === ' ') {
        if (aStart === null) { aStart = op[1] + 1; bStart = op[2] + 1; }
        lines.push([' ', a[op[1]]]); aLines++; bLines++;
      } else if (op[0] === '-') {
        if (aStart === null) { aStart = op[1] + 1; bStart = bIndexAt(ops, p) + 1; }
        lines.push(['-', a[op[1]]]); aLines++;
      } else {
        if (aStart === null) { aStart = aIndexAt(ops, p) + 1; bStart = op[1] + 1; }
        lines.push(['+', b[op[1]]]); bLines++;
      }
    }
    hunks.push({ aStart, aLines, bStart, bLines, lines });
    i = to;
  }
  return hunks;
}

// For a hunk starting on an insert/delete, the other side's position is the
// next index that side reaches (or the count consumed so far).
function aIndexAt(ops, p) {
  for (let q = p; q < ops.length; q++) if (ops[q][0] !== '+') return ops[q][1];
  let consumed = 0;
  for (let q = 0; q < p; q++) if (ops[q][0] !== '+') consumed++;
  return consumed;
}
function bIndexAt(ops, p) {
  for (let q = p; q < ops.length; q++) {
    if (ops[q][0] === ' ') return ops[q][2];
    if (ops[q][0] === '+') return ops[q][1];
  }
  let consumed = 0;
  for (let q = 0; q < p; q++) if (ops[q][0] !== '-') consumed++;
  return consumed;
}

// Fallback when the edit distance blows the cap: common prefix as context,
// then a capped delete/insert block.
function truncatedHunk(a, b, context, maxChanges) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  const half = Math.max(1, Math.floor(maxChanges / 2));
  const lines = [];
  for (let i = Math.max(0, pre - context); i < pre; i++) lines.push([' ', a[i]]);
  const del = a.slice(pre, pre + half);
  const ins = b.slice(pre, pre + half);
  for (const l of del) lines.push(['-', l]);
  for (const l of ins) lines.push(['+', l]);
  const ctx = Math.min(context, pre);
  return {
    hunks: [{ aStart: pre - ctx + 1, aLines: ctx + del.length, bStart: pre - ctx + 1, bLines: ctx + ins.length, lines }],
    added: ins.length,
    removed: del.length,
  };
}

function diffLines(aText, bText, opts = {}) {
  const { context, maxChanges, maxBytes } = { ...DEFAULTS, ...opts };
  const empty = { hunks: [], added: 0, removed: 0, truncated: false, tooLarge: false };
  if (String(aText).length > maxBytes || String(bText).length > maxBytes) return { ...empty, tooLarge: true };
  const a = splitLines(aText), b = splitLines(bText);
  const ops = myers(a, b, maxChanges);
  if (ops === null) return { ...truncatedHunk(a, b, context, maxChanges), truncated: true, tooLarge: false };
  let added = 0, removed = 0;
  for (const op of ops) { if (op[0] === '+') added++; else if (op[0] === '-') removed++; }
  if (!added && !removed) return empty;
  return { hunks: buildHunks(ops, a, b, context), added, removed, truncated: false, tooLarge: false };
}

module.exports = { diffLines };
