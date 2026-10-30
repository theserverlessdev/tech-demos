import { columnsFor, type CatalogId, type Column, type ColumnKind } from "./rows";

export type Role = "analyst" | "viewer" | "guest";

export type Effect = "allow" | "deny" | "rewrite";

export type Explain = {
  effect: Effect;
  role: Role;
  catalog: CatalogId;
  reasons: string[];
  executedSql: string | null;
  columns: Column[];
};

const ROLES = new Set<Role>(["analyst", "viewer", "guest"]);
const WRITE = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|copy|call|grant|revoke|load|truncate|merge|analyze)\b/i;
const SENSITIVE = new Set(["revenue", "customer"]);

export function isRole(value: string): value is Role {
  return ROLES.has(value as Role);
}

export function isCatalog(value: string): value is CatalogId {
  return value === "orders" || value === "regions";
}

function deny(role: Role, catalog: CatalogId, reasons: string[]): Explain {
  return { effect: "deny", role, catalog, reasons, executedSql: null, columns: [] };
}

type Parsed = {
  columns: string[];
  where: string | null;
  limit: number | null;
};

function stripComments(sql: string): string | null {
  if (sql.includes("--") || sql.includes("/*") || sql.includes("*/")) return null;
  return sql;
}

/** Split on `separator` outside quotes. The separator is matched case-insensitively. */
function splitTop(input: string, separator: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  const needle = separator.toLowerCase();
  const lower = input.toLowerCase();
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (input[i + 1] === quote) {
          current += input[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      current += ch;
      continue;
    }
    if (lower.startsWith(needle, i)) {
      parts.push(current.trim());
      current = "";
      i += needle.length - 1;
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  parts.push(current.trim());
  return parts;
}

function readableNames(role: Role, catalog: CatalogId, known: Set<string>): Set<string> {
  if (catalog !== "orders" || role === "analyst") return known;
  const hidden = role === "guest" ? SENSITIVE : new Set(["customer"]);
  return new Set([...known].filter((name) => !hidden.has(name)));
}

function parseSelect(sql: string, table: string, known: Set<string>, readable: Set<string>): Parsed | { error: string } {
  const compact = sql.replace(/\s+/g, " ").trim();
  const fromParts = splitTop(compact, " from ");
  if (!fromParts || fromParts.length !== 2) return { error: `Use SELECT columns FROM ${table}.` };
  const [head, tail] = fromParts;
  if (!head || !tail || !/^select\s+/i.test(head)) return { error: `Use SELECT columns FROM ${table}.` };
  const projection = head.replace(/^select\s+/i, "").trim();
  let rest = tail;
  let where: string | null = null;
  let limit: number | null = null;
  const limitParts = splitTop(rest, " limit ");
  if (!limitParts) return { error: "The statement could not be read." };
  if (limitParts.length > 2) return { error: "Only one LIMIT is allowed." };
  if (limitParts.length === 2) {
    rest = limitParts[0] ?? "";
    const rawLimit = limitParts[1] ?? "";
    if (!/^\d+$/.test(rawLimit)) return { error: "LIMIT must be a whole number." };
    limit = Number(rawLimit);
    if (limit < 1 || limit > 100) return { error: "LIMIT must be from 1 to 100." };
  }
  const whereParts = splitTop(rest, " where ");
  if (!whereParts) return { error: "The statement could not be read." };
  if (whereParts.length > 2) return { error: "Only one WHERE is allowed." };
  if (whereParts.length === 2) {
    rest = whereParts[0] ?? "";
    where = whereParts[1] ?? "";
    if (!where) return { error: "WHERE needs a comparison." };
  }
  if (rest.toLowerCase() !== table) return { error: `This token queries ${table}.` };
  const pieces = splitTop(projection, ",");
  if (!pieces || pieces.some((piece) => piece.length === 0)) return { error: "The column list could not be read." };
  const columns: string[] = [];
  for (const piece of pieces) {
    const name = piece.toLowerCase();
    if (name === "*") {
      if (pieces.length !== 1) return { error: "Star must be the only selected item." };
      columns.push("*");
      continue;
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || !known.has(name)) {
      return { error: `Unknown column ${piece}.` };
    }
    columns.push(name);
  }
  if (where) {
    const check = checkWhere(where, known, readable);
    if (check) return { error: check };
  }
  return { columns, where, limit };
}

function checkWhere(where: string, known: Set<string>, readable: Set<string>): string | null {
  const terms = splitTop(where, " and ");
  if (!terms || terms.length === 0) return "WHERE needs a comparison.";
  for (const term of terms) {
    const match = /^([a-z_][a-z0-9_]*)\s*(=|<>|!=)\s*('(?:[^']|'')*'|-?\d+)$/i.exec(term);
    if (!match) return "Filters must compare a column to a number or a quoted string, joined with AND.";
    const column = (match[1] ?? "").toLowerCase();
    if (!known.has(column)) return `Unknown column ${match[1]}.`;
    if (!readable.has(column)) return `This role cannot filter on ${column}.`;
  }
  return null;
}

function quoteIdent(name: string): string {
  return name;
}

function projectionSql(names: string[], masked: Set<string>): string {
  return names
    .map((name) => (masked.has(name) ? `NULL AS ${quoteIdent(name)}` : quoteIdent(name)))
    .join(", ");
}

function finish(sql: string, where: string | null, limit: number | null, extra: string | null): string {
  let text = sql;
  const filters = [where, extra].filter((part): part is string => Boolean(part));
  if (filters.length) text += ` WHERE ${filters.join(" AND ")}`;
  if (limit !== null) text += ` LIMIT ${limit}`;
  return text;
}

export function decide(role: Role, rawSql: string, catalog: CatalogId): Explain {
  const stripped = stripComments(rawSql);
  if (stripped === null) return deny(role, catalog, ["Comments are not allowed in this demo."]);
  const sql = stripped.trim().replace(/;+\s*$/u, "");
  if (!sql) return deny(role, catalog, ["The query is empty."]);
  if (sql.includes(";")) return deny(role, catalog, ["Only one statement is allowed."]);
  if (WRITE.test(sql)) return deny(role, catalog, ["This catalog is read-only."]);
  if (!/^select\b/i.test(sql)) return deny(role, catalog, ["Only SELECT is allowed."]);

  const knownColumns = columnsFor(catalog);
  const known = new Set(knownColumns.map((column) => column.name));
  const parsed = parseSelect(sql, catalog, known, readableNames(role, catalog, known));
  if ("error" in parsed) return deny(role, catalog, [parsed.error]);

  const star = parsed.columns.length === 1 && parsed.columns[0] === "*";
  const selected = star ? knownColumns.map((column) => column.name) : parsed.columns;
  const reasons: string[] = [];
  const masked = new Set<string>();
  let extraWhere: string | null = null;
  let narrowed = selected;

  if (catalog === "orders" && role === "guest") {
    const explicit = selected.filter((name) => SENSITIVE.has(name));
    if (!star && explicit.length) {
      return deny(role, catalog, [`Guest cannot read ${explicit.join(" or ")}.`]);
    }
    if (star) {
      narrowed = selected.filter((name) => !SENSITIVE.has(name));
      reasons.push("Guest queries for every column are narrowed to region, product, and units.");
    }
  }

  if (catalog === "orders" && (role === "viewer" || role === "guest")) {
    if (role === "viewer" && narrowed.includes("customer")) {
      masked.add("customer");
      reasons.push("Viewer cannot see the customer column. It is returned as NULL.");
    }
    extraWhere = "region <> 'restricted'";
    reasons.push(
      role === "viewer"
        ? "Viewer cannot see rows where region is restricted."
        : "Guest cannot see rows where region is restricted.",
    );
  }

  const columns: Column[] = narrowed.map((name) => {
    const kind: ColumnKind = knownColumns.find((column) => column.name === name)?.kind ?? "text";
    return { name, kind };
  });
  const executedSql = finish(
    `SELECT ${projectionSql(narrowed, masked)} FROM ${catalog}`,
    parsed.where,
    parsed.limit,
    extraWhere,
  );
  const effect: Effect = reasons.length ? "rewrite" : "allow";
  if (effect === "allow") {
    reasons.push(
      role === "analyst"
        ? "The analyst role can read every column and every row."
        : "The statement stays inside the columns this role can read.",
    );
  }
  return { effect, role, catalog, reasons, executedSql, columns };
}
