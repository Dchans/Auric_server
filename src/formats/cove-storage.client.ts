import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface CovePutFileResult {
  fileId: string;
  folderId: string | null;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

@Injectable()
export class CoveStorageClient {
  private readonly logger = new Logger(CoveStorageClient.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;

  constructor() {
    const explicit = (process.env.COVE_API_URL || process.env.COVE_URL || '').trim();
    const isProd = process.env.NODE_ENV === 'production' || /^https:\/\//i.test(process.env.AUTH_API_URL || '');
    const defaultUrl = isProd ? 'https://cove.storage.dchans.com' : 'http://cove-cove-1:3000';
    this.baseUrl = (explicit || defaultUrl).replace(/\/+$/, '');
    this.serviceKey = process.env.COVE_SERVICE_KEY || 'auric-cove-internal-service-v1';
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-cove-service-key': this.serviceKey,
      ...extra,
    };
  }

  async putFile(params: {
    userId: string;
    folderPath: string[];
    fileName: string;
    data: Buffer;
    mimeType?: string;
  }): Promise<CovePutFileResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/service-storage/files/put`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          userId: params.userId,
          folderPath: params.folderPath,
          fileName: params.fileName,
          mimeType: params.mimeType ?? 'application/octet-stream',
          dataBase64: params.data.toString('base64'),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      this.logger.error(`Cove putFile failed (${this.baseUrl}): ${err?.message}`);
      throw new ServiceUnavailableException('Cove storage service is currently unavailable.');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Cove putFile returned HTTP ${response.status}: ${detail}`);
      throw new ServiceUnavailableException(`Could not store file "${params.fileName}" in Cove storage.`);
    }

    return (await response.json()) as CovePutFileResult;
  }

  async getFileBuffer(userId: string, fileId: string): Promise<Buffer> {
    let response: Response;
    try {
      const qs = new URLSearchParams({ userId }).toString();
      response = await fetch(`${this.baseUrl}/internal/service-storage/files/${encodeURIComponent(fileId)}?${qs}`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      this.logger.error(`Cove getFileBuffer failed (${this.baseUrl}): ${err?.message}`);
      throw new ServiceUnavailableException('Cove storage service is currently unavailable.');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Cove getFileBuffer(${fileId}) returned HTTP ${response.status}: ${detail}`);
      throw new ServiceUnavailableException('Stored format file could not be read from Cove storage.');
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteFile(userId: string, fileId: string): Promise<void> {
    try {
      const qs = new URLSearchParams({ userId }).toString();
      await fetch(`${this.baseUrl}/internal/service-storage/files/${encodeURIComponent(fileId)}?${qs}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      this.logger.warn(`Cove deleteFile(${fileId}) warning: ${err?.message}`);
    }
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    try {
      const qs = new URLSearchParams({ userId }).toString();
      await fetch(`${this.baseUrl}/internal/service-storage/folders/${encodeURIComponent(folderId)}?${qs}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      this.logger.warn(`Cove deleteFolder(${folderId}) warning: ${err?.message}`);
    }
  }
}
