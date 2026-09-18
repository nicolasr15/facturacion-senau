/**
 * Emulación mínima de D1Database sobre node:sqlite (Node 22+), suficiente para
 * probar src/lib/store.ts sin Cloudflare. Misma idea que senau-tickets/test.
 *
 * No implementa D1Database/D1PreparedStatement al pie de la letra: le faltan
 * cosas del tipo real de @cloudflare/workers-types que store.ts nunca usa
 * (withSession, dump, los campos completos de D1Meta, los overloads de raw()
 * con columnNames). Por eso se define un tipo local mínimo para el objeto de
 * adentro (evita además el "implicitly has type any" de que `bind` se
 * referencia a sí mismo) y se castea una sola vez, por `unknown`, al retornar.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

interface FakeResult<T> {
  success: true;
  meta: Record<string, unknown>;
  results: T[];
}

interface FakePreparedStatement {
  bind(...values: unknown[]): FakePreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<FakeResult<T>>;
  all<T = unknown>(): Promise<FakeResult<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export function createTestDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  db.exec(readFileSync(join(here, "../migrations/0001_documents.sql"), "utf8"));

  const prepare = (sql: string): FakePreparedStatement => {
    let params: unknown[] = [];
    const stmt = () => db.prepare(sql);
    const isWrite = /^\s*(insert|update|delete)/i.test(sql);
    const hasReturning = /\breturning\b/i.test(sql);
    const ps: FakePreparedStatement = {
      bind(...values: unknown[]) {
        params = values;
        return ps;
      },
      async first<T = unknown>(colName?: string) {
        const row = stmt().get(...(params as never[])) as Row | undefined;
        if (!row) return null;
        return (colName ? row[colName] : row) as T;
      },
      async run<T = unknown>() {
        if (isWrite && !hasReturning) {
          const r = stmt().run(...(params as never[]));
          return { success: true, meta: { changes: Number(r.changes) }, results: [] as T[] };
        }
        const results = stmt().all(...(params as never[])) as T[];
        return { success: true, meta: { changes: results.length }, results };
      },
      async all<T = unknown>() {
        const results = stmt().all(...(params as never[])) as T[];
        return { success: true, meta: {}, results };
      },
      async raw<T = unknown>() {
        return (stmt().all(...(params as never[])) as Row[]).map((r) => Object.values(r)) as T[];
      },
    };
    return ps;
  };

  const database = {
    prepare,
    async batch(statements: FakePreparedStatement[]) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(query: string) {
      db.exec(query);
      return { count: 1, duration: 0 };
    },
  };

  return database as unknown as D1Database;
}
