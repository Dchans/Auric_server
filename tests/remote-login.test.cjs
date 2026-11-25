require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RemoteAuthController}=require('../dist/auth/remote-auth.controller');
const body={username:'owner',password:'test-password',device_id:'browser-123',browser_device_id:'browser-123',browser_device_name:'Chrome on Windows',client_kind:'browser',login_type:'auric_remotecontrol'};
function fixture(device={deviceType:'browser',deviceRole:'secondary',approvalStatus:'pending',id:'id',displayName:'Chrome'}){let registered;const controller=new RemoteAuthController({rateLimit:async()=>{},getProfile:async()=>({shopProfile:{shopName:'Test shop'}})},{registerOrGetDevice:async(...args)=>{registered=args;return {device};}});return {controller,registered:()=>registered};}
test('remote login matches browser response contract and never returns desktop encryption credentials',async()=>{
 const original=global.fetch;try{global.fetch=async()=>Response.json({accessToken:'access',refreshToken:'refresh',user:{id:'user',username:'owner',email:'owner@example.test',db_password:'never-return',file_key:'never-return'}});const f=fixture(),result=await f.controller.login(body,{ip:'127.0.0.1'});assert.equal(result.success,true);assert.equal(result.tokens.access,'access');assert.equal(result.approval_required,true);assert.equal(result.device.device_type,'browser');assert.equal(f.registered()[3],'browser');assert.equal(f.registered()[1],'browser-123');assert.ok(!JSON.stringify(result).includes('never-return'));}finally{global.fetch=original;}
});
test('browser cannot reuse desktop identity or bypass blocked-device approval',async()=>{
 const original=global.fetch;try{let revokes=0;global.fetch=async url=>{if(url.endsWith('/auth/logout'))revokes++;return Response.json({accessToken:'access',refreshToken:'refresh',user:{id:'user',username:'owner'}});};for(const device of [{deviceType:'electron',deviceRole:'primary',approvalStatus:'approved'},{deviceType:'browser',deviceRole:'secondary',approvalStatus:'rejected'}])await assert.rejects(fixture(device).controller.login(body,{ip:'local'}));assert.equal(revokes,2);}finally{global.fetch=original;}
});
test('remote login validates device identity and preserves authentication errors',async()=>{
 const f=fixture();for(const invalid of [{...body,username:null},{...body,password:''},{...body,browser_device_id:''},{...body,browser_device_name:123}])await assert.rejects(f.controller.login(invalid,{ip:'local'}));const original=global.fetch;try{global.fetch=async()=>Response.json({message:'Bad credentials'},{status:401});await assert.rejects(f.controller.login(body,{ip:'local'}),/Invalid username/);}finally{global.fetch=original;}
});
