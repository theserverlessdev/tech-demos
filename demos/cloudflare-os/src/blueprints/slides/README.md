# Slides

A small slide deck with four layouts: `title`, `bullets`, `quote`, and `stat`. The Durable Object keeps the deck as one document in `this.ctx.storage.kv` under the key `deck`, and it sends every change to all open tabs. People edit text directly on the slide, reorder slides in the rail, and present the deck full-bleed.

## Methods

Types: `Deck = { title: string, slides: Slide[] }` and `Slide = { id: string, layout: "title" | "bullets" | "quote" | "stat", title: string, subtitle?: string, bullets?: string[], quote?: string, attribution?: string, stat?: string, caption?: string }`. The `title` layout shows `title` and `subtitle`. The `bullets` layout shows `title` and `bullets` (12 at most). The `quote` layout shows `title` as a small label, `quote`, and `attribution`. The `stat` layout shows `title` as a small label, `stat` (24 characters at most), and `caption`. The server trims strings, drops empty optional fields and empty bullets, and keeps 1 to 30 slides. Indexes start at 0.

- `getDeck()` returns the `Deck`. The first call seeds a 4-slide deck.
- `setDeck(deck: Deck)` validates and replaces the whole deck, generates an `id` for each slide without a valid unique `id`, and returns the saved `Deck`.
- `setTitle(title: string)` sets the deck title and returns the saved `Deck`.
- `addSlide(slide: Partial<Slide>, index?: number)` inserts the slide at `index` (at the end when `index` is missing; `layout` defaults to `"bullets"`) and returns the saved `Slide` with its `id`.
- `updateSlide(id: string, patch: Partial<Slide>)` merges `patch` into the slide (a `""` value or `bullets: []` clears the field; `patch.id` is ignored) and returns the saved `Slide`.
- `removeSlide(id: string)` deletes the slide, throws if it is the last slide, and returns the saved `Deck`.
- `moveSlide(id: string, toIndex: number)` moves the slide to `toIndex` (clamped to the deck range) and returns the saved `Deck`.
- `subscribe(callback)` registers an `RpcTarget`; its `deckChanged(deck: Deck)` method receives the full deck after each change.
