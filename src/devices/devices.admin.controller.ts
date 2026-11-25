import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../security/admin.guard';
import { DeviceApprovalStatus } from '../schema';
import { DevicesService } from './devices.service';
import { boolean, choice, object, page, uuid } from '../control-common';

class UpdateDeviceStatusDto {
  status!: DeviceApprovalStatus;
  canRead?: boolean;
  canWrite?: boolean;
  canPrint?: boolean;
}

@Controller('admin/devices')
@UseGuards(AdminGuard)
export class DevicesAdminController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  async listDevices(@Query() query:Record<string,string>) {
    const p=page(query);
    return this.devicesService.listAllDevices(p.userId??undefined,p.limit,p.offset,p.search);
  }

  @Put(':id/make-primary')
  async makePrimary(@Param('id') deviceId: string) {
    uuid(deviceId);
    const device = await this.devicesService.makePrimary(deviceId);
    return {
      success: true,
      message: 'Device promoted to primary and approved successfully.',
      device,
    };
  }

  @Put(':id/status')
  async updateStatus(
    @Param('id') deviceId: string,
    @Body() body: UpdateDeviceStatusDto
  ) {
    uuid(deviceId);object(body);choice(body.status,['pending','approved','rejected','revoked']);
    for(const value of [body.canRead,body.canWrite,body.canPrint])if(value!==undefined)boolean(value);
    const device = await this.devicesService.updateStatus(
      deviceId,
      body.status,
      body.canRead,
      body.canWrite,
      body.canPrint
    );
    return {
      success: true,
      message: `Device status updated to ${body.status}.`,
      device,
    };
  }

  @Delete(':id')
  async deleteDevice(@Param('id') deviceId: string) {
    uuid(deviceId);
    return this.devicesService.deleteDevice(deviceId);
  }
}
