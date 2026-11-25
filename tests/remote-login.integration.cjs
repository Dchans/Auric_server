require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),path=require('node:path'),{WebSocket}=require('ws');
test('deployed browser login, main-device approval and RPC relay work together',{skip:process.env.AURIC_REMOTE_INTEGRATION!=='1',timeout:30000},async()=>{
 process.loadEnvFile(path.resolve(__dirname,'../../API/.env'));Object.assign(process.env,{PGHOST:'127.0.0.1',PGPORT:'5432',PGUSER:process.env.POSTGRES_USER||'app',PGDATABASE:process.env.POSTGRES_DB||'app',PGPASSWORD:process.env.POSTGRES_PASSWORD});
 const {Database}=require('../../API/dist/database.js'),{AuthService}=require('../../API/dist/auth.js'),{DevicesService}=require('../dist/devices/devices.service');
 const db=new Database(),auth=new AuthService(db),devices=new DevicesService(db),suffix=randomBytes(5).toString('hex'),password=randomBytes(30).toString('base64url');let account;const sockets=[];
 const login=async body=>{const r=await fetch('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const connect=(token,device,kind)=>{const ws=new WebSocket('ws://127.0.0.1:3001/ws/remote?'+new URLSearchParams({token,device_id:device,client_kind:kind}));ws.messages=[];ws.on('message',bytes=>ws.messages.push(JSON.parse(bytes)));sockets.push(ws);return ws;};
 const wait=async(ws,predicate)=>{for(let i=0;i<500;i++){const item=ws.messages.find(predicate);if(item)return item;await new Promise(r=>setTimeout(r,10));}throw Error('Expected remote protocol event was not received');};
 try{
  assert.equal((await login({})).status,400);
  account=await auth.createAccount({firstName:'Remote',lastName:'Verification',username:'remote_'+suffix,email:`remote_${suffix}@example.test`,password},'user');
  const desktopId='desktop_'+suffix,browserId='browser_'+suffix;const desktopDevice=await devices.registerOrGetDevice(account.id,desktopId,'Disposable primary','electron');await devices.makePrimary(desktopDevice.device.id);
  const desktopSession=await auth.login({identifier:account.username,password},'remote-integration');const primary=connect(desktopSession.accessToken,desktopId,'electron');await wait(primary,m=>m.type==='ready');
  const result=await login({username:account.username,password,device_id:browserId,browser_device_id:browserId,browser_device_name:'Chrome test',client_kind:'browser',login_type:'auric_remotecontrol'});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.success,true);assert.equal(result.data.device.device_type,'browser');assert.equal(result.data.approval_required,true);assert.ok(!JSON.stringify(result.data).includes('db_password'));assert.ok(!JSON.stringify(result.data).includes('file_key'));
  const browser=connect(result.data.tokens.access,browserId,'browser');await wait(browser,m=>m.type==='ready');const requested=await wait(primary,m=>m.type==='device.approval_requested');assert.equal(requested.device_id,result.data.device.id);
  browser.send(JSON.stringify({type:'rpc_request',action:'fetchAll',requestId:'unapproved'}));await wait(browser,m=>m.code==='approval_required');
  primary.send(JSON.stringify({type:'device.update_request',action:'approve',device_id:requested.device_id,permissions:{read:true,write:false,print:false}}));await wait(browser,m=>m.type==='device_approved');
  browser.send(JSON.stringify({type:'rpc_request',action:'fetchAll',args:[],requestId:'verified-read'}));const relayed=await wait(primary,m=>m.requestId==='verified-read');assert.equal(relayed.from_device_id,requested.device_id);
  primary.send(JSON.stringify({type:'rpc_response',target_device_id:requested.device_id,requestId:'verified-read',result:{verified:true},error:null}));assert.deepEqual((await wait(browser,m=>m.type==='rpc_response'&&m.requestId==='verified-read')).result,{verified:true});
  browser.send(JSON.stringify({type:'rpc_request',action:'insert',args:[],requestId:'denied-write'}));await wait(browser,m=>m.requestId==='denied-write'&&m.error?.includes('permission'));
  const wrong=await login({username:account.username,password:'incorrect',browser_device_id:browserId});assert.equal(wrong.status,401);
  primary.send(JSON.stringify({type:'device.update_request',action:'deny',device_id:requested.device_id}));await wait(browser,m=>m.type==='device_rejected');assert.equal((await login({username:account.username,password,browser_device_id:browserId})).status,403);
 }finally{for(const ws of sockets)ws.terminate();if(account){await db.query('DELETE FROM auth.admin_audit WHERE actor_id=$1',[account.id]);await db.query('DELETE FROM auth.users WHERE id=$1',[account.id]);}await db.onModuleDestroy();}
});
