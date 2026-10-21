/* Wordfish UI: Wordle board + Stockfish-style engine panel + chess.com-style move ratings. */

const $ = (sel, el = document) => el.querySelector(sel);
const WIN = 242;
const PAR = 4;
const STORE = 'wordfish-v1';

// ------------------------------------------------------------------ move classes

const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z"/></svg>',
  thumb: '<svg viewBox="0 0 24 24"><path d="M2.5 10.5h3.5V21H2.5zM8 21h8.8a2.2 2.2 0 0 0 2.1-1.7l1.5-6.6A2.2 2.2 0 0 0 18.3 10H14l.7-3.9a1.9 1.9 0 0 0-3.4-1.5L8 10z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M4.5 12.5l4.8 4.8L19.5 7"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M11.1 6.4C9.3 5 6.7 4.5 2.5 4.7v13.6c4-.2 6.6.3 8.6 1.6zM12.9 6.4C14.7 5 17.3 4.5 21.5 4.7v13.6c-4-.2-6.6.3-8.6 1.6z"/></svg>',
};

const CLASSES = {
  brilliant:  { label: 'Brilliant',  color: '#26c2a3', icon: '!!', desc: 'A sacrifice: a word that can’t be the answer, yet clearly better than every word that could.' },
  great:      { label: 'Great',      color: '#749bbf', icon: '!',  desc: 'The only good move. Every alternative was 0.15+ guesses worse.' },
  best:       { label: 'Best',       color: '#81b64c', icon: ICON.star,  desc: 'The engine’s top choice.' },
  excellent:  { label: 'Excellent',  color: '#81b64c', icon: ICON.thumb, desc: 'Within 0.03 guesses of the best move.' },
  good:       { label: 'Good',       color: '#95b776', icon: ICON.check, desc: 'Within 0.08 guesses of the best move.' },
  book:       { label: 'Book',       color: '#d5a47d', icon: ICON.book,  desc: 'A strong opener: first guess within 0.06 of the best.' },
  inaccuracy: { label: 'Inaccuracy', color: '#f7c631', icon: '?!', desc: 'Gave away 0.08–0.2 guesses.' },
  mistake:    { label: 'Mistake',    color: '#ffa459', icon: '?',  desc: 'Gave away 0.2–0.45 guesses.' },
  blunder:    { label: 'Blunder',    color: '#fa412d', icon: '??', desc: 'Gave away more than 0.45 guesses.' },
};

function lossClass(loss) {
  if (loss <= 0.005) return 'best';
  if (loss <= 0.03) return 'excellent';
  if (loss <= 0.08) return 'good';
  if (loss <= 0.2) return 'inaccuracy';
  if (loss <= 0.45) return 'mistake';
  return 'blunder';
}

/* Same idea as chess.com: grade by how much expected score the move gave up vs. the best move. */
function classify(r, moveNo) {
  const loss = Math.max(0, r.moveEval - r.bestEval);
  if (moveNo === 0 && loss <= 0.06) return 'book';
  const cls = lossClass(loss);
  if (cls === 'best' && r.n > 2) {
    if (!r.isCand && r.n >= 4 && r.bestCandEval - r.moveEval >= 0.25) return 'brilliant';
    if (r.otherEval - r.moveEval >= 0.15) return 'great';
  }
  return cls;
}

/* chess.com's CAPS-style accuracy curve, fed with guesses lost instead of win% lost. */
const accuracy = (loss) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss * 40) - 3.1669));

function badge(cls, size = '') {
  const c = CLASSES[cls];
  return `<span class="badge ${size} ${cls === 'good' ? 'check' : ''}" style="--bc:${c.color}" title="${c.label}">${c.icon}</span>`;
}

// ------------------------------------------------------------------ wordle rules

function feedback(guess, answer) {
  const res = [0, 0, 0, 0, 0];
  const left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) res[i] = 2;
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] !== 2 && left[guess[i]] > 0) { res[i] = 1; left[guess[i]]--; }
  }
  return toPat(res);
}
const toPat = (d) => d.reduce((p, x, i) => p + x * 3 ** i, 0);
const toDigits = (pat) => [0, 1, 2, 3, 4].map((i) => Math.floor(pat / 3 ** i) % 3);
const COLOR = ['b', 'y', 'g'];

