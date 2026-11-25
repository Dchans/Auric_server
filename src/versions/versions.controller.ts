import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthAccount } from '../common/types/auth-account.type';
import { DatabaseService } from '../database/database.service';
import { AuthGuard } from '../security/auth.guard';
import { AdminGuard } from '../security/admin.guard';
import { RegisterVersionDto } from './dto/register-version.dto';
import { UpdateVersionDto } from './dto/update-version.dto';
import { ReleaseChannel, WindowsVersion } from './types/version.types';
import { VersionsService } from './versions.service';
import { choice, page, uuid } from '../control-common';

@Controller('updates')
export class VersionsController {
  constructor(
    private readonly versionsService: VersionsService,
    private readonly database: DatabaseService,
  ) {}

  // ---------------------------------------------------------------------------
  // PUBLIC CLIENT AUTO-UPDATER FEEDS (for electron-updater)
  // ---------------------------------------------------------------------------

  /**
   * Helper to serve electron-updater YAML manifest for a specific channel & platform.
   */
  private async serveManifest(
    channel: ReleaseChannel,
    rawWindowsVersion: string | undefined,
    res: Response,
    ip?: string
  ): Promise<string> {
    // Basic rate limit for public update checks (up to 120 req / min per IP)
    if (ip) {
      await this.database.rateLimit('auric_updates_feed_ip', ip, 120, 60);
    }

    const normalizedWindows: WindowsVersion =
      rawWindowsVersion === 'win7' || rawWindowsVersion === 'windows_7' ? 'win7' : 'win10_11';

    const record = await this.versionsService.getLatestRecord(channel, normalizedWindows);
    if (!record) {
      throw new NotFoundException(
        `No release found for channel "${channel}" on platform "${normalizedWindows}".`
      );
    }

    const yaml = this.versionsService.generateManifestYaml(record);
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return yaml;
  }

  /**
   * Stable channel manifest: GET /updates/latest.yml
   */
  @Get('latest.yml')
  async getStableLatestYml(
    @Query('windows_version') windowsVersion: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: Response
  ) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || '127.0.0.1';
    return this.serveManifest('stable', windowsVersion, res, ip);
  }

  /**
   * Beta channel manifest: GET /updates/beta.yml
   */
  @Get('beta.yml')
  async getBetaYml(
    @Query('windows_version') windowsVersion: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: Response
  ) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || '127.0.0.1';
    return this.serveManifest('beta', windowsVersion, res, ip);
  }

  /**
   * Alpha channel manifest: GET /updates/alpha.yml
   */
  @Get('alpha.yml')
  async getAlphaYml(
    @Query('windows_version') windowsVersion: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: Response
  ) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || '127.0.0.1';
    return this.serveManifest('alpha', windowsVersion, res, ip);
  }

  /**
   * Flexible channel manifest: GET /updates/:channel/latest.yml
   */
  @Get(':channel/latest.yml')
  async getChannelLatestYml(
    @Param('channel') channelParam: string,
    @Query('windows_version') windowsVersion: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: Response
  ) {
    const channelLower = String(channelParam).toLowerCase();
    const channel: ReleaseChannel =
      channelLower === 'alpha' ? 'alpha' : channelLower === 'beta' ? 'beta' : 'stable';

    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || '127.0.0.1';
    return this.serveManifest(channel, windowsVersion, res, ip);
  }

  /**
   * Public overview of current active versions across all channels: GET /updates/status
   */
  @Get('status')
  @Header('Cache-Control', 'public, max-age=60')
  async getStatus() {
    return this.versionsService.getChannelsStatus();
  }

  // ---------------------------------------------------------------------------
  // ADMIN & PUBLISHER API (Protected by AuthGuard)
  // ---------------------------------------------------------------------------

  /**
   * Register a new version release: POST /updates/register
   */
  @Post('register')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: Record<string, any>,
    @CurrentUser() user: AuthAccount
  ) {
    const dto = RegisterVersionDto.fromRaw(body);
    dto.pushedBy = user.username || user.email;
    const defaultPusher = user.username || user.email || 'admin';
    const version = await this.versionsService.registerVersion(dto, defaultPusher);
    return {
      success: true,
      message: `Version ${version.version} (${version.releaseChannel}) registered successfully.`,
      version,
    };
  }

  /**
   * List all releases with optional filtering: GET /updates/versions
   */
  @Get('versions')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  async list(
    @Query('channel') channel?: ReleaseChannel,
    @Query('windows_version') windowsVersion?: WindowsVersion,
    @Query('is_latest') isLatestStr?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('search') search?:string
  ) {
    const isLatest =
      isLatestStr === 'true' ? true : isLatestStr === 'false' ? false : undefined;
    const {limit,offset}=page({limit:limitStr??'25',offset:offsetStr??'0',search:search??''});
    if(channel)choice(channel,['stable','beta','alpha']);
    if(windowsVersion)choice(windowsVersion,['win10_11','win7']);

    return this.versionsService.listVersions({
      channel,
      windowsVersion,
      isLatest,
      limit,
      offset,
      search,
    });
  }

  /**
   * Get specific version details: GET /updates/versions/:id
   */
  @Get('versions/:id')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  async getOne(@Param('id') id: string) {
    uuid(id);
    return this.versionsService.getVersion(id);
  }

  /**
   * Update version metadata or toggle latest status: PATCH /updates/versions/:id
   */
  @Patch('versions/:id')
  @UseGuards(AdminGuard)
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, any>
  ) {
    const dto = UpdateVersionDto.fromRaw(body);
    uuid(id);
    const version = await this.versionsService.updateVersion(id, dto);
    return {
      success: true,
      version,
    };
  }

  /**
   * Remove a version: DELETE /updates/versions/:id
   */
  @Delete('versions/:id')
  @UseGuards(AdminGuard)
  async delete(@Param('id') id: string) {
    uuid(id);
    await this.versionsService.deleteVersion(id);
    return {
      success: true,
      message: `Version ${id} removed successfully.`,
    };
  }
}
