#!/usr/bin/env python3
"""
Wordle engine -- a "Stockfish for Wordle".

Evaluation   : expected number of guesses still needed to solve (lower is better),
               like a chess eval but measured in guesses instead of pawns.
Search       : depth-limited expectimax over feedback patterns. At each node the
               engine ranks every legal guess with a fast 1-ply heuristic, then
               searches the most promising `width` of them `depth` plies deep,
               with alpha cut-offs from an admissible lower bound.
Heuristics   : entropy (bits of information), expected candidates left,
               worst-case bucket, chance of winning on this guess.

Usage
  py wordle_engine.py                       interactive mode (type `help`)
  py wordle_engine.py salet:bbyg- courd:...  analyse a position and exit
  py wordle_engine.py --bench               solve every answer, show stats
  py wordle_engine.py --play cigar          watch the engine solve a word

Feedback strings: g/2/🟩 = green, y/1/🟨 = yellow, b/x/0/-/./⬛/⬜ = gray.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS_DIR = os.path.join(HERE, "words")
WIN = 242                     # all-green pattern: 2 * (1 + 3 + 9 + 27 + 81)
SMALL = 40                    # candidate-set size where pairwise counting beats bincount
LEAF_SLOPE = 0.14             # leaf estimate: h(n) = 2 - 1/n + LEAF_SLOPE * log2(n/2)

FEEDBACK_CHARS = {
    "g": 2, "2": 2, "🟩": 2,
    "y": 1, "1": 1, "🟨": 1,
    "b": 0, "x": 0, "0": 0, "-": 0, ".": 0, "⬛": 0, "⬜": 0,
}


# --------------------------------------------------------------------------- words

def load_words(name):
    with open(os.path.join(WORDS_DIR, name), encoding="utf-8") as f:
        return [w.strip().lower() for w in f if w.strip()]


def encode(words):
    return np.array([[ord(c) - 97 for c in w] for w in words], dtype=np.uint8)


def pattern_matrix(guesses, answers, chunk=400):
    """M[g, a] = feedback pattern (base-3 int, position i has weight 3**i)."""
    g, a = encode(guesses), encode(answers)
    out = np.empty((len(g), len(a)), dtype=np.uint8)
    pw = (3 ** np.arange(5)).astype(np.uint16)
    idx = np.arange(5)
    before = np.tril(np.ones((5, 5), dtype=bool), k=-1)       # before[i, j] = j < i
    for s in range(0, len(g), chunk):
        gc = g[s:s + chunk]
        eq = gc[:, None, :, None] == a[None, :, None, :]       # (C, A, i, j): guess[i] == answer[j]
        green = eq[:, :, idx, idx]                             # (C, A, 5)
        free = ~green
        # unmatched copies of guess[i]'s letter left in the answer
        avail = (eq & free[:, :, None, :]).sum(3)
        # earlier non-green copies of the same letter in the guess (they claim yellows first)
        same = (gc[:, :, None] == gc[:, None, :]) & before     # (C, i, j)
        prev = (same[:, None] & free[:, :, None, :]).sum(3)
        yellow = free & (prev < avail)
        digits = 2 * green.astype(np.uint16) + yellow
        out[s:s + chunk] = (digits * pw).sum(2)
    return out


def load_matrix(guesses, answers):
    path = os.path.join(WORDS_DIR, "patterns.npy")
    if os.path.exists(path):
        M = np.load(path)
        if M.shape == (len(guesses), len(answers)):
            return M
    print("Building pattern table (one-time)...", file=sys.stderr)
    M = pattern_matrix(guesses, answers)
    np.save(path, M)
    return M


def parse_feedback(text):
    digits = []
    for ch in text.strip():
        if ch in "️ ":
            continue
        if ch.lower() not in FEEDBACK_CHARS:
            raise ValueError(f"bad feedback character {ch!r}")
        digits.append(FEEDBACK_CHARS[ch.lower()])
    if len(digits) != 5:
        raise ValueError("feedback must have exactly 5 tiles")
    return sum(d * 3 ** i for i, d in enumerate(digits))


def digits_of(pat):
    return [(pat // 3 ** i) % 3 for i in range(5)]


COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def show(word, pat):
    if not COLOR:
        return f"{word}[{''.join('-yg'[d] for d in digits_of(pat))}]"
    bg = {0: "100", 1: "43", 2: "42"}
    return "".join(f"\x1b[1;97;{bg[d]}m {c.upper()} \x1b[0m" for c, d in zip(word, digits_of(pat)))


# -------------------------------------------------------------------------- engine

class Engine:
    def __init__(self, answers, allowed, hard=False):
        self.answers = answers
        # answers come first, so answer i is also guess i
        seen = set(answers)
        self.words = answers + [w for w in allowed if w not in seen]
        self.index = {w: i for i, w in enumerate(self.words)}
        self.letters = encode(self.words)
        self.M = load_matrix(self.words, answers)
        self.A = len(answers)
        self.hard = hard
        self.memo = {}

        c = np.arange(self.A + 1, dtype=np.float64)
        h = np.zeros_like(c)
        h[1], h[2] = 1.0, 1.5
        h[3:] = 2 - 1 / c[3:] + LEAF_SLOPE * np.log2(c[3:] / 2)
        self.h = h                                  # leaf estimate of guesses to solve n words
        self.ch = c * h
        self.log2c = np.log2(np.maximum(c, 1))
        self.clog = c * self.log2c
        self.c2 = c * c

    # ---- positions

    def root(self):
        return np.arange(self.A, dtype=np.int32), np.arange(len(self.words), dtype=np.int32)

    def apply(self, S, pool, g, pat):
        S = S[self.M[g, S] == pat]
        if self.hard:
            pool = self.hard_filter(pool, g, pat)
        return S, pool

    def hard_filter(self, pool, g, pat):
        """NYT hard mode: greens stay put, revealed letters must be reused."""
        d = digits_of(pat)
        word = self.letters[g]
        L = self.letters[pool]
        keep = np.ones(len(pool), dtype=bool)
        need = {}
        for i in range(5):
            if d[i] == 2:
                keep &= L[:, i] == word[i]
            if d[i]:
                need[word[i]] = need.get(word[i], 0) + 1
        for letter, k in need.items():
            keep &= (L == letter).sum(1) >= k
        return pool[keep]

    # ---- static evaluation (1 ply)

    def one_ply(self, S, pool):
        """For every guess in pool: expected guesses (leaf estimate), entropy bits,
        expected candidates left, worst-case bucket."""
        n, P = len(S), len(pool)
        exp, ent, left = np.empty(P), np.empty(P), np.empty(P)
        worst = np.empty(P, dtype=np.int64)
        logn = math.log2(n)
        step = max(1, 3_000_000 // (n * n)) if n <= SMALL else max(1, 6_000_000 // n)
        for s in range(0, P, step):
            sub = self.M[pool[s:s + step, None], S[None, :]]
            e = s + len(sub)
            if n <= SMALL:
                c = (sub[:, :, None] == sub[:, None, :]).sum(2)
                hv = self.h[c]
                hv[sub == WIN] = 0
                exp[s:e] = 1 + hv.sum(1) / n
                ent[s:e] = logn - self.log2c[c].sum(1) / n
                left[s:e] = c.sum(1) / n
                worst[s:e] = c.max(1)
            else:
                B = len(sub)
                flat = (np.arange(B, dtype=np.int64) * 243)[:, None] + sub
                cnt = np.bincount(flat.ravel(), minlength=B * 243).reshape(B, 243)
                hc = self.ch[cnt]
                exp[s:e] = 1 + (hc.sum(1) - hc[:, WIN]) / n
                ent[s:e] = logn - self.clog[cnt].sum(1) / n
                left[s:e] = self.c2[cnt].sum(1) / n
                worst[s:e] = cnt.max(1)
        return exp, ent, left, worst

    def rank(self, S, pool, exp, ent):
        cand = np.zeros(len(self.words), dtype=bool)
        cand[S] = True
        return np.lexsort((~cand[pool], -ent, np.round(exp, 9)))

    # ---- search

    def value(self, S, pool, depth, width):
        """(expected guesses to solve S, best guess)."""
        n = len(S)
        if n <= 2:
            return (1.0 if n == 1 else 1.5), int(S[0])
        key = (S.tobytes(), depth, width, pool.tobytes() if self.hard else None)
        hit = self.memo.get(key)
        if hit:
            return hit
        exp, ent, _, _ = self.one_ply(S, pool)
        order = self.rank(S, pool, exp, ent)
        best_v, best_g = float(exp[order[0]]), int(pool[order[0]])
        if depth > 1:
            best_v = math.inf
            for i in order[:width]:
                v = self.expect(S, int(pool[i]), pool, depth - 1, width, best_v)
                if v < best_v:
                    best_v, best_g = v, int(pool[i])
        self.memo[key] = (best_v, best_g)
        return best_v, best_g

    def buckets(self, S, g):
        pats = self.M[g, S]
        order = np.argsort(pats, kind="stable")
        sp = pats[order]
        cuts = np.flatnonzero(np.diff(sp)) + 1
        groups = [(int(sp[a]), S[order[a:b]])
                  for a, b in zip(np.r_[0, cuts], np.r_[cuts, len(S)]) if sp[a] != WIN]
        groups.sort(key=lambda t: -len(t[1]))
        return groups

    def expect(self, S, g, pool, depth, width, alpha=math.inf):
        """Expected guesses to solve S starting with guess g (inf if it can't beat alpha)."""
        n = len(S)
        groups = self.buckets(S, g)
        # admissible lower bound for a bucket of c words: 2 - 1/c
        rest = sum(len(b) * (2 - 1 / len(b)) for _, b in groups) / n
        total = 1.0
        for pat, sub in groups:
            c = len(sub)
            rest -= c * (2 - 1 / c) / n
            child_pool = self.hard_filter(pool, g, pat) if self.hard else pool
            v, _ = self.value(np.sort(sub), child_pool, depth, width)
            total += c / n * v
            if total + rest >= alpha:
                return math.inf
        return total

    def analyse(self, S, pool, depth=2, width=12, multipv=5):
        """Top `multipv` lines. Opening analysis is cached in words/book.json."""
        if len(S) == self.A and len(pool) == len(self.words):
            path = os.path.join(WORDS_DIR, "book.json")
            book = json.load(open(path)) if os.path.exists(path) else {}
            key = f"{depth}/{width}/{multipv}/{LEAF_SLOPE}"
            if key not in book:
                book[key] = self._analyse(S, pool, depth, width, multipv)
                json.dump(book, open(path, "w"))
            return book[key]
        return self._analyse(S, pool, depth, width, multipv)

    def _analyse(self, S, pool, depth, width, multipv):
        exp, ent, left, worst = self.one_ply(S, pool)
        order = self.rank(S, pool, exp, ent)
        inner = max(3, width // 2)
        lines = []
        for i in order[:max(width, multipv)]:
            g = int(pool[i])
            if depth <= 1 or len(S) <= 2:
                v = float(exp[i])
            else:
                alpha = sorted(l["eval"] for l in lines)[multipv - 1] if len(lines) >= multipv else math.inf
                v = self.expect(S, g, pool, depth - 1, inner, alpha)
                if v == math.inf:
                    continue
            lines.append(dict(move=self.words[g], g=g, eval=v, bits=float(ent[i]),
                              left=float(left[i]), worst=int(worst[i]),
                              win=(1 / len(S)) if g < self.A and g in set(S.tolist()) else 0.0))
        lines.sort(key=lambda l: (l["eval"], -l["bits"]))
        return lines[:multipv]

    def pv(self, S, pool, g, depth, width, plies=6):
        """Principal variation: follow the most likely (largest) feedback bucket."""
        out = []
        inner = max(3, width // 2)
        while plies and len(S) > 1:
            groups = self.buckets(S, g)
            if not groups:
                break
            pat, sub = groups[0]
            out.append((self.words[g], pat))
            S = np.sort(sub)
            pool = self.hard_filter(pool, g, pat) if self.hard else pool
            _, g = self.value(S, pool, max(depth - 1, 1), inner)
            plies -= 1
        if len(S) == 1:
            out.append((self.words[int(S[0])], WIN))
        return out

    def best_move(self, S, pool, depth, width):
        if len(S) <= 2:
            return int(S[0])
        key = ("root", S.tobytes(), depth, width, pool.tobytes() if self.hard else None)
        if key not in self.memo:
            self.memo[key] = self.analyse(S, pool, depth, width, multipv=1)[0]["g"]
        return self.memo[key]


# ------------------------------------------------------------------------ frontend

def print_analysis(eng, S, pool, history, depth, width, multipv):
    n = len(S)
    print(f"\nposition: guess {len(history) + 1}, {n} candidate{'s' * (n != 1)} "
          f"({math.log2(n):.2f} bits){'  [hard mode]' if eng.hard else ''}")
    if n == 0:
        print("no words match that feedback -- check what you typed")
        return
    if n <= 12:
        print("candidates: " + " ".join(eng.words[i] for i in S))
    t = time.time()
    lines = eng.analyse(S, pool, depth, width, multipv)
    dt = time.time() - t
    print(f"\n  #  move    eval   bits  E[left]  worst   win%")
    for k, l in enumerate(lines, 1):
        print(f" {k:>2}  {l['move']}  {l['eval']:5.3f}  {l['bits']:5.2f}  {l['left']:7.1f}  "
              f"{l['worst']:5d}  {100 * l['win']:5.1f}")
    best = lines[0]
    pv = eng.pv(S, pool, best["g"], depth, width)
    print(f"\nbestmove {best['move']}   (expect to finish in {len(history) + best['eval']:.2f} "
          f"guesses total; depth {depth}, {dt:.1f}s)")
    print("pv  " + "  ".join(show(w, p) for w, p in pv))


HELP = """commands:
  <word> <feedback>     enter a guess and its colours, e.g.  salet bbyg-
  go [d N] [w N] [m N]  analyse (depth, width, multipv); just pressing Enter also works
  list                  show remaining candidate answers
  undo | new            take back last guess | start over
  hard on|off           toggle hard mode
  play <answer>         watch the engine solve a word
  depth N / width N     change default search settings
  quit"""


def play(eng, secret, depth, width, opener=None):
    if secret not in eng.index or eng.index[secret] >= eng.A:
        print(f"{secret!r} is not in the answer list")
        return None
    S, pool = eng.root()
    a = eng.index[secret]
    trace = []
    while True:
        g = eng.index[opener] if (opener and not trace) else eng.best_move(S, pool, depth, width)
        pat = int(eng.M[g, a])
        trace.append((eng.words[g], pat))
        if pat == WIN:
            return trace
        S, pool = eng.apply(S, pool, g, pat)


def bench(eng, depth, width, limit=None, opener=None):
    words = eng.answers[:limit] if limit else eng.answers
    dist = {}
    t = time.time()
    fails = []
    for k, w in enumerate(words, 1):
        n = len(play(eng, w, depth, width, opener))
        dist[n] = dist.get(n, 0) + 1
        if n > 6:
            fails.append(w)
        if k % 250 == 0:
            print(f"  {k}/{len(words)} ...", file=sys.stderr)
    total = sum(k * v for k, v in dist.items())
    print(f"solved {len(words)} words: average {total / len(words):.4f} guesses, "
          f"{len(fails)} failures, {time.time() - t:.0f}s")
    for k in sorted(dist):
        print(f"  {k}: {dist[k]:5d}  {'#' * max(1, round(60 * dist[k] / len(words)))}")
    if fails:
        print("failed: " + " ".join(fails))


def repl(eng, depth, width, multipv):
    history = []

    def position():
        S, pool = eng.root()
        for g, p in history:
            S, pool = eng.apply(S, pool, g, p)
        return S, pool

    print("Wordle engine. Type `help` for commands. Enter a guess + feedback, e.g.  salet bbyg-")
    print_analysis(eng, *position(), history, depth, width, multipv)
    while True:
        try:
            line = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        parts = line.split()
        cmd = parts[0].lower() if parts else "go"
        try:
            if cmd in ("quit", "exit", "q"):
                return
            elif cmd == "help":
                print(HELP)
            elif cmd == "go":
                opts = dict(zip(parts[1::2], parts[2::2]))
                print_analysis(eng, *position(), history, int(opts.get("d", depth)),
                               int(opts.get("w", width)), int(opts.get("m", multipv)))
            elif cmd in ("depth", "width") and len(parts) == 2:
                if cmd == "depth":
                    depth = int(parts[1])
                else:
                    width = int(parts[1])
                print(f"depth {depth}, width {width}")
            elif cmd == "list":
                S, _ = position()
                print(f"{len(S)} candidates:\n" + " ".join(eng.words[i] for i in S))
            elif cmd == "undo":
                if history:
                    history.pop()
                print_analysis(eng, *position(), history, depth, width, multipv)
            elif cmd == "new":
                history.clear()
                print_analysis(eng, *position(), history, depth, width, multipv)
            elif cmd == "hard" and len(parts) == 2:
                eng.hard = parts[1].lower() in ("on", "1", "true")
                eng.memo.clear()
                print_analysis(eng, *position(), history, depth, width, multipv)
            elif cmd == "play" and len(parts) >= 2:
                trace = play(eng, parts[1].lower(), depth, width, parts[2].lower() if len(parts) > 2 else None)
                if trace:
                    print("\n".join(show(w, p) for w, p in trace))
                    print(f"solved in {len(trace)}")
            elif len(parts) >= 2 and len(parts[0]) == 5:
                word = parts[0].lower()
                if word not in eng.index:
                    print(f"{word!r} is not a valid Wordle guess")
                    continue
                pat = parse_feedback("".join(parts[1:]))
                history.append((eng.index[word], pat))
                print("  ".join(show(eng.words[g], p) for g, p in history))
                if pat == WIN:
                    print(f"solved in {len(history)}!  (`new` to start again)")
                    continue
                print_analysis(eng, *position(), history, depth, width, multipv)
            else:
                print("unknown command -- type `help`")
        except ValueError as e:
            print(f"error: {e}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Wordle engine (expectimax search over feedback).")
    ap.add_argument("moves", nargs="*", help="history as word:feedback, e.g. salet:bbyg-")
    ap.add_argument("--depth", type=int, default=2, help="search depth in guesses (default 2)")
    ap.add_argument("--width", type=int, default=12, help="moves searched at the root (default 12)")
    ap.add_argument("--multipv", type=int, default=5, help="lines to show (default 5)")
    ap.add_argument("--hard", action="store_true", help="hard mode")
    ap.add_argument("--bench", nargs="?", const=0, type=int, metavar="N", help="solve all (or first N) answers")
    ap.add_argument("--play", metavar="ANSWER", help="watch the engine solve ANSWER")
    ap.add_argument("--opener", help="force the first guess in --play / --bench")
    args = ap.parse_args()

    eng = Engine(load_words("answers.txt"), load_words("allowed.txt"), hard=args.hard)

    if args.bench is not None:
        bench(eng, args.depth, args.width, args.bench or None, args.opener)
    elif args.play:
        trace = play(eng, args.play.lower(), args.depth, args.width, args.opener)
        if trace:
            print("\n".join(show(w, p) for w, p in trace))
            print(f"solved in {len(trace)}")
    elif args.moves:
        S, pool = eng.root()
        history = []
        for m in args.moves:
            word, _, fb = m.replace("=", ":").partition(":")
            g, pat = eng.index[word.lower()], parse_feedback(fb)
            history.append((g, pat))
            S, pool = eng.apply(S, pool, g, pat)
        print_analysis(eng, S, pool, history, args.depth, args.width, args.multipv)
    else:
        repl(eng, args.depth, args.width, args.multipv)


if __name__ == "__main__":
    main()