function hardModeError(word) {
  const ord = ['1st', '2nd', '3rd', '4th', '5th'];
  for (const { word: w, pat } of state.rows) {
    const d = toDigits(pat);
    for (let i = 0; i < 5; i++) {
      if (d[i] === 2 && word[i] !== w[i]) return `${ord[i]} letter must be ${w[i].toUpperCase()}`;
    }
    for (let i = 0; i < 5; i++) {
      if (!d[i]) continue;
      const need = [...w].filter((c, j) => c === w[i] && d[j]).length;
      if ([...word].filter((c) => c === w[i]).length < need) return `Guess must contain ${w[i].toUpperCase()}`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ state

let WORDS = null, WORDSET = null, ANSWERS = null;

const state = {
  mode: 'assist',
  rows: [],                       // { word, pat, rating, cls }
  cur: { letters: [], colors: [] },
  secret: null,
  reviewShown: false,
  stash: {},
  hard: false,
  depth: 'auto',
  lines: '5',
  peek: false,
  ready: false,
  progress: 0,
  analysis: null,
  analysisId: 0,
  animRow: -1,
  candsAll: false,
};

const solved = () => state.rows.length > 0 && state.rows[state.rows.length - 1].pat === WIN;
const failed = () => state.rows.length === 6 && !solved();
const over = () => solved() || failed();
const engineHidden = () => state.mode === 'practice' && !state.peek && !over();
const history = (rows = state.rows) => rows.map((r) => [r.word, r.pat]);

function save() {
  try {
    const game = (rows) => rows.map(({ word, pat, rating, cls }) => ({ word, pat, rating, cls }));
    const stash = Object.fromEntries(Object.entries(state.stash).map(([k, v]) => [k, { ...v, rows: game(v.rows) }]));
    localStorage.setItem(STORE, JSON.stringify({
      mode: state.mode, rows: game(state.rows), secret: state.secret, reviewShown: state.reviewShown,
      stash, hard: state.hard, depth: state.depth, lines: state.lines,
    }));
  } catch { /* storage unavailable: nothing to persist */ }
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (!s || !Array.isArray(s.rows)) return;
    Object.assign(state, {
      mode: s.mode === 'practice' ? 'practice' : 'assist',
      rows: s.rows, secret: s.secret || null, reviewShown: !!s.reviewShown,
      stash: s.stash || {}, hard: !!s.hard, depth: s.depth || 'auto', lines: s.lines || '5',
    });
  } catch { /* corrupt or blocked storage: start fresh */ }
}

// ------------------------------------------------------------------ engine worker

const worker = new Worker(new URL('./engine.worker.js', import.meta.url));
let seq = 0;

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    state.progress = data.value;
    renderLoading();
  } else if (data.type === 'ready') {
    WORDS = data.words;
    ANSWERS = WORDS.slice(0, data.answers);
    WORDSET = new Set(WORDS);
    state.ready = true;
    if (state.mode === 'practice' && !state.secret) state.secret = randomAnswer();
    state.rows.forEach((r, i) => { if (!r.rating) requestRating(i); });
    requestAnalysis();
    render();
  } else if (data.type === 'analysis') {
    if (data.id !== state.analysisId) return;
    state.analysis = data;
    renderEngine();
    renderEvalBar();
  } else if (data.type === 'rating') {
    const i = state.rows.findIndex((r) => r.rid === data.id);
    if (i < 0) return;
    state.rows[i].rating = data;
    state.rows[i].cls = classify(data, i);
    render();
    maybeAutoReview();
  } else if (data.type === 'error') {
    $('#loading-text').textContent = `Engine failed to start: ${data.message}. Serve this folder over http (see README).`;
  }
};

function requestAnalysis() {
  state.analysis = null;
  if (!state.ready || over()) return;
  state.analysisId = ++seq;
  worker.postMessage({
    type: 'analyse', id: state.analysisId, history: history(), hard: state.hard,
    depth: state.depth === 'auto' ? 'auto' : +state.depth, multipv: +state.lines,
  });
}

function requestRating(i) {
  const row = state.rows[i];
  row.rating = null;
  row.cls = null;
  if (!state.ready) return;
  row.rid = ++seq;
  worker.postMessage({ type: 'rate', id: row.rid, history: history(state.rows.slice(0, i)), guess: row.word, hard: state.hard });
}

const randomAnswer = () => ANSWERS[Math.floor(Math.random() * ANSWERS.length)];

// ------------------------------------------------------------------ candidates (main thread, cheap)

function candidatesAfter(k) {
  if (!ANSWERS) return null;
  let c = ANSWERS;
  for (const r of state.rows.slice(0, k)) c = c.filter((a) => feedback(r.word, a) === r.pat);
  return c;
}

// ------------------------------------------------------------------ input

