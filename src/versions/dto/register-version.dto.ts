import { ReleaseChannel, WindowsVersion } from '../types/version.types';
import { BadRequestException } from '@nestjs/common';

export class RegisterVersionDto {
  version!: string;
  releaseChannel!: ReleaseChannel;
  windowsVersion!: WindowsVersion;
  exeUrl!: string;
  exeCoveFileId?: string | null;
  blockmapUrl?: string | null;
  blockmapCoveFileId?: string | null;
  sha512!: string;
  fileSize!: number;
  blockmapSize?: number | null;
  releaseNotes?: string;
  isLatest?: boolean;
  pushedBy?: string;

  /**
   * Normalize an incoming request body (supporting both snake_case and camelCase).
   */
  static fromRaw(body: Record<string, any>): RegisterVersionDto {
    const rawVersion = String(body.version || '').trim();
    if (!rawVersion) {
      throw new BadRequestException('Version is required (e.g. "4.4.1")');
    }

    const rawChannel = String(body.releaseChannel || body.release_channel || 'stable')
      .trim()
      .toLowerCase();
    if (!['stable', 'beta', 'alpha'].includes(rawChannel)) {
      throw new BadRequestException(`Invalid releaseChannel "${rawChannel}". Must be one of: stable, beta, alpha.`);
    }

    const rawWindows = String(body.windowsVersion || body.windows_version || 'win10_11')
      .trim()
      .toLowerCase();
    const normalizedWindows: WindowsVersion =
      rawWindows === 'win7' || rawWindows === 'windows_7' ? 'win7' : 'win10_11';

    const exeUrl = String(body.exeUrl || body.exe_url || body.exe_file || '').trim();
    if (!exeUrl) {
      throw new BadRequestException('exeUrl is required.');
    }

    const sha512 = String(body.sha512 || '').trim();
    if (!sha512) {
      throw new BadRequestException('sha512 (Base64 checksum) is required.');
    }

    const fileSize = Number(body.fileSize || body.file_size || 0);
    if (!fileSize || isNaN(fileSize) || fileSize <= 0) {
      throw new BadRequestException('fileSize must be a positive integer.');
    }

    const rawBlockmapSize = body.blockmapSize ?? body.blockmap_size;
    const blockmapSize =
      rawBlockmapSize !== undefined && rawBlockmapSize !== null && !isNaN(Number(rawBlockmapSize))
        ? Number(rawBlockmapSize)
        : null;

    const blockmapUrl = String(body.blockmapUrl || body.blockmap_url || body.blockmap_file || '').trim() || null;
    const exeCoveFileId = String(body.exeCoveFileId || body.exe_cove_file_id || '').trim() || null;
    const blockmapCoveFileId = String(body.blockmapCoveFileId || body.blockmap_cove_file_id || '').trim() || null;
    const releaseNotes = String(body.releaseNotes ?? body.release_notes ?? '').trim();
    const isLatest = body.isLatest !== undefined ? Boolean(body.isLatest) : body.is_latest !== undefined ? Boolean(body.is_latest) : true;
    const pushedBy = String(body.pushedBy || body.pushed_by || body.released_by || '').trim() || undefined;
    if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(rawVersion))throw new BadRequestException('Use a semantic version such as 4.4.1 or 4.4.1-beta.1.');
    for(const value of [exeUrl,blockmapUrl])if(value){try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||/[\r\n]/.test(value))throw new Error();}catch{throw new BadRequestException('Installer and blockmap URLs must be valid HTTP(S) URLs without embedded credentials.');}}
    if(!/^[A-Za-z0-9+/]{86}==$/.test(sha512)||Buffer.from(sha512,'base64').length!==64)throw new BadRequestException('SHA-512 must be a Base64-encoded 64-byte checksum.');
    if(!Number.isSafeInteger(fileSize)||fileSize<=0||(blockmapSize!==null&&(!Number.isSafeInteger(blockmapSize)||blockmapSize<=0)))throw new BadRequestException('Installer and blockmap sizes must be positive safe integers.');
    if(rawWindows && !['win7','windows_7','win10_11'].includes(rawWindows))throw new BadRequestException('Choose win10_11 or win7.');
    if(releaseNotes.length>32000)throw new BadRequestException('Release notes are too long.');
    for(const value of [body.isLatest,body.is_latest])if(value!==undefined&&typeof value!=='boolean')throw new BadRequestException('isLatest must be a boolean.');

    return {
      version: rawVersion,
      releaseChannel: rawChannel as ReleaseChannel,
      windowsVersion: normalizedWindows,
      exeUrl,
      exeCoveFileId,
      blockmapUrl,
      blockmapCoveFileId,
      sha512,
      fileSize,
      blockmapSize,
      releaseNotes,
      isLatest,
      pushedBy,
    };
  }
}
