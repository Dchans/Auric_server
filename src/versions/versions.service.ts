import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RegisterVersionDto } from './dto/register-version.dto';
import { UpdateVersionDto } from './dto/update-version.dto';
import {
  AppVersionDto,
  AppVersionRecord,
  ChannelStatusSummary,
  QueryVersionsOptions,
  ReleaseChannel,
  WindowsVersion,
} from './types/version.types';

@Injectable()
export class VersionsService {
  constructor(private readonly db: DatabaseService) {}

  private mapRecordToDto(row: AppVersionRecord): AppVersionDto {
    return {
      id: row.id,
      version: row.version,
      releaseChannel: row.release_channel,
      windowsVersion: row.windows_version,
      exeUrl: row.exe_url,
      exeCoveFileId: row.exe_cove_file_id,
      blockmapUrl: row.blockmap_url,
      blockmapCoveFileId: row.blockmap_cove_file_id,
      sha512: row.sha512,
      fileSize: Number(row.file_size),
      blockmapSize: row.blockmap_size !== null ? Number(row.blockmap_size) : null,
      releaseNotes: row.release_notes || '',
      isLatest: row.is_latest,
      pushedBy: row.pushed_by,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  /**
   * Register a new version.
   * If isLatest is true, demotes existing latest versions on the same channel & platform.
   */
  async registerVersion(dto: RegisterVersionDto, defaultPusher: string): Promise<AppVersionDto> {
    const pushedBy = dto.pushedBy || defaultPusher || 'admin';
    const isLatest = dto.isLatest ?? true;
    return this.db.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.release'),hashtext($1))",[`${dto.releaseChannel}/${dto.windowsVersion}`]);
    if (isLatest) {
      await client.query(
        `UPDATE auric.app_versions
         SET is_latest = false, updated_at = now()
         WHERE release_channel = $1 AND windows_version = $2 AND is_latest = true`,
        [dto.releaseChannel, dto.windowsVersion]
      );
    }

    const { rows } = await client.query<AppVersionRecord>(
      `INSERT INTO auric.app_versions (
         version,
         release_channel,
         windows_version,
         exe_url,
         exe_cove_file_id,
         blockmap_url,
         blockmap_cove_file_id,
         sha512,
         file_size,
         blockmap_size,
         release_notes,
         is_latest,
         pushed_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        dto.version,
        dto.releaseChannel,
        dto.windowsVersion,
        dto.exeUrl,
        dto.exeCoveFileId || null,
        dto.blockmapUrl || null,
        dto.blockmapCoveFileId || null,
        dto.sha512,
        dto.fileSize,
        dto.blockmapSize || null,
        dto.releaseNotes || '',
        isLatest,
        pushedBy,
      ]
    );

    return this.mapRecordToDto(rows[0]);
    });
  }

  /**
   * List versions with optional filters.
   */
  async listVersions(options: QueryVersionsOptions = {}): Promise<{ versions: AppVersionDto[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    if(options.search){params.push(`%${options.search}%`);conditions.push(`concat_ws(' ',version,release_channel,windows_version,pushed_by) ILIKE $${params.length}`);}

    if (options.channel) {
      params.push(options.channel);
      conditions.push(`release_channel = $${params.length}`);
    }

    if (options.windowsVersion) {
      params.push(options.windowsVersion);
      conditions.push(`windows_version = $${params.length}`);
    }

    if (options.isLatest !== undefined) {
      params.push(options.isLatest);
      conditions.push(`is_latest = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.db.query<{ count: string }>(
      `SELECT count(*)::text as count FROM auric.app_versions ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0]?.count || 0);

    const limit = Math.min(Math.max(Number(options.limit || 20), 1), 100);
    const offset = Math.max(Number(options.offset || 0), 0);

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const { rows } = await this.db.query<AppVersionRecord>(
      `SELECT * FROM auric.app_versions
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      params
    );

    return {
      versions: rows.map((r) => this.mapRecordToDto(r)),
      total,
    };
  }

  /**
   * Get version by ID.
   */
  async getVersion(id: string): Promise<AppVersionDto> {
    const { rows } = await this.db.query<AppVersionRecord>(
      `SELECT * FROM auric.app_versions WHERE id = $1`,
      [id]
    );
    if (!rows[0]) {
      throw new NotFoundException(`Version with id ${id} not found.`);
    }
    return this.mapRecordToDto(rows[0]);
  }

  /**
   * Update version metadata or toggle isLatest.
   */
  async updateVersion(id: string, dto: UpdateVersionDto): Promise<AppVersionDto> {
    const initial = await this.getVersion(id);
    return this.db.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.release'),hashtext($1))",[`${initial.releaseChannel}/${initial.windowsVersion}`]);
    const {rows:[record]}=await client.query<AppVersionRecord>('SELECT * FROM auric.app_versions WHERE id=$1 FOR UPDATE',[id]);
    if(!record)throw new NotFoundException('Release not found.');
    const existing=this.mapRecordToDto(record);

    if (dto.isLatest === true && !existing.isLatest) {
      await client.query(
        `UPDATE auric.app_versions
         SET is_latest = false, updated_at = now()
         WHERE release_channel = $1 AND windows_version = $2 AND id <> $3 AND is_latest = true`,
        [existing.releaseChannel, existing.windowsVersion, id]
      );
    }

    const nextIsLatest = dto.isLatest !== undefined ? dto.isLatest : existing.isLatest;
    const nextNotes = dto.releaseNotes !== undefined ? dto.releaseNotes : existing.releaseNotes;

    const { rows } = await client.query<AppVersionRecord>(
      `UPDATE auric.app_versions
       SET is_latest = $1, release_notes = $2, updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [nextIsLatest, nextNotes, id]
    );

    return this.mapRecordToDto(rows[0]);
    });
  }

  /**
   * Delete version by ID.
   */
  async deleteVersion(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM auric.app_versions WHERE id = $1`,
      [id]
    );
    if (!rowCount) {
      throw new NotFoundException(`Version with id ${id} not found.`);
    }
    return true;
  }

  /**
   * Retrieve active latest version record for a channel and windows version.
   */
  async getLatestRecord(channel: ReleaseChannel, windowsVersion: WindowsVersion): Promise<AppVersionRecord | null> {
    const { rows } = await this.db.query<AppVersionRecord>(
      `SELECT * FROM auric.app_versions
       WHERE release_channel = $1 AND windows_version = $2 AND is_latest = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [channel, windowsVersion]
    );

    if (rows[0]) {
      return rows[0];
    }

    // Fallback: newest created version on this channel/platform even if is_latest wasn't flagged
    const fallback = await this.db.query<AppVersionRecord>(
      `SELECT * FROM auric.app_versions
       WHERE release_channel = $1 AND windows_version = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [channel, windowsVersion]
    );

    return fallback.rows[0] ?? null;
  }

  /**
   * Generate electron-updater compliant YAML manifest (e.g. latest.yml, beta.yml, alpha.yml).
   * Includes blockMapSize for differential update downloads when available.
   */
  generateManifestYaml(record: AppVersionRecord): string {
    const fileName = `Auric-Setup-${record.version}.exe`;
    const dateStr =
      record.created_at instanceof Date
        ? record.created_at.toISOString()
        : new Date(record.created_at).toISOString();

    const fileSize = Number(record.file_size);
    const blockmapSize = record.blockmap_size ? Number(record.blockmap_size) : null;

    let filesBlock = `files:
  - url: ${record.exe_url}
    sha512: ${record.sha512}
    size: ${fileSize}`;

    if (blockmapSize) {
      filesBlock += `\n    blockMapSize: ${blockmapSize}`;
    }

    const lines = [
      `version: ${record.version}`,
      filesBlock,
      `path: ${fileName}`,
      `sha512: ${record.sha512}`,
      `releaseDate: '${dateStr}'`,
    ];

    if (record.release_notes || record.pushed_by) {
      const noteLines: string[] = [];
      if (record.pushed_by) {
        noteLines.push(`Pushed by: ${record.pushed_by}`);
      }
      if (record.release_notes) {
        noteLines.push(record.release_notes);
      }
      const indentedNotes = noteLines
        .join('\n')
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n');
      lines.push(`releaseNotes: |\n${indentedNotes}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Channel overview reporting latest releases across alpha, beta, stable.
   */
  async getChannelsStatus(): Promise<ChannelStatusSummary> {
    const channels: ReleaseChannel[] = ['stable', 'beta', 'alpha'];
    const platforms: WindowsVersion[] = ['win10_11', 'win7'];

    const summary: ChannelStatusSummary = {
      stable: { win10_11: null, win7: null },
      beta: { win10_11: null, win7: null },
      alpha: { win10_11: null, win7: null },
    };

    for (const ch of channels) {
      for (const pl of platforms) {
        const record = await this.getLatestRecord(ch, pl);
        if (record) {
          summary[ch][pl] = this.mapRecordToDto(record);
        }
      }
    }

    return summary;
  }
}
