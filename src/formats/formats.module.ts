import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { SecurityModule } from '../security/security.module';
import { CoveStorageClient } from './cove-storage.client';
import { FormatsAdminController, FormatsController } from './formats.controller';
import { FormatsService } from './formats.service';

@Module({
  imports: [CredentialsModule, SecurityModule],
  controllers: [FormatsController, FormatsAdminController],
  providers: [CoveStorageClient, FormatsService],
  exports: [FormatsService, CoveStorageClient],
})
export class FormatsModule {}
