import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types/auth-account.type';
import { AuthGuard } from './auth.guard';
import { DatabaseService } from '../database/database.service';
import { createHash } from 'node:crypto';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard, private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isAuth = await this.authGuard.canActivate(context);
    if (!isAuth) return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Administrative requests bypass the ordinary 30 second account cache.
    const token=/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')?.[1];
    const fresh=token ? await this.database.getSessionAccount(createHash('sha256').update(token).digest()) : null;
    if (fresh?.role !== 'admin') {
      throw new ForbiddenException('Admin privileges required to perform this action.');
    }
    request.auricUser=fresh;

    return true;
  }
}
