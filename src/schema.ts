import {auricSupportSchema} from './support/support.schema';
/**
 * TypeScript Data Types, Domain Models, and SQL Migrations for Auric
 * Strictly typed interfaces matching the PostgreSQL schema.
 */

// ---------------------------------------------------------------------------
// Auth & Identity References
// ---------------------------------------------------------------------------

export type AuthAccount = {
  role?: string;
  id: string;
  email: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
};

// ---------------------------------------------------------------------------
// Device Types & Interfaces (auric.devices)
// ---------------------------------------------------------------------------

export type DeviceType = 'electron' | 'browser';
export type DeviceRole = 'primary' | 'secondary';
export type DeviceApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface DeviceRow {
  id: string;
  user_id: string;
  device_identity_signature: string;
  device_type: DeviceType;
  device_role: DeviceRole;
  display_name: string | null;
  approval_status: DeviceApprovalStatus;
  can_read: boolean;
  can_write: boolean;
  can_print: boolean;
  created_at: Date;
  last_seen_at: Date;
}

export interface DeviceDto {
  id: string;
  displayName: string | null;
  deviceType: DeviceType;
  deviceRole: DeviceRole;
  approvalStatus: DeviceApprovalStatus;
  canRead: boolean;
  canWrite: boolean;
  canPrint: boolean;
  createdAt: Date | string;
  lastSeenAt: Date | string;
}

export interface ApprovedDeviceResult {
  id: string;
  role: DeviceRole;
}

// ---------------------------------------------------------------------------
// Shop Profile Types (auric.shop_profiles)
// ---------------------------------------------------------------------------