function letterInfo() {
  const best = {}, greenAt = {}, yellowAt = {};
  state.rows.forEach(({ word, pat }) => toDigits(pat).forEach((d, i) => {
    const c = word[i];
    best[c] = Math.max(best[c] ?? -1, d);
    if (d === 2) greenAt[`${c}${i}`] = true;
    if (d === 1) yellowAt[`${c}${i}`] = true;
  }));
  return { best, greenAt, yellowAt };
}

/* Solve mode: guess the colour Wordle will show, so you rarely need to tap. */
function prefill(letter, i) {
  const { best, greenAt } = letterInfo();
  if (greenAt[`${letter}${i}`]) return 2;
  if ((best[letter] ?? 0) >= 1) return 1;
  return 0;
}

function typeLetter(ch) {
  if (over() || state.cur.letters.length >= 5) return;
  const i = state.cur.letters.length;
  state.cur.letters.push(ch);
  state.cur.colors[i] = prefill(ch, i);
  pressKey(ch);
  renderBoard();
  renderHint();
}

function erase() {
  if (!state.cur.letters.length) return;
  state.cur.letters.pop();
  state.cur.colors.length = state.cur.letters.length;
  pressKey('back');
  renderBoard();
  renderHint();
}

function setWord(word) {
  if (over()) return;
  state.cur.letters = [...word];
  state.cur.colors = state.cur.letters.map(prefill);
  renderBoard();
  renderHint();
}

function cycle(i) {
  if (state.mode !== 'assist' || over() || i >= state.cur.letters.length) return;
  state.cur.colors[i] = (state.cur.colors[i] + 1) % 3;
  const tile = boardRows[state.rows.length].tiles[i];
  tile.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.15)' }, { transform: 'scaleY(1)' }], { duration: 200, easing: 'ease-in-out' });
  renderBoard();
}

function submit() {
  if (over()) return;
  if (!state.ready) return toast('Engine is still warming up…');
  const word = state.cur.letters.join('');
  if (word.length < 5) return shake('Not enough letters');
  if (!WORDSET.has(word)) return shake('Not in word list');
  if (state.hard) {
    const err = hardModeError(word);
    if (err) return shake(err);
  }
  const pat = state.mode === 'assist' ? toPat(state.cur.colors) : feedback(word, state.secret);
  state.rows.push({ word, pat });
  const idx = state.rows.length - 1;
  state.cur = { letters: [], colors: [] };
  state.candsAll = false;
  requestRating(idx);
  requestAnalysis();

  const reveal = state.mode === 'practice';
  if (reveal) {
    state.animRow = idx;
    setTimeout(() => { state.animRow = -1; render(); }, 1500);
  }
  render();

  const delay = reveal ? 1500 : 200;
  if (pat === WIN) {
    setTimeout(() => {
      const row = boardRows[idx].el;
      row.classList.add('dance');
      setTimeout(() => row.classList.remove('dance'), 1000);
      toast(['Genius', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'][idx]);
    }, delay);
    setTimeout(maybeAutoReview, delay + 1200);
  } else if (failed()) {
    setTimeout(() => toast(state.mode === 'practice' ? state.secret.toUpperCase() : 'Out of guesses', 4000), delay);
    setTimeout(maybeAutoReview, delay + 1800);
  } else if (state.mode === 'assist' && candidatesAfter(state.rows.length).length === 0) {
    toast('No answer fits those colours. Check the tiles or press Undo', 4500);
  }
}

function undo() {
  if (!state.rows.length) {
    if (state.cur.letters.length) { state.cur = { letters: [], colors: [] }; render(); }
    return;
  }
  const last = state.rows.pop();
  state.cur = state.mode === 'assist'
    ? { letters: [...last.word], colors: toDigits(last.pat) }
    : { letters: [], colors: [] };
  state.reviewShown = false;
  state.animRow = -1;
  requestAnalysis();
  render();
}

function newGame() {
  state.rows = [];
  state.cur = { letters: [], colors: [] };
  state.reviewShown = false;
  state.peek = false;
  state.candsAll = false;
  state.secret = state.mode === 'practice' && ANSWERS ? randomAnswer() : null;
  requestAnalysis();
  render();
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.stash[state.mode] = { rows: state.rows, secret: state.secret, reviewShown: state.reviewShown };
  state.mode = mode;
  const g = state.stash[mode];
  state.rows = g ? g.rows : [];
  state.secret = g ? g.secret : null;
  state.reviewShown = g ? g.reviewShown : false;
  if (mode === 'practice' && !state.secret && ANSWERS) state.secret = randomAnswer();
  state.cur = { letters: [], colors: [] };
  state.peek = false;
  state.rows.forEach((r, i) => { if (!r.rating) requestRating(i); });
  requestAnalysis();
  render();
}

function maybeAutoReview() {
  if (!over() || state.reviewShown || state.animRow >= 0) return;
  if (!state.rows.every((r) => r.cls)) return;
  state.reviewShown = true;
  save();
  openReview();
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.matches?.('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    return;
  }
  if (e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); submit(); }
  else if (e.key === 'Backspace') erase();
  else if (/^[a-zA-Z]$/.test(e.key)) typeLetter(e.key.toLowerCase());
  else if (/^[1-5]$/.test(e.key)) cycle(+e.key - 1);
});

