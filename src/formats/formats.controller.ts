import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthAccount } from '../common/types/auth-account.type';
import { AdminGuard } from '../security/admin.guard';
import { AuthGuard } from '../security/auth.guard';
import { FormatsService } from './formats.service';

/** Desktop endpoints: list the server catalog and fetch selected formats sealed for the signed-in shop. */
@Controller('api/formats')
@UseGuards(AuthGuard)
export class FormatsController {
  constructor(private readonly formats: FormatsService) {}

  @Get('catalog') @Header('Cache-Control', 'no-store')
  catalog() { return this.formats.catalog(); }

  @Post('fetch') @Header('Cache-Control', 'no-store')
  fetch(@CurrentUser() user: AuthAccount, @Body() body: unknown) { return this.formats.fetch(user.id, body); }
}

/** Administrator endpoints (reached through the Control Center): upload and manage the catalog. */
@Controller('admin/formats')
@UseGuards(AdminGuard)
export class FormatsAdminController {
  constructor(private readonly formats: FormatsService) {}

  @Get() @Header('Cache-Control', 'no-store')
  list(@Query() q: Record<string, string>) { return this.formats.adminList(q); }

  @Get('source') @Header('Cache-Control', 'no-store')
  source() { return this.formats.sourceStatus(); }

  @Put('source')
  setSource(@Body() body: unknown) { return this.formats.setSource(body); }

  @Post()
  upload(@Body() body: unknown) { return this.formats.upload(body); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.formats.update(id, body); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.formats.remove(id); }
}