export interface ShopProfileRow {
  user_id: string;
  shop_name: string;
  shop_location: string;
  gstin: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShopProfileDto {
  shopName: string;
  shopLocation: string;
  gstin: string | null;
}

// ---------------------------------------------------------------------------
// Encrypted Credentials (auric.auric_credentials)
// ---------------------------------------------------------------------------

export type CredentialType = 'db_password' | 'file_password';

export interface AuricCredentialsRow {
  user_id: string;
  credential_type: CredentialType;
  ciphertext: Buffer;
  nonce: Buffer; // 12-byte AES-GCM IV
  auth_tag: Buffer; // 16-byte AES-GCM tag
  key_id: string;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Subscription Plans (auric.subscription_plans)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_MODULES = [
  'PAWN',
  'JEWEL',
  'FINANCE',
  'REMOTE',
  'CLOUD_BACKUP',
] as const;

export type SubscriptionModuleCode = typeof SUBSCRIPTION_MODULES[number] | 'JEWLE';
export type SubscriptionBillingInterval = 'day' | 'week' | 'month' | 'year';

export interface SubscriptionPlanRow {
  id: string;
  plan_code: string;
  name: string;
  description: string | null;
  amount_minor: bigint;
  currency: 'INR';
  billing_interval: SubscriptionBillingInterval;
  modules: SubscriptionModuleCode[];
  is_available: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionPlanDto {
  id: string;
  planCode: string;
  name: string;
  description: string | null;
  amountMinor: string;
  currency: 'INR';
  billingInterval: SubscriptionBillingInterval;
  modules: SubscriptionModuleCode[];
  isAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Subscriptions (auric.subscriptions & auric.active_subscriptions)
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'pending'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled'
  | 'expired';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  provider: string;
  provider_subscription_id: string | null;
  provider_checkout_id: string | null;
  status: SubscriptionStatus;
  current_period_end_at: Date | null;
  canceled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActiveSubscriptionDto {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  planDescription: string | null;
  status: SubscriptionStatus;
  currentPeriodEndAt: Date | string | null;
  amountMinor: string;
  currency: string;
  billingInterval: SubscriptionBillingInterval;
  modules: SubscriptionModuleCode[];
}

export interface SubscriptionStatusResponse {
  status: 'active' | 'inactive';
  subscriptions: ActiveSubscriptionDto[];
}

// ---------------------------------------------------------------------------
// Payments & Settlement (auric.payments)
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'partially_refunded'
  | 'refunded';

export interface PaymentRow {
  id: string;
  subscription_id: string;
  provider: string;
  provider_payment_id: string;
  amount_minor: bigint;
  refunded_amount_minor: bigint;
  status: PaymentStatus;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentDto {
  id: string;
  subscriptionId: string;
  provider: string;
  amountMinor: string;
  refundedAmountMinor: string;
  status: PaymentStatus;
  paidAt: Date | string | null;
  createdAt: Date | string;
}

export interface PaymentsResponse {
  payments: PaymentDto[];
}

// ---------------------------------------------------------------------------
// App Versions & Updates (auric.app_versions)
// ---------------------------------------------------------------------------

export type ReleaseChannel = 'stable' | 'beta' | 'alpha';
export type WindowsVersion = 'win10_11' | 'win7';

export interface AppVersionRow {
  id: string;
  version: string;
  release_channel: ReleaseChannel;
  windows_version: WindowsVersion;
  exe_url: string;
  exe_cove_file_id: string | null;
  blockmap_url: string | null;
  blockmap_cove_file_id: string | null;
  sha512: string;
  file_size: string | number | bigint;
  blockmap_size: string | number | bigint | null;
  release_notes: string;
  is_latest: boolean;
  pushed_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface AppVersionDto {
  id: string;
  version: string;
  releaseChannel: ReleaseChannel;
  windowsVersion: WindowsVersion;
  exeUrl: string;
  exeCoveFileId: string | null;
  blockmapUrl: string | null;
  blockmapCoveFileId: string | null;
  sha512: string;
  fileSize: number;
  blockmapSize: number | null;
  releaseNotes: string;
  isLatest: boolean;
  pushedBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface VersionListResponse {
  versions: AppVersionDto[];
  total: number;
}

// ---------------------------------------------------------------------------
// SQL Migrations
// ---------------------------------------------------------------------------

export const auricSchema = {
  id: '001_auric',
  sql: `
CREATE SCHEMA IF NOT EXISTS auric;

CREATE TABLE auric.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  installation_id text NOT NULL CHECK (char_length(installation_id) BETWEEN 1 AND 200),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, installation_id)
);

CREATE TABLE auric.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL CONSTRAINT subscriptions_auth_user_fk
    REFERENCES auth.users (id) ON DELETE RESTRICT,
  plan_code text NOT NULL CHECK (btrim(plan_code) <> ''),
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  provider_subscription_id text,
  provider_checkout_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  current_period_end_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id),
  UNIQUE (provider, provider_checkout_id),
  UNIQUE (id, provider)
);

CREATE INDEX subscriptions_user_id_idx ON auric.subscriptions (user_id);

CREATE TABLE auric.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  provider text NOT NULL,
  provider_payment_id text NOT NULL CHECK (btrim(provider_payment_id) <> ''),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'partially_refunded', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id),
  FOREIGN KEY (subscription_id, provider) REFERENCES auric.subscriptions (id, provider) ON DELETE RESTRICT
);

CREATE INDEX payments_subscription_id_idx ON auric.payments (subscription_id);

GRANT USAGE ON SCHEMA auric TO auric_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auric.devices TO auric_app;
GRANT SELECT, INSERT, UPDATE ON auric.subscriptions, auric.payments TO auric_app;
`,
} as const;

export const auricEntitlementsSchema = {
  id: '002_device_and_subscription_entitlements',
  sql: `
ALTER TABLE auric.devices
  ADD COLUMN can_read boolean NOT NULL DEFAULT false,
  ADD COLUMN can_write boolean NOT NULL DEFAULT false,
  ADD COLUMN can_print boolean NOT NULL DEFAULT false,
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT devices_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected', 'revoked'));

ALTER TABLE auric.subscriptions
  ADD COLUMN plan_name text NOT NULL CHECK (btrim(plan_name) <> ''),
  ADD COLUMN plan_description text,
  ADD COLUMN amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  ADD COLUMN currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT subscriptions_active_period_check
    CHECK (status <> 'active' OR current_period_end_at IS NOT NULL);

CREATE TABLE auric.subscription_modules (
  subscription_id uuid NOT NULL REFERENCES auric.subscriptions (id) ON DELETE CASCADE,
  module_code text NOT NULL
    CHECK (module_code IN ('PAWN', 'JEWLE', 'FINANCE', 'REMOTE', 'CLOUD_BACKUP')),
  PRIMARY KEY (subscription_id, module_code)
);

CREATE INDEX subscriptions_active_user_period_idx
  ON auric.subscriptions (user_id, current_period_end_at) WHERE status = 'active';

CREATE VIEW auric.active_subscriptions AS
SELECT *
FROM auric.subscriptions
WHERE status = 'active' AND current_period_end_at > statement_timestamp();

GRANT SELECT, INSERT, DELETE ON auric.subscription_modules TO auric_app;
GRANT SELECT ON auric.active_subscriptions TO auric_app;
`,
} as const;

export const auricShopProfileSchema = {
  id: '003_shop_profiles',
  sql: `
CREATE TABLE auric.shop_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  shop_name text NOT NULL CHECK (char_length(btrim(shop_name)) BETWEEN 1 AND 200),
  shop_location text NOT NULL CHECK (char_length(btrim(shop_location)) BETWEEN 1 AND 500),
  gstin text CHECK (gstin ~ '^[A-Z0-9]{15}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auric.shop_credentials (
  user_id uuid NOT NULL REFERENCES auric.shop_profiles (user_id) ON DELETE CASCADE,
  credential_type text NOT NULL CHECK (credential_type IN ('db_password', 'file_password')),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_id text NOT NULL CHECK (btrim(key_id) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, credential_type),
  UNIQUE (key_id, nonce)
);

GRANT SELECT, INSERT ON auric.shop_profiles TO auric_app;
GRANT UPDATE (shop_name, shop_location, gstin, updated_at) ON auric.shop_profiles TO auric_app;
REVOKE ALL ON auric.shop_credentials FROM PUBLIC, auric_app;
`,
} as const;

export const auricCredentialRenameSchema = {
  id: '004_rename_auric_credentials',
  sql: `
ALTER TABLE auric.shop_credentials RENAME TO auric_credentials;
`,
} as const;

export const auricInrPaymentsSchema = {
  id: '005_inr_only_payments',
  sql: `
LOCK TABLE auric.payments IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auric.payments WHERE currency <> 'INR') THEN
    RAISE EXCEPTION 'Cannot remove currency while non-INR payments exist';
  END IF;
END;
$$;

ALTER TABLE auric.payments DROP COLUMN currency;
COMMENT ON COLUMN auric.payments.amount_minor IS 'Payment amount in INR paise (100 paise = 1 rupee).';
`,
} as const;

export const auricSubscriptionPlansSchema = {
  id: '006_separate_subscription_plans',
  sql: `
LOCK TABLE auric.subscriptions, auric.subscription_modules IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auric.subscriptions) OR EXISTS (SELECT 1 FROM auric.subscription_modules) THEN
    RAISE EXCEPTION 'Existing subscriptions must be mapped to plans before applying this migration';
  END IF;
END;
$$;

CREATE TABLE auric.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code text NOT NULL UNIQUE CHECK (btrim(plan_code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('day', 'week', 'month', 'year')),
  modules text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (COALESCE(array_ndims(modules), 1) = 1
      AND modules <@ ARRAY['PAWN', 'JEWLE', 'FINANCE', 'REMOTE', 'CLOUD_BACKUP']::text[]),
  is_available boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP VIEW auric.active_subscriptions;
DROP TABLE auric.subscription_modules;
ALTER TABLE auric.subscriptions
  ADD COLUMN plan_id uuid NOT NULL REFERENCES auric.subscription_plans (id) ON DELETE RESTRICT,
  DROP COLUMN plan_code,
  DROP COLUMN plan_name,
  DROP COLUMN plan_description,
  DROP COLUMN amount_minor,
  DROP COLUMN currency;

CREATE INDEX subscriptions_plan_id_idx ON auric.subscriptions (plan_id);

CREATE VIEW auric.active_subscriptions AS
SELECT s.*, p.plan_code, p.name AS plan_name, p.modules
FROM auric.subscriptions s
JOIN auric.subscription_plans p ON p.id = s.plan_id
WHERE s.status = 'active' AND s.current_period_end_at > statement_timestamp();

GRANT SELECT ON auric.subscription_plans, auric.active_subscriptions TO auric_app;
`,
} as const;

export const auricDeviceIdentitySchema = {
  id: '007_device_identity',
  sql: `
LOCK TABLE auric.devices IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auric.devices) THEN
    RAISE EXCEPTION 'Existing devices must be assigned a signature and type before applying this migration';
  END IF;
END;
$$;

ALTER TABLE auric.devices
  ADD COLUMN device_identity_signature text NOT NULL
    CHECK (btrim(device_identity_signature) <> '' AND octet_length(device_identity_signature) <= 1024),
  ADD COLUMN device_type text NOT NULL CHECK (device_type IN ('electron', 'browser')),
  ADD COLUMN device_role text NOT NULL DEFAULT 'secondary'
    CHECK (device_role IN ('primary', 'secondary')),
  ADD CONSTRAINT devices_user_signature_key UNIQUE (user_id, device_identity_signature),
  DROP COLUMN installation_id;

CREATE UNIQUE INDEX devices_one_primary_per_user_idx
  ON auric.devices (user_id) WHERE device_role = 'primary';
`,
} as const;

export const auricOptimizationsSchema = {
  id: '008_auric_optimizations',
  sql: `
-- 1. Fix typo in module codes check constraint (allow JEWEL and migrate JEWLE)
DO $$
DECLARE
  v_con_name text;
BEGIN
  FOR v_con_name IN (
    SELECT conname FROM pg_constraint 
    WHERE conrelid = 'auric.subscription_plans'::regclass 
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%modules%'
  ) LOOP
    EXECUTE 'ALTER TABLE auric.subscription_plans DROP CONSTRAINT ' || quote_ident(v_con_name);
  END LOOP;
END;
$$;

UPDATE auric.subscription_plans
  SET modules = array_replace(modules, 'JEWLE', 'JEWEL')
  WHERE 'JEWLE' = ANY(modules);

ALTER TABLE auric.subscription_plans
  ADD CONSTRAINT subscription_plans_modules_check
  CHECK (
    COALESCE(array_ndims(modules), 1) = 1
    AND modules <@ ARRAY['PAWN', 'JEWEL', 'JEWLE', 'FINANCE', 'REMOTE', 'CLOUD_BACKUP']::text[]
  );

-- 2. Add refunded_amount_minor to payments for tracking partial/full refunds
ALTER TABLE auric.payments
  ADD COLUMN IF NOT EXISTS refunded_amount_minor bigint NOT NULL DEFAULT 0
  CHECK (refunded_amount_minor >= 0 AND refunded_amount_minor <= amount_minor);

COMMENT ON COLUMN auric.payments.refunded_amount_minor IS 'Refunded amount in INR paise (100 paise = 1 rupee).';

-- 3. Composite and sorting indexes
CREATE INDEX IF NOT EXISTS payments_subscription_created_idx
  ON auric.payments (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payments_created_at_idx
  ON auric.payments (created_at DESC);

CREATE INDEX IF NOT EXISTS devices_user_last_seen_idx
  ON auric.devices (user_id, last_seen_at DESC, id);

-- 4. Fix primary device index so revoked/rejected devices do not block new primary devices
DROP INDEX IF EXISTS auric.devices_one_primary_per_user_idx;
CREATE UNIQUE INDEX IF NOT EXISTS devices_one_active_primary_per_user_idx
  ON auric.devices (user_id)
  WHERE device_role = 'primary' AND approval_status NOT IN ('rejected', 'revoked');

-- 5. Expand active_subscriptions view with all plan details to avoid redundant joins in API
DROP VIEW IF EXISTS auric.active_subscriptions CASCADE;
CREATE VIEW auric.active_subscriptions AS
SELECT 
  s.id,
  s.user_id,
  s.plan_id,
  s.provider,
  s.provider_subscription_id,
  s.provider_checkout_id,
  s.status,
  s.current_period_end_at,
  s.canceled_at,
  s.created_at,
  s.updated_at,
  p.plan_code,
  p.name AS plan_name,
  p.description AS plan_description,
  p.amount_minor,
  p.currency,
  p.billing_interval,
  p.modules
FROM auric.subscriptions s
JOIN auric.subscription_plans p ON p.id = s.plan_id
WHERE s.status = 'active' AND s.current_period_end_at > statement_timestamp();

-- 6. Automated updated_at triggers
CREATE OR REPLACE FUNCTION auric.touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS touch_subscriptions_updated_at ON auric.subscriptions;
CREATE TRIGGER touch_subscriptions_updated_at
  BEFORE UPDATE ON auric.subscriptions
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

DROP TRIGGER IF EXISTS touch_payments_updated_at ON auric.payments;
CREATE TRIGGER touch_payments_updated_at
  BEFORE UPDATE ON auric.payments
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

DROP TRIGGER IF EXISTS touch_shop_profiles_updated_at ON auric.shop_profiles;
CREATE TRIGGER touch_shop_profiles_updated_at
  BEFORE UPDATE ON auric.shop_profiles
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

DROP TRIGGER IF EXISTS touch_subscription_plans_updated_at ON auric.subscription_plans;
CREATE TRIGGER touch_subscription_plans_updated_at
  BEFORE UPDATE ON auric.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

DROP TRIGGER IF EXISTS touch_auric_credentials_updated_at ON auric.auric_credentials;
CREATE TRIGGER touch_auric_credentials_updated_at
  BEFORE UPDATE ON auric.auric_credentials
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

-- 7. Ensure auric_app has required permissions
GRANT SELECT ON auric.active_subscriptions TO auric_app;
GRANT SELECT, INSERT, UPDATE ON auric.payments TO auric_app;
`,
} as const;

export const auricAppVersionsSchema = {
  id: '009_auric_app_versions',
  sql: `
-- ===========================================================================
-- Auric Desktop App Version Manager & Multi-Channel Feed Distribution
-- ===========================================================================

CREATE TABLE IF NOT EXISTS auric.app_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL CHECK (btrim(version) <> ''),
  release_channel text NOT NULL CHECK (release_channel IN ('stable', 'beta', 'alpha')),
  windows_version text NOT NULL CHECK (windows_version IN ('win10_11', 'win7')),
  exe_url text NOT NULL CHECK (btrim(exe_url) <> ''),
  exe_cove_file_id text,
  blockmap_url text,
  blockmap_cove_file_id text,
  sha512 text NOT NULL CHECK (btrim(sha512) <> ''),
  file_size bigint NOT NULL CHECK (file_size > 0),
  blockmap_size bigint CHECK (blockmap_size IS NULL OR blockmap_size > 0),
  release_notes text NOT NULL DEFAULT '',
  is_latest boolean NOT NULL DEFAULT true,
  pushed_by text NOT NULL CHECK (btrim(pushed_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Optimize active feed query (electron-updater checking latest for channel/platform)
CREATE INDEX IF NOT EXISTS idx_app_versions_active_feed
  ON auric.app_versions (release_channel, windows_version, is_latest)
  WHERE is_latest = true;

CREATE INDEX IF NOT EXISTS idx_app_versions_semver
  ON auric.app_versions (version, release_channel);

CREATE INDEX IF NOT EXISTS idx_app_versions_created_at
  ON auric.app_versions (created_at DESC);

-- Automated updated_at trigger
DROP TRIGGER IF EXISTS touch_app_versions_updated_at ON auric.app_versions;
CREATE TRIGGER touch_app_versions_updated_at
  BEFORE UPDATE ON auric.app_versions
  FOR EACH ROW EXECUTE FUNCTION auric.touch_updated_at();

-- Grant permissions to auric_app role
GRANT SELECT, INSERT, UPDATE, DELETE ON auric.app_versions TO auric_app;
`,
} as const;

export const auricCredentialsPermissionsSchema = {
  id: '010_credentials_and_devices_grants',
  sql: `
GRANT USAGE ON SCHEMA auth TO auric_app;
GRANT SELECT ON auth.users, auth.roles, auth.sessions TO auric_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auric.auric_credentials TO auric_app;
`,
} as const;

export const auricControlCenterGrantsSchema = {
  id: '012_auric_control_center_grants',
  sql: `
GRANT INSERT, UPDATE ON auric.subscription_plans TO auric_app;
`,
} as const;

export const auricDevicePublicKeySchema = {
  id: '013_auric_device_public_key',
  sql: `
ALTER TABLE auric.devices ADD COLUMN IF NOT EXISTS public_key text;
`,
} as const;

export const auricFormatTemplatesSchema = {
  id: '014_auric_format_templates',
  sql: `
CREATE TABLE IF NOT EXISTS auric.format_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  format_id text NOT NULL UNIQUE CHECK (length(format_id) BETWEEN 1 AND 200),
  folder_name text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  category text NOT NULL,
  page_size text,
  paper_name text,
  description text,
  format_enc bytea NOT NULL CHECK (octet_length(format_enc) <= 8388608),
  assets jsonb NOT NULL DEFAULT '[]',
  assets_count integer NOT NULL DEFAULT 0,
  elements_count integer NOT NULL DEFAULT 0,
  source_key_id text NOT NULL,
  is_required boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS format_templates_catalog ON auric.format_templates (is_active, category, name);
CREATE TABLE IF NOT EXISTS auric.format_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auric.format_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON auric.format_templates, auric.format_settings TO auric_app;
`,
} as const;

export const auricServerCoveStorageSchema = {
  id: '015_auric_server_cove_storage',
  sql: `
-- Dedicated disabled system service account for Auric Server files in Cove
INSERT INTO auth.users (email, password_hash, role_id, disabled_at, first_name, last_name, username)
VALUES (
  'auric_server@system.auric.internal',
  '!disabled-system-service-account!',
  1,
  now(),
  'Auric',
  'Server',
  'auric_server'
)
ON CONFLICT (username) DO NOTHING;

INSERT INTO auric.shop_profiles (user_id, shop_name, shop_location, gstin)
SELECT id, 'Auric Server Storage', 'System', NULL
FROM auth.users
WHERE lower(COALESCE(username, '')) = 'auric_server'
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE auric.format_templates
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'cove' CHECK (storage_backend IN ('cove', 'postgres')),
  ADD COLUMN IF NOT EXISTS cove_folder_id uuid,
  ADD COLUMN IF NOT EXISTS format_cove_file_id uuid,
  ALTER COLUMN format_enc DROP NOT NULL;

UPDATE auric.format_templates
SET storage_backend = 'postgres'
WHERE format_cove_file_id IS NULL AND format_enc IS NOT NULL;
`,
} as const;

export const AURIC_MIGRATIONS = [
  auricSchema,
  auricEntitlementsSchema,
  auricShopProfileSchema,
  auricCredentialRenameSchema,
  auricInrPaymentsSchema,
  auricSubscriptionPlansSchema,
  auricDeviceIdentitySchema,
  auricOptimizationsSchema,
  auricAppVersionsSchema,
  auricCredentialsPermissionsSchema,
  auricSupportSchema,
  auricControlCenterGrantsSchema,
  auricDevicePublicKeySchema,
  auricFormatTemplatesSchema,
  auricServerCoveStorageSchema,
];

