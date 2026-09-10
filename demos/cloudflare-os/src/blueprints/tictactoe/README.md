# Tic-tac-toe

A shared tic-tac-toe board with a running score. The Durable Object keeps the game and the scores in its facet SQLite database, so every open tab plays on the same board. X always starts a new game, and `bestMove()` gives the move of a perfect minimax player.

## Methods

Types: cells are indexes `0` to `8`, left to right and top to bottom (`0 1 2` / `3 4 5` / `6 7 8`). `State = { board: ("" | "X" | "O")[9], turn: "X" | "O", winner: "" | "X" | "O" | "draw", line: number[], moves: number, scores: { X: number, O: number, draw: number }, lastMove: { index: number, player: "X" | "O", by: string } | null }`. `line` holds the 3 winning indexes, or `[]` when nobody has won.

- `getState()` returns the current `State`.
- `move(index: number, by?: string)` places the mark of the side to move (`turn`) on cell `index`, records `by` (a display name, 40 characters at most) in `lastMove`, and returns the new `State`. It throws an `Error` when `index` is not an integer from 0 to 8, when the cell is taken, or when the game is over.
- `reset()` clears the board for a new game with X to move, keeps the scores, and returns the new `State`.
- `resetScores()` sets all scores to 0, keeps the board, and returns the new `State`.
- `bestMove()` returns the index that a perfect minimax player picks for the side to move, or `-1` when the game is over. It does not play the move; call `move(index)` to play it.
- `subscribe(callback)` registers an `RpcTarget`; its `stateChanged(state: State)` method receives the full state after each change.
