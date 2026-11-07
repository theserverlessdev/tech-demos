export type Sql = {
  /** Returns the number of rows the statement changed. Throws on a constraint failure. */
  run(query: string, params?: unknown[]): Promise<number>;
  get<T extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<T | null>;
  all<T extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
};

export function d1sql(db: D1Database): Sql {
  const statement = (query: string, params: unknown[]) => {
    const prepared = db.prepare(query);
    return params.length > 0 ? prepared.bind(...params) : prepared;
  };
  return {
    async run(query, params = []) {
      const result = await statement(query, params).run();
      return result.meta.changes ?? 0;
    },
    async get<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const row = await statement(query, params).first<T>();
      return row ?? null;
    },
    async all<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const result = await statement(query, params).all<T>();
      return result.results ?? [];
    },
  };
}
