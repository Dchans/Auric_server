import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { AdminGuard } from './security/admin.guard';
import { UserSocket } from './realtime/user.socket';
import { EntitlementService } from './security/entitlement.service';
import { CredentialsService, CredentialType } from './credentials/credentials.service';
import { boolean, choice, date, integer, object, page, strings, text, uuid } from './control-common';

const planFields=`id,plan_code AS "planCode",name,description,amount_minor::text AS "amountMinor",currency,billing_interval AS "billingInterval",modules,is_available AS "isAvailable",created_at AS "createdAt"`;
const subFields=`s.id,s.user_id AS "userId",u.email,s.plan_id AS "planId",p.name AS "planName",p.modules,s.provider,s.status,s.current_period_end_at AS "currentPeriodEndAt",s.created_at AS "createdAt"`;

@Controller('admin')
@UseGuards(AdminGuard)
export class ControlController {
  constructor(
    private readonly db: DatabaseService,
    private readonly socket: UserSocket,
    private readonly credentials: CredentialsService,
    private readonly entitlement: EntitlementService
  ) {}
  @Get('shops/:userId/credentials')
  getCredentials(@Param('userId') userId:string) {
    return this.credentials.getCredentialStatus(uuid(userId));
  }
  @Put('shops/:userId/credentials/:type')
  resetCredential(@Param('userId') userId:string,@Param('type') type:string,@Body() body:unknown) {
    const credentialType=choice(type,['db_password','file_password']) as CredentialType;
    return this.credentials.resetCredential(uuid(userId),credentialType,body);
  }
  @Get('overview')
  async overview() {
    const {rows:[stats]}=await this.db.query(`SELECT
      (SELECT count(*)::int FROM auric.devices) AS devices,
      (SELECT count(*)::int FROM auric.devices WHERE approval_status='pending') AS "pendingDevices",
      (SELECT count(*)::int FROM auric.subscriptions WHERE status='active' AND current_period_end_at>now()) AS subscriptions,
      (SELECT count(*)::int FROM auric.shop_profiles) AS shops,
      (SELECT COALESCE(sum(amount_minor-refunded_amount_minor),0)::text FROM auric.payments WHERE status IN ('succeeded','partially_refunded')) AS "collectedMinor"`);
    return {...stats,realtime:this.socket.adminStats()};
  }
  private async list(select:string,from:string,search:string,q:Record<string,string>, userColumn?:string) {
    const p=page(q);
    const where=`${from} WHERE (${search}) ${userColumn ? `AND ($2::uuid IS NULL OR ${userColumn}=$2)` : 'AND $2::uuid IS NULL'}`;
    const args=[p.search,p.userId];
    const {rows}=await this.db.query(`SELECT ${select} ${where} ORDER BY 1 LIMIT $3 OFFSET $4`,[...args,p.limit,p.offset]);
    const {rows:[count]}=await this.db.query(`SELECT count(*)::int AS total ${where}`,args);
    return {rows,total:count.total};
  }
  @Get('shops')
  shops(@Query() q:Record<string,string>) {
    return this.list(`s.user_id AS id,s.user_id AS "userId",u.email,s.shop_name AS "shopName",s.shop_location AS "shopLocation",s.gstin,s.created_at AS "createdAt"`,'FROM auric.shop_profiles s JOIN auth.users u ON u.id=s.user_id',`s.shop_name ILIKE $1 OR u.email ILIKE $1 OR s.shop_location ILIKE $1`,q,'s.user_id');
  }
  @Post('shops')
  @Header('Cache-Control','no-store')
  async saveShop(@Body() raw:unknown) {
    const b=object(raw),userId=uuid(b.userId),name=text(b.shopName,'shop name',200),location=text(b.shopLocation,'shop location',500);
    const gstin=b.gstin ? text(b.gstin,'GSTIN',15).toUpperCase():null;
    if (gstin && !/^[A-Z0-9]{15}$/.test(gstin)) throw new BadRequestException('GSTIN must have 15 letters or digits.');
    const {rows:[row]}=await this.db.query(`INSERT INTO auric.shop_profiles(user_id,shop_name,shop_location,gstin) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET shop_name=$2,shop_location=$3,gstin=$4,updated_at=now() RETURNING user_id AS id`,[userId,name,location,gstin]);
    return row;
  }
  @Get('plans')
  plans(@Query() q:Record<string,string>) {
    return this.list(planFields,'FROM auric.subscription_plans','name ILIKE $1 OR plan_code ILIKE $1',q);
  }
  private plan(raw:unknown) {
    const b=object(raw), modules=strings(b.modules).map(v=>v==='JEWEL'?'JEWLE':v);
    if (modules.some(v=>!['PAWN','JEWLE','FINANCE','REMOTE','CLOUD_BACKUP'].includes(v))) throw new BadRequestException('Invalid Auric module.');
    return [text(b.planCode,'plan code',64),text(b.name,'plan name',200), b.description ? text(b.description,'description',2000) : null,integer(b.amountMinor),choice(b.billingInterval,['day','week','month','year']),modules,boolean(b.isAvailable)];
  }
  @Post('plans')
  async createPlan(@Body() raw:unknown) {
    const {rows:[row]}=await this.db.query(`INSERT INTO auric.subscription_plans(plan_code,name,description,amount_minor,billing_interval,modules,is_available) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${planFields}`,this.plan(raw));
    return row;
  }
  @Patch('plans/:id')
  async updatePlan(@Param('id') id:string,@Body() raw:unknown) {
    const {rows:[row]}=await this.db.query(`UPDATE auric.subscription_plans SET plan_code=$1,name=$2,description=$3,amount_minor=$4,billing_interval=$5,modules=$6,is_available=$7,updated_at=now() WHERE id=$8 RETURNING ${planFields}`,[...this.plan(raw),uuid(id)]);
    if(!row) throw new NotFoundException('Plan not found.');
    return row;
  }
  @Get('subscriptions')
  subscriptions(@Query() q:Record<string,string>) {
    return this.list(subFields,'FROM auric.subscriptions s JOIN auth.users u ON u.id=s.user_id JOIN auric.subscription_plans p ON p.id=s.plan_id','u.email ILIKE $1 OR p.name ILIKE $1 OR s.status ILIKE $1',q,'s.user_id');
  }
  private subscription(raw:unknown) {
    const b=object(raw),status=choice(b.status,['pending','trialing','active','past_due','paused','canceled','expired']),end=date(b.currentPeriodEndAt);
    if(status==='active' && (!end || Date.parse(end)<=Date.now())) throw new BadRequestException('An active subscription requires a future period end.');
    return {b,status,end,planId:uuid(b.planId)};
  }
  @Post('subscriptions')
  async createSubscription(@Body() raw:unknown) {
    const {b,status,end,planId}=this.subscription(raw);
    const {rows:[row]}=await this.db.query(`INSERT INTO auric.subscriptions(user_id,plan_id,provider,status,current_period_end_at,canceled_at) VALUES($1,$2,'manual',$3,$4,CASE WHEN $3='canceled' THEN now() END) RETURNING id`,[uuid(b.userId),planId,status,end]);
    try {
      const subStatus = await this.db.getSubscriptionStatus(b.userId);
      const payload = this.entitlement.buildSubscriptionPayload({ id: b.userId }, subStatus);
      this.socket.notifyUser(b.userId, { type: 'subscription:updated', data: payload });
    } catch {}
    return row;
  }
  @Patch('subscriptions/:id')
  async updateSubscription(@Param('id') id:string,@Body() raw:unknown) {
    const {status,end,planId}=this.subscription(raw);
    const {rows:[row]}=await this.db.query(`UPDATE auric.subscriptions SET plan_id=$2,status=$3,current_period_end_at=$4,canceled_at=CASE WHEN $3='canceled' THEN COALESCE(canceled_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING id, user_id AS "userId"`,[uuid(id),planId,status,end]);
    if(!row) throw new NotFoundException('Subscription not found.');
    if (row.userId) {
      try {
        const subStatus = await this.db.getSubscriptionStatus(row.userId);
        const payload = this.entitlement.buildSubscriptionPayload({ id: row.userId }, subStatus);
        this.socket.notifyUser(row.userId, { type: 'subscription:updated', data: payload });
      } catch {}
    }
    return row;
  }
  @Get('payments')
  payments(@Query() q:Record<string,string>) {
    return this.list(`p.id,s.user_id AS "userId",u.email,p.subscription_id AS "subscriptionId",p.provider,p.amount_minor::text AS "amountMinor",p.refunded_amount_minor::text AS "refundedAmountMinor",'INR' AS currency,p.status,p.paid_at AS "paidAt",p.created_at AS "createdAt"`,'FROM auric.payments p JOIN auric.subscriptions s ON s.id=p.subscription_id JOIN auth.users u ON u.id=s.user_id','u.email ILIKE $1 OR p.status ILIKE $1 OR p.provider ILIKE $1',q,'s.user_id');
  }
}
