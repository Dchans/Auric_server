'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CredentialsService } = require('../dist/credentials/credentials.service');

function makeFakeDb() {
  const store = new Map();
  const query = async (sql, values = []) => {
    if (sql.includes('SELECT credential_type FROM auric.auric_credentials')) {
      const [userId] = values;
      const rows = [];
      for (const row of store.values()) {
        if (row.user_id === userId) rows.push({ credential_type: row.credential_type });
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT credential_type, ciphertext, nonce, auth_tag')) {
      const [userId] = values;
      const rows = [];
      for (const row of store.values()) {
        if (row.user_id === userId) rows.push(row);
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO auric.auric_credentials') && sql.includes('DO NOTHING')) {
      const [user_id, credential_type, ciphertext, nonce, auth_tag, key_id] = values;
      const key = `${user_id}:${credential_type}`;
      if (store.has(key)) return { rows: [], rowCount: 0 };
      store.set(key, { user_id, credential_type, ciphertext, nonce, auth_tag, key_id, updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO auric.auric_credentials') && sql.includes('DO UPDATE')) {
      const [user_id, credential_type, ciphertext, nonce, auth_tag, key_id] = values;
      const key = `${user_id}:${credential_type}`;
      store.set(key, { user_id, credential_type, ciphertext, nonce, auth_tag, key_id, updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in fake DB: ${sql}`);
  };
  return { store, query };
}

test('generateRandomSecret creates 32-char alphanumeric secrets with high entropy', () => {
  const svc = new CredentialsService(makeFakeDb());
  const first = svc.generateRandomSecret(32);
  const second = svc.generateRandomSecret(32);
  assert.match(first, /^[A-Za-z0-9]{32}$/);
  assert.match(second, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(first, second);
});

test('ensureCredentials auto-generates missing db_password and file_password and never overwrites existing ones', async () => {
  const db = makeFakeDb();
  const svc = new CredentialsService(db);
  const userId = '11111111-1111-4111-8111-111111111111';

  const firstRun = await svc.ensureCredentials(userId);
  assert.deepEqual(firstRun.created.sort(), ['db_password', 'file_password']);

  const firstCreds = await svc.getDecryptedCredentials(userId);
  assert.match(firstCreds.dbPassword, /^[A-Za-z0-9]{32}$/);
  assert.match(firstCreds.filePassword, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(firstCreds.dbPassword, firstCreds.filePassword);

  const secondRun = await svc.ensureCredentials(userId);
  assert.deepEqual(secondRun.created, []);

  const secondCreds = await svc.getDecryptedCredentials(userId);
  assert.equal(secondCreds.dbPassword, firstCreds.dbPassword);
  assert.equal(secondCreds.filePassword, firstCreds.filePassword);
});

test('ensureCredentials only generates the missing credential when one already exists', async () => {
  const db = makeFakeDb();
  const svc = new CredentialsService(db);
  const userId = '22222222-2222-4222-8222-222222222222';

  await svc.saveCredential(userId, 'db_password', 'existing-custom-db-password-123');
  const result = await svc.ensureCredentials(userId);
  assert.deepEqual(result.created, ['file_password']);

  const creds = await svc.getDecryptedCredentials(userId);
  assert.equal(creds.dbPassword, 'existing-custom-db-password-123');
  assert.match(creds.filePassword, /^[A-Za-z0-9]{32}$/);
});
