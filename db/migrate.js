#!/usr/bin/env node
// Minimal, dependency-light SQL migration runner.
//
// Why not an ORM migration DSL (Prisma Migrate / Drizzle Kit / etc.)? Phase 1
// wants transparent, reviewable raw SQL for a schema that leans heavily on
// Postgres-specific features (RLS policies, SECURITY DEFINER functions,
// pgvector) that migration DSLs typically only half-support anyway. This
// runner just tracks which numbered .sql files in db/migrations/ have been
// applied, in a `_migrations` table, and applies the rest in order inside a
// transaction each. See docs/PHASE1_DECISIONS.md for the full justification.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Set DATABASE_URL_MIGRATE (a superuser connection) or DATABASE_URL.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query('SELECT filename FROM _migrations');
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`applying: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`failed: ${file}`);
        throw err;
      }
    }
    console.log('migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
