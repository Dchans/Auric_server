import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UserSocket } from './realtime/user.socket';
import { DatabaseService } from './database/database.service';
import { AdminAudit, ControlErrors } from './control-common';
import {json} from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule,{bodyParser:false});
  app.use('/api/support',json({limit:'8mb'}));
  app.use(json({limit:'256kb'}));
  app.enableShutdownHooks();
  app.useGlobalInterceptors(new AdminAudit(app.get(DatabaseService), 'auric'));
  app.useGlobalFilters(new ControlErrors());
  app.use('/admin', (_req:any,res:any,next:()=>void)=>{res.setHeader('Cache-Control','no-store');next();});
  app.enableCors({ origin: true, credentials: true });
  app.get(UserSocket).attach(app.getHttpServer());

  const port = Number(process.env.AURIC_PORT ?? process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