// ------------------------------------------------------------------ board + keyboard

const boardRows = [];
(function buildBoard() {
  const board = $('#board');
  for (let r = 0; r < 6; r++) {
    const el = document.createElement('div');
    el.className = 'row';
    el.addEventListener('animationend', (e) => { if (e.animationName === 'shake') el.classList.remove('shake'); });
    const tiles = [];
    for (let i = 0; i < 5; i++) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.style.setProperty('--i', i);
      t.addEventListener('click', () => { if (r === state.rows.length) cycle(i); });
      el.append(t);
      tiles.push(t);
    }
    const annot = document.createElement('div');
    annot.className = 'annot';
    el.append(annot);
    board.append(el);
    boardRows.push({ el, tiles, annot });
  }
})();

const keyEls = {};
(function buildKeyboard() {
  const kb = $('#keyboard');
  const back = '<svg viewBox="0 0 24 24"><path d="M21 5H8.5L2 12l6.5 7H21z"/><path d="m11.5 9 6 6M17.5 9l-6 6"/></svg>';
  ['qwertyuiop', '-asdfghjkl-', '>zxcvbnm<'].forEach((line) => {
    const row = document.createElement('div');
    row.className = 'krow';
    for (const ch of line) {
      if (ch === '-') { row.append(Object.assign(document.createElement('span'), { className: 'spacer' })); continue; }
      const b = document.createElement('button');
      b.className = 'key';
      b.type = 'button';
      b.tabIndex = -1;
      if (ch === '>') { b.textContent = 'enter'; b.classList.add('wide'); b.onclick = submit; keyEls.enter = b; }
      else if (ch === '<') { b.innerHTML = back; b.classList.add('wide'); b.setAttribute('aria-label', 'Backspace'); b.onclick = erase; keyEls.back = b; }
      else { b.textContent = ch; b.onclick = () => typeLetter(ch); keyEls[ch] = b; }
      row.append(b);
    }
    kb.append(row);
  });
})();

function pressKey(k) {
  const el = keyEls[k];
  if (!el) return;
  el.classList.add('press');
  setTimeout(() => el.classList.remove('press'), 90);
}

function renderBoard() {
  const active = over() ? -1 : state.rows.length;
  const counts = ANSWERS ? state.rows.map((_, i) => candidatesAfter(i + 1).length) : [];
  boardRows.forEach(({ el, tiles, annot }, r) => {
    const row = state.rows[r];
    const editing = r === active && state.mode === 'assist';
    el.classList.toggle('editing', editing);
    tiles.forEach((t, i) => {
      let letter = '', cls = 'tile';
      if (row) {
        letter = row.word[i];
        cls += ` done ${COLOR[toDigits(row.pat)[i]]}${r === state.animRow ? ' reveal' : ''}`;
      } else if (r === active && state.cur.letters[i]) {
        letter = state.cur.letters[i];
        cls += ' filled';
        if (editing) cls += ` ${COLOR[state.cur.colors[i]]}`;
      }
      if (t.textContent !== letter) t.textContent = letter;
      if (t.className !== cls) t.className = cls;
    });

    let key = '';
    if (row && r !== state.animRow) key = `${row.word}|${row.cls}|${counts[r]}`;
    if (annot.dataset.key !== key) {
      annot.dataset.key = key;
      annot.innerHTML = !key ? '' :
        `${row.cls ? badge(row.cls) : '<span class="pending" title="Rating…"></span>'}` +
        (counts[r] !== undefined && row.pat !== WIN ? `<span class="left" title="${counts[r]} possible answers left"><b>${counts[r]}</b><span class="lw"> left</span></span>` : '');
    }
  });
}

