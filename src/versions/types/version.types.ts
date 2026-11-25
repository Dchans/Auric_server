export type ReleaseChannel = 'stable' | 'beta' | 'alpha';
export type WindowsVersion = 'win10_11' | 'win7';

export interface AppVersionRecord {
  id: string;
  version: string;
  release_channel: ReleaseChannel;
  windows_version: WindowsVersion;
  exe_url: string;
  exe_cove_file_id: string | null;
  blockmap_url: string | null;
  blockmap_cove_file_id: string | null;
  sha512: string;
  file_size: string;
  blockmap_size: string | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface QueryVersionsOptions {
  search?:string;
  channel?: ReleaseChannel;
  windowsVersion?: WindowsVersion;
  isLatest?: boolean;
  limit?: number;
  offset?: number;
}

export interface ChannelStatusSummary {
  stable: {
    win10_11: AppVersionDto | null;
    win7: AppVersionDto | null;
  };
  beta: {
    win10_11: AppVersionDto | null;
    win7: AppVersionDto | null;
  };
  alpha: {
    win10_11: AppVersionDto | null;
    win7: AppVersionDto | null;
  };
}
