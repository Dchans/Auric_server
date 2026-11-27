'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateChecksumV1, calculateChecksumV2, checkIntegrity, convertFormat, decryptBuffer, deriveSecretKey,
  encryptBuffer, keyFingerprint, parseFormatUpload, sealFormat,
} = require('../dist/formats/format-convertor');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function sampleFormat(overrides = {}) {
  return {
    id: 'pawnBill-sample-1', name: 'Sample', category: 'pawnBill', pageSize: 'A4', backgroundColor: '#fff',
    backgroundImage: 'bg_1_a.enc', backgroundImagePreserveAspectRatio: 'xMidYMid meet', textLanguage: 'english', numberSystem: 'english',
    elements: [{ id: 'e1', type: 'text', content: 'Hi' }, { id: 'e2', type: 'image', href: 'img_1_b.enc' }], ...overrides,
  };
}

function encryptedBundle(key, { legacy = false, tamper = false } = {}) {
  const data = sampleFormat();
  const checksum = legacy ? calculateChecksumV1(data) : calculateChecksumV2(data);
  const files = [
    { name: 'folder/format.enc', data: encryptBuffer(Buffer.from(JSON.stringify({ ...data, checksum: tamper ? 'bad' : checksum })), key, 'format-json') },
    { name: 'folder/bg_1_a.enc', data: encryptBuffer(PNG, key, 'format-image') },
    { name: 'folder/img_1_b.enc', data: encryptBuffer(Buffer.concat([PNG, Buffer.from('x')]), key, 'format-image') },
  ];
  return files;
}

const demo = deriveSecretKey('demo-file-password-0000000000000000');
const customer = deriveSecretKey('customer-file-password-111111111111');

test('encrypted demo bundle is validated, sealed and converted for one customer only', () => {
  const normalised = parseFormatUpload(encryptedBundle(demo), { sourceKey: demo });
  assert.equal(normalised.checksumState, 'v2');
  assert.equal(normalised.assets.size, 2);
  const sealed = sealFormat(normalised, demo);
  const files = convertFormat({ formatEnc: sealed.formatEnc, assets: sealed.assets }, demo, customer);
  assert.deepEqual(files.map((f) => f.filename).sort(), ['bg_1_a.enc', 'format.enc', 'img_1_b.enc']);

  const format = files.find((f) => f.filename === 'format.enc');
  const data = JSON.parse(decryptBuffer(format.data, customer, 'format-json').toString('utf8'));
  assert.equal(checkIntegrity(data), 'v2');
  assert.deepEqual(decryptBuffer(files.find((f) => f.filename === 'bg_1_a.enc').data, customer, 'format-image'), PNG);
  assert.throws(() => decryptBuffer(format.data, demo, 'format-json'), 'demo key must not open customer files');
});

test('legacy v1 checksum is accepted and upgraded to v2', () => {
  const normalised = parseFormatUpload(encryptedBundle(demo, { legacy: true }), { sourceKey: demo });
  assert.equal(normalised.checksumState, 'v1');
  const sealed = sealFormat(normalised, demo);
  const files = convertFormat({ formatEnc: sealed.formatEnc, assets: sealed.assets }, demo, customer);
  const data = JSON.parse(decryptBuffer(files[0].data, customer, 'format-json').toString('utf8'));
  assert.equal(checkIntegrity(data), 'v2');
});

test('tampered, wrong-key and incomplete uploads are rejected', () => {
  assert.throws(() => parseFormatUpload(encryptedBundle(demo, { tamper: true }), { sourceKey: demo }), /checksum/i);
  assert.doesNotThrow(() => parseFormatUpload(encryptedBundle(demo, { tamper: true }), { sourceKey: demo, ignoreChecksum: true }));
  assert.throws(() => parseFormatUpload(encryptedBundle(demo), { sourceKey: customer }), /decrypted/i);
  assert.throws(() => parseFormatUpload(encryptedBundle(demo).slice(0, 2), { sourceKey: demo }), /missing/i);
  assert.throws(() => parseFormatUpload([{ name: 'x.txt', data: Buffer.from('x') }], { sourceKey: demo }), /format\.enc/);
});

test('plain format.json with inline images becomes encrypted assets and rejects bad ids', () => {
  const plain = sampleFormat({
    backgroundImage: `data:image/png;base64,${PNG.toString('base64')}`,
    elements: [{ id: 'e', type: 'image', href: `data:image/png;base64,${PNG.toString('base64')}` }],
  });
  const normalised = parseFormatUpload([{ name: 'format.json', data: Buffer.from(JSON.stringify(plain)) }]);
  assert.equal(normalised.assets.size, 2);
  assert.match(normalised.data.backgroundImage, /^bg_.*\.enc$/);

  const bad = sampleFormat({ id: '../escape', backgroundImage: null, elements: [] });
  assert.throws(() => parseFormatUpload([{ name: 'format.json', data: Buffer.from(JSON.stringify(bad)) }]), /unsafe/i);
  const unknown = sampleFormat({ category: 'nope', backgroundImage: null, elements: [] });
  assert.throws(() => parseFormatUpload([{ name: 'format.json', data: Buffer.from(JSON.stringify(unknown)) }]), /category/i);
});

test('a changed master key is reported and key fingerprints differ', () => {
  const sealed = sealFormat(parseFormatUpload(encryptedBundle(demo), { sourceKey: demo }), demo);
  assert.throws(() => convertFormat({ formatEnc: sealed.formatEnc, assets: sealed.assets }, customer, customer), /MASTER_KEY_MISMATCH/);
  assert.notEqual(keyFingerprint(demo), keyFingerprint(customer));
});
