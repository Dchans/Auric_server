import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthAccount, AuthenticatedRequest } from '../types/auth-account.type';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthAccount => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.auricUser;
  },
);
