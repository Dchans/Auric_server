import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { DeviceApprovalStatus, DeviceDto, DeviceRole, DeviceType } from '../schema';

export interface AdminDeviceViewDto extends DeviceDto {
  userId: string;
  userEmail: string;
  username: string | null;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Format single-line or raw PEM to standard multi-line PEM format
   */
  formatPem(pemOrSingle: string): string {
    const clean = pemOrSingle.trim();
    if (clean.includes('\n')) return clean;
    const match = /-----BEGIN [^-]+-----([^-]+)-----END [^-]+-----/.exec(clean);
    if (match) {
      const body = match[1].match(/.{1,64}/g)?.join('\n') || match[1];
      return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
    }
    return clean;
  }

  /**
   * Cryptographically verify that the device owns the private key corresponding
   * to its public key, proving it is the genuine physical computer.
   */
  verifySignature(publicKey: string, challenge: string, signatureBase64: string): boolean {
    try {
      const formattedKey = this.formatPem(publicKey);
      const verifier = crypto.createVerify('SHA256');
      verifier.update(challenge);
      verifier.end();
      return verifier.verify(formattedKey, signatureBase64, 'base64');
    } catch (err) {
      this.logger.error('Cryptographic signature verification exception:', err);
      return false;
    }
  }

  /**
   * Register a new device or fetch existing device during Electron login.
   * STRICT SECURITY RULE: Any newly seen device is ALWAYS assigned role 'secondary'
   * and approval_status 'pending'. ONLY an admin can promote to primary.
   */
  async registerOrGetDevice(
    userId: string,
    signature: string,
    displayName: string | null,
    deviceType: DeviceType = 'electron',
    publicKey?: string | null
  ): Promise<{
    device: {
      id: string;
      userId: string;
      displayName: string | null;
      deviceType: DeviceType;
      deviceRole: DeviceRole;
      approvalStatus: DeviceApprovalStatus;
      canRead: boolean;
      canWrite: boolean;
      canPrint: boolean;
      publicKey: string | null;
    };
    isNew: boolean;
  }> {
    const cleanSignature = signature.trim();
    if (!cleanSignature) {
      throw new BadRequestException('Device signature or hardware identifier is required.');
    }

    // 1. Check existing device record
    const { rows: [existing] } = await this.database.query<{
      id: string;
      user_id: string;
      display_name: string | null;
      device_type: DeviceType;
      device_role: DeviceRole;
      approval_status: DeviceApprovalStatus;
      can_read: boolean;
      can_write: boolean;
      can_print: boolean;
      public_key: string | null;
    }>(
      `SELECT id, user_id, display_name, device_type, device_role, approval_status, can_read, can_write, can_print, public_key
       FROM auric.devices
       WHERE user_id = $1 AND device_identity_signature = $2`,
      [userId, cleanSignature]
    );

    if (existing) {
      await this.database.query(
        `UPDATE auric.devices SET last_seen_at = now() WHERE id = $1`,
        [existing.id]
      );
      return {
        device: {
          id: existing.id,
          userId: existing.user_id,
          displayName: existing.display_name,
          deviceType: existing.device_type,
          deviceRole: existing.device_role,
          approvalStatus: existing.approval_status,
          canRead: existing.can_read,
          canWrite: existing.can_write,
          canPrint: existing.can_print,
          publicKey: existing.public_key,
        },
        isNew: false,
      };
    }

    // 2. Insert new device strictly as 'secondary' and 'pending'
    this.logger.log(`Registering new ${deviceType} device for user ${userId} [role=secondary, status=pending]`);
    const { rows: [created] } = await this.database.query<{
      id: string;
      user_id: string;
      display_name: string | null;
      device_type: DeviceType;
      device_role: DeviceRole;
      approval_status: DeviceApprovalStatus;
      can_read: boolean;
      can_write: boolean;
      can_print: boolean;
      public_key: string | null;
    }>(
      `INSERT INTO auric.devices (
        user_id, device_identity_signature, display_name, device_type, device_role,
        approval_status, can_read, can_write, can_print, public_key, created_at, last_seen_at
      ) VALUES ($1, $2, $3, $4, 'secondary', 'pending', false, false, false, $5, now(), now())
      RETURNING id, user_id, display_name, device_type, device_role, approval_status, can_read, can_write, can_print, public_key`,
      [userId, cleanSignature, displayName?.slice(0, 200) || null, deviceType, publicKey || null]
    );

    return {
      device: {
        id: created.id,
        userId: created.user_id,
        displayName: created.display_name,
        deviceType: created.device_type,
        deviceRole: created.device_role,
        approvalStatus: created.approval_status,
        canRead: created.can_read,
        canWrite: created.can_write,
        canPrint: created.can_print,
        publicKey: created.public_key,
      },
      isNew: true,
    };
  }

