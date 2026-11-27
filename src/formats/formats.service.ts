import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CredentialsService } from '../credentials/credentials.service';
import { boolean, object, text, uuid } from '../control-common';
import { CoveStorageClient } from './cove-storage.client';
import {
  convertFormat, deriveSecretKey, FORMAT_CATEGORIES, keyFingerprint, parseFormatUpload, safeUploadFiles, sealFormat,
} from './format-convertor';

const MAX_FETCH = 25;
const SERVER_STORAGE_USERNAME = 'auric_server';
const COVE_FORMATS_ROOT_PATH = ['Auric Server', 'Formats'];

type AccountRef = { id: string; email: string; username: string | null };

interface StoredAssetEntry {
  filename: string;
  coveFileId?: string;
  dataBase64?: string;
  sha256: string;
  sizeBytes?: number;
}

@Injectable()
export class FormatsService {
  private readonly logger = new Logger(FormatsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly credentials: CredentialsService,
    private readonly cove: CoveStorageClient,
  ) {}

  // ── Dedicated auric_server Cove storage account ──────────────────────────

  async resolveStorageAccount(): Promise<AccountRef> {
    const { rows: [account] } = await this.db.query<AccountRef>(
      `SELECT id, email, username FROM auth.users
       WHERE lower(COALESCE(username,'')) = $1
       LIMIT 1`,
      [SERVER_STORAGE_USERNAME],
    );
    if (!account) {
      throw new ServiceUnavailableException(
        'The auric_server storage account was not found. Run Auric migration 015_auric_server_cove_storage first.',
      );
    }
    return account;
  }

  private async storageKey(): Promise<{ account: AccountRef; key: Buffer }> {
    const account = await this.resolveStorageAccount();
    const key = await this.keyFor(account.id, true);
    return { account, key };
  }

  // ── Default upload decryption key source (demo by default) ───────────────

  async resolveSourceUser(): Promise<AccountRef | null> {
    const { rows: [setting] } = await this.db.query<{ source_user_id: string | null }>('SELECT source_user_id FROM auric.format_settings WHERE singleton');
    if (setting?.source_user_id) {
      const { rows: [user] } = await this.db.query<AccountRef>('SELECT id, email, username FROM auth.users WHERE id=$1', [setting.source_user_id]);
      if (user) return user;
    }
    const { rows: [demo] } = await this.db.query<AccountRef>(
      `SELECT id, email, username FROM auth.users
       WHERE lower(COALESCE(username,''))='demo' OR lower(email) LIKE 'demo@%'
       ORDER BY (lower(COALESCE(username,''))='demo') DESC, created_at LIMIT 1`);
    return demo ?? null;
  }

  async sourceStatus() {
    const user = await this.resolveSourceUser();
    let configured = false;
    if (user) {
      const { rows } = await this.db.query('SELECT 1 FROM auric.auric_credentials WHERE user_id=$1 AND credential_type=\'file_password\'', [user.id]);
      configured = rows.length > 0;
    }
    const { rows: [setting] } = await this.db.query<{ source_user_id: string | null }>('SELECT source_user_id FROM auric.format_settings WHERE singleton');
    const storageAccount = await this.db.query<AccountRef>(
      `SELECT id, email, username FROM auth.users WHERE lower(COALESCE(username,'')) = $1 LIMIT 1`,
      [SERVER_STORAGE_USERNAME],
    ).then((res) => res.rows[0] ?? null);

    return {
      user,
      filePasswordConfigured: configured,
      custom: !!setting?.source_user_id,
      storage: {
        backend: 'cove' as const,
        account: storageAccount?.username ?? SERVER_STORAGE_USERNAME,
        configured: Boolean(storageAccount),
        folder: COVE_FORMATS_ROOT_PATH.join(' / '),
      },
    };
  }

