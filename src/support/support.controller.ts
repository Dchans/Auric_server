import {Body,Controller,Get,Header,Param,Patch,Post,Query,UseGuards} from '@nestjs/common';
import {AuthGuard} from '../security/auth.guard';
import {AdminGuard} from '../security/admin.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {AuthAccount} from '../common/types/auth-account.type';
import {SupportService} from './support.service';
@Controller('api/support')
@UseGuards(AuthGuard)
export class SupportController {
 constructor(private readonly support:SupportService){}
 @Post(['requests','request']) create(@CurrentUser() user:AuthAccount,@Body() body:unknown){return this.support.create(user.id,body,'request');}
 @Post('error-report') error(@CurrentUser() user:AuthAccount,@Body() body:unknown){return this.support.create(user.id,body,'error_report');}
 @Get('requests') @Header('Cache-Control','no-store') list(@CurrentUser() user:AuthAccount,@Query() query:Record<string,string>){return this.support.list(query,user.id);}
 @Get('requests/:id') @Header('Cache-Control','no-store') detail(@CurrentUser() user:AuthAccount,@Param('id') id:string){return this.support.detail(id,user.id);}
 @Post('requests/:id/replies') reply(@CurrentUser() user:AuthAccount,@Param('id') id:string,@Body() body:unknown){return this.support.reply(id,body,user.id);}
}
@Controller('admin/support')
@UseGuards(AdminGuard)
export class SupportAdminController {
 constructor(private readonly support:SupportService){}
 @Get('summary') @Header('Cache-Control','no-store') summary(){return this.support.summary();}
 @Get('assignees') @Header('Cache-Control','no-store') assignees(){return this.support.assignees();}
 @Get('requests') @Header('Cache-Control','no-store') list(@Query() query:Record<string,string>){return this.support.list(query);}
 @Get('requests/:id') @Header('Cache-Control','no-store') detail(@Param('id') id:string){return this.support.detail(id);}
 @Get('requests/:id/screenshot') @Header('Cache-Control','no-store') image(@Param('id') id:string){return this.support.image(id);}
 @Patch('requests/:id') update(@CurrentUser() user:AuthAccount,@Param('id') id:string,@Body() body:unknown){return this.support.update(id,body,user.id);}
 @Post('requests/:id/replies') reply(@CurrentUser() user:AuthAccount,@Param('id') id:string,@Body() body:unknown){return this.support.reply(id,body,user.id,true);}
}
