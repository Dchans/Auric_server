import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database/database.service';

@Controller()
export class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  index() {
    return { service: 'auric' };
  }

  @Get('health')
  async health(@Req() request: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
    const forwarded = request.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.ip) || '127.0.0.1';

    // Anti-bot scraper / scan protection (max 60 req / min per IP)
    await this.database.rateLimit('auric_health_ip', ip, 60, 60);
    try {
      await this.database.ping();
      return { status: 'ok', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
  }
}
