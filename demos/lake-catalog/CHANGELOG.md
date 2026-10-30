# Changelog — lake-catalog vs quacklake

This demo is based on [tobilg/quacklake](https://github.com/tobilg/quacklake) (MIT, alpha). Upstream is a catalog service with OIDC, an admin API, DuckLake metadata shims, and optional R2 leases. This folder is a short read-only demo on the same idea.

## Architecture

| | quacklake | This demo |
| --- | --- | --- |
| Protocol | Quack `POST /quack` via `@quack-protocol/sdk` | Same SDK, protocol v3, with a bound `fetch` for Workers and browsers |
| Catalogs | `CatalogRegistry` plus one `QuackCatalogObject` per catalog | `CatalogRegistry` plus one `QuackCatalog` per catalog |
| Auth | First-party JWT and OIDC (Cognito, Entra) | Three demo roles in a ten-minute HS256 JWT |
| Policy | Rule documents, explain output | Allow, deny, or rewrite for `orders`, with the SQL that ran |
| Data | Planned DuckLake `DATA_PATH` in R2, client-side scans | Sample Parquet written to R2 and mirrored into the catalog SQLite |
| SQL | DuckDB-to-SQLite rewrites and DuckLake metadata | One `SELECT` against the sample tables |
| Visitors | Admin API and DuckDB CLI | Turnstile, a role picker, and a copy-paste CLI snippet |

## What we cut

- OIDC, JWKS, Cognito, and Entra
- Admin API and OpenAPI
- Trusted-client R2 credential leases
- DuckLake metadata, transactions, and append
- Workers for Platforms

## What we kept

- Quack connection, prepare, fetch, heartbeat, and disconnect
- A registry Durable Object that names catalogs and counts a daily cap
- One SQLite Durable Object per catalog
- Server-side row and column policy before any rows are returned
- An R2 data path, reseeded by the midnight cron

## 2026-10-30

First demo. Analyst sees the full `orders` table. Viewer gets a masked `customer` column and no `restricted` rows. Guest is denied when the statement names `customer` or `revenue`, and a public-column guest query uses the same row rule as viewer.

Requests do not write R2. The cron publishes Parquet. SQLite is seeded only when the table is empty or the UTC day marker is stale. `/status` is a count. The page map does not wake the catalog objects. A filter on a column the role cannot read is denied.