function renderKeyboard() {
  const best = {};
  state.rows.forEach(({ word, pat }, r) => {
    if (r === state.animRow) return;
    toDigits(pat).forEach((d, i) => { best[word[i]] = Math.max(best[word[i]] ?? -1, d); });
  });
  for (const [k, el] of Object.entries(keyEls)) {
    if (k.length !== 1) continue;
    const cls = `key${best[k] !== undefined ? ` ${COLOR[best[k]]}` : ''}`;
    if (el.className !== cls) el.className = cls;
  }
}

function renderHint() {
  const h = $('#hint');
  const sw = (c) => `<span class="sw" style="background:var(--${c})"></span>`;
  if (solved()) h.innerHTML = `Solved in <b>${state.rows.length}</b>. Press <kbd>New</kbd> for another round`;
  else if (failed()) h.innerHTML = state.mode === 'practice' ? `The word was <b>${state.secret.toUpperCase()}</b>` : 'Out of rows';
  else if (state.mode === 'practice') h.innerHTML = 'Guess the hidden word. Every move gets graded';
  else if (!state.cur.letters.length) h.innerHTML = state.rows.length ? 'Type your next guess, or tap a suggestion' : 'Type the word you played in Wordle, or tap a suggestion';
  else h.innerHTML = `Tap tiles to match Wordle’s colours ${sw('gray')}${sw('yellow')}${sw('green')}, then <kbd>Enter</kbd>`;
}

// ------------------------------------------------------------------ eval bar

function renderEvalBar() {
  const bar = $('#evalbar');
  const fill = $('#evalbar-fill');
  const label = $('#evalbar-label');
  bar.classList.toggle('solved', solved());
  bar.classList.toggle('failed', failed());
  bar.classList.toggle('hidden', engineHidden());
  let E;
  if (solved()) { E = state.rows.length; label.textContent = `${E}`; }
  else if (failed()) { label.textContent = 'X'; label.style.top = '100%'; return; }
  else if (engineHidden()) { label.textContent = '?'; return; }
  else if (state.analysis?.lines?.length) { E = state.rows.length + state.analysis.lines[0].eval; label.textContent = E.toFixed(2); }
  else return;
  const f = Math.max(0.03, Math.min(1, (6 - E) / 5));
  fill.style.height = `${f * 100}%`;
  label.style.top = `${(1 - f) * 100}%`;
  bar.title = `Expected total: ${E.toFixed(2)} guesses (par ${PAR})`;
}

// ------------------------------------------------------------------ engine panel

let linesFor = '';

function renderLoading() {
  const loading = $('#loading');
  loading.hidden = state.ready;
  $('#loading-fill').style.width = `${Math.round(state.progress * 100)}%`;
  if (!state.ready) $('#engine-status').textContent = `Loading… ${Math.round(state.progress * 100)}%`;
}

