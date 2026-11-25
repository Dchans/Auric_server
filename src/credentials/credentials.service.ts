import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export type CredentialType = 'db_password' | 'file_password';

export interface DecryptedCredentials {
  dbPassword?: string;
  filePassword?: string;
}

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);
  private readonly derivedKey: Buffer;
  private readonly keyId = 'master-v1';

  constructor(private readonly database: DatabaseService) {
    const rawKey =
      process.env.AURIC_CREDENTIALS_MASTER_KEY ||
      '6gLUllbLXb8mrblOZHssbWYihZdTHt_TBT5TB84ozM8=';
    
    // Derive high-entropy 256-bit symmetric key via HKDF
    this.derivedKey = Buffer.from(
      crypto.hkdfSync('sha256', rawKey, '', 'auric-credentials-v1', 32)
    );
  }

  encrypt(plainText: string): { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; keyId: string } {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.derivedKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, nonce, authTag, keyId: this.keyId };
  }

  decrypt(ciphertext: Buffer, nonce: Buffer, authTag: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.derivedKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  async getDecryptedCredentials(userId: string): Promise<DecryptedCredentials> {
    try {
      const { rows } = await this.database.query<{
        credential_type: string;
        ciphertext: Buffer;
        nonce: Buffer;
        auth_tag: Buffer;
      }>(
        `SELECT credential_type, ciphertext, nonce, auth_tag 
         FROM auric.auric_credentials 
         WHERE user_id = $1`,
        [userId]
      );

      const result: DecryptedCredentials = {};
      for (const row of rows) {
        try {
          const decrypted = this.decrypt(row.ciphertext, row.nonce, row.auth_tag);
          if (row.credential_type === 'db_password') {
            result.dbPassword = decrypted;
          } else if (row.credential_type === 'file_password') {
            result.filePassword = decrypted;
          }
        } catch (decErr) {
          this.logger.error(`Failed to decrypt ${row.credential_type} for user ${userId}`, decErr);
        }
      }

      return result;
    } catch (err) {
      this.logger.error(`Database error fetching credentials for user ${userId}`, err);
      return {};
    }
  }

  async getCredentialStatus(userId: string) {
    const {rowCount}=await this.database.query('SELECT user_id FROM auric.shop_profiles WHERE user_id=$1',[userId]);
    if(!rowCount)throw new NotFoundException('Create a shop profile before managing Auric credentials.');
    const {rows}=await this.database.query<{credential_type:CredentialType;updated_at:Date}>(
      'SELECT credential_type,updated_at FROM auric.auric_credentials WHERE user_id=$1',[userId]);
    return {userId,credentials:(['db_password','file_password'] as const).map(type=>{
      const row=rows.find(r=>r.credential_type===type);
      return {type,configured:!!row,updatedAt:row?.updated_at??null};
    })};
  }

  async resetCredential(userId:string,credentialType:CredentialType,body:unknown) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('Provide a new password and confirmation.');
    const data=body as Record<string,unknown>;
    if(Object.keys(data).some(key=>!['password','confirmPassword'].includes(key)))throw new BadRequestException('Only password and confirmPassword are accepted.');
    const {password,confirmPassword}=data;
    if(typeof password!=='string'||password.length<15||password.length>128||!password.trim()||/[\x00-\x1f\x7f]/.test(password))throw new BadRequestException('Use 15–128 characters without control characters.');
    if(typeof confirmPassword!=='string'||password!==confirmPassword)throw new BadRequestException('The password confirmation must match.');
    return this.database.transaction(async client=>{
      const {rowCount}=await client.query('SELECT user_id FROM auric.shop_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
      if(!rowCount)throw new NotFoundException('Create a shop profile before managing Auric credentials.');
      await this.saveCredential(userId,credentialType,password,client);
      const {rows:[row]}=await client.query('SELECT updated_at AS "updatedAt" FROM auric.auric_credentials WHERE user_id=$1 AND credential_type=$2',[userId,credentialType]);
      return {userId,type:credentialType,configured:true,updatedAt:row.updatedAt};
    });
  }

  async saveCredential(userId: string, credentialType: CredentialType, plaintext: string, client?:PoolClient): Promise<void> {
    const enc = this.encrypt(plaintext);
    const executor:{query(sql:string,values:unknown[]):Promise<unknown>}=client??this.database;
    await executor.query(
      `INSERT INTO auric.auric_credentials (user_id, credential_type, ciphertext, nonce, auth_tag, key_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, credential_type) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag, key_id = EXCLUDED.key_id, updated_at = now()`,
      [userId, credentialType, enc.ciphertext, enc.nonce, enc.authTag, enc.keyId]
    );
  }
}
