import { DurableObject } from "cloudflare:workers";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
// Search order for ties: centre, corners, edges.
const PREFERENCE = [4, 0, 2, 6, 8, 1, 3, 5, 7];
const MAX_NAME = 40;

// The board is stored as a 9-character string. "." is an empty cell.
const encode = (board) => board.map((c) => c || ".").join("");
const decode = (text) => [...text].map((c) => (c === "." ? "" : c));

function outcome(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line };
  }
  if (board.every(Boolean)) return { winner: "draw", line: [] };
  return { winner: "", line: [] };
}

// Negamax: the value of a position for the side to move. Each ply moves the
// value one step toward 0, so a faster win and a slower loss score higher.
const memo = new Map();
function negamax(board, player) {
  const key = encode(board) + player;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const { winner } = outcome(board);
  let value;
  if (winner === "draw") value = 0;
  else if (winner) value = -10; // The other player completed a line.
  else {
    value = -Infinity;
    const other = player === "X" ? "O" : "X";
    for (const i of PREFERENCE) {
      if (board[i]) continue;
      board[i] = player;
      value = Math.max(value, -negamax(board, other));
      board[i] = "";
    }
  }
  if (value > 0) value -= 1;
  else if (value < 0) value += 1;
  memo.set(key, value);
  return value;
}

function bestIndex(board, player) {
  if (outcome(board).winner) return -1;
  const other = player === "X" ? "O" : "X";
  let best = -1;
  let bestScore = -Infinity;
  for (const i of PREFERENCE) {
    if (board[i]) continue;
    board[i] = player;
    const s = -negamax(board, other);
    board[i] = "";
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

function parseIndex(index) {
  if (typeof index === "string" && /^\s*\d+\s*$/.test(index)) index = Number(index);
  if (!Number.isInteger(index) || index < 0 || index > 8) {
    throw new Error("index must be an integer from 0 to 8 (cells are numbered left to right, top to bottom)");
  }
  return index;
}

function parseName(by) {
  if (by === undefined || by === null) return "";
  if (typeof by !== "string") throw new Error("by must be a string");
  return by.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.subscribers = new Set();
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS game (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      board TEXT NOT NULL,
      turn TEXT NOT NULL,
      winner TEXT NOT NULL,
      line TEXT NOT NULL,
      moves INTEGER NOT NULL,
      last_index INTEGER,
      last_player TEXT,
      last_by TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      x INTEGER NOT NULL DEFAULT 0,
      o INTEGER NOT NULL DEFAULT 0,
      draw INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`INSERT OR IGNORE INTO game (id, board, turn, winner, line, moves) VALUES (1, '.........', 'X', '', '[]', 0)`);
    sql.exec(`INSERT OR IGNORE INTO scores (id) VALUES (1)`);
  }

  #transaction(fn) {
    const storage = this.ctx.storage;
    return typeof storage.transactionSync === "function" ? storage.transactionSync(fn) : fn();
  }

  #read() {
    const sql = this.ctx.storage.sql;
    const g = sql.exec("SELECT * FROM game WHERE id = 1").one();
    const s = sql.exec("SELECT x, o, draw FROM scores WHERE id = 1").one();
    return {
      board: decode(g.board),
      turn: g.turn,
      winner: g.winner,
      line: JSON.parse(g.line),
      moves: g.moves,
      scores: { X: s.x, O: s.o, draw: s.draw },
      lastMove: g.last_index === null ? null : { index: g.last_index, player: g.last_player, by: g.last_by || "" },
    };
  }

  #changed() {
    const state = this.#read();
    this.#broadcast("stateChanged", state);
    return state;
  }

  async getState() {
    return this.#read();
  }

  async move(index, by) {
    const cell = parseIndex(index);
    const name = parseName(by);
    this.#transaction(() => {
      const state = this.#read();
      if (state.winner === "draw") throw new Error("The game ended in a draw. Call reset() to start a new game.");
      if (state.winner) throw new Error(`The game is over: ${state.winner} won. Call reset() to start a new game.`);
      if (state.board[cell]) throw new Error(`Cell ${cell} is already taken by ${state.board[cell]}.`);

      const player = state.turn;
      const board = state.board.slice();
      board[cell] = player;
      const { winner, line } = outcome(board);
      const sql = this.ctx.storage.sql;
      sql.exec(
        `UPDATE game SET board = ?, turn = ?, winner = ?, line = ?, moves = ?, last_index = ?, last_player = ?, last_by = ? WHERE id = 1`,
        encode(board), player === "X" ? "O" : "X", winner, JSON.stringify(line), state.moves + 1, cell, player, name,
      );
      // The game finishes on this move only, so each game counts once.
      if (winner === "X") sql.exec("UPDATE scores SET x = x + 1 WHERE id = 1");
      else if (winner === "O") sql.exec("UPDATE scores SET o = o + 1 WHERE id = 1");
      else if (winner === "draw") sql.exec("UPDATE scores SET draw = draw + 1 WHERE id = 1");
    });
    return this.#changed();
  }

  async reset() {
    this.ctx.storage.sql.exec(
      `UPDATE game SET board = '.........', turn = 'X', winner = '', line = '[]', moves = 0,
        last_index = NULL, last_player = NULL, last_by = NULL WHERE id = 1`,
    );
    return this.#changed();
  }

  async resetScores() {
    this.ctx.storage.sql.exec("UPDATE scores SET x = 0, o = 0, draw = 0 WHERE id = 1");
    return this.#changed();
  }

  async bestMove() {
    const state = this.#read();
    return bestIndex(state.board, state.turn);
  }

  async subscribe(callback) {
    const dup = callback.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
  }

  #broadcast(method, value) {
    for (const s of this.subscribers) {
      Promise.resolve()
        .then(() => s[method](value))
        .catch(() => this.subscribers.delete(s));
    }
  }
}
