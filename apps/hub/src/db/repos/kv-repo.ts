import type { DbDriver } from '../types.js';

export class KvRepo {
  constructor(private readonly db: DbDriver) {}

  async get(key: string): Promise<string | undefined> {
    const rows = await this.db.query<{ value: string }>('SELECT value FROM kv WHERE key = ?', [
      key,
    ]);
    return rows[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.exec(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async remove(key: string): Promise<void> {
    await this.db.exec('DELETE FROM kv WHERE key = ?', [key]);
  }
}
