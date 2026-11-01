import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal SQL handle. PGlite implements it in dev/tests; a `pg.Pool`-backed
 * implementation (Postgres / Timescale) satisfies the same interface in prod.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PgLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(pg: PgLike, root: PGlite): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (pg !== (root as unknown as PgLike)) return fn(db); // already inside a tx
      return root.transaction(async (tx) => fn(wrap(tx as unknown as PgLike, root)));
    },
    async close() {
      if (pg === (root as unknown as PgLike)) await root.close();
    },
  };
  return db;
}

export async function openDb(location: string): Promise<Db> {
  let pg: PGlite;
  if (location === "memory" || location === "memory://") {
    pg = await PGlite.create();
  } else {
    mkdirSync(location, { recursive: true });
    pg = await PGlite.create(location);
  }
  const db = wrap(pg as unknown as PgLike, pg);
  await migrate(db);
  return db;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies versioned `NNNN_name.sql` migrations exactly once, in order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>(`SELECT version FROM schema_migrations`)).map((r) => r.version));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = f.split("_")[0]!;
    if (done.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
    });
    applied.push(f);
  }
  return applied;
}
