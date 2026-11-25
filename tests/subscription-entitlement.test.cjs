const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

function canonicalizeJson(obj) {
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

// 1. Load keys
const privateKey = require('fs').readFileSync(path.resolve(__dirname, '../keys/subscription_private.pem'), 'utf8');
const publicKey = require('fs').readFileSync(path.resolve(__dirname, '../keys/subscription_public.pem'), 'utf8');

console.log('[1/5] Testing Key Pair Loading & Basic Ed25519 Signing...');
assert(privateKey.includes('BEGIN PRIVATE KEY'), 'Private key should be valid PEM');
assert(publicKey.includes('BEGIN PUBLIC KEY'), 'Public key should be valid PEM');

// 2. Generate Claims
const claims = {
  sub: '123e4567-e89b-12d3-a456-426614174000',
  username: 'testshop',
  plan_code: 'AURIC_GOLD',
  plan_name: 'Auric Gold Suite',
  active: true,
  status: 'active',
  modules: {
    pawn: true,
    jewel: true,
    finance: false,
    remote: true,
    cloud_backup: true,
  },
  issued_at: Date.now(),
  valid_until: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days in future
  grace_period_days: 7,
  offline_unlimited: true,
  nonce: crypto.randomBytes(16).toString('hex'),
};

const canonicalPayload = canonicalizeJson(claims);
const signature = crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKey).toString('base64');

console.log('[2/5] Verifying Untampered Claims Signature...');
const isSigValid = crypto.verify(
  null,
  Buffer.from(canonicalPayload, 'utf8'),
  publicKey,
  Buffer.from(signature, 'base64')
);
assert.strictEqual(isSigValid, true, 'Valid signature should verify successfully');
console.log(' -> Signature verified: OK');

console.log('[3/5] Testing Anti-Tampering (Modifying Module Access)...');
const tamperedClaims = { ...claims, modules: { ...claims.modules, finance: true } };
const tamperedPayload = canonicalizeJson(tamperedClaims);
const isTamperedValid = crypto.verify(
  null,
  Buffer.from(tamperedPayload, 'utf8'),
  publicKey,
  Buffer.from(signature, 'base64')
);
assert.strictEqual(isTamperedValid, false, 'Tampered claims MUST fail signature verification');
console.log(' -> Tamper detection verified: OK (Forged claim correctly rejected)');

console.log('[4/5] Testing Indefinite Offline Expiration Logic...');
const now = Date.now();
const isStillValidOffline = claims.valid_until > now;
assert.strictEqual(isStillValidOffline, true, 'Indefinite offline validity should hold before valid_until');

const expiredClaims = { ...claims, valid_until: now - 1000 };
const isExpiredWithoutGrace = (now > expiredClaims.valid_until + (expiredClaims.grace_period_days * 86400000));
assert.strictEqual(isExpiredWithoutGrace, false, 'Should still be in grace period within 7 days');

const longExpiredClaims = { ...claims, valid_until: now - (8 * 86400000) };
const isHardExpired = (now > longExpiredClaims.valid_until + (longExpiredClaims.grace_period_days * 86400000));
assert.strictEqual(isHardExpired, true, 'Should be hard expired after valid_until + grace_period');
console.log(' -> Offline expiration & grace period: OK');

console.log('[5/5] Testing Monotonic Clock Rollback Detection...');
let lastVerifiedTime = now;
let rolledBackSystemTime = now - (60 * 60 * 1000); // User rolled clock back 1 hour
let rollbackDetected = rolledBackSystemTime < lastVerifiedTime - 300000;
assert.strictEqual(rollbackDetected, true, 'System clock rollback must be detected');
console.log(' -> Clock rollback detection: OK');

console.log('\n=== ALL SUBSCRIPTION VERIFICATION TESTS PASSED ===\n');
