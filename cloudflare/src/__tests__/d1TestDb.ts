import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../index';

/**
 * A D1-shaped binding over real in-memory SQLite, loading the project's own
 * schema files.
 *
 * KAN-387's state machine lives entirely in conditional UPDATEs whose
 * `meta.changes` is the atomicity primitive, so a fake that pattern-matches
 * SQL strings would assert nothing about the behaviour that matters: whether
 * a second claimant really loses the race, or whether SQLite's SET clause
 * really sees pre-update values. Running the statements for real is also why
 * a schema change that breaks them fails in the tests rather than in
 * production.
 */
export function schemaDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const root = join(__dirname, '..', '..');
  for (const file of ['country_schema.sql', 'place_schema.sql', 'schema.sql']) {
    db.exec(readFileSync(join(root, file), 'utf8'));
  }
  return db;
}

/** Wrap a database as the subset of D1's API the Worker actually calls. */
export function d1Binding(db: DatabaseSync): Env['REGISTRY_DB'] {
  const prepare = (sql: string) => {
    const statement = (args: unknown[]) => ({
      bind: (...next: unknown[]) => statement(next),
      async run() {
        return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } };
      },
      async first<T>() {
        return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...(args as never[])) as T[] };
      },
    });
    return statement([]);
  };
  return { prepare } as unknown as Env['REGISTRY_DB'];
}
