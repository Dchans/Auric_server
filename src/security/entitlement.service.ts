import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ActiveSubscriptionDto } from '../schema';

export interface SubscriptionEntitlementClaims {
  sub: string;
  username: string;
  plan_code: string | null;
  plan_name: string | null;
  active: boolean;
  status: 'active' | 'trialing' | 'past_due' | 'expired' | 'inactive';
  modules: {
    pawn: boolean;
    jewel: boolean;
    finance: boolean;
    remote: boolean;
    cloud_backup: boolean;
  };
  issued_at: number;
  valid_until: number | null;
  grace_period_days: number;
  offline_unlimited: boolean;
  nonce: string;
}

export interface SignedEntitlement {
  claims: SubscriptionEntitlementClaims;
  signature: string;
  algorithm: 'Ed25519';
}

export interface SubscriptionPayload {
  success: boolean;
  active: boolean;
  status: 'active' | 'trialing' | 'past_due' | 'expired' | 'inactive';
  subscription_type: string | null;
  plan_name: string | null;
  expiry: string | null;
  days_remaining: number | null;
  is_expired: boolean;
  renewal_grace_days_remaining: number;
  remote_enabled: boolean;
  backup_enabled: boolean;
  online_backup_enabled: boolean;
  module_access: {
    pawn: boolean;
    jewel: boolean;
    finance: boolean;
  };
  entitlement: SignedEntitlement;
}

const DEFAULT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEILIQLcfMkP1iiTieWyFRily3NNsLTrMcwXkKJfZIazse
-----END PRIVATE KEY-----`;

const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkei8MrrOzAANoduFYeoFlNFzpYc0/zeODKrs3s4HDdI=
-----END PUBLIC KEY-----`;