function renderEngine() {
  renderLoading();
  const a = state.analysis;
  const dot = $('#engine-dot');
  const status = $('#engine-status');
  const summary = $('#summary');
  const lines = $('#lines');
  const hidden = engineHidden();

  $('#veil').hidden = !hidden;
  $('#cand-card').classList.toggle('blur', hidden);
  const peek = $('#btn-peek');
  peek.hidden = state.mode !== 'practice' || over();
  peek.querySelector('span').textContent = state.peek ? 'Hide engine' : 'Show engine';

  if (!state.ready) { dot.className = 'engine-dot'; $('#engine-body').hidden = true; return; }
  $('#engine-body').hidden = false;

  if (over()) {
    dot.className = 'engine-dot on';
    status.textContent = 'game over';
    summary.className = 'summary';
    summary.innerHTML = solved()
      ? `<div class="big">${state.rows.length}<small>guesses</small></div><div class="sub">Solved: <b>${state.rows.at(-1).word.toUpperCase()}</b></div><div class="sub">${state.rows.length <= PAR ? 'Par or better' : 'Over par'} · par ${PAR}</div>`
      : `<div class="big">X<small>/6</small></div><div class="sub">${state.mode === 'practice' ? `The word was <b>${state.secret.toUpperCase()}</b>` : 'Out of rows'}</div><div class="sub">Undo to try a different path</div>`;
    lines.innerHTML = '';
    linesFor = '';
    return;
  }

  if (!a) {
    dot.className = 'engine-dot busy';
    status.textContent = 'thinking…';
    if (linesFor !== key()) lines.classList.add('stale');
    return;
  }
  dot.className = `engine-dot ${a.final ? 'on' : 'busy'}`;
  status.textContent = [`depth ${a.depth}${a.final ? '' : '+'}`, a.ms >= 50 && `${(a.ms / 1000).toFixed(1)}s`, !a.final && 'thinking…']
    .filter(Boolean).join(' · ');

  if (a.n === 0) {
    summary.className = 'summary empty';
    summary.innerHTML = 'No answer in the list fits these colours. Double-check the tiles, then use <b>Undo</b> to fix the last row.';
    lines.innerHTML = '';
    return;
  }

  const best = a.lines[0];
  const E = state.rows.length + best.eval;
  const adv = PAR - E;
  summary.className = 'summary';
  summary.innerHTML = `
    <div class="big">${E.toFixed(2)}<small>guesses</small></div>
    <div class="sub"><b>${a.n.toLocaleString()}</b> possible answer${a.n === 1 ? '' : 's'} · ${Math.log2(a.n).toFixed(2)} bits</div>
    <div class="sub">vs par ${PAR}: <b style="color:${adv >= 0 ? 'var(--accent)' : '#ffa459'}">${adv >= 0 ? '+' : '−'}${Math.abs(adv).toFixed(2)}</b> · best <b>${best.word.toUpperCase()}</b></div>`;

  const fresh = linesFor !== key();
  linesFor = key();
  lines.classList.remove('stale');
  lines.innerHTML = a.lines.map((l, i) => {
    const loss = l.eval - best.eval;
    const cls = lossClass(loss);
    const c = CLASSES[cls];
    const pct = (x) => (x * 100 < 10 && x > 0 ? (x * 100).toFixed(1) : Math.round(x * 100));
    return `
      <li class="line ${l.cand ? 'cand' : ''}" style="--i:${fresh ? i : 0};--bc:${c.color};${fresh ? '' : 'animation:none'}" data-word="${l.word}" title="Play ${l.word.toUpperCase()}">
        <span class="rank">${i + 1}</span>
        <span class="mini">${[...l.word].map((ch) => `<i>${ch}</i>`).join('')}</span>
        <span class="rate"><span class="meter"><span style="width:${accuracy(loss).toFixed(1)}%;${fresh ? '' : 'animation:none'}"></span></span>${badge(cls, 'sm')}</span>
        <span class="eval">${l.eval.toFixed(3)}</span>
        <span class="meta">
          <span class="cls">${c.label}${loss >= 0.005 ? ` −${loss.toFixed(2)}` : ''}</span>
          <span><b>${l.bits.toFixed(2)}</b> bits</span>
          <span><b>${l.left < 10 ? l.left.toFixed(1) : Math.round(l.left)}</b> left</span>
          <span>worst <b>${l.worst}</b></span>
          <span>win <b>${pct(l.winNow)}%</b> · by next <b>${pct(l.winNext)}%</b></span>
        </span>
      </li>`;
  }).join('');
}

const key = () => `${state.mode}|${state.hard}|${history().join(';')}`;

$('#lines').addEventListener('click', (e) => {
  const li = e.target.closest('.line');
  if (li) setWord(li.dataset.word);
});

function renderCands() {
  const box = $('#cands');
  const c = candidatesAfter(state.rows.length);
  $('#cand-count').textContent = c ? c.length.toLocaleString() : '';
  if (!c) { box.innerHTML = '<span class="none">Loading word list…</span>'; return; }
  if (!c.length) { box.innerHTML = '<span class="none">None. Check the colours.</span>'; return; }
  const limit = state.candsAll ? 600 : 48;
  box.innerHTML = c.slice(0, limit).map((w) => `<button type="button" tabindex="-1" data-word="${w}">${w}</button>`).join('') +
    (c.length > limit ? `<button type="button" class="more" tabindex="-1">+${(c.length - limit).toLocaleString()} more</button>` : '');
}

$('#cands').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.classList.contains('more')) { state.candsAll = true; renderCands(); } else setWord(b.dataset.word);
});

function renderMoves() {
  const list = $('#moves');
  if (!state.rows.length) {
    list.innerHTML = '<li class="empty">No guesses yet.</li>';
    $('#accuracy').textContent = '';
    return;
  }
  list.innerHTML = state.rows.map((r, i) => {
    if (!r.cls) return `<li class="move"><span class="n">${i + 1}</span><span class="w">${r.word}</span><span class="what">rating…</span><span class="ev"></span></li>`;
    const c = CLASSES[r.cls];
    const loss = Math.max(0, r.rating.moveEval - r.rating.bestEval);
    const alt = loss > 0.005 && r.rating.bestWord !== r.word ? ` · ${r.rating.bestWord.toUpperCase()} was best` : '';
    return `<li class="move" style="--bc:${c.color}">
      <span class="n">${i + 1}</span><span class="w">${r.word}</span>
      <span class="what">${badge(r.cls, 'sm')} <b>${c.label}</b>${alt}</span>
      <span class="ev" title="Expected guesses after this move">${loss > 0.005 ? `−${loss.toFixed(2)}` : r.rating.moveEval.toFixed(2)}</span>
    </li>`;
  }).join('');
  const rated = state.rows.filter((r) => r.cls);
  $('#accuracy').textContent = rated.length ? `accuracy ${gameAccuracy(rated).toFixed(1)}` : '';
}

