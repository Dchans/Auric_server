import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { AppController } from './app.controller';
import { ElectronAuthController } from './auth/electron-auth.controller';
import {RemoteAuthController} from './auth/remote-auth.controller';
import { CredentialsModule } from './credentials/credentials.module';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SecurityModule } from './security/security.module';
import { VersionsModule } from './versions/versions.module';
import { ControlController } from './control';
import {SupportModule} from './support/support.module';

export { AuthAccount } from './common/types/auth-account.type';
export { Database, DatabaseService } from './database/database.service';
export { AuthClient } from './security/auth.client';
export { AuthGuard } from './security/auth.guard';

@Module({
  imports: [
    DatabaseModule,
    SecurityModule,
    AccountModule,
    RealtimeModule,
    VersionsModule,
    CredentialsModule,
    DevicesModule,
    SupportModule,
  ],
  controllers: [AppController, ElectronAuthController, RemoteAuthController, ControlController],
})
export class AppModule {}
