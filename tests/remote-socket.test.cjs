require('reflect-metadata');
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {WebSocket}=require('ws'),{UserSocket}=require('../dist/realtime/user.socket');
const ids={host:'11111111-1111-4111-8111-111111111111',browser:'22222222-2222-4222-8222-222222222222',other:'33333333-3333-4333-8333-333333333333'};
test('remote browser waits for same-account primary approval and then relays permitted RPC',{timeout:15000},async()=>{
 const records=[{id:ids.host,user_id:'owner',signature:'desktop',type:'electron',device_role:'primary',approval_status:'approved'},{id:ids.browser,user_id:'owner',signature:'browser',type:'browser',device_role:'secondary',approval_status:'pending',display_name:'Chrome',can_read:false,can_write:false,can_print:false},{id:ids.other,user_id:'other',signature:'other-desktop',type:'electron',device_role:'primary',approval_status:'approved'}];
 const auth={currentUser:async bearer=>({id:bearer.includes('other-token')?'other':'owner'})};
 const db={query:async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:records.filter(r=>r.user_id===args[0]&&r.signature===args[1]&&r.type==='browser')};if(sql.startsWith('UPDATE')){const rows=records.filter(r=>r.user_id===args[0]&&r.type==='browser'&&(r.id===args[1]||args[2]==='disconnect_all'));for(const r of rows){r.approval_status=['approve','unblock'].includes(args[2])?'approved':args[2]==='deny'?'rejected':['disconnect','disconnect_all'].includes(args[2])?'pending':r.approval_status;['can_read','can_write','can_print'].forEach((k,i)=>{if(args[i+3]!==null)r[k]=args[i+3];});}return {rows};}throw Error('Unexpected query');},getApprovedDevice:async(user,signature)=>{const r=records.find(r=>r.user_id===user&&r.signature===signature&&r.approval_status==='approved');return r?{id:r.id,role:r.device_role}:undefined;},getDevices:async()=>({devices:[]})};
 const gateway=new UserSocket(auth,db),server=http.createServer();gateway.attach(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const sockets=[];
 const connect=(signature,kind,token='owner-token')=>{const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/remote?${new URLSearchParams({device_id:signature,client_kind:kind,token})}`);socket.messages=[];socket.on('message',raw=>socket.messages.push(JSON.parse(raw)));sockets.push(socket);return socket;};
 const wait=async(socket,predicate)=>{for(let i=0;i<250;i++){const found=socket.messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,10));}throw Error('Expected WebSocket message not received');};
 try{
  const host=connect('desktop','electron');await wait(host,m=>m.type==='ready');const other=connect('other-desktop','electron','other-token');await wait(other,m=>m.type==='ready');
  const browser=connect('browser','browser');await wait(browser,m=>m.type==='ready');await wait(host,m=>m.type==='device.approval_requested');
  browser.send(JSON.stringify({type:'rpc_request',action:'fetchAll',requestId:'pending'}));await wait(browser,m=>m.code==='approval_required');assert.ok(!host.messages.some(m=>m.requestId==='pending'));
  host.send(JSON.stringify({type:'broadcast',secret:'must-not-reach-pending'}));await new Promise(r=>setTimeout(r,30));assert.ok(!browser.messages.some(m=>m.secret==='must-not-reach-pending'));
  other.send(JSON.stringify({type:'device.update_request',action:'approve',device_id:ids.browser,permissions:{read:true}}));await new Promise(r=>setTimeout(r,30));assert.equal(records[1].approval_status,'pending');
  host.send(JSON.stringify({type:'device.update_request',action:'approve',device_id:ids.browser,permissions:{read:true,write:false,print:false}}));await wait(browser,m=>m.type==='device_approved');
  browser.send(JSON.stringify({type:'rpc_request',action:'fetchAll',args:[],requestId:'read'}));const relayed=await wait(host,m=>m.requestId==='read');assert.equal(relayed.from_device_id,ids.browser);
  host.send(JSON.stringify({type:'rpc_response',target_device_id:ids.browser,requestId:'read',result:[{ok:true}]}));await wait(browser,m=>m.type==='rpc_response'&&m.requestId==='read');
  browser.send(JSON.stringify({type:'rpc_request',action:'insert',requestId:'write'}));await wait(browser,m=>m.requestId==='write'&&m.error?.includes('permission'));assert.ok(!host.messages.some(m=>m.requestId==='write'));
  host.send(JSON.stringify({type:'device.update_request',action:'disconnect_all'}));await wait(browser,m=>m.type==='device_rejected');assert.equal(records[1].approval_status,'pending');
 }finally{for(const socket of sockets)socket.terminate();gateway.onModuleDestroy();await new Promise(resolve=>server.close(resolve));}
});
