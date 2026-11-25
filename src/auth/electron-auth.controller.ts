import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { CredentialsService } from '../credentials/credentials.service';
import { DatabaseService } from '../database/database.service';
import { DevicesService } from '../devices/devices.service';
import { EntitlementService } from '../security/entitlement.service';

interface ElectronLoginBody {
  username?: string;
  password?: string;
  device_id?: string;
  device_name?: string;
  device_type?: string;
  hardware_id?: string;
  public_key?: string;
  signature?: string;
  client_kind?: string;
  login_type?: string;
  os?: string;
  browser?: string;
}

interface AuthApiResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string;
  refreshExpiresAt: string;
  user: {
    id: string;
    email: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    phoneNumber?: string | null;
    role?: string;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
}

@Controller()
export class ElectronAuthController {
  private readonly logger = new Logger(ElectronAuthController.name);
  private readonly authApiUrl: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly devicesService: DevicesService,
    private readonly credentialsService: CredentialsService,
    private readonly entitlementService: EntitlementService
  ) {
    this.authApiUrl = process.env.AUTH_API_URL || 'http://local-api-auth-1:3000';
  }

  @Post(['api/auth/login/auric', 'auth/login/auric'])
  @HttpCode(HttpStatus.OK)
  async loginWithDevice(
    @Body() body: ElectronLoginBody,
    @Headers() headers: Record<string, string | undefined>
  ) {
    const username = body.username?.trim();
    const password = body.password;

    if (!username || !password) {
      throw new BadRequestException('Username and password are required.');
    }

    // 1. Authenticate identity with Auth API
    let authData: AuthApiResponse;
    try {
      const authRes = await fetch(`${this.authApiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: username, password }),
      });

      if (!authRes.ok) {
        const errorJson = await authRes.json().catch(() => ({}));
        throw new UnauthorizedException(errorJson.message || 'Invalid login or password.');
      }

      authData = (await authRes.json()) as AuthApiResponse;
    } catch (err: any) {
      if (err instanceof UnauthorizedException || err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`Auth API unreachable at ${this.authApiUrl}`, err);
      // Fallback for local development or direct host connection
      try {
        const hostRes = await fetch('http://127.0.0.1:3000/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: username, password }),
        });
        if (!hostRes.ok) throw new UnauthorizedException('Invalid login or password.');
        authData = (await hostRes.json()) as AuthApiResponse;
      } catch (fallbackErr: any) {
        if (fallbackErr instanceof UnauthorizedException) throw fallbackErr;
        throw new UnauthorizedException('Authentication service temporarily unavailable.');
      }
    }

    const authUser = authData.user;

    // 2. Resolve permanent hardware fingerprint
    const hardwareId =
      body.hardware_id ||
      body.device_id ||
      headers['x-hardware-id'] ||
      'unknown-hardware-id';
    
    // The permanent hardware fingerprint stored in auric.devices
    const deviceFingerprint = hardwareId;

    const deviceName =
      body.device_name ||
      headers['x-device-name'] ||
      'Electron Desktop';

    const publicKey =
      body.public_key ||
      headers['x-public-key'];

    const signature =
      body.signature ||
      headers['x-device-signature'];

    // 3. Register or Retrieve Device
    // STRICT SECURITY RULE: Any newly seen device is ALWAYS assigned role 'secondary'
    // and approval_status 'pending'. ONLY an admin can promote to primary.
    const { device, isNew } = await this.devicesService.registerOrGetDevice(
      authUser.id,
      deviceFingerprint,
      deviceName,
      'electron',
      publicKey
    );

    // 4. Cryptographic Proof of Possession Check (Anti-Spoofing Defense)
    // Verifies that the client actually possesses the private key generated on that hardware
    const activePublicKey = device.publicKey || publicKey;
    if (activePublicKey && signature) {
      const challenge = `${hardwareId}:${username}`;
      const isValid = this.devicesService.verifySignature(activePublicKey, challenge, signature);
      if (!isValid) {
        this.logger.warn(`Device signature spoofing attempt detected for user ${username} (hardware: ${hardwareId})`);
        throw new UnauthorizedException('Cryptographic device verification failed. Invalid device signature.');
      }
    }

    // 5. Evaluate Device Approval Status
    if (device.approvalStatus === 'pending' || isNew) {
      this.logger.warn(`Device ${device.id} for user ${authUser.username} is pending admin approval.`);
      return {
        success: false,
        approval_required: true,
        reason: 'device_pending_approval',
        message: 'Device verification is pending. This machine is not approved by administrator.',
        device_status: 'pending',
        device: {
          id: device.id,
          device_id: hardwareId,
          device_name: device.displayName,
          device_type: device.deviceType,
          is_primary: false,
          approval_status: 'pending',
        },
      };
    }

    if (device.approvalStatus === 'rejected' || device.approvalStatus === 'revoked') {
      return {
        success: false,
        blocked: true,
        reason: 'device_blocked',
        message: 'This device has been revoked or rejected by administrator. Please contact support.',
        device_status: 'blocked',
      };
    }

    // 5. Approved Device Flow
    const [profileRes, subStatus] = await Promise.all([
      this.database.getProfile(authUser as any),
      this.database.getSubscriptionStatus(authUser.id),
    ]);
    const shopProfile = profileRes.shopProfile;
    const subscription = this.entitlementService.buildSubscriptionPayload(authUser, subStatus);

    const isPrimary = device.deviceRole === 'primary';
    if (!isPrimary && !subscription.remote_enabled) {
      this.logger.warn(`Secondary device ${device.id} login rejected for user ${authUser.username}: Remote service not in active subscription.`);
      return {
        success: false,
        blocked: true,
        reason: 'remote_service_disabled',
        message: 'Remote secondary device access is not included in your active subscription plan. Please upgrade your plan to enable remote devices.',
        device_status: 'blocked',
      };
    }
    let dbPassword = '';
    let fileKey = '';

    // Only approved PRIMARY devices receive decrypted SQLite encryption keys
    if (isPrimary) {
      const credentials = await this.credentialsService.getDecryptedCredentials(authUser.id);
      dbPassword = credentials.dbPassword || '';
      fileKey = credentials.filePassword || '';
      this.logger.log(`Approved primary device ${device.id} logged in for user ${authUser.username}`);
    } else {
      this.logger.log(`Approved secondary device ${device.id} logged in for user ${authUser.username}`);
    }

    return {
      success: true,
      message: 'Login successful',
      device_status: 'verified',
      approval_required: false,
      tokens: {
        access: authData.accessToken,
        refresh: authData.refreshToken,
      },
      device: {
        id: device.id,
        device_id: hardwareId,
        device_name: device.displayName,
        device_type: device.deviceType,
        is_primary: isPrimary,
        approval_status: 'approved',
      },
      user: {
        id: authUser.id,
        username: authUser.username,
        email: authUser.email,
        phone: authUser.phoneNumber || '',
        shop_name: shopProfile?.shopName || authUser.username || '',
        address: shopProfile?.shopLocation || '',
        gstnumber: shopProfile?.gstin || '',
        ...(isPrimary ? { db_password: dbPassword, file_key: fileKey } : {}),
      },
      subscription,
    };
  }
}