export function canonicalizeJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => JSON.stringify(key) + ':' + canonicalizeJson(obj[key]));
  return '{' + pairs.join(',') + '}';
}

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);
  private privateKeyPem: string;
  private publicKeyPem: string;

  constructor() {
    this.privateKeyPem = this.resolvePrivateKey();
    this.publicKeyPem = this.resolvePublicKey();
  }

  private resolvePrivateKey(): string {
    if (process.env.SUBSCRIPTION_SIGNING_PRIVATE_KEY) {
      return process.env.SUBSCRIPTION_SIGNING_PRIVATE_KEY;
    }
    const keyPath = process.env.SUBSCRIPTION_PRIVATE_KEY_PATH || path.resolve(__dirname, '../../keys/subscription_private.pem');
    try {
      if (fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf8');
      }
    } catch (e) {
      this.logger.warn(`Could not read private key from ${keyPath}, using embedded default`);
    }
    return DEFAULT_PRIVATE_KEY;
  }

  private resolvePublicKey(): string {
    if (process.env.SUBSCRIPTION_VERIFY_PUBLIC_KEY) {
      return process.env.SUBSCRIPTION_VERIFY_PUBLIC_KEY;
    }
    const keyPath = process.env.SUBSCRIPTION_PUBLIC_KEY_PATH || path.resolve(__dirname, '../../keys/subscription_public.pem');
    try {
      if (fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf8');
      }
    } catch (e) {
      this.logger.warn(`Could not read public key from ${keyPath}, using embedded default`);
    }
    return DEFAULT_PUBLIC_KEY;
  }

  public getPublicKey(): string {
    return this.publicKeyPem;
  }

  public buildClaims(
    user: { id: string; username?: string | null },
    subData: { status: 'active' | 'inactive'; subscriptions: ActiveSubscriptionDto[] }
  ): SubscriptionEntitlementClaims {
    const activeSubs = (subData.subscriptions || []).filter((s) => s.status === 'active');
    const hasActive = activeSubs.length > 0;

    let latestPeriodEnd: number | null = null;
    let primaryPlanCode: string | null = null;
    let primaryPlanName: string | null = null;
    let fallbackStatus: 'active' | 'trialing' | 'past_due' | 'expired' | 'inactive' = 'inactive';

    const moduleFlags = {
      pawn: false,
      jewel: false,
      finance: false,
      remote: false,
      cloud_backup: false,
    };

    if (hasActive) {
      fallbackStatus = 'active';
      for (const sub of activeSubs) {
        if (!primaryPlanCode) primaryPlanCode = sub.planCode;
        if (!primaryPlanName) primaryPlanName = sub.planName;

        if (sub.currentPeriodEndAt) {
          const endMs = new Date(sub.currentPeriodEndAt).getTime();
          if (latestPeriodEnd === null || endMs > latestPeriodEnd) {
            latestPeriodEnd = endMs;
          }
        }

        const mods = sub.modules || [];
        for (const m of mods) {
          const upper = String(m).toUpperCase();
          if (upper === 'PAWN') moduleFlags.pawn = true;
          if (upper === 'JEWEL' || upper === 'JEWLE') moduleFlags.jewel = true;
          if (upper === 'FINANCE') moduleFlags.finance = true;
          if (upper === 'REMOTE') moduleFlags.remote = true;
          if (upper === 'CLOUD_BACKUP') moduleFlags.cloud_backup = true;
        }
      }
    } else if (subData.subscriptions && subData.subscriptions.length > 0) {
      // Retain latest subscription details even if non-active (expired, canceled, past_due)
      const latestSub = subData.subscriptions[0];
      primaryPlanCode = latestSub.planCode;
      primaryPlanName = latestSub.planName;
      if (latestSub.currentPeriodEndAt) {
        latestPeriodEnd = new Date(latestSub.currentPeriodEndAt).getTime();
      }
      const rawStatus = (latestSub.status as string)?.toLowerCase();
      if (rawStatus === 'expired' || rawStatus === 'canceled' || rawStatus === 'past_due' || rawStatus === 'trialing') {
        fallbackStatus = rawStatus as any;
      } else {
        fallbackStatus = 'expired';
      }
    }

    const now = Date.now();
    const isPastPeriodEnd = latestPeriodEnd !== null ? latestPeriodEnd <= now : false;
    const finalActive = hasActive && !isPastPeriodEnd;
    const finalStatus: 'active' | 'trialing' | 'past_due' | 'expired' | 'inactive' =
      finalActive
        ? 'active'
        : (fallbackStatus === 'expired' || isPastPeriodEnd)
          ? 'expired'
          : fallbackStatus;

    return {
      sub: user.id,
      username: user.username || 'unknown',
      plan_code: primaryPlanCode,
      plan_name: primaryPlanName,
      active: finalActive,
      status: finalStatus,
      modules: {
        pawn: finalActive ? moduleFlags.pawn : false,
        jewel: finalActive ? moduleFlags.jewel : false,
        finance: finalActive ? moduleFlags.finance : false,
        remote: finalActive ? moduleFlags.remote : false,
        cloud_backup: finalActive ? moduleFlags.cloud_backup : false,
      },
      issued_at: now,
      valid_until: latestPeriodEnd,
      grace_period_days: 7,
      offline_unlimited: true, // Offline permitted indefinitely until valid_until
      nonce: crypto.randomBytes(16).toString('hex'),
    };
  }

  public signClaims(claims: SubscriptionEntitlementClaims): SignedEntitlement {
    // Canonical serialization: keys and nested objects sorted deterministically
    const canonicalPayload = canonicalizeJson(claims);
    const dataBuffer = Buffer.from(canonicalPayload, 'utf8');

    const signature = crypto.sign(null, dataBuffer, this.privateKeyPem).toString('base64');

    return {
      claims,
      signature,
      algorithm: 'Ed25519',
    };
  }

  public buildSubscriptionPayload(
    user: { id: string; username?: string | null },
    subData: { status: 'active' | 'inactive'; subscriptions: ActiveSubscriptionDto[] }
  ): SubscriptionPayload {
    const claims = this.buildClaims(user, subData);
    const entitlement = this.signClaims(claims);

    const now = Date.now();
    let daysRemaining: number | null = null;
    if (claims.valid_until && claims.active) {
      const diffMs = claims.valid_until - now;
      daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    } else {
      daysRemaining = 0;
    }

    const isExpired = claims.status === 'expired' || !claims.active;

    return {
      success: true,
      active: claims.active,
      status: claims.status,
      subscription_type: claims.plan_code,
      plan_name: claims.plan_name,
      expiry: claims.valid_until ? new Date(claims.valid_until).toISOString() : null,
      days_remaining: daysRemaining,
      is_expired: isExpired,
      renewal_grace_days_remaining: claims.grace_period_days,
      remote_enabled: claims.modules.remote,
      backup_enabled: claims.modules.cloud_backup,
      online_backup_enabled: claims.modules.cloud_backup,
      module_access: {
        pawn: claims.modules.pawn,
        jewel: claims.modules.jewel,
        finance: claims.modules.finance,
      },
      entitlement,
    };
  }
}