  async setSource(raw: unknown) {
    const body = object(raw);
    if (body.identifier === null || body.identifier === '') {
      await this.db.query('UPDATE auric.format_settings SET source_user_id=NULL, updated_at=now() WHERE singleton');
      return this.sourceStatus();
    }
    const identifier = text(body.identifier, 'email or username', 254).toLowerCase();
    const { rows: [user] } = await this.db.query<AccountRef>(
      'SELECT id, email, username FROM auth.users WHERE lower(email)=$1 OR lower(COALESCE(username,\'\'))=$1 LIMIT 1', [identifier]);
    if (!user) throw new NotFoundException('No account matches that email or username.');
    const key = await this.keyFor(user.id, true);
    key.fill(0);
    await this.db.query('UPDATE auric.format_settings SET source_user_id=$1, updated_at=now() WHERE singleton', [user.id]);
    return { ...(await this.sourceStatus()), reuploadRequired: false };
  }

  private async keyFor(userId: string, ensure: boolean): Promise<Buffer> {
    let creds = await this.credentials.getDecryptedCredentials(userId);
    if (!creds.filePassword && ensure) {
      await this.db.transaction(async (client) => {
        const { rows: [user] } = await client.query<{ email: string; username: string | null }>(
          'SELECT email, username FROM auth.users WHERE id=$1',
          [userId],
        );
        const fallbackShopName = (user?.username || user?.email || 'Auric Shop').trim().slice(0, 200);
        await client.query(
          `INSERT INTO auric.shop_profiles (user_id, shop_name, shop_location, gstin)
           VALUES ($1, $2, $3, NULL)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, fallbackShopName, 'Not set'],
        );
        await this.credentials.ensureCredentials(userId, client);
      });
      creds = await this.credentials.getDecryptedCredentials(userId);
    }
    if (!creds.filePassword) throw new ServiceUnavailableException('That account has no file password yet. Generate one in Credentials first.');
    return deriveSecretKey(creds.filePassword);
  }

  private async defaultUploadDecryptKey(): Promise<Buffer> {
    const source = await this.resolveSourceUser();
    if (!source) throw new ServiceUnavailableException('The default upload source account (demo) was not found. Create it or choose another source account.');
    return this.keyFor(source.id, true);
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  private readonly listFields = `id, format_id AS "formatId", folder_name AS "folderName", name, category, page_size AS "pageSize", paper_name AS "paperName",
    description, assets_count AS "assetsCount", elements_count AS "elementsCount", is_required AS "isRequired", is_active AS "isActive",
    version, source_key_id AS "sourceKeyId", storage_backend AS "storageBackend", cove_folder_id AS "coveFolderId",
    format_cove_file_id AS "formatCoveFileId", created_at AS "createdAt", updated_at AS "updatedAt"`;

  async adminList(q: Record<string, string>) {
    const search = `%${(q.search ?? '').slice(0, 200)}%`;
    const category = q.category && (FORMAT_CATEGORIES as readonly string[]).includes(q.category) ? q.category : null;
    const { rows } = await this.db.query(
      `SELECT ${this.listFields} FROM auric.format_templates
       WHERE (name ILIKE $1 OR format_id ILIKE $1) AND ($2::text IS NULL OR category=$2)
       ORDER BY category, name LIMIT 500`, [search, category]);
    const source = await this.sourceStatus();

    let serverKeyId: string | null = null;
    try {
      const { key } = await this.storageKey();
      try {
        serverKeyId = keyFingerprint(key);
      } finally {
        key.fill(0);
      }
    } catch {
      serverKeyId = null;
    }

    let legacyDemoKeyId: string | null = null;
    if (source.user && source.filePasswordConfigured) {
      const demoKey = await this.keyFor(source.user.id, false);
      try {
        legacyDemoKeyId = keyFingerprint(demoKey);
      } finally {
        demoKey.fill(0);
      }
    }

    return {
      rows: rows.map((row: any) => ({
        ...row,
        keyCurrent: row.storageBackend === 'cove'
          ? serverKeyId !== null && serverKeyId === row.sourceKeyId
          : legacyDemoKeyId !== null && legacyDemoKeyId === row.sourceKeyId,
      })),
      total: rows.length,
      source,
      categories: FORMAT_CATEGORIES,
    };
  }

  async upload(raw: unknown) {
    const body = object(raw);
    const files = safeUploadFiles(body.files);

    // 1. Resolve upload decryption key (defaults to demo account's file_password)
    let uploadDecryptKey: Buffer;
    if (typeof body.sourceKey === 'string' && body.sourceKey) {
      if (body.sourceKey.length > 4096) throw new BadRequestException('The source key is too long.');
      uploadDecryptKey = deriveSecretKey(body.sourceKey);
    } else if (body.sourceUserId) {
      uploadDecryptKey = await this.keyFor(uuid(body.sourceUserId), false);
    } else {
      uploadDecryptKey = await this.defaultUploadDecryptKey();
    }

    // 2. Resolve dedicated auric_server Cove account & sealing key
    const { account: storageAccount, key: serverSealKey } = await this.storageKey();

    const uploadedCoveIds: string[] = [];
    try {
      const description = body.description ? text(body.description, 'description', 1000) : null;
      const isRequired = body.isRequired === undefined ? undefined : boolean(body.isRequired);
      const ignoreChecksum = body.ignoreChecksum === true;

      const normalised = parseFormatUpload(files, { sourceKey: uploadDecryptKey, ignoreChecksum });
      const sealed = sealFormat(normalised, serverSealKey);
      for (const plain of normalised.assets.values()) plain.fill(0);

      const data = normalised.data;
      const folder = `${data.category}_${data.id}`;
      const coveFolderPath = [...COVE_FORMATS_ROOT_PATH, folder];

      // Remember previous Cove asset IDs if replacing an existing template
      const { rows: [existing] } = await this.db.query<{
        format_cove_file_id: string | null;
        assets: StoredAssetEntry[];
      }>('SELECT format_cove_file_id, assets FROM auric.format_templates WHERE format_id = $1', [data.id]);

      // 3. Store sealed format.enc and every .enc asset inside Cove under auric_server
      const storedFormat = await this.cove.putFile({
        userId: storageAccount.id,
        folderPath: coveFolderPath,
        fileName: 'format.enc',
        data: sealed.formatEnc,
      });
      uploadedCoveIds.push(storedFormat.fileId);

      const storedAssets: StoredAssetEntry[] = [];
      for (const asset of sealed.assets) {
        const assetBuf = Buffer.from(asset.dataBase64, 'base64');
        const uploadedAsset = await this.cove.putFile({
          userId: storageAccount.id,
          folderPath: coveFolderPath,
          fileName: asset.filename,
          data: assetBuf,
        });
        uploadedCoveIds.push(uploadedAsset.fileId);
        storedAssets.push({
          filename: asset.filename,
          coveFileId: uploadedAsset.fileId,
          sha256: asset.sha256,
          sizeBytes: assetBuf.length,
        });
      }

      const { rows: [row] } = await this.db.query(
        `INSERT INTO auric.format_templates(
           format_id, folder_name, name, category, page_size, paper_name, description,
           storage_backend, cove_folder_id, format_cove_file_id, format_enc, assets,
           assets_count, elements_count, source_key_id, is_required
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,'cove',$8,$9,NULL,$10::jsonb,$11,$12,$13,COALESCE($14,false))
         ON CONFLICT (format_id) DO UPDATE SET
           folder_name=EXCLUDED.folder_name, name=EXCLUDED.name, category=EXCLUDED.category,
           page_size=EXCLUDED.page_size, paper_name=EXCLUDED.paper_name,
           description=COALESCE($7, auric.format_templates.description),
           storage_backend='cove', cove_folder_id=EXCLUDED.cove_folder_id,
           format_cove_file_id=EXCLUDED.format_cove_file_id, format_enc=NULL,
           assets=EXCLUDED.assets, assets_count=EXCLUDED.assets_count,
           elements_count=EXCLUDED.elements_count, source_key_id=EXCLUDED.source_key_id,
           is_required=COALESCE($14, auric.format_templates.is_required),
           version=auric.format_templates.version+1, updated_at=now()
         RETURNING ${this.listFields}, (xmax <> 0) AS replaced`,
        [
          data.id, folder, data.name, data.category, data.pageSize,
          typeof data.paperName === 'string' ? data.paperName : null,
          description,
          storedFormat.folderId, storedFormat.fileId, JSON.stringify(storedAssets),
          storedAssets.length, data.elements.length, keyFingerprint(serverSealKey), isRequired ?? null,
        ],
      );

      // Clean up any removed asset files from the previous version in Cove
      if (existing?.assets && Array.isArray(existing.assets)) {
        const newNames = new Set(storedAssets.map((a) => a.filename));
        for (const prevAsset of existing.assets) {
          if (prevAsset.coveFileId && !newNames.has(prevAsset.filename)) {
            await this.cove.deleteFile(storageAccount.id, prevAsset.coveFileId);
          }
        }
      }

      return { ...row, checksum: normalised.checksumState };
    } catch (err) {
      // Roll back newly uploaded Cove files on DB/validation failure
      for (const fileId of uploadedCoveIds) {
        await this.cove.deleteFile(storageAccount.id, fileId);
      }
      throw err;
    } finally {
      uploadDecryptKey.fill(0);
      serverSealKey.fill(0);
    }
  }

  async update(id: string, raw: unknown) {
    const body = object(raw);
    const sets: string[] = [];
    const values: unknown[] = [uuid(id)];
    const add = (column: string, value: unknown) => { values.push(value); sets.push(`${column}=$${values.length}`); };
    if (body.isRequired !== undefined) add('is_required', boolean(body.isRequired));
    if (body.isActive !== undefined) add('is_active', boolean(body.isActive));
    if (body.name !== undefined) add('name', text(body.name, 'name', 200));
    if (body.description !== undefined) add('description', body.description === null || body.description === '' ? null : text(body.description, 'description', 1000));
    if (!sets.length) throw new BadRequestException('Nothing to update.');
    const { rows: [row] } = await this.db.query(`UPDATE auric.format_templates SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING ${this.listFields}`, values);
    if (!row) throw new NotFoundException('Format not found.');
    return row;
  }

  async remove(id: string) {
    const { rows: [deleted] } = await this.db.query<{
      id: string; storage_backend: string; cove_folder_id: string | null; format_cove_file_id: string | null; assets: StoredAssetEntry[];
    }>(
      `DELETE FROM auric.format_templates
       WHERE id=$1
       RETURNING id, storage_backend, cove_folder_id, format_cove_file_id, assets`,
      [uuid(id)],
    );
    if (!deleted) throw new NotFoundException('Format not found.');

    if (deleted.storage_backend === 'cove') {
      try {
        const storageAccount = await this.resolveStorageAccount();
        if (deleted.cove_folder_id) {
          await this.cove.deleteFolder(storageAccount.id, deleted.cove_folder_id);
        } else {
          if (deleted.format_cove_file_id) {
            await this.cove.deleteFile(storageAccount.id, deleted.format_cove_file_id);
          }
          for (const asset of deleted.assets ?? []) {
            if (asset.coveFileId) {
              await this.cove.deleteFile(storageAccount.id, asset.coveFileId);
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not clean up Cove files for deleted format ${deleted.id}: ${err?.message}`);
      }
    }

    return { success: true };
  }

  // ── Desktop ──────────────────────────────────────────────────────────────

  async catalog() {
    const { rows } = await this.db.query(`SELECT ${this.listFields} FROM auric.format_templates WHERE is_active ORDER BY is_required DESC, category, name`);
    return {
      formats: rows.map(({ sourceKeyId: _omit1, coveFolderId: _omit2, formatCoveFileId: _omit3, ...row }: any) => row),
    };
  }

  async fetch(userId: string, raw: unknown) {
    const body = object(raw);
    if (!Array.isArray(body.formatIds) || !body.formatIds.length || body.formatIds.length > MAX_FETCH) {
      throw new BadRequestException(`Choose between 1 and ${MAX_FETCH} formats per request.`);
    }
    const ids = [...new Set(body.formatIds.map(uuid))];
    await this.db.rateLimit('auric_format_fetch', userId, 20, 60);
    const { rows } = await this.db.query<{
      id: string;
      format_id: string;
      folder_name: string;
      name: string;
      category: string;
      storage_backend: 'cove' | 'postgres';
      format_cove_file_id: string | null;
      format_enc: Buffer | null;
      assets: StoredAssetEntry[];
      source_key_id: string;
    }>(
      `SELECT id, format_id, folder_name, name, category, storage_backend,
              format_cove_file_id, format_enc, assets, source_key_id
       FROM auric.format_templates
       WHERE is_active AND id = ANY($1::uuid[])`,
      [ids],
    );
    if (rows.length !== ids.length) throw new NotFoundException('One or more selected formats are no longer available. Refresh the list.');

    const { account: storageAccount, key: serverSealKey } = await this.storageKey();
    const target = await this.keyFor(userId, true);
    let legacyDemoKey: Buffer | null = null;
    const formats: unknown[] = [];

    try {
      for (const row of rows) {
        let formatEncBuffer: Buffer;
        let assetList: Array<{ filename: string; dataBase64: string }>;
        let unwrapKey: Buffer;

        if (row.storage_backend === 'cove') {
          if (!row.format_cove_file_id) {
            throw new ConflictException(`"${row.name}" is missing its Cove storage reference. Ask an administrator to upload it again.`);
          }
          if (row.source_key_id !== keyFingerprint(serverSealKey)) {
            throw new ConflictException(`"${row.name}" was sealed with a previous server key. Ask an administrator to upload it again.`);
          }
          formatEncBuffer = await this.cove.getFileBuffer(storageAccount.id, row.format_cove_file_id);
          assetList = await Promise.all(
            (row.assets ?? []).map(async (asset) => {
              if (!asset.coveFileId) throw new ConflictException(`"${row.name}" is missing an asset reference in Cove.`);
              const buf = await this.cove.getFileBuffer(storageAccount.id, asset.coveFileId);
              return { filename: asset.filename, dataBase64: buf.toString('base64') };
            }),
          );
          unwrapKey = serverSealKey;
        } else {
          // Backwards compatibility for any legacy Postgres-stored rows
          if (!legacyDemoKey) {
            legacyDemoKey = await this.defaultUploadDecryptKey();
          }
          if (!row.format_enc || row.source_key_id !== keyFingerprint(legacyDemoKey)) {
            throw new ConflictException(`"${row.name}" was sealed with a previous key. Ask an administrator to upload it again.`);
          }
          formatEncBuffer = row.format_enc;
          assetList = (row.assets ?? []).map((asset) => ({
            filename: asset.filename,
            dataBase64: asset.dataBase64 ?? '',
          }));
          unwrapKey = legacyDemoKey;
        }

        let files;
        try {
          files = convertFormat({ formatEnc: formatEncBuffer, assets: assetList }, unwrapKey, target);
        } catch (error: any) {
          this.logger.error(`Format ${row.format_id} could not be converted: ${error?.message}`);
          throw new ConflictException(`"${row.name}" could not be prepared. Ask an administrator to upload it again.`);
        }

        formats.push({
          id: row.id,
          formatId: row.format_id,
          folderName: row.folder_name,
          name: row.name,
          category: row.category,
          files: files.map((file) => ({
            filename: file.filename,
            dataBase64: file.data.toString('base64'),
            sha256: file.sha256,
          })),
        });
      }
    } finally {
      serverSealKey.fill(0);
      legacyDemoKey?.fill(0);
      target.fill(0);
    }

    return { formats };
  }
}
