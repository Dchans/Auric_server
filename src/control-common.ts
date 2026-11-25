import { ArgumentsHost, BadRequestException, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, from, lastValueFrom } from 'rxjs';

export function page(query: Record<string, string>) {
  const limit = Number(query.limit ?? 25), offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new BadRequestException('Invalid pagination.');
  if ((query.search ?? '').length > 200) throw new BadRequestException('Search is too long.');
  return { limit, offset, search: `%${query.search ?? ''}%`, userId: query.userId ? uuid(query.userId) : null };
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException('A valid UUID is required.');
  return value;
}
export function text(value: unknown, label: string, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new BadRequestException(`Provide a valid ${label} (maximum ${max} characters).`);
  return value.trim();
}
export function choice(value: unknown, options: readonly string[]) {
  if (typeof value !== 'string' || !options.includes(value)) throw new BadRequestException(`Choose ${options.join(', ')}.`);
  return value;
}
export function integer(value: unknown, min = 0): string {
  if (!((typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value))) || BigInt(value as string) < BigInt(min) || BigInt(value as string) > 9223372036854775807n) throw new BadRequestException('Provide a valid whole number.');
  return String(value);
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException('Provide true or false.');
  return value;
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Provide a JSON object.');
  return value as Record<string, any>;
}
export function date(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new BadRequestException('Provide a valid date.');
  return new Date(value).toISOString();
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !/^[A-Z_0-9]{1,64}$/.test(v))) throw new BadRequestException('Provide a list of feature codes.');
  return [...new Set(value)];
}

@Catch()
export class ControlErrors implements ExceptionFilter {
  catch(error:any,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse();
    if(error?.type==='entity.too.large'){response.status(413).json({statusCode:413,message:'The request body is too large.'});return;}
    if(error?.type==='entity.parse.failed'){response.status(400).json({statusCode:400,message:'Provide valid JSON.'});return;}
    if(error instanceof HttpException){response.status(error.getStatus()).json(typeof error.getResponse()==='string'?{message:error.getResponse()}:error.getResponse());return;}
    const known:Record<string,[number,string]>={
      '23505':[409,'A record with these details already exists.'],
      '23503':[409,'A related record is missing or prevents this change. Check account and subscription dependencies.'],
      '23514':[400,'This change violates a service rule. Check the values and try again.'],
      '22P02':[400,'A value has an invalid format.'],
      '22003':[400,'A number is outside the supported range.'],
      '40P01':[409,'Another administrator changed these records. Refresh and try again.'],
    };
    const [status,message]=known[error?.code]??[500,'The service could not complete the request. Check Operations and try again.'];
    if(status===500)console.error('Request failed:',error?.code??error?.name??'Unknown error');
    response.status(status).json({statusCode:status,message});
  }
}

// Append-only records. Request bodies, query strings and bearer tokens are never persisted.
@Injectable()
export class AdminAudit implements NestInterceptor {
  constructor(private readonly db: { query(sql: string, values?: any[]): Promise<any> }, private readonly service: string) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const path = String(req.path ?? req.url).split('?')[0];
    const actor = req.admin ?? req.auricUser ?? req.coveAdmin;
    if (!actor || req.method === 'GET' || path.startsWith('/admin/operations/') || !(path.startsWith('/admin/') || path.startsWith('/updates/'))) return next.handle();
    return from((async () => {
      const requestId = randomUUID();
      const record = (outcome: string) => this.db.query('INSERT INTO auth.admin_audit (actor_id, actor_email, service, action, resource, outcome, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [actor.id, actor.email, this.service, req.method, path, outcome, requestId]);
      await record('requested');
      let result;
      try { result = await lastValueFrom(next.handle(), { defaultValue: undefined }); }
      catch (error) { await record('failed'); throw error; }
      await record('succeeded');
      return result;
    })());
  }
}