  /**
   * Admin exclusive action: Promote a device to Primary.
   * Atomically demotes previous primary to secondary and sets target to primary & approved.
   */
  async makePrimary(deviceId: string): Promise<DeviceDto> {
    return this.database.transaction(async (client: PoolClient) => {
      const {rows:[owner]}=await client.query('SELECT user_id FROM auric.devices WHERE id=$1',[deviceId]);
      if(!owner)throw new NotFoundException('Device not found.');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.primary'),hashtext($1))",[owner.user_id]);
      // 1. Lock and fetch target device
      const { rows: [target] } = await client.query<{
        id: string;
        user_id: string;
        display_name: string | null;
      }>(
        `SELECT id, user_id, display_name FROM auric.devices WHERE id = $1 FOR UPDATE`,
        [deviceId]
      );

      if (!target) {
        throw new NotFoundException(`Device with ID ${deviceId} not found.`);
      }

      // 2. Demote any active primary device for this user
      await client.query(
        `UPDATE auric.devices
         SET device_role = 'secondary', last_seen_at = now()
         WHERE user_id = $1 AND device_role = 'primary'`,
        [target.user_id]
      );

      // 3. Promote target device to primary and approved
      const { rows: [promoted] } = await client.query<{
        id: string;
        display_name: string | null;
        device_type: DeviceType;
        device_role: DeviceRole;
        approval_status: DeviceApprovalStatus;
        can_read: boolean;
        can_write: boolean;
        can_print: boolean;
        created_at: Date;
        last_seen_at: Date;
      }>(
        `UPDATE auric.devices
         SET device_role = 'primary',
             approval_status = 'approved',
             can_read = true,
             can_write = true,
             can_print = true,
             last_seen_at = now()
         WHERE id = $1
         RETURNING id, display_name, device_type, device_role, approval_status,
                   can_read, can_write, can_print, created_at, last_seen_at`,
        [deviceId]
      );

      this.logger.log(`Admin promoted device ${deviceId} to primary for user ${target.user_id}`);

      return {
        id: promoted.id,
        displayName: promoted.display_name,
        deviceType: promoted.device_type,
        deviceRole: promoted.device_role,
        approvalStatus: promoted.approval_status,
        canRead: promoted.can_read,
        canWrite: promoted.can_write,
        canPrint: promoted.can_print,
        createdAt: promoted.created_at,
        lastSeenAt: promoted.last_seen_at,
      };
    });
  }

  /**
   * Admin exclusive action: Update approval status and permissions for a device.
   */
  async updateStatus(
    deviceId: string,
    approvalStatus: DeviceApprovalStatus,
    canRead?: boolean,
    canWrite?: boolean,
    canPrint?: boolean
  ): Promise<DeviceDto> {
    const { rows: [updated] } = await this.database.query<{
      id: string;
      display_name: string | null;
      device_type: DeviceType;
      device_role: DeviceRole;
      approval_status: DeviceApprovalStatus;
      can_read: boolean;
      can_write: boolean;
      can_print: boolean;
      created_at: Date;
      last_seen_at: Date;
    }>(
      `UPDATE auric.devices
       SET approval_status = $2,
           can_read = COALESCE($3, can_read),
           can_write = COALESCE($4, can_write),
           can_print = COALESCE($5, can_print),
           last_seen_at = now()
       WHERE id = $1
       RETURNING id, display_name, device_type, device_role, approval_status,
                 can_read, can_write, can_print, created_at, last_seen_at`,
      [deviceId, approvalStatus, canRead, canWrite, canPrint]
    );

    if (!updated) {
      throw new NotFoundException(`Device with ID ${deviceId} not found.`);
    }

    return {
      id: updated.id,
      displayName: updated.display_name,
      deviceType: updated.device_type,
      deviceRole: updated.device_role,
      approvalStatus: updated.approval_status,
      canRead: updated.can_read,
      canWrite: updated.can_write,
      canPrint: updated.can_print,
      createdAt: updated.created_at,
      lastSeenAt: updated.last_seen_at,
    };
  }

  /**
   * Admin: List all devices across all users (or filter by specific user).
   */
  async listAllDevices(userIdFilter?: string,limit=25,offset=0,search='%'): Promise<{ devices: AdminDeviceViewDto[]; total:number }> {
    const query = `
      SELECT 
        d.id,
        d.user_id AS "userId",
        u.email AS "userEmail",
        u.username,
        d.display_name AS "displayName",
        d.device_type AS "deviceType",
        d.device_role AS "deviceRole",
        d.approval_status AS "approvalStatus",
        d.can_read AS "canRead",
        d.can_write AS "canWrite",
        d.can_print AS "canPrint",
        d.created_at AS "createdAt",
        d.last_seen_at AS "lastSeenAt"
      FROM auric.devices d
      JOIN auth.users u ON u.id = d.user_id
      WHERE ($1::uuid IS NULL OR d.user_id=$1) AND concat_ws(' ',u.email,u.username,d.display_name,d.approval_status) ILIKE $2
      ORDER BY d.last_seen_at DESC,d.id LIMIT $3 OFFSET $4
    `;

    const { rows } = await this.database.query<AdminDeviceViewDto>(
      query,
      [userIdFilter??null,search,limit,offset]
    );

    const {rows:[count]}=await this.database.query(`SELECT count(*)::int AS total FROM auric.devices d JOIN auth.users u ON u.id=d.user_id WHERE ($1::uuid IS NULL OR d.user_id=$1) AND concat_ws(' ',u.email,u.username,d.display_name,d.approval_status) ILIKE $2`,[userIdFilter??null,search]);
    return { devices: rows,total:count.total };
  }

  /**
   * Admin: Delete device
   */
  async deleteDevice(deviceId: string): Promise<{ deleted: boolean }> {
    const { rowCount } = await this.database.query(
      `DELETE FROM auric.devices WHERE id = $1`,
      [deviceId]
    );
    if (!rowCount) {
      throw new NotFoundException(`Device with ID ${deviceId} not found.`);
    }
    return { deleted: true };
  }
}
