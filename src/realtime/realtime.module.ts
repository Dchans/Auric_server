import { Global, Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthClient } from '../security/auth.client';
import { UserSocket } from './user.socket';

@Global()
@Module({
  providers: [
    {
      provide: UserSocket,
      inject: [AuthClient, DatabaseService],
      useFactory: (auth: AuthClient, database: DatabaseService) => new UserSocket(auth, database),
    },
  ],
  exports: [UserSocket],
})
export class RealtimeModule {}
