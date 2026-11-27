import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UserSocket } from './realtime/user.socket';
import { DatabaseService } from './database/database.service';
import { AdminAudit, ControlErrors } from './control-common';
import {json} from 'express';

function resolveTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = raw.trim().toLowerCase();
  if (value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return raw.trim();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule,{bodyParser:false});
  app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
  app.use('/api/support',json({limit:'8mb'}));
  app.use('/admin/formats',json({limit:'25mb'}));
  app.use(json({limit:'256kb'}));
  app.enableShutdownHooks();
  app.useGlobalInterceptors(new AdminAudit(app.get(DatabaseService), 'auric'));
  app.useGlobalFilters(new ControlErrors());
  app.use('/admin', (_req:any,res:any,next:()=>void)=>{res.setHeader('Cache-Control','no-store');next();});
  const corsEnv = process.env.AURIC_CORS_ORIGIN ?? process.env.CORS_ORIGIN;
  const corsOrigin = corsEnv && corsEnv !== '*' && corsEnv !== 'true'
    ? corsEnv.split(',').map((o) => o.trim()).filter(Boolean)
    : true;
  app.enableCors({ origin: corsOrigin, credentials: true });
  app.get(UserSocket).attach(app.getHttpServer());

  const port = Number(process.env.PORT ?? process.env.AURIC_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
