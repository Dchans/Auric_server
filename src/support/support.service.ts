import {BadRequestException,ConflictException,Injectable,NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {page,uuid,choice} from '../control-common';
import {supportId,supportPayload,supportText,statuses,priorities} from './support.validation';
const fields=`r.id::text AS id,r.user_id AS "userId",u.email,u.username,r.kind,r.category,r.subject,r.message,r.current_path AS "currentPath",r.page_title AS "pageTitle",r.status,r.priority,r.assignee_id AS "assigneeId",a.email AS "assigneeEmail",r.version,(r.screenshot IS NOT NULL) AS "hasScreenshot",r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.resolved_at AS "resolvedAt"`;
const joins=`FROM auric.support_requests r JOIN auth.users u ON u.id=r.user_id LEFT JOIN auth.users a ON a.id=r.assignee_id`;
@Injectable()
export class SupportService{
 constructor(private readonly db:DatabaseService){}
 async create(userId:string,raw:unknown,kind:'request'|'error_report'){
  const p=supportPayload(raw,kind);await this.db.rateLimit('auric_support_'+kind,userId,kind==='request'?10:30,900);
  const result=await this.db.transaction(async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtext('auric.support'),hashtext($1))",[userId]);
   const existing=(await client.query('SELECT id FROM auric.support_requests WHERE user_id=$1 AND kind=$2 AND fingerprint=$3 AND created_at>now()-interval \'60 seconds\' ORDER BY id DESC LIMIT 1',[userId,kind,p.fingerprint])).rows[0];if(existing)return {id:existing.id,duplicate:true};
   const {rows:[row]}=await client.query(`INSERT INTO auric.support_requests(user_id,kind,category,subject,message,current_path,page_title,diagnostics,screenshot,screenshot_mime,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[userId,kind,p.category,p.subject,p.message,p.currentPath,p.pageTitle,JSON.stringify(p.diagnostics),p.image?.bytes??null,p.image?.mime??null,p.fingerprint]);
   await client.query("INSERT INTO auric.support_events(request_id,actor_id,action) VALUES($1,$2,'created')",[row.id,userId]);return {id:row.id,duplicate:false};
  });
  return {success:true,[kind==='request'?'request_id':'report_id']:Number(result.id),message:kind==='request'?'Support request received.':'Error report received.',duplicate:result.duplicate};
 }
 async list(q:Record<string,string>,userId?:string){
  const p=page(q),status=q.status?choice(q.status,statuses):null,category=q.category?choice(q.category,['bug','help','feedback']):null,priority=q.priority?choice(q.priority,priorities):null,kind=q.kind?choice(q.kind,['request','error_report']):null;
  const args=[userId??p.userId,status,category,priority,kind,p.search];
  const where=`WHERE ($1::uuid IS NULL OR r.user_id=$1) AND ($2::text IS NULL OR r.status=$2) AND ($3::text IS NULL OR r.category=$3) AND ($4::text IS NULL OR r.priority=$4) AND ($5::text IS NULL OR r.kind=$5) AND (r.subject ILIKE $6 OR r.message ILIKE $6 OR u.email ILIKE $6 OR r.id::text ILIKE $6)`;
  const {rows}=await this.db.query(`SELECT ${fields.replace('r.message,','')} ${joins} ${where} ORDER BY r.updated_at DESC,r.id DESC LIMIT $7 OFFSET $8`,[...args,p.limit,p.offset]);
  const {rows:[count]}=await this.db.query(`SELECT count(*)::int AS total ${joins} ${where}`,args);return {rows,total:count.total};
 }
 async detail(id:string,userId?:string){
  supportId(id);const {rows:[request]}=await this.db.query(`SELECT ${fields}${userId?'':',r.diagnostics'} ${joins} WHERE r.id=$1 AND ($2::uuid IS NULL OR r.user_id=$2)`,[id,userId??null]);if(!request)throw new NotFoundException('Support request not found.');
  const {rows:messages}=await this.db.query(`SELECT m.id::text AS id,m.author_role AS "authorRole",m.visibility,m.message,m.created_at AS "createdAt",CASE WHEN m.author_role='admin' THEN 'Support team' ELSE u.email END AS "authorName" FROM auric.support_messages m LEFT JOIN auth.users u ON u.id=m.author_id WHERE request_id=$1 ${userId?"AND visibility='public'":''} ORDER BY m.id`,[id]);
  const {rows:events}=userId?{rows:[]}:await this.db.query(`SELECT e.id::text AS id,e.action,e.changes,u.email AS "actorEmail",e.created_at AS "createdAt" FROM auric.support_events e LEFT JOIN auth.users u ON u.id=e.actor_id WHERE request_id=$1 ORDER BY e.id`,[id]);
  return {...request,messages,events};
 }
 async image(id:string,userId?:string){supportId(id);const {rows:[row]}=await this.db.query('SELECT screenshot,screenshot_mime FROM auric.support_requests WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)',[id,userId??null]);if(!row?.screenshot)throw new NotFoundException('Screenshot not found.');return {mimeType:row.screenshot_mime,data:row.screenshot.toString('base64')};}
 async update(id:string,raw:any,actorId:string){
  supportId(id);if(!raw||!Number.isInteger(raw.version)||raw.version<1)throw new BadRequestException('Send the current request version.');
  const values:any={};if(raw.status!==undefined)values.status=choice(raw.status,statuses);if(raw.priority!==undefined)values.priority=choice(raw.priority,priorities);if(raw.assigneeId!==undefined)values.assignee_id=raw.assigneeId===null?null:uuid(raw.assigneeId);if(!Object.keys(values).length)throw new BadRequestException('Choose at least one change.');
  await this.db.transaction(async client=>{
   const {rows:[row]}=await client.query('SELECT * FROM auric.support_requests WHERE id=$1 FOR UPDATE',[id]);if(!row)throw new NotFoundException('Support request not found.');if(row.version!==raw.version)throw new ConflictException('This request changed. Refresh before saving.');
   if(values.assignee_id){const {rowCount}=await client.query("SELECT 1 FROM auth.users u JOIN auth.roles r ON r.id=u.role_id WHERE u.id=$1 AND r.name='admin' AND u.disabled_at IS NULL",[values.assignee_id]);if(!rowCount)throw new BadRequestException('Assign requests to an active administrator.');}
   const status=values.status??row.status;await client.query(`UPDATE auric.support_requests SET status=$2,priority=$3,assignee_id=$4,version=version+1,updated_at=now(),resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN COALESCE(resolved_at,now()) ELSE NULL END WHERE id=$1`,[id,status,values.priority??row.priority,Object.hasOwn(values,'assignee_id')?values.assignee_id:row.assignee_id]);
   const changes=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{from:row[key],to:value}]));await client.query("INSERT INTO auric.support_events(request_id,actor_id,action,changes) VALUES($1,$2,'updated',$3)",[id,actorId,JSON.stringify(changes)]);
  });return this.detail(id);
 }
 async reply(id:string,raw:any,actorId:string,admin=false){
  supportId(id);const message=supportText(raw?.message,'reply',12000),visibility=admin?choice(raw?.visibility??'public',['public','internal']):'public';await this.db.rateLimit('auric_support_reply',actorId,30,900);
  await this.db.transaction(async client=>{
   const {rows:[row]}=await client.query('SELECT user_id,status FROM auric.support_requests WHERE id=$1 FOR UPDATE',[id]);if(!row||!admin&&row.user_id!==actorId)throw new NotFoundException('Support request not found.');
   if(!admin&&row.status==='closed')throw new ConflictException('This request is closed. Create a new support request.');
   await client.query('INSERT INTO auric.support_messages(request_id,author_id,author_role,visibility,message) VALUES($1,$2,$3,$4,$5)',[id,actorId,admin?'admin':'customer',visibility,message]);
   await client.query(`UPDATE auric.support_requests SET version=version+1,updated_at=now(),status=CASE WHEN $2 AND status IN ('waiting_customer','resolved') THEN 'open' ELSE status END,resolved_at=CASE WHEN $2 AND status IN ('waiting_customer','resolved') THEN NULL ELSE resolved_at END WHERE id=$1`,[id,!admin]);
   await client.query("INSERT INTO auric.support_events(request_id,actor_id,action,changes) VALUES($1,$2,$3,$4)",[id,actorId,visibility==='internal'?'internal_note':'reply',JSON.stringify({visibility})]);
  });return this.detail(id,admin?undefined:actorId);
 }
 async summary(){const {rows}=await this.db.query('SELECT status,count(*)::int AS count FROM auric.support_requests GROUP BY status');return Object.fromEntries(statuses.map(status=>[status,rows.find(r=>r.status===status)?.count??0]));}
 async assignees(){const {rows}=await this.db.query("SELECT u.id,u.email FROM auth.users u JOIN auth.roles r ON r.id=u.role_id WHERE r.name='admin' AND u.disabled_at IS NULL ORDER BY u.email LIMIT 200");return rows;}
}
