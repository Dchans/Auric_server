import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthAccount } from '../common/types/auth-account.type';
import { AuthGuard } from '../security/auth.guard';
import { EntitlementService } from '../security/entitlement.service';
import { AccountService } from './account.service';

@Controller()
@UseGuards(AuthGuard)
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly entitlementService: EntitlementService
  ) {}

  @Get(['profile', 'api/user/profile', 'api/profile'])
  @Header('Cache-Control', 'no-store')
  async profile(@CurrentUser() user: AuthAccount) {
    const [profileData, subStatus] = await Promise.all([
      this.accountService.getProfile(user),
      this.accountService.getSubscriptionStatus(user.id),
    ]);
    const subscription = this.entitlementService.buildSubscriptionPayload(user, subStatus);
    return {
      success: true,
      ...profileData,
      subscription,
    };
  }

  @Get('devices')
  @Header('Cache-Control', 'no-store')
  async devices(@CurrentUser() user: AuthAccount) {
    return this.accountService.getDevices(user.id);
  }

  @Get(['subscription/status', 'api/subscription/status', 'api/subscription', 'subscription', 'user/subscription', 'api/user/subscription', 'api/user/subscription/status'])
  @Header('Cache-Control', 'no-store')
  async subscriptionStatus(@CurrentUser() user: AuthAccount) {
    const subStatus = await this.accountService.getSubscriptionStatus(user.id);
    return this.entitlementService.buildSubscriptionPayload(user, subStatus);
  }

  @Get(['subscription/plans', 'api/subscription/plans', 'plans'])
  @Header('Cache-Control', 'no-store')
  async subscriptionPlans() {
    return this.accountService.getAvailablePlans();
  }

  @Get(['payments', 'api/user/payments', 'api/payments'])
  @Header('Cache-Control', 'no-store')
  async payments(@CurrentUser() user: AuthAccount) {
    return this.accountService.getRecentPayments(user.id);
  }
}