const gameAccuracy = (rows) => rows.reduce((s, r) => s + accuracy(Math.max(0, r.rating.moveEval - r.rating.bestEval)), 0) / rows.length;

// ------------------------------------------------------------------ review

function openReview() {
  const rows = state.rows.filter((r) => r.cls);
  if (!rows.length) return toast('Make a guess first');
  const acc = gameAccuracy(rows);
  const k = state.rows.length;
  const title = solved() ? `Solved in ${k}` : failed() ? 'Out of guesses' : 'Game in progress';
  const verdict = solved()
    ? (k <= 2 ? 'Absurd. Were you peeking?' : k === 3 ? 'Birdie: one under par.' : k === 4 ? 'Par. Solid, steady play.' : 'Got there in the end.')
    : failed() ? (state.mode === 'practice' ? `The word was ${state.secret.toUpperCase()}.` : 'Undo a few moves and follow the engine.') : 'Here’s how your guesses rate so far.';

  const order = Object.keys(CLASSES);
  const tally = Object.fromEntries(order.map((c) => [c, 0]));
  rows.forEach((r) => tally[r.cls]++);

  const C = 2 * Math.PI * 47;
  const ringColor = acc >= 90 ? 'var(--accent)' : acc >= 75 ? '#f7c631' : acc >= 55 ? '#ffa459' : '#fa412d';

  $('#review-body').innerHTML = `
    <div class="review-top">
      <div class="ring">
        <svg viewBox="0 0 112 112"><circle class="bg" cx="56" cy="56" r="47"/><circle class="fg" cx="56" cy="56" r="47"
          style="stroke:${ringColor};stroke-dasharray:${C};stroke-dashoffset:${C}" data-to="${C * (1 - acc / 100)}"/></svg>
        <div class="val">${acc.toFixed(1)}<small>Accuracy</small></div>
      </div>
      <div class="review-verdict"><h2>${title}</h2><p>${verdict}</p></div>
    </div>
    <div class="tally">${order.map((c) => `<div class="${tally[c] ? '' : 'zero'}" style="--bc:${CLASSES[c].color}">${badge(c, 'sm')}${CLASSES[c].label}<b>${tally[c]}</b></div>`).join('')}</div>
    <h3>Expected guesses over the game</h3>
    <div class="graph">${graph()}</div>
    <h3>Move by move</h3>
    <ol class="review-moves">${state.rows.map(reviewLine).join('')}</ol>
    <div class="review-actions">
      <button class="btn" id="rv-close" type="button">Keep looking</button>
      <button class="btn btn-primary" id="rv-new" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>New game</button>
    </div>`;
  const dlg = $('#review');
  dlg.showModal();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fg = $('.ring .fg', dlg);
    fg.style.strokeDashoffset = fg.dataset.to;
  }));
  $('#rv-close').onclick = () => dlg.close();
  $('#rv-new').onclick = () => { dlg.close(); newGame(); };
}

function reviewLine(r, i) {
  const tiles = `<span class="tiles">${[...r.word].map((ch, j) => `<i class="${COLOR[toDigits(r.pat)[j]]}">${ch}</i>`).join('')}</span>`;
  if (!r.cls) return `<li>${tiles}<span></span><span class="txt">rating…</span></li>`;
  const c = CLASSES[r.cls];
  const R = r.rating;
  const loss = Math.max(0, R.moveEval - R.bestEval);
  let txt = `<b>${c.label}</b>. `;
  if (r.cls === 'brilliant') txt += `It couldn’t be the answer, but it beat every word that could by ${(R.bestCandEval - R.moveEval).toFixed(2)}.`;
  else if (r.cls === 'great') txt += `The only strong move. The next best was ${(R.otherEval - R.moveEval).toFixed(2)} worse.`;
  else if (loss <= 0.005 || r.cls === 'book') txt += `Expected to finish in ${(i + R.moveEval).toFixed(2)}.`;
  else txt += `Cost ${loss.toFixed(2)} guesses; <em>${R.bestWord}</em> was best.`;
  if (r.pat !== WIN) {
    const after = candidatesAfter(i + 1).length;
    const exp = R.expectedLeft;
    const luck = after <= exp * 0.5 ? ' Lucky split.' : after >= exp * 1.6 && after > 2 ? ' Unlucky split.' : '';
    txt += ` ${R.n.toLocaleString()} → ${after} answers (expected ${exp < 10 ? exp.toFixed(1) : Math.round(exp)}).${luck}`;
  }
  return `<li style="--bc:${c.color}">${tiles}${badge(r.cls)}<span class="txt">${txt}</span></li>`;
}

