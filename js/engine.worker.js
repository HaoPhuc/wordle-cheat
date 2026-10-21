/*
 * Wordfish engine (web worker) -- JS port of wordle_engine.py.
 *
 * Eval = expected number of guesses still needed to solve (lower is better).
 * Search = depth-limited expectimax over feedback patterns: every legal guess is
 * scored with a 1-ply leaf estimate, the best `width` are searched deeper, and
 * branches are cut with an admissible lower bound (a bucket of c words needs
 * at least 2 - 1/c more guesses).
 */
'use strict';

const WIN = 242;                 // all-green pattern
const LEAF_SLOPE = 0.14;         // leaf estimate h(n) = 2 - 1/n + LEAF_SLOPE * log2(n/2)
const ROOT_WIDTH = 12;
const INNER_WIDTH = 6;
const RATE_DEPTH = 2;            // fixed depth used to grade played moves
const AUTO_BUDGET_MS = 3500;     // auto depth: keep deepening while the next ply should fit
const POW = [1, 3, 9, 27, 81];

let words, A, G, L, M, H, CH, CLOG, candMark;
const cnt = new Uint16Array(243);
const touched = new Uint8Array(243);
const gid = new Int16Array(243);
const memo = new Map();
let analyseToken = 0;

// ------------------------------------------------------------------ setup

async function init() {
  const load = (f) => fetch(new URL(`../words/${f}.txt`, self.location)).then((r) => {
    if (!r.ok) throw new Error(`could not load ${f}.txt`);
    return r.text();
  });
  const parse = (t) => t.split(/\s+/).map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]{5}$/.test(w));
  const [ans, allowed] = (await Promise.all([load('answers'), load('allowed')])).map(parse);
  const seen = new Set(ans);
  words = ans.concat(allowed.filter((w) => !seen.has(w)));   // answer i is also guess i
  A = ans.length;
  G = words.length;
  L = new Uint8Array(G * 5);
  words.forEach((w, i) => { for (let k = 0; k < 5; k++) L[i * 5 + k] = w.charCodeAt(k) - 97; });
  candMark = new Uint8Array(A);

  H = new Float64Array(A + 1);
  CH = new Float64Array(A + 1);
  CLOG = new Float64Array(A + 1);
  for (let c = 1; c <= A; c++) {
    H[c] = c === 1 ? 1 : c === 2 ? 1.5 : 2 - 1 / c + LEAF_SLOPE * Math.log2(c / 2);
    CH[c] = c * H[c];
    CLOG[c] = c * Math.log2(c);
  }

  M = new Uint8Array(G * A);
  const ac = new Uint8Array(26);
  for (let g = 0; g < G; g++) {
    const gb = g * 5, row = g * A;
    for (let a = 0; a < A; a++) {
      const ab = a * 5;
      let p = 0, gm = 0;
      for (let i = 0; i < 5; i++) {
        if (L[ab + i] === L[gb + i]) { gm |= 1 << i; p += 2 * POW[i]; } else ac[L[ab + i]]++;
      }
      for (let i = 0; i < 5; i++) {
        if (gm & (1 << i)) continue;
        const c = L[gb + i];
        if (ac[c]) { ac[c]--; p += POW[i]; }
      }
      for (let i = 0; i < 5; i++) ac[L[ab + i]] = 0;
      M[row + a] = p;
    }
    if (g % 1000 === 0) postMessage({ type: 'progress', value: g / G });
  }
  postMessage({ type: 'ready', words, answers: A });
}

// --------------------------------------------------------------- position

function position(history, hard) {
  let S = new Int32Array(A);
  for (let i = 0; i < A; i++) S[i] = i;
  let pool = null;                                   // null = every guess is legal (normal mode)
  if (hard) { pool = new Int32Array(G); for (let i = 0; i < G; i++) pool[i] = i; pool.key = 'all'; }
  for (const [word, pat] of history) {
    const g = words.indexOf(word);
    S = S.filter((a) => M[g * A + a] === pat);
    if (hard) pool = hardFilter(pool, g, pat);
  }
  return { S, pool };
}

function digits(pat) {
  const d = [];
  for (let i = 0; i < 5; i++) { d.push(pat % 3); pat = (pat / 3) | 0; }
  return d;
}

/* NYT hard mode: greens stay in place, revealed letters must be reused. */
function hardFilter(pool, g, pat) {
  const d = digits(pat);
  const need = new Uint8Array(26);
  for (let i = 0; i < 5; i++) if (d[i]) need[L[g * 5 + i]]++;
  const out = [];
  const have = new Uint8Array(26);
  const P = pool ? pool.length : G;
  outer: for (let k = 0; k < P; k++) {
    const w = pool ? pool[k] : k;
    for (let i = 0; i < 5; i++) if (d[i] === 2 && L[w * 5 + i] !== L[g * 5 + i]) continue outer;
    have.fill(0);
    for (let i = 0; i < 5; i++) have[L[w * 5 + i]]++;
    for (let c = 0; c < 26; c++) if (have[c] < need[c]) continue outer;
    out.push(w);
  }
  const res = Int32Array.from(out);
  let h = 2166136261;
  for (const w of res) h = Math.imul(h ^ w, 16777619);
  res.key = `${res.length}:${h >>> 0}`;
  return res;
}

