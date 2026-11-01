import type { Db } from "./db";
import { json } from "../util/rows";

export interface DocEntity {
  id: string;
  tenantId: string;
  createdAt: string;
}

export interface ListOptions {
  tenantIds?: string[];
  /** Extra SQL predicate using $-params numbered after the generated ones (use `?` placeholders). */
  where?: string[];
  params?: unknown[];
  limit?: number;
  offset?: number;
  orderBy?: string;
}

/**
 * Generic repository for "indexed columns + jsonb doc" tables. Each table has
 * `id`, `tenant_id`, `doc`, `created_at` plus optional extra columns derived
 * from the document (kept in sync on every write).
 */
export class DocRepo<T extends DocEntity> {
  constructor(
    protected readonly db: Db,
    readonly table: string,
    private readonly extra: Record<string, (t: T) => unknown> = {},
  ) {}

  private cols(): string[] {
    return ["id", "tenant_id", "doc", "created_at", ...Object.keys(this.extra)];
  }
  private values(t: T): unknown[] {
    return [t.id, t.tenantId, json(t), t.createdAt, ...Object.values(this.extra).map((f) => f(t) ?? null)];
  }

  async get(id: string): Promise<T | undefined> {
    const rows = await this.db.query<{ doc: T }>(`SELECT doc FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0]?.doc;
  }

  /** Fetch by id, constrained to the caller's tenant scope (undefined → no constraint). */
  async getScoped(id: string, tenantIds?: string[]): Promise<T | undefined> {
    if (!tenantIds) return this.get(id);
    const rows = await this.db.query<{ doc: T }>(
      `SELECT doc FROM ${this.table} WHERE id = $1 AND tenant_id = ANY($2::text[])`,
      [id, tenantIds],
    );
    return rows[0]?.doc;
  }

  async list(opts: ListOptions = {}): Promise<T[]> {
    return this.run(opts);
  }

  private async run(opts: ListOptions): Promise<T[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantIds) {
      params.push(opts.tenantIds);
      where.push(`tenant_id = ANY($${params.length}::text[])`);
    }
    const extraParams = [...(opts.params ?? [])];
    for (const w of opts.where ?? []) {
      where.push(
        w.replace(/\?/g, () => {
          params.push(extraParams.shift());
          return `$${params.length}`;
        }),
      );
    }
    let sql = `SELECT doc FROM ${this.table}`;
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY ${opts.orderBy ?? "created_at DESC"}`;
    if (opts.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (opts.offset) {
      params.push(opts.offset);
      sql += ` OFFSET $${params.length}`;
    }
    const rows = await this.db.query<{ doc: T }>(sql, params);
    return rows.map((r) => r.doc);
  }

  async insert(t: T): Promise<T> {
    await this.insertMany([t]);
    return t;
  }

  async insertMany(items: T[], chunk = 200): Promise<void> {
    const cols = this.cols();
    for (let i = 0; i < items.length; i += chunk) {
      const slice = items.slice(i, i + chunk);
      const params: unknown[] = [];
      const tuples = slice.map((t) => {
        const vals = this.values(t);
        const ph = vals.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      });
      await this.db.query(`INSERT INTO ${this.table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, params);
    }
  }

  async update(t: T): Promise<T> {
    const cols = this.cols().slice(1);
    const vals = this.values(t).slice(1);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`);
    await this.db.query(`UPDATE ${this.table} SET ${sets.join(", ")} WHERE id = $1`, [t.id, ...vals]);
    return t;
  }

  async count(opts: Pick<ListOptions, "tenantIds" | "where" | "params"> = {}): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantIds) {
      params.push(opts.tenantIds);
      where.push(`tenant_id = ANY($${params.length}::text[])`);
    }
    const extraParams = [...(opts.params ?? [])];
    for (const w of opts.where ?? []) {
      where.push(
        w.replace(/\?/g, () => {
          params.push(extraParams.shift());
          return `$${params.length}`;
        }),
      );
    }
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${this.table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
      params,
    );
    return rows[0]?.n ?? 0;
  }
}

