# Migrations

This demo does not use D1. Each visitor's thread and recall index live in that visitor's Durable Object SQLite database, created in `Assistant.onStart`. Note bodies live in R2 under `v/<visitorId>/`.

The Durable Object class migration is the `migrations` array in `wrangler.jsonc` (`new_sqlite_classes: ["Assistant"]`).
