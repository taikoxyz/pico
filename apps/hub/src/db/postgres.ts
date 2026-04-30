import pg from 'pg';
import type { DbDriver, Row } from './types.js';

export interface PostgresDriverOptions {
  readonly url: string;
  readonly poolSize?: number;
}

export function openPostgresDriver(opts: PostgresDriverOptions): DbDriver {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolSize ?? 10,
  });
  return wrapPool(pool);
}

function pgify(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

interface QueryRunner {
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: Row[]; rowCount: number }>;
}

function wrapRunner(runner: QueryRunner): Omit<DbDriver, 'transaction' | 'close'> {
  return {
    async query<R = Row>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
      const result = await runner.query(pgify(sql), params);
      return result.rows as R[];
    },
    async exec(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
      const result = await runner.query(pgify(sql), params);
      return { changes: result.rowCount };
    },
    async executeScript(sql: string): Promise<void> {
      await runner.query(sql, []);
    },
    async ping(): Promise<void> {
      await runner.query('SELECT 1', []);
    },
  };
}

function wrapPool(pool: pg.Pool): DbDriver {
  const base = wrapRunner({
    query: async (sql, params) => {
      const res = await pool.query(sql, [...params]);
      return { rows: res.rows as Row[], rowCount: res.rowCount ?? 0 };
    },
  });
  return {
    ...base,
    async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const txBase = wrapRunner({
        query: async (sql, params) => {
          const res = await client.query(sql, [...params]);
          return { rows: res.rows as Row[], rowCount: res.rowCount ?? 0 };
        },
      });
      const txDriver: DbDriver = {
        ...txBase,
        async transaction<U>(nested: (inner: DbDriver) => Promise<U>): Promise<U> {
          return nested(txDriver);
        },
        async close(): Promise<void> {
          // tx scope close is a no-op; outer close releases the pool
        },
      };
      try {
        await client.query('BEGIN');
        const result = await fn(txDriver);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
