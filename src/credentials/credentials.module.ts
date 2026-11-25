import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CredentialsService } from './credentials.service';

@Module({
  imports: [DatabaseModule],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
