# Pixel Board

Pixel Board is a shared 32 by 32 pixel canvas. Each stroke is a Cap'n Web call into the Durable Object facet of the gadget, and every open viewer sees the change immediately. The agent can draw a full picture with one `paintMany` call.

## Coordinates

- The board has 32 columns and 32 rows.
- `x` is the column. It goes from `0` (left edge) to `31` (right edge).
- `y` is the row. It goes from `0` (top edge) to `31` (bottom edge).
- The origin `(0, 0)` is the top-left cell. The centre of the board is near `(15, 15)` and `(16, 16)`.
- A cell index is `idx = y * 32 + x`. The `pixels` array of `getBoard()` uses this order.

## Palette

`color` is an integer palette index.

| Index | Name | Hex |
|---|---|---|
| `-1` | Empty (erase) | none |
| `0` | Ember | `#c2410c` |
| `1` | Ember light | `#e2622e` |
| `2` | Amber | `#f59e0b` |
| `3` | Green | `#4d9e6a` |
| `4` | Teal | `#2f7d8c` |
| `5` | Blue | `#3b5bdb` |
| `6` | Violet | `#7c4dff` |
| `7` | Red | `#d0533f` |
| `8` | Bone (near white) | `#e8e8e4` |
| `9` | Grey | `#8a8a85` |
| `10` | Graphite (dark grey) | `#3a3a40` |
| `11` | Ink (near black) | `#0e0e11` |

## Methods

- `getBoard()` returns `{ size: 32, palette: string[], pixels: number[], painted: number, contributors: string[] }`.
  `pixels` has 1024 entries in `idx` order, and `-1` is an empty cell. `painted` is the number of cells that are not empty.
  `contributors` has the distinct `by` names on the board, most recent first, with a maximum of 20.
- `paint(x: number, y: number, color: number, by?: string)` returns `{ applied: number }`.
  It paints one cell. It throws a `RangeError` if `x`, `y` or `color` is not an integer in range.
- `paintMany(points: Array<{ x: number, y: number, color: number }>, by?: string)` returns `{ applied: number }`.
  It paints a maximum of 1024 points in one call, and it throws if `points` has more than 1024 entries.
  It skips invalid points. If two points hit the same cell, the last point wins.
  `applied` is the number of distinct cells that the call wrote. Use `color: -1` to erase a cell.
- `drawPreset(name: string, color?: number, accent?: number, by?: string)` returns `{ applied: number }`.
  It clears the board and draws a named picture: `bolt`, `heart`, `star`, `smile`, `cloud`, or `logo` (the theserverless.dev cloud and bolt). `color` is the main palette index (default `0`, Ember). `accent` is the second colour (default `2`, Amber). **Use this first for any of these shapes.**
- `paintRects(rects: Array<{ x: number, y: number, w: number, h: number, color: number }>, by?: string)` returns `{ applied: number }`.
  It fills a maximum of 64 rectangles. Use it for blocky shapes, letters, and backgrounds.
- `listPresets()` returns the preset names.
- `clear()` returns `{ cleared: number }`. It erases all cells. `cleared` is the number of cells that had a colour.
- `subscribe(callback: RpcTarget)` returns nothing. The callback receives these calls:
  - `pixelsChanged({ changes: Array<{ idx: number, color: number }>, painted: number, contributors: string[] })` after each write.
  - `boardCleared()` after `clear()`.

## Notes for the agent

- For a bolt, heart, star, smile, cloud, or the logo, call `drawPreset`. For other pictures, use `paintRects` with a few large rectangles.
- Send a full drawing in one call. Every viewer then sees the picture appear at the same time.
- Set `by` to a short name, for example `"Agent"`. Viewers see this name in the contributors list. The default name is `"anonymous"`.
- Coordinates and colours must be integers. The call skips a point with a string such as `"4"`.
- Call `getBoard()` first if the picture must fit around the cells that people already painted.
