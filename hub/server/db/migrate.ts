import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { loadHubConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(databaseUrl: string, sslRequire = false): Promise<string[]> {
  const ssl = sslRequire || databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined;
  const client = new pg.Client({ connectionString: databaseUrl, ssl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    // Support running from dist/ where SQL lives in source or copied next to dist
    const effectiveDir = fs.existsSync(migrationsDir)
      ? migrationsDir
      : path.resolve(__dirname, '../../../server/db/migrations');

    const files = fs
      .readdirSync(effectiveDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const alreadyApplied = new Set(appliedRows.rows.map((r) => r.version));
    const newlyApplied: string[] = [];

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = fs.readFileSync(path.join(effectiveDir, file), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    return newlyApplied;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = loadHubConfig();
  runMigrations(cfg.databaseUrl)
    .then((applied) => {
      console.log(`Migrations complete. Newly applied: ${applied.length ? applied.join(', ') : 'none'}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
