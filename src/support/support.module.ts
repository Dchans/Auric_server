import {Module} from '@nestjs/common';
import {SupportController,SupportAdminController} from './support.controller';
import {SupportService} from './support.service';
@Module({controllers:[SupportController,SupportAdminController],providers:[SupportService]})
export class SupportModule{}
