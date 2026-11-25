import { Client } from 'pg';
import { buildAuricPgConfig } from './database/database.service';
import { AURIC_MIGRATIONS } from './schema';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(maxAttempts = 30, retryDelayMs = 2000): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new Client(buildAuricPgConfig({ connectionTimeoutMillis: 5000 }, true));
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      if (attempt < maxAttempts) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[Auric Migration] Waiting for PostgreSQL (${attempt}/${maxAttempts}): ${message}`);
        await delay(retryDelayMs);
      }
    }
  }
  throw lastError;
}

async function waitForRelation(client: Client, relation: string, maxAttempts = 45, retryDelayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { rows } = await client.query<{ ready: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ready', [relation]);
    if (rows[0]?.ready) return;
    if (attempt < maxAttempts) {
      console.log(`[Auric Migration] Waiting for upstream table '${relation}' (${attempt}/${maxAttempts})...`);
      await delay(retryDelayMs);
    }
  }
  throw new Error(`Timed out waiting for upstream relation '${relation}'. Make sure Auth migrations have run first.`);
}

async function migrate() {
  const client = await connectWithRetry();

  try {
    const { rows: [info] } = await client.query<{
      current_user: string;
      current_database: string;
      can_create: boolean;
      has_auric: boolean;
    }>(`
      SELECT
        current_user,
        current_database(),
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
        to_regclass('auric.devices') IS NOT NULL AS has_auric
    `);
    console.log(`[Auric Migration] Connected to database '${info.current_database}' as '${info.current_user}'`);

    await waitForRelation(client, 'auth.users');

    if (!info.can_create) {
      if (info.has_auric) {
        console.log(
          `[Auric Migration] Role '${info.current_user}' does not have CREATE privilege and Auric tables already exist; skipping DDL migrations.`,
        );
        return;
      }
      throw new Error(
        `Role '${info.current_user}' lacks CREATE privilege to initialize Auric tables. Provide DATABASE_URL or MIGRATION_DATABASE_URL with an admin PostgreSQL role.`,
      );
    }

    await client.query('BEGIN');
    try {
      // Serialize migrations when multiple processes target the same database.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.schema_migrations'))");
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auric_app') THEN
            CREATE ROLE auric_app WITH LOGIN;
          END IF;
        END;
        $$;
      `);
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
