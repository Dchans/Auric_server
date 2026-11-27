import { BadRequestException } from '@nestjs/common';
import * as crypto from 'node:crypto';

/**
 * Server-side port of the standalone Format Convertor (P:\Auric\Format_Convertor).
 * Everything is in-memory: no temporary files are ever written on the server.
 *
 * Cryptography is intentionally identical to the Auric desktop FormatManager:
 *  - AES-256-GCM, layout [IV(16) | AuthTag(16) | ciphertext]
 *  - AAD 'format-json' for format.enc, 'format-image' for background/image assets
 *  - key = base64 32-byte key, otherwise PBKDF2-SHA256(100000, 'format-encryption-salt-v1')
 *  - checksum = SHA-256 over the canonical (Auric v2) field selection
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_SIZE = 32;
const IV_SIZE = 16;
const AUTH_TAG_SIZE = 16;
const KEY_SALT = 'format-encryption-salt-v1';
const PBKDF2_ITERATIONS = 100000;

export const FORMAT_CATEGORIES = [
  'pawnBill', 'pawnFormD3', 'pawnToken', 'jewelSale', 'jewelPurchase', 'jewelOldMetalPurchase',
  'jewelRefinery', 'jewelPureGoldIssue', 'jewelStockReport', 'barcode', 'pawnNotice', 'stockBuylist',
  'pawnLedger', 'jewelSaleLedger', 'jewelOldMetalExchangeLedger', 'financeLedger', 'finance',
] as const;

export const FORMAT_LIMITS = {
  maxFiles: 80,
  maxTotalBytes: 18 * 1024 * 1024,
  maxAssetBytes: 6 * 1024 * 1024,
  maxElements: 5000,
  maxFormatJsonBytes: 4 * 1024 * 1024,
} as const;

const SAFE_ID = /^[A-Za-z0-9_.\-]{1,200}$/;
const SAFE_ASSET = /^[A-Za-z0-9_.\-]{1,160}\.enc$/;

export type FormatData = {
  id: string;
  name: string;
  category: string;
  pageSize: string;
  customWidth?: number;
  customHeight?: number;
  backgroundColor?: string;
  backgroundImage?: string | null;
  backgroundImagePreserveAspectRatio?: string;
  paperName?: string;
  textLanguage?: string;
  numberSystem?: string;
  elements: Array<Record<string, any>>;
  createdAt?: number;
  updatedAt?: number;
  checksum?: string;
  [extra: string]: unknown;
};

export interface UploadFile { name: string; data: Buffer }
export interface NormalizedFormat { data: FormatData; assets: Map<string, Buffer>; checksumState: 'v2' | 'v1' | 'none' }
export interface OutputFile { filename: string; data: Buffer; sha256: string }

export function deriveSecretKey(userKey: string): Buffer {
  const decoded = Buffer.from(userKey, 'base64');
  if (decoded.length === KEY_SIZE) return decoded;
  return crypto.pbkdf2Sync(userKey, KEY_SALT, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
}

/** Non-reversible identifier used to detect when the key a format was sealed with has changed. */
export function keyFingerprint(key: Buffer): string {
  return crypto.createHmac('sha256', 'auric-format-key-id-v1').update(key).digest('hex').slice(0, 24);
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function encryptBuffer(buffer: Buffer, key: Buffer, aad: string): Buffer {
  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBuffer(encrypted: Buffer, key: Buffer, aad: string): Buffer {
  if (encrypted.length < IV_SIZE + AUTH_TAG_SIZE) throw new Error('Invalid encrypted data format.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, encrypted.subarray(0, IV_SIZE));
  decipher.setAuthTag(encrypted.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE));
  decipher.setAAD(Buffer.from(aad));
  return Buffer.concat([decipher.update(encrypted.subarray(IV_SIZE + AUTH_TAG_SIZE)), decipher.final()]);
}

export function calculateChecksumV2(data: FormatData): string {
  return sha256Hex(Buffer.from(JSON.stringify({
    id: data.id, name: data.name, category: data.category, pageSize: data.pageSize,
    customWidth: data.customWidth, customHeight: data.customHeight,
    backgroundColor: data.backgroundColor, backgroundImage: data.backgroundImage,
    backgroundImagePreserveAspectRatio: data.backgroundImagePreserveAspectRatio,
    textLanguage: data.textLanguage, numberSystem: data.numberSystem, elements: data.elements,
  })));
}

export function calculateChecksumV1(data: FormatData): string {
  return sha256Hex(Buffer.from(JSON.stringify({
    id: data.id, name: data.name, category: data.category, pageSize: data.pageSize,
    customWidth: data.customWidth, customHeight: data.customHeight,
    backgroundColor: data.backgroundColor, backgroundImage: data.backgroundImage,
    backgroundImagePreserveAspectRatio: data.backgroundImagePreserveAspectRatio, elements: data.elements,
  })));
}

export function checkIntegrity(data: FormatData): 'v2' | 'v1' | 'none' | 'invalid' {
  if (!data.checksum) return 'none';
  const { checksum, ...rest } = data;
  if (checksum === calculateChecksumV2(rest as FormatData)) return 'v2';
  if (checksum === calculateChecksumV1(rest as FormatData)) return 'v1';
  return 'invalid';
}

const baseName = (name: string) => name.replace(/\\/g, '/').split('/').pop() ?? '';
const isDataImage = (value: unknown): value is string => typeof value === 'string' && value.startsWith('data:image/');
const decodeDataImage = (value: string) => Buffer.from(value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ''), 'base64');

function assetName(prefix: 'bg' | 'img'): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}.enc`;
}

function validateShape(data: any): asserts data is FormatData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BadRequestException('The format file does not contain a JSON object.');
  if (typeof data.id !== 'string' || !SAFE_ID.test(data.id)) throw new BadRequestException('The format id is missing or has unsafe characters.');
  if (typeof data.category !== 'string' || !(FORMAT_CATEGORIES as readonly string[]).includes(data.category)) {
    throw new BadRequestException(`Unknown format category "${String(data.category)}".`);
  }
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw new BadRequestException('The format name is missing or too long.');
  if (typeof data.pageSize !== 'string' || !data.pageSize.trim() || data.pageSize.length > 64) throw new BadRequestException('The format page size is missing.');
  if (!Array.isArray(data.elements) || data.elements.length > FORMAT_LIMITS.maxElements) throw new BadRequestException('The format elements are missing or too many.');
  if (data.elements.some((el: unknown) => !el || typeof el !== 'object' || Array.isArray(el))) throw new BadRequestException('The format contains an invalid element.');
}

/**
 * Validates an uploaded format (encrypted format.enc bundle or plain format.json) and returns it
 * normalised: plaintext JSON data plus every image asset as plaintext bytes referenced by .enc filename.
 */
export function parseFormatUpload(files: UploadFile[], opts: { sourceKey?: Buffer; ignoreChecksum?: boolean } = {}): NormalizedFormat {
  const byName = new Map<string, Buffer>();
  for (const file of files) byName.set(baseName(file.name), file.data);
  const enc = byName.get('format.enc');
  const json = byName.get('format.json');
  if (!enc && !json) throw new BadRequestException('Include format.enc (with its .enc images) or format.json.');

  let data: FormatData;
  const assets = new Map<string, Buffer>();
  if (enc) {
    if (!opts.sourceKey) throw new BadRequestException('A source key is required for an encrypted format.');
    let text: string;
    try { text = decryptBuffer(enc, opts.sourceKey, 'format-json').toString('utf8'); }
    catch { throw new BadRequestException('format.enc could not be decrypted with the selected source key.'); }
    try { data = JSON.parse(text); } catch { throw new BadRequestException('The decrypted format is not valid JSON.'); }
  } else {
    if (json!.length > FORMAT_LIMITS.maxFormatJsonBytes) throw new BadRequestException('format.json is too large.');
    try { data = JSON.parse(json!.toString('utf8')); } catch { throw new BadRequestException('format.json is not valid JSON.'); }
  }
  validateShape(data);

  const state = checkIntegrity(data);
  if (state === 'invalid' && !opts.ignoreChecksum) {
    throw new BadRequestException('The format checksum does not match its contents. It may be damaged or edited.');
  }

  const resolveImage = (ref: unknown, prefix: 'bg' | 'img'): string | null | unknown => {
    if (typeof ref !== 'string' || !ref) return ref;
    if (ref.endsWith('.enc')) {
      const name = baseName(ref);
      if (!SAFE_ASSET.test(name)) throw new BadRequestException(`Unsafe image file name "${name}".`);
      if (assets.has(name)) return name;
      const source = byName.get(name);
      if (!source) throw new BadRequestException(`The image file ${name} is missing from the upload.`);
      if (!opts.sourceKey) throw new BadRequestException('A source key is required for encrypted images.');
      let plain: Buffer;
      try { plain = decryptBuffer(source, opts.sourceKey, 'format-image'); }
      catch { throw new BadRequestException(`The image ${name} could not be decrypted with the selected source key.`); }
      if (plain.length > FORMAT_LIMITS.maxAssetBytes) throw new BadRequestException(`The image ${name} is too large.`);
      assets.set(name, plain);
      return name;
    }
    if (/^https?:\/\//i.test(ref)) return ref;
    let plain: Buffer | undefined;
    if (isDataImage(ref)) plain = decodeDataImage(ref);
    else plain = byName.get(baseName(ref));
    if (!plain) throw new BadRequestException(`The image "${ref.slice(0, 40)}" is missing from the upload.`);
    if (plain.length > FORMAT_LIMITS.maxAssetBytes) throw new BadRequestException('An image in the format is too large.');
    const name = assetName(prefix);
    assets.set(name, plain);
    return name;
  };

  const now = Date.now();
  const final: FormatData = {
    ...data,
    id: data.id,
    name: data.name.trim(),
    backgroundImage: (resolveImage(data.backgroundImage ?? null, 'bg') as string | null) ?? null,
    elements: data.elements.map((el) => (el.type === 'image' && el.href ? { ...el, href: resolveImage(el.href, 'img') } : el)),
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : now,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
  };
  delete final.checksum;
  return { data: final, assets, checksumState: state === 'invalid' ? 'none' : state };
}

export interface SealedFormat {
  formatEnc: Buffer;
  assets: Array<{ filename: string; dataBase64: string; sha256: string }>;
}

/** Re-encrypts a normalised format under the master (demo) key for storage. */
export function sealFormat(format: NormalizedFormat, masterKey: Buffer): SealedFormat {
  const checksum = calculateChecksumV2(format.data);
  const json = Buffer.from(JSON.stringify({ ...format.data, checksum }, null, 2), 'utf8');
  const assets = [...format.assets].map(([filename, plain]) => {
    const encrypted = encryptBuffer(plain, masterKey, 'format-image');
    return { filename, dataBase64: encrypted.toString('base64'), sha256: sha256Hex(encrypted) };
  });
  return { formatEnc: encryptBuffer(json, masterKey, 'format-json'), assets };
}

/**
 * Decrypts a stored format with the master (demo) key and re-encrypts it for one target user.
 * The master key never leaves the server; only data sealed for the target key is returned.
 */
export function convertFormat(
  stored: { formatEnc: Buffer; assets: Array<{ filename: string; dataBase64: string }> },
  masterKey: Buffer,
  targetKey: Buffer,
): OutputFile[] {
  let data: FormatData;
  try { data = JSON.parse(decryptBuffer(stored.formatEnc, masterKey, 'format-json').toString('utf8')); }
  catch { throw new Error('MASTER_KEY_MISMATCH'); }
  if (checkIntegrity(data) !== 'v2') throw new Error('STORED_FORMAT_DAMAGED');

  const stash = new Map(stored.assets.map((asset) => [asset.filename, Buffer.from(asset.dataBase64, 'base64')]));
  const referenced = new Set<string>();
  if (typeof data.backgroundImage === 'string' && data.backgroundImage.endsWith('.enc')) referenced.add(data.backgroundImage);
  for (const el of data.elements) if (el.type === 'image' && typeof el.href === 'string' && el.href.endsWith('.enc')) referenced.add(el.href);

  const outputs: OutputFile[] = [];
  for (const filename of referenced) {
    const sealed = stash.get(filename);
    if (!sealed) throw new Error('STORED_FORMAT_DAMAGED');
    let plain: Buffer;
    try { plain = decryptBuffer(sealed, masterKey, 'format-image'); } catch { throw new Error('STORED_FORMAT_DAMAGED'); }
    const encrypted = encryptBuffer(plain, targetKey, 'format-image');
    plain.fill(0);
    outputs.push({ filename, data: encrypted, sha256: sha256Hex(encrypted) });
  }
  const json = Buffer.from(JSON.stringify({ ...data, checksum: calculateChecksumV2(data) }, null, 2), 'utf8');
  const encrypted = encryptBuffer(json, targetKey, 'format-json');
  outputs.unshift({ filename: 'format.enc', data: encrypted, sha256: sha256Hex(encrypted) });
  return outputs;
}

export function safeUploadFiles(raw: unknown): UploadFile[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > FORMAT_LIMITS.maxFiles) throw new BadRequestException('Provide between 1 and 80 files.');
  let total = 0;
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.dataBase64 !== 'string' || !item.name || item.name.length > 300 || /[\x00-\x1f]/.test(item.name)) {
      throw new BadRequestException('Each file needs a name and base64 data.');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) throw new BadRequestException('A file is not valid base64.');
    const data = Buffer.from(item.dataBase64, 'base64');
    total += data.length;
    if (total > FORMAT_LIMITS.maxTotalBytes) throw new BadRequestException('The upload is too large.');
    return { name: item.name, data };
  });
}
