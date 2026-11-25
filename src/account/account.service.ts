import { Injectable } from '@nestjs/common';
import { AuthAccount } from '../common/types/auth-account.type';
import { DatabaseService } from '../database/database.service';
import { ActiveSubscriptionDto, DeviceDto, PaymentDto, ShopProfileDto, SubscriptionPlanDto } from '../schema';

@Injectable()
export class AccountService {
  constructor(private readonly database: DatabaseService) {}

  async getProfile(user: AuthAccount): Promise<{ user: AuthAccount; shopProfile: ShopProfileDto | null }> {
    return this.database.getProfile(user);
  }

  async getDevices(userId: string): Promise<{ devices: DeviceDto[] }> {
    return this.database.getDevices(userId);
  }

  async getSubscriptionStatus(userId: string): Promise<{ status: 'active' | 'inactive'; subscriptions: ActiveSubscriptionDto[] }> {
    return this.database.getSubscriptionStatus(userId);
  }

  async getAvailablePlans(): Promise<{ plans: SubscriptionPlanDto[] }> {
    const plans = await this.database.getAvailablePlans();
    return { plans };
  }

  async getRecentPayments(userId: string): Promise<{ payments: PaymentDto[] }> {
    return this.database.getRecentPayments(userId);
  }
}
