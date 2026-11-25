import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SecurityModule } from '../security/security.module';
import { DevicesAdminController } from './devices.admin.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [DatabaseModule, SecurityModule],
  controllers: [DevicesAdminController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
