import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types/auth-account.type';
import { DatabaseService } from '../database/database.service';
import { AuthClient } from './auth.client';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthClient,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const forwarded = request.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.ip) || '127.0.0.1';

    // 1. Anti-bot flood defense: Rate limit by client IP (max 120 req / min)
    await this.database.rateLimit('auric_api_ip', ip, 120, 60);

    // 2. Authenticate token
    request.auricUser = await this.auth.currentUser(request.headers.authorization);

    // 3. Rate limit by authenticated account (max 120 req / min per user)
    await this.database.rateLimit('auric_api_user', request.auricUser.id, 120, 60);

    return true;
  }
}
