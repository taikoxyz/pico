export type Row = Record<string, unknown>;

export interface DbDriver {
  query<R = Row>(sql: string, params?: readonly unknown[]): Promise<readonly R[]>;
  exec(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  executeScript(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface MigrationRecord {
  readonly name: string;
  readonly appliedAt: string;
}