// ------------------------------------------------------------------ search

function better(exp, ent, cand, o) {
  if (Math.abs(exp - o.exp) > 1e-9) return exp < o.exp;
  if (Math.abs(ent - o.ent) > 1e-9) return ent > o.ent;
  return cand && !o.cand;
}

/* Static 1-ply evaluation of every legal guess; returns the best k. */
function onePlyTop(S, pool, k) {
  const n = S.length, logn = Math.log2(n);
  for (let j = 0; j < n; j++) candMark[S[j]] = 1;
  const top = [];
  const P = pool ? pool.length : G;
  for (let pi = 0; pi < P; pi++) {
    const g = pool ? pool[pi] : pi;
    const off = g * A;
    let t = 0;
    for (let j = 0; j < n; j++) { const p = M[off + S[j]]; if (cnt[p]++ === 0) touched[t++] = p; }
    let sh = 0, sl = 0;
    for (let q = 0; q < t; q++) {
      const p = touched[q], c = cnt[p];
      cnt[p] = 0;
      sl += CLOG[c];
      if (p !== WIN) sh += CH[c];
    }
    const exp = 1 + sh / n, ent = logn - sl / n, cand = g < A && candMark[g] === 1;
    if (top.length < k || better(exp, ent, cand, top[top.length - 1])) {
      let i = top.length;
      while (i > 0 && better(exp, ent, cand, top[i - 1])) i--;
      top.splice(i, 0, { g, exp, ent, cand });
      if (top.length > k) top.pop();
    }
  }
  for (let j = 0; j < n; j++) candMark[S[j]] = 0;
  return top;
}

/* Split S by the feedback guess g would get; win bucket dropped, biggest first. */
function buckets(S, g) {
  const n = S.length, off = g * A;
  const pats = new Uint8Array(n);
  let t = 0;
  for (let j = 0; j < n; j++) { const p = M[off + S[j]]; pats[j] = p; if (cnt[p]++ === 0) touched[t++] = p; }
  const groups = [];
  for (let q = 0; q < t; q++) {
    const p = touched[q];
    if (p !== WIN) { gid[p] = groups.length; groups.push({ pat: p, sub: new Int32Array(cnt[p]), k: 0 }); }
    cnt[p] = 0;
  }
  for (let j = 0; j < n; j++) {
    if (pats[j] === WIN) continue;
    const grp = groups[gid[pats[j]]];
    grp.sub[grp.k++] = S[j];
  }
  return groups.sort((a, b) => b.sub.length - a.sub.length);
}

const lowerBound = (c) => 2 - 1 / c;

