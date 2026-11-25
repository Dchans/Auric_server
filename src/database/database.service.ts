import { HttpException, HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClientConfig, Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import {
  ActiveSubscriptionDto,
  ApprovedDeviceResult,
  AuthAccount,
  DeviceDto,
  PaymentDto,
  ShopProfileDto,
  SubscriptionPlanDto,
} from '../schema';

export function buildAuricPgConfig(
  overrides: Partial<PoolConfig & ClientConfig> = {},
  preferMigrationEnv = false,
): PoolConfig & ClientConfig {
  const connectionString = preferMigrationEnv
    ? process.env.MIGRATION_DATABASE_URL || process.env.AURIC_DATABASE_URL || process.env.DATABASE_URL
    : process.env.AURIC_DATABASE_URL || process.env.DATABASE_URL;
  const sslEnabled =
    process.env.DATABASE_SSL === 'true' ||
    process.env.PGSSLMODE === 'require' ||
    process.env.PGSSLMODE === 'verify-full';

  const base: PoolConfig & ClientConfig = connectionString
    ? { connectionString }
    : {
        host:
          (preferMigrationEnv ? process.env.MIGRATION_PG_HOST : undefined) ||
          process.env.AURIC_PG_HOST ||
          process.env.PGHOST ||
          '127.0.0.1',
        port: Number(
          (preferMigrationEnv ? process.env.MIGRATION_PG_PORT : undefined) ||
            process.env.AURIC_PG_PORT ||
            process.env.PGPORT ||
            5432,
        ),
        user:
          (preferMigrationEnv ? process.env.MIGRATION_PG_USER : undefined) ||
          process.env.AURIC_PG_USER ||
          process.env.PGUSER ||
          'app',
        password:
          (preferMigrationEnv ? process.env.MIGRATION_PG_PASSWORD : undefined) ||
          process.env.AURIC_PG_PASSWORD ||
          process.env.PGPASSWORD,
        database:
          (preferMigrationEnv ? process.env.MIGRATION_PG_DATABASE : undefined) ||
          process.env.AURIC_PG_DATABASE ||
          process.env.PGDATABASE ||
          'app',
      };

  return {
    ...base,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } } : {}),
    ...overrides,
  };
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool(
      buildAuricPgConfig({
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
        application_name: 'auric',
      }),
    );

    this.pool.on('error', (error) => {
      console.error('[Auric Database] Idle PostgreSQL connection error:', error.message);
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1 FROM auric.devices LIMIT 0');
  }

  async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rateLimit(bucket: string, key: string, limit: number, seconds: number): Promise<void> {
    const keyHash = createHash('sha256').update(key, 'utf8').digest();
    const { rowCount } = await this.pool.query(`
      INSERT INTO auth.rate_limits AS counter (bucket, key_hash, expires_at, attempts)
      VALUES ($1, $2, statement_timestamp() + make_interval(secs => $4), 1)
      ON CONFLICT (bucket, key_hash) DO UPDATE SET
        attempts = CASE WHEN counter.expires_at <= statement_timestamp() THEN 1
          ELSE counter.attempts + 1 END,
        expires_at = CASE WHEN counter.expires_at <= statement_timestamp()
          THEN EXCLUDED.expires_at ELSE counter.expires_at END
      WHERE counter.expires_at <= statement_timestamp() OR counter.attempts < $3
      RETURNING attempts
    `, [bucket, keyHash, limit, seconds]);

    if (rowCount === 0) {
      throw new HttpException('Too many requests. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async getSessionAccount(tokenHash: Buffer): Promise<AuthAccount | null> {
    const { rows: [account] } = await this.pool.query<AuthAccount>(`
      SELECT 
        u.id, 
        u.email, 
        u.username, 
        u.first_name AS "firstName", 
        u.last_name AS "lastName",
        u.phone_number AS "phoneNumber",
        r.name AS role,
        (u.email_verified_at IS NOT NULL) AS "emailVerified",
        (u.phone_verified_at IS NOT NULL) AS "phoneVerified"
      FROM auth.sessions s
      JOIN auth.users u ON u.id = s.user_id
      JOIN auth.roles r ON r.id = u.role_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
        AND u.disabled_at IS NULL
    `, [tokenHash]);

    return account ?? null;
  }

  async getProfile(user: AuthAccount): Promise<{ user: AuthAccount; shopProfile: ShopProfileDto | null }> {
    const { rows } = await this.pool.query<ShopProfileDto>(`
      SELECT shop_name AS "shopName", shop_location AS "shopLocation", gstin
      FROM auric.shop_profiles WHERE user_id = $1
    `, [user.id]);

    return { user, shopProfile: rows[0] ?? null };
  }

  async getDevices(userId: string): Promise<{ devices: DeviceDto[] }> {
    const { rows } = await this.pool.query<DeviceDto>(`
      SELECT id, device_type AS "deviceType", device_role AS "deviceRole", display_name AS "displayName",
        approval_status AS "approvalStatus",
        approval_status = 'approved' AND can_read AS "canRead",
        approval_status = 'approved' AND can_write AS "canWrite",
        approval_status = 'approved' AND can_print AS "canPrint",
        created_at AS "createdAt", last_seen_at AS "lastSeenAt"
      FROM auric.devices WHERE user_id = $1
      ORDER BY last_seen_at DESC, id
    `, [userId]);

    return { devices: rows };
  }

  async getApprovedDevice(userId: string, signature: string): Promise<ApprovedDeviceResult | undefined> {
    const { rows: [device] } = await this.pool.query<ApprovedDeviceResult>(`
      SELECT id, device_role AS role
      FROM auric.devices
      WHERE user_id = $1 AND device_identity_signature = $2 AND approval_status = 'approved'
    `, [userId, signature]);

    return device;
  }

  async getSubscriptionStatus(userId: string): Promise<{ status: 'active' | 'inactive'; subscriptions: ActiveSubscriptionDto[] }> {
    const { rows: activeRows } = await this.pool.query<ActiveSubscriptionDto>(`
      SELECT id, plan_id AS "planId", plan_code AS "planCode", plan_name AS "planName",
        status, current_period_end_at AS "currentPeriodEndAt", modules,
        plan_description AS "planDescription", amount_minor::text AS "amountMinor",
        currency, billing_interval AS "billingInterval"
      FROM auric.active_subscriptions
      WHERE user_id = $1
      ORDER BY current_period_end_at DESC, id
    `, [userId]);

    if (activeRows.length > 0) {
      return { status: 'active', subscriptions: activeRows };
    }

    // Fall back to most recent subscription to preserve plan details & expired/past_due/canceled status
    const { rows: latestRows } = await this.pool.query<ActiveSubscriptionDto>(`
      SELECT s.id, s.plan_id AS "planId", p.plan_code AS "planCode", p.name AS "planName",
        s.status, s.current_period_end_at AS "currentPeriodEndAt", p.modules,
        p.description AS "planDescription", p.amount_minor::text AS "amountMinor",
        p.currency, p.billing_interval AS "billingInterval"
      FROM auric.subscriptions s
      JOIN auric.subscription_plans p ON p.id = s.plan_id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC, s.id
      LIMIT 1
    `, [userId]);

    return { status: 'inactive', subscriptions: latestRows };
  }

  async getRecentPayments(userId: string): Promise<{ payments: PaymentDto[] }> {
    const { rows } = await this.pool.query<PaymentDto>(`
      SELECT p.id, p.subscription_id AS "subscriptionId", p.provider,
        p.amount_minor::text AS "amountMinor", p.refunded_amount_minor::text AS "refundedAmountMinor",
        p.status, p.paid_at AS "paidAt", p.created_at AS "createdAt"
      FROM auric.payments p JOIN auric.subscriptions s ON s.id = p.subscription_id AND s.provider = p.provider
      WHERE s.user_id = $1
      ORDER BY p.created_at DESC, p.id
      LIMIT 20
    `, [userId]);

    return { payments: rows };
  }

  async getAvailablePlans(): Promise<SubscriptionPlanDto[]> {
    const { rows } = await this.pool.query<SubscriptionPlanDto>(`
      SELECT id, plan_code AS "planCode", name, description,
        amount_minor::text AS "amountMinor", currency, billing_interval AS "billingInterval",
        modules, is_available AS "isAvailable"
      FROM auric.subscription_plans
      WHERE is_available = true
      ORDER BY amount_minor ASC, id
    `);
    return rows;
  }

  /**
   * Check if user is an admin or has an active Auric subscription that includes REMOTE module.
   */
  async hasRemoteAccess(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ has_access: boolean }>(`
      SELECT (
        EXISTS (
          SELECT 1 
          FROM auth.users u
          JOIN auth.roles r ON r.id = u.role_id
          WHERE u.id = $1 AND r.name = 'admin'
        )
        OR
        EXISTS (
          SELECT 1 
          FROM auric.active_subscriptions 
          WHERE user_id = $1 
            AND ('REMOTE' = ANY(modules))
        )
      ) AS has_access
    `, [userId]);

    return Boolean(rows[0]?.has_access);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

// Backward-compatible alias
export { DatabaseService as Database };