function graph() {
  const W = 480, H = 150, pl = 30, pr = 14, pt = 12, pb = 22;
  const pts = state.rows.map((r, i) => (r.rating ? { x: i, y: i + r.rating.bestEval, cls: r.cls } : null)).filter(Boolean);
  if (solved()) pts.push({ x: state.rows.length, y: state.rows.length, end: 'g' });
  else if (failed()) pts.push({ x: 6, y: 7, end: 'r' });
  const n = Math.max(...pts.map((p) => p.x), 1);
  const X = (x) => pl + (x / n) * (W - pl - pr);
  const Y = (y) => pt + ((Math.min(y, 7) - 1) / 6) * (H - pt - pb);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${path}L${X(pts.at(-1).x).toFixed(1)},${H - pb}L${X(pts[0].x).toFixed(1)},${H - pb}Z`;
  const grid = [1, 2, 3, 4, 5, 6].map((g) => `
    <line x1="${pl}" x2="${W - pr}" y1="${Y(g)}" y2="${Y(g)}" stroke="${g === PAR ? 'rgba(201,167,60,.55)' : 'rgba(255,255,255,.06)'}" ${g === PAR ? 'stroke-dasharray="4 4"' : ''}/>
    <text x="${pl - 8}" y="${Y(g) + 4}" text-anchor="end" fill="#5d6170" font-size="10" font-family="JetBrains Mono">${g}</text>`).join('');
  const xs = pts.map((p) => `<text x="${X(p.x)}" y="${H - 6}" text-anchor="middle" fill="#5d6170" font-size="10" font-family="JetBrains Mono">${p.x}</text>`).join('');
  const dots = pts.map((p) => {
    const col = p.end ? (p.end === 'g' ? '#4fa463' : '#fa412d') : CLASSES[p.cls]?.color || '#888';
    return `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="${col}" stroke="#14161d" stroke-width="2.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#eef0f5" stop-opacity=".22"/><stop offset="1" stop-color="#eef0f5" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xs}
    <path d="${area}" fill="url(#ga)"/>
    <path d="${path}" fill="none" stroke="#eef0f5" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

// ------------------------------------------------------------------ chrome

function toast(msg, ms = 1600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').prepend(t);
  setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove()); }, ms);
}

function shake(msg) {
  boardRows[state.rows.length]?.el.classList.add('shake');
  toast(msg);
}

function renderChrome() {
  const modes = $('.modes');
  modes.dataset.mode = state.mode;
  modes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)));
  $('#btn-undo').disabled = !state.rows.length && !state.cur.letters.length;
  $('#opt-hard').checked = state.hard;
  $('#opt-depth').value = state.depth;
  $('#opt-lines').value = state.lines;
}

function render() {
  renderChrome();
  renderBoard();
  renderKeyboard();
  renderHint();
  renderEvalBar();
  renderEngine();
  renderCands();
  renderMoves();
  save();
}

document.querySelectorAll('.modes button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
$('#btn-new').onclick = newGame;
$('#btn-undo').onclick = undo;
$('#btn-review').onclick = openReview;
$('#btn-help').onclick = () => $('#help').showModal();
$('#btn-peek').onclick = () => { state.peek = !state.peek; render(); };
$('#btn-settings').onclick = (e) => {
  const s = $('#settings');
  s.hidden = !s.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!s.hidden));
};
$('#opt-hard').onchange = (e) => {
  state.hard = e.target.checked;
  state.rows.forEach((_, i) => requestRating(i));
  requestAnalysis();
  render();
};
$('#opt-depth').onchange = (e) => { state.depth = e.target.value; requestAnalysis(); render(); };
$('#opt-lines').onchange = (e) => { state.lines = e.target.value; requestAnalysis(); render(); };
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

$('#help-classes').innerHTML = Object.entries(CLASSES).map(([k, c]) =>
  `<div class="help-item" style="--bc:${c.color}">${badge(k)}<b>${c.label}</b><span class="desc">${c.desc}</span></div>`).join('');

restore();
render();
