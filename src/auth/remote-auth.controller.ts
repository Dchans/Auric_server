import {BadRequestException,Body,Controller,ForbiddenException,Header,HttpCode,HttpException,Post,Req,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import {DatabaseService} from '../database/database.service';
import {DevicesService} from '../devices/devices.service';
import {EntitlementService} from '../security/entitlement.service';

@Controller('api/auth')
export class RemoteAuthController {
  constructor(
    private readonly database:DatabaseService,
    private readonly devices:DevicesService,
    private readonly entitlementService:EntitlementService
  ){}
  @Post('login') @HttpCode(200) @Header('Cache-Control','no-store')
  async login(@Body() body:any,@Req() req:Request){
    if(!body||typeof body.username!=='string'||!body.username.trim()||body.username.length>254||typeof body.password!=='string'||!body.password||body.password.length>128)throw new BadRequestException('Enter a username or email and password.');
    const fingerprint=body.browser_device_id??body.device_id;
    if(typeof fingerprint!=='string'||!fingerprint.trim()||fingerprint.length>1024||/[\x00-\x1f]/.test(fingerprint))throw new BadRequestException('A browser device identifier is required.');
    const name=body.browser_device_name??body.device_name??'Browser remote client';
    if(typeof name!=='string'||name.length>200||/[\x00-\x1f]/.test(name))throw new BadRequestException('Provide a valid browser device name.');
    await this.database.rateLimit('auric_remote_login_ip',req.ip??'local',30,900);
    const authUrl=process.env.AUTH_API_URL||'http://local-api-auth-1:3000';
    let result:Response;
    try{result=await fetch(`${authUrl}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:body.username.trim(),password:body.password}),signal:AbortSignal.timeout(10000),redirect:'error'});}catch{throw new ServiceUnavailableException('Authentication service is temporarily unavailable.');}
    const auth=await result.json().catch(()=>null) as any;
    if(!result.ok){if(result.status===429)throw new HttpException('Too many sign-in attempts. Try again later.',429);if(result.status>=500)throw new ServiceUnavailableException('Authentication service is temporarily unavailable.');throw new UnauthorizedException('Invalid username or password.');}
    if(!auth?.user?.id||!auth.accessToken||!auth.refreshToken)throw new ServiceUnavailableException('Authentication service returned an invalid response.');
    const revoke=()=>fetch(`${authUrl}/auth/logout`,{method:'POST',headers:{Authorization:`Bearer ${auth.accessToken}`},signal:AbortSignal.timeout(5000)}).catch(()=>undefined);
    try{
      const {device}=await this.devices.registerOrGetDevice(auth.user.id,fingerprint.trim(),name,'browser');
      if(device.deviceType!=='browser'||device.deviceRole!=='secondary')throw new ForbiddenException('Use a separate browser device identity for remote access.');
      if(['rejected','revoked'].includes(device.approvalStatus))throw new ForbiddenException('This browser device is blocked. Ask your main device or administrator to review its access.');
      const [profile, subStatus] = await Promise.all([
        this.database.getProfile(auth.user),
        this.database.getSubscriptionStatus(auth.user.id),
      ]);
      const subscription = this.entitlementService.buildSubscriptionPayload(auth.user, subStatus);
      if (!subscription.remote_enabled) {
        throw new ForbiddenException('Remote service is not included in your active subscription plan. Please upgrade your subscription to enable remote device access.');
      }
      return {success:true,message:'Credentials verified. Connect to the main Electron device for remote approval.',tokens:{access:auth.accessToken,refresh:auth.refreshToken},expiresAt:auth.expiresAt,refreshExpiresAt:auth.refreshExpiresAt,approval_required:device.approvalStatus!=='approved',device:{id:device.id,device_id:fingerprint.trim(),device_name:device.displayName,device_type:'browser',approval_status:device.approvalStatus,is_primary:false},user:{id:auth.user.id,username:auth.user.username,email:auth.user.email,shop_name:profile.shopProfile?.shopName||auth.user.username||'',address:profile.shopProfile?.shopLocation||'',gstnumber:profile.shopProfile?.gstin||''},subscription};
    }catch(error){await revoke();throw error;}
  }
}
