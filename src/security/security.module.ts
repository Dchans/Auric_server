import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AuthClient } from './auth.client';
import { AuthGuard } from './auth.guard';
import { EntitlementService } from './entitlement.service';

@Global()
@Module({
  providers: [AuthClient, AuthGuard, AdminGuard, EntitlementService],
  exports: [AuthClient, AuthGuard, AdminGuard, EntitlementService],
})
export class SecurityModule {}
