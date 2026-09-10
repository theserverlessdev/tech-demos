import { DurableObject } from "cloudflare:workers";

// The whole deck is one small document in synchronous KV storage.
const KEY = "deck";
const MAX_SLIDES = 30;
const MAX_BULLETS = 12;
const LAYOUTS = ["title", "bullets", "quote", "stat"];
const LIMITS = {
  deckTitle: 120,
  title: 160,
  subtitle: 240,
  bullet: 240,
  quote: 480,
  attribution: 120,
  stat: 24,
  caption: 240,
};
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const SEED = {
  title: "Cloudflare OS, sliced",
  slides: [
    {
      id: "intro",
      layout: "title",
      title: "Cloudflare OS, sliced",
      subtitle: "Gadgets on Dynamic Workers and Durable Object facets",
    },
    {
      id: "how",
      layout: "bullets",
      title: "How a gadget runs",
      bullets: [
        "server.js is a Durable Object class",
        "The Worker Loader loads it as a Dynamic Worker",
        "It runs as a facet with its own SQLite database",
        "client.js runs in a sandboxed iframe",
        "Cap'n Web RPC connects them over a MessagePort",
      ],
    },
    {
      id: "egress",
      layout: "stat",
      title: "Outbound network",
      stat: "0",
      caption: "network egress without a gatekeeper",
    },
    {
      id: "quote",
      layout: "quote",
      title: "The idea",
      quote: "Code that the agent writes gets its own storage and its own sandbox, and nothing else.",
      attribution: "Cloudflare OS design notes",
    },
  ],
};

function newId(taken) {
  let id;
  do id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  while (taken && taken.has(id));
  return id;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Trim, collapse whitespace, and cap length. Missing values become "".
function text(value, max, field) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function bulletList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("bullets must be an array of strings");
  return value
    .map((b, i) => text(b, LIMITS.bullet, `bullets[${i}]`))
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
}

// Build a clean slide from untrusted input. Optional fields are kept for
// every layout, so a layout switch does not lose content.
function normaliseSlide(input, taken) {
  if (!isObject(input)) throw new Error("A slide must be an object");
  const layout = input.layout === undefined ? "bullets" : input.layout;
  if (!LAYOUTS.includes(layout)) {
    throw new Error(`layout must be one of: ${LAYOUTS.join(", ")}`);
  }
  let id = typeof input.id === "string" ? input.id.trim() : "";
  if (!ID_RE.test(id) || taken.has(id)) id = newId(taken);
  taken.add(id);

  const slide = { id, layout, title: text(input.title, LIMITS.title, "title") };
  for (const field of ["subtitle", "quote", "attribution", "stat", "caption"]) {
    const v = text(input[field], LIMITS[field], field);
    if (v) slide[field] = v;
  }
  const bullets = bulletList(input.bullets);
  if (bullets.length) slide.bullets = bullets;
  return slide;
}

function normaliseDeck(input) {
  if (!isObject(input)) throw new Error("deck must be an object");
  if (!Array.isArray(input.slides)) throw new Error("deck.slides must be an array");
  if (input.slides.length < 1) throw new Error("A deck needs at least one slide");
  if (input.slides.length > MAX_SLIDES) {
    throw new Error(`A deck can have at most ${MAX_SLIDES} slides`);
  }
  const taken = new Set();
  return {
    title: text(input.title, LIMITS.deckTitle, "title") || "Untitled deck",
    slides: input.slides.map((s) => normaliseSlide(s, taken)),
  };
}

function toIndex(value, max, field) {
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) value = Number(value);
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return Math.max(0, Math.min(max, value));
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.subscribers = new Set();
  }

  #load() {
    const stored = this.ctx.storage.kv.get(KEY);
    if (isObject(stored) && Array.isArray(stored.slides) && stored.slides.length) return stored;
    const seed = structuredClone(SEED);
    this.ctx.storage.kv.put(KEY, seed);
    return seed;
  }

  #save(deck) {
    this.ctx.storage.kv.put(KEY, deck);
    this.#broadcast("deckChanged", deck);
    return deck;
  }

  #find(deck, id) {
    if (typeof id !== "string" || !id) throw new Error("id must be a non-empty string");
    const index = deck.slides.findIndex((s) => s.id === id);
    if (index < 0) throw new Error(`No slide with id "${id}"`);
    return index;
  }

  async getDeck() {
    return this.#load();
  }

  async setDeck(deck) {
    return this.#save(normaliseDeck(deck));
  }

  async setTitle(title) {
    const deck = this.#load();
    deck.title = text(title, LIMITS.deckTitle, "title") || "Untitled deck";
    return this.#save(deck);
  }

  async addSlide(slide, index) {
    const deck = this.#load();
    if (deck.slides.length >= MAX_SLIDES) {
      throw new Error(`A deck can have at most ${MAX_SLIDES} slides`);
    }
    const taken = new Set(deck.slides.map((s) => s.id));
    const clean = normaliseSlide(slide === undefined ? {} : slide, taken);
    const at =
      index === undefined || index === null
        ? deck.slides.length
        : toIndex(index, deck.slides.length, "index");
    deck.slides.splice(at, 0, clean);
    this.#save(deck);
    return clean;
  }

  async updateSlide(id, patch) {
    if (!isObject(patch)) throw new Error("patch must be an object");
    const deck = this.#load();
    const index = this.#find(deck, id);
    const current = deck.slides[index];
    const merged = { ...current, ...patch, id: current.id };
    const taken = new Set(deck.slides.filter((s) => s.id !== current.id).map((s) => s.id));
    const clean = normaliseSlide(merged, taken);
    deck.slides[index] = clean;
    this.#save(deck);
    return clean;
  }

  async removeSlide(id) {
    const deck = this.#load();
    const index = this.#find(deck, id);
    if (deck.slides.length === 1) throw new Error("A deck needs at least one slide");
    deck.slides.splice(index, 1);
    return this.#save(deck);
  }

  async moveSlide(id, toIndexValue) {
    const deck = this.#load();
    const from = this.#find(deck, id);
    const to = toIndex(toIndexValue, deck.slides.length - 1, "toIndex");
    if (from !== to) {
      const [slide] = deck.slides.splice(from, 1);
      deck.slides.splice(to, 0, slide);
    }
    return this.#save(deck);
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
