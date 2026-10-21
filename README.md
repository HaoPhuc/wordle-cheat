GOAL: Try to predict the best moves for Wordle like chess

After a few rounds of Wordle, I managed to come up with, in my opinion, a quite decent strategy: NIGHT --> SCARF --> BULKY --> VOWEL --> GUESS --> GUESS. It tests all the vowels and only repeats 1 letter - L - so for the last 2 guesses you can narrow down the options by a lot. However, I know that there are better strategies out there and want to see what an AI model will come up with. Also, I would want to see how many bad guesses can it come back from.

Still, this is just yet an idea. I am in a middle of many things. I will come back to this project when the time is available.

## Wordfish

A Stockfish-style engine for Wordle, with a website that rates your guesses the way chess.com rates moves.

- **Eval** = expected number of guesses still needed to solve (lower is better).
- **Search** = depth-limited expectimax over every feedback pattern a guess could get, with alpha cut-offs.
- **Ratings** = like chess.com: each guess is graded by how much expected score (here: guesses) it gave up
  compared with the best move: Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Blunder.

Playing every one of the 2,315 original answers, the engine averages **3.424 guesses** and never fails
(the proven optimum is about 3.421).

### Website

Everything runs in your browser (the engine is in a web worker), but it has to be served over http:

```bash
py -m http.server 5173
```

Then open http://127.0.0.1:5173.

- **Solve**: type the word you played in Wordle, tap the tiles until the colours match, press Enter.
  The engine suggests the next guess and rates the one you played.
- **Practice**: guess a hidden word with the engine hidden, then get a game review with accuracy and an eval graph.

It is a static site (`index.html`, `css/`, `js/`, `words/`), so it can be hosted as-is on GitHub Pages.

### Command line

`wordle_engine.py` is the original Python engine (needs numpy):

```bash
py wordle_engine.py                         # interactive
py wordle_engine.py salet:-y-g- courd:--g-- # analyse a position
py wordle_engine.py --bench                 # solve every answer
py wordle_engine.py --play cigar            # watch it solve a word
```

Word lists are the original Wordle answer list (2,315) and allowed guesses (~13k). The NYT has edited the
answer list since, so a few recent answers may be missing.