function value(S, pool, depth, width) {
  const n = S.length;
  if (n === 1) return [1, S[0]];
  if (n === 2) return [1.5, S[0]];
  const key = `${depth}|${width}|${pool ? pool.key : ''}|${S.join(',')}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const top = onePlyTop(S, pool, depth > 1 ? width : 1);
  let res = [top[0].exp, top[0].g];
  if (depth > 1) {
    res = [Infinity, top[0].g];
    for (const t of top) {
      const v = expect(S, t.g, pool, depth - 1, width, res[0]);
      if (v < res[0]) res = [v, t.g];
    }
  }
  if (memo.size > 400000) memo.clear();
  memo.set(key, res);
  return res;
}

/* Expected guesses to solve S when guessing g now (Infinity if it can't beat alpha). */
function expect(S, g, pool, depth, width, alpha = Infinity) {
  const n = S.length;
  const groups = buckets(S, g);
  let rest = 0;
  for (const { sub } of groups) rest += sub.length * lowerBound(sub.length);
  rest /= n;
  let total = 1;
  for (const { pat, sub } of groups) {
    const c = sub.length;
    rest -= c * lowerBound(c) / n;
    total += c / n * value(sub, pool ? hardFilter(pool, g, pat) : null, depth, width)[0];
    if (total + rest >= alpha) return Infinity;
  }
  return total;
}

/* Same as expect(), but yields to the event loop so a newer request can cancel it. */
async function expectAsync(S, g, pool, depth, width, alpha, cancelled) {
  const n = S.length;
  const groups = buckets(S, g);
  let rest = 0;
  for (const { sub } of groups) rest += sub.length * lowerBound(sub.length);
  rest /= n;
  let total = 1;
  for (const { pat, sub } of groups) {
    await maybeYield();
    if (cancelled()) return null;
    const c = sub.length;
    rest -= c * lowerBound(c) / n;
    total += c / n * value(sub, pool ? hardFilter(pool, g, pat) : null, depth, width)[0];
    if (total + rest >= alpha) return Infinity;
  }
  return total;
}

let lastYield = 0;
const channel = new MessageChannel();
const waiting = [];
channel.port1.onmessage = () => waiting.shift()();
function maybeYield() {
  if (performance.now() - lastYield < 30) return null;
  return new Promise((r) => { waiting.push(() => { lastYield = performance.now(); r(); }); channel.port2.postMessage(0); });
}

function stats(S, g) {
  const n = S.length, off = g * A;
  let t = 0, win = 0;
  for (let j = 0; j < n; j++) { const p = M[off + S[j]]; if (cnt[p]++ === 0) touched[t++] = p; }
  let sl = 0, sq = 0, worst = 0, groups = 0;
  for (let q = 0; q < t; q++) {
    const p = touched[q], c = cnt[p];
    cnt[p] = 0;
    sl += CLOG[c]; sq += c * c;
    if (p === WIN) win = 1; else { groups++; if (c > worst) worst = c; }
  }
  return {
    bits: Math.log2(n) - sl / n,
    left: sq / n,
    worst,
    winNow: win / n,
    winNext: (win + groups) / n,          // best case: next guess is always a candidate
  };
}

/* Search the top `width` moves `depth` plies deep; returns lines sorted by eval. */
async function analyse(S, pool, depth, multipv, cancelled) {
  const n = S.length;
  const top = onePlyTop(S, pool, Math.max(ROOT_WIDTH, multipv));
  const lines = [];
  for (const t of top) {
    let v = t.exp;
    if (depth > 1 && n > 2) {
      const evals = lines.map((l) => l.eval).sort((a, b) => a - b);
      const alpha = evals.length >= multipv ? evals[multipv - 1] : Infinity;
      v = await expectAsync(S, t.g, pool, depth - 1, INNER_WIDTH, alpha, cancelled);
      if (v === null) return null;
      if (v === Infinity) continue;
    }
    lines.push({ g: t.g, word: words[t.g], eval: v, cand: t.cand, ...stats(S, t.g) });
  }
  lines.sort((a, b) => a.eval - b.eval || b.bits - a.bits || b.cand - a.cand);
  return lines.slice(0, multipv);
}

// ---------------------------------------------------------------- requests

async function onAnalyse({ id, history, hard, depth, multipv }) {
  const token = ++analyseToken;
  const cancelled = () => token !== analyseToken;
  const { S, pool } = position(history, hard);
  const n = S.length;
  const candidates = Array.from(S.subarray(0, 500), (i) => words[i]);
  if (n === 0) {
    postMessage({ type: 'analysis', id, n, candidates, lines: [], depth: 0, final: true });
    return;
  }
  const maxDepth = depth === 'auto' ? 6 : depth;
  for (let d = 1; d <= maxDepth; d++) {
    const t0 = performance.now();
    const lines = await analyse(S, pool, d, multipv, cancelled);
    if (lines === null) return;
    const ms = performance.now() - t0;
    const done = d === maxDepth || n <= 2 || (depth === 'auto' && ms * 7 > AUTO_BUDGET_MS);
    postMessage({ type: 'analysis', id, n, candidates, lines, depth: d, ms, final: done });
    if (done) return;
    await maybeYield();
  }
}

async function onRate({ id, history, guess, hard }) {
  const { S, pool } = position(history, hard);
  const n = S.length;
  const g = words.indexOf(guess);
  const never = () => false;
  const lines = await analyse(S, pool, RATE_DEPTH, 2, never);
  const moveEval = n <= 2 || RATE_DEPTH === 1
    ? onePlyEval(S, g)
    : await expectAsync(S, g, pool, RATE_DEPTH - 1, INNER_WIDTH, Infinity, never);
  const others = lines.filter((l) => l.g !== g);
  // best guess that could itself be the answer (to spot "brilliant" sacrifices)
  let bestCand = Infinity;
  if (n > 2) {
    for (const t of onePlyTop(S, S, 4)) {
      bestCand = Math.min(bestCand, await expectAsync(S, t.g, pool, RATE_DEPTH - 1, INNER_WIDTH, bestCand, never));
    }
  } else bestCand = lines[0].eval;
  const st = stats(S, g);
  postMessage({
    type: 'rating', id, guess,
    n, moveEval, bestEval: Math.min(lines[0].eval, moveEval), bestWord: lines[0].word,
    otherEval: others.length ? others[0].eval : Infinity,
    bestCandEval: bestCand, isCand: g < A && S.includes(g), expectedLeft: st.left,
  });
}

function onePlyEval(S, g) {
  const n = S.length;
  if (n === 1) return S[0] === g ? 1 : 2;
  let t = 0;
  for (let j = 0; j < n; j++) { const p = M[g * A + S[j]]; if (cnt[p]++ === 0) touched[t++] = p; }
  let sh = 0;
  for (let q = 0; q < t; q++) { const p = touched[q]; if (p !== WIN) sh += CH[cnt[p]]; cnt[p] = 0; }
  return 1 + sh / n;
}

let ready = init().catch((e) => postMessage({ type: 'error', message: String(e.message || e) }));

onmessage = async ({ data }) => {
  await ready;
  if (data.type === 'analyse') onAnalyse(data);
  else if (data.type === 'rate') onRate(data);
};
