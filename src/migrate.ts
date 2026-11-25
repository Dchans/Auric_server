import { Client } from 'pg';
import { AURIC_MIGRATIONS } from './schema';

async function migrate() {
  const host = process.env.AURIC_PG_HOST || process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.AURIC_PG_PORT || process.env.PGPORT || 5432);
  const user = process.env.AURIC_PG_USER || process.env.PGUSER || 'app';
  const password = process.env.AURIC_PG_PASSWORD || process.env.PGPASSWORD;
  const database = process.env.AURIC_PG_DATABASE || process.env.PGDATABASE || 'app';

  const client = new Client({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    console.log(`Connected to PostgreSQL database '${database}' on ${host}:${port} as '${user}'`);

    await client.query('BEGIN');
    try {
      // Serialize migrations when multiple processes target the same database.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.schema_migrations'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS auric');
      await client.query(`
        CREATE TABLE IF NOT EXISTS auric.schema_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      for (const migration of AURIC_MIGRATIONS) {
        const { rows } = await client.query('SELECT id FROM auric.schema_migrations WHERE id = $1', [migration.id]);
        if (rows.length > 0) {
          console.log(`[Auric Migration] Already applied ${migration.id}`);
          continue;
        }
        await client.query(migration.sql);
        await client.query('INSERT INTO auric.schema_migrations (id) VALUES ($1)', [migration.id]);
        console.log(`[Auric Migration] Applied ${migration.id}`);
      }

      await client.query('COMMIT');
      console.log('All Auric migrations completed successfully.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

void migrate().catch((error) => {
  console.error('[Auric Migration Error]:', error);
  process.exitCode = 1;
});
