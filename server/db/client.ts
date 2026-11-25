import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { env } from "../env";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Production: Postgres via DATABASE_URL.
 * Development/tests: embedded PGlite (on disk, or in memory for tests).
 */
export async function createDb(opts: { memory?: boolean } = {}): Promise<{ db: DB; close: () => Promise<void> }> {
  if (env.DATABASE_URL && !opts.memory) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const sql = postgres(env.DATABASE_URL, { max: 10 });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as DB, close: () => sql.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  if (!opts.memory) fs.mkdirSync(env.PGLITE_DIR, { recursive: true });
  const client = new PGlite(opts.memory ? undefined : env.PGLITE_DIR);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as DB, close: () => client.close() };
}
