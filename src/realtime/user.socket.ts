import { Injectable, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Database } from '../database/database.service';
import type { AuthClient } from '../security/auth.client';

type DeviceSession = {
  authorization: string;
  userId: string;
  deviceId: string;
  signature: string;
  role: 'primary' | 'secondary';
  browser?: boolean;
  approved?: boolean;
};

type ClientMessage = {
  type?: unknown;
  token?: unknown;
  accessToken?: unknown;
  fingerprint?: unknown;
  deviceIdentitySignature?: unknown;
  targetDeviceId?: unknown;
  toDeviceId?: unknown;
  requestId?: unknown;
  action?: unknown;
  data?: unknown;
  payload?: unknown;
};

@Injectable()
export class UserSocket implements OnModuleDestroy {
  adminStats() {return {connections:this.server.clients.size,authenticated:this.sessions.size,primaryDevices:this.primaryByUserId.size,connectedDevices:this.socketByDeviceId.size};}
  // 64 KB max payload for relaying commands/invoices
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  private readonly alive = new Set<WebSocket>();
  private readonly sessions = new Map<WebSocket, DeviceSession>();

  // O(1) High-Speed Routing Indexes (Instant Hash Map Lookups for 10,000+ Connections)
  private readonly primaryByUserId = new Map<string, WebSocket>();
  private readonly secondariesByUserId = new Map<string, Set<WebSocket>>();
  private readonly socketByDeviceId = new Map<string, WebSocket>();

  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly auth: AuthClient, private readonly database: Database) {}

  attach(http: Server) {
    const maxClients = Number(process.env.AURIC_MAX_WS_CLIENTS ?? '10000');

    http.on('upgrade', (request, socket, head) => {
      const parsedUrl = new URL(request.url || '', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      if (pathname !== '/ws' && !pathname.startsWith('/ws/')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      if (this.server.clients.size >= maxClients) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => this.connect(client, request));
    });

    this.heartbeat = setInterval(() => {
      for (const client of this.server.clients) {
        if (!this.alive.delete(client)) {
          client.terminate();
          this.removeSession(client);
          continue;
        }
        client.ping();
        const session = this.sessions.get(client);
        if (session?.role === 'primary') {
          void this.validateDevice(client, session).catch(() => undefined);
        }
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  private connect(client: WebSocket, request?: IncomingMessage) {
    let requests = 0;
    let windowStart = Date.now();
    const authTimeout = setTimeout(() => client.close(1008, 'Authentication required'), 10_000);
    this.alive.add(client);

    client.on('pong', () => this.alive.add(client));
    client.on('error', () => client.terminate());
    client.on('close', () => {
      clearTimeout(authTimeout);
      this.alive.delete(client);
      this.removeSession(client);
    });

    // Extract handshake parameters (URL query params & subprotocol auth header)
    let initialToken: string | undefined;
    let initialSignature: string | undefined;
    let initialClientKind: string | undefined;

    if (request?.url) {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        initialToken = url.searchParams.get('token') || url.searchParams.get('accessToken') || undefined;
        initialSignature = url.searchParams.get('hardware_id') || url.searchParams.get('device_id') || url.searchParams.get('fingerprint') || undefined;
        initialClientKind = url.searchParams.get('client_kind') || url.searchParams.get('clientKind') || undefined;
      } catch {}
    }

    if (!initialToken && request?.headers['sec-websocket-protocol']) {
      const protocols = String(request.headers['sec-websocket-protocol']).split(',').map((p) => p.trim());
      const authProto = protocols.find((p) => p.startsWith('auth.'));
      if (authProto) {
        initialToken = authProto.slice(5);
      }
    }

    // Proactively authorize device if token and signature were supplied in handshake
    if (initialToken && initialSignature) {
      void (async () => {
        try {
          const connected = await this.authorizeDevice(client, initialToken, initialSignature, initialClientKind);
          if (connected) {
            clearTimeout(authTimeout);
            this.send(client, {
              type: 'ready',
              deviceId: connected.deviceId,
              deviceRole: connected.role,
            });

            if (connected.role === 'secondary'&&!connected.browser) {
              const primarySocket = this.findPrimarySocket(connected.userId);
              if (primarySocket) {
                this.send(primarySocket, {
                  type: 'secondary_connected',
                  deviceId: connected.deviceId,
                });
              }
            }
          }
        } catch {
          // Handshake auth will fall through to message-based auth or authTimeout
        }
      })();
    }

    client.on('message', async (raw, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;

      // Rate limit per socket: max 120 messages per minute
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        requests = 0;
      }
      if (++requests > 120) {
        this.closeSession(client, 'Too many requests');
        return;
      }

      if (binary) {
        client.close(1003, 'JSON text required');
        this.removeSession(client);
        return;
      }

      let message: ClientMessage | null;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.send(client, { type: 'error', code: 'invalid_json' });
        return;
      }

      const session = this.sessions.get(client);
      const requestId = typeof message?.requestId === 'string' && message.requestId.length <= 64
        ? message.requestId : undefined;

      try {
        // --- 1. Authentication Phase ---
        if (!session) {
          const token = typeof message?.token === 'string'
            ? message.token
            : (typeof message?.accessToken === 'string' ? message.accessToken : null);
          const signature = typeof message?.fingerprint === 'string'
            ? message.fingerprint
            : (typeof message?.deviceIdentitySignature === 'string' ? message.deviceIdentitySignature : null);

          if (message?.type !== 'auth' || !token) {
            this.closeSession(client, 'Authentication required');
            return;
          }

          const connected = await this.authorizeDevice(client, token, signature,initialClientKind);
          if (connected) {
            clearTimeout(authTimeout);
            this.send(client, {
              type: 'ready',
              deviceId: connected.deviceId,
              deviceRole: connected.role,
            });

            // Notify primary device if a secondary device connected (O(1) lookup)
            if (connected.role === 'secondary'&&!connected.browser) {
              const primarySocket = this.findPrimarySocket(connected.userId);
              if (primarySocket) {
                this.send(primarySocket, {
                  type: 'secondary_connected',
                  deviceId: connected.deviceId,
                });
              }
            }
          }
          return;
        }

        if(message?.type==='device.update_request'||message?.type==='device.delete_request'){
          if(session.role!=='primary'||session.browser||!await this.validateDevice(client,session)){this.send(client,{type:'error',code:'primary_required'});return;}
          await this.updateBrowserDevice(session,message,client);return;
        }
        if(session.browser){
          if(!['rpc_request','device.list_request'].includes(String(message?.type))){this.send(client,{type:'error',requestId,code:'unsupported_remote_message'});return;}
          const record=await this.browserDevice(session.userId,session.signature);
          await this.auth.currentUser(session.authorization);
          if(!session.approved||record?.approval_status!=='approved'){this.send(client,{type:'error',requestId,code:'approval_required',message:'Wait for approval on the main Electron device.'});return;}
          if(message?.type==='rpc_request'){
            const rpc=message as any;const name=rpc.action==='invoke'&&Array.isArray(rpc.args)?String(rpc.args[0]):String(rpc.action??'');
            const permission=/print/i.test(name)?record.can_print:/^(get|fetch|list|read|load|check|search|count|query|select|is|has|resolve|subscription[:_-]|ui-state:get|settings:get)/i.test(name)?record.can_read:record.can_write;
            if(!permission){this.send(client,{type:'rpc_response',requestId,error:'This device does not have permission for this action.',result:null});return;}
          }
        }
        // --- 2. Live Device List Request ---
        if (message?.type === 'device.list_request') {
          const { devices } = await this.database.getDevices(session.userId);
          const mappedDevices = devices.map((d: any) => ({
            device_id: d.id,
            device_name: d.displayName,
            client_kind: d.deviceType === 'electron' ? 'electron' : 'browser',
            device_type: d.deviceType,
            is_primary: d.deviceRole === 'primary',
            approval_status: d.approvalStatus,
            is_online: this.socketByDeviceId.has(d.id),
            is_active: d.approvalStatus === 'approved',
            permissions: {
              read: d.canRead,
              write: d.canWrite,
              print: d.canPrint,
            },
            last_seen_at: d.lastSeenAt,
          }));
          this.send(client, {
            type: 'device.list_response',
            devices: mappedDevices,
          });
          return;
        }

        // --- 3. O(1) Instant Device Relay Phase ---
        const payloadData = message?.data !== undefined ? message.data : message?.payload;
        const action = typeof message?.action === 'string' ? message.action : undefined;
        const targetDeviceId = typeof message?.targetDeviceId === 'string'
          ? message.targetDeviceId
          : (typeof message?.toDeviceId === 'string'
              ? message.toDeviceId
              : (typeof (message as any)?.target_device_id === 'string'
                  ? (message as any).target_device_id
                  : undefined));

        // A) Secondary Device sends trigger/data/RPC -> O(1) forward directly to Primary
        if (session.role === 'secondary') {
          const primarySocket = this.findPrimarySocket(session.userId);
          if (!primarySocket) {
            this.send(client, {
              type: 'error',
              code: 'primary_offline',
              message: 'Primary device is not connected',
              requestId,
            });
            return;
          }

          this.send(primarySocket, {
            ...message,
            fromDeviceId: session.deviceId,
            from_device_id: session.deviceId,
          });
          return;
        }

        // B) Primary Device sends data -> O(1) forward to target Secondary or broadcast to all
        if (session.role === 'primary') {
          const isBroadcast = message?.type === 'broadcast' || !targetDeviceId;

          if (isBroadcast) {
            // Broadcast to ALL secondary devices of this account (O(1) Set access)
            const secondaries = this.findAllSecondarySockets(session.userId);
            for (const secSocket of secondaries) {
              this.send(secSocket, {
                ...message,
                fromDeviceId: session.deviceId,
                from_device_id: session.deviceId,
              });
            }
            return;
          }

          // Direct message to a specific secondary device (O(1) Map lookup)
          const targetSocket = this.findSecondarySocket(session.userId, targetDeviceId);
          if (!targetSocket||this.sessions.get(targetSocket)?.approved===false) {
            this.send(client, {
              type: 'error',
              code: 'target_offline',
              message: 'Target secondary device is offline',
              requestId,
            });
            return;
          }

          if (message) {
            this.send(targetSocket, message);
          }
          return;
        }
      } catch (error) {
        if (error instanceof UnauthorizedException) this.closeSession(client, 'Invalid or expired session');
        else if (!session) client.close(1013, 'Auth or device service unavailable');
        else this.send(client, { type: 'error', requestId, code: 'relay_failed' });
      }
    });
  }

  private async authorizeDevice(client: WebSocket, token: string, signature: unknown, clientKind?: string) {
    if (typeof signature !== 'string' || !signature.trim() || Buffer.byteLength(signature) > 1024) {
      this.closeSession(client, 'Device fingerprint is required');
      return;
    }
    const authorization = `Bearer ${token}`;
    const user = await this.auth.currentUser(authorization);
    const browser=await this.browserDevice(user.id,signature);
    if(clientKind==='browser'||browser){
      const hasRemote = await this.database.hasRemoteAccess(user.id);
      if (!hasRemote) {
        this.send(client, {
          type: 'connection_closed',
          code: 'remote_not_subscribed',
          message: 'Remote device service is not included in your active subscription plan. Please upgrade your plan to enable remote access.',
        });
        client.close(4003, 'Remote subscription required');
        return;
      }
      if(!browser||browser.device_role!=='secondary'||['rejected','revoked'].includes(browser.approval_status)){this.closeSession(client,'Browser device is not permitted');return;}
      if(!await this.hasActivePrimary(user.id)){this.send(client,{type:'connection_closed',message:'Primary desktop device is offline. Open Auric on the main computer first.'});client.close(4003,'Primary desktop is offline');return;}
      const previous=this.socketByDeviceId.get(browser.id);if(previous&&previous!==client)this.closeSession(previous,'Browser session was replaced');
      const session:DeviceSession={authorization,signature,userId:user.id,deviceId:browser.id,role:'secondary',browser:true,approved:browser.approval_status==='approved'};
      this.sessions.set(client,session);this.socketByDeviceId.set(browser.id,client);
      let set=this.secondariesByUserId.get(user.id);if(!set){set=new Set();this.secondariesByUserId.set(user.id,set);}set.add(client);
      if(session.approved)this.send(client,{type:'device_approved',device_id:browser.id,permissions:{read:browser.can_read,write:browser.can_write,print:browser.can_print}});
      else {const primary=this.findPrimarySocket(user.id);if(primary)this.send(primary,{type:'device.approval_requested',device_id:browser.id,from_device_id:browser.id,device_fingerprint:signature,device_name:browser.display_name||'Browser',from_device_name:browser.display_name||'Browser',permissions:{read:true,write:false,print:false}});else this.closeSession(client,'Primary desktop is offline');}
      return session;
    }
    const device = await this.database.getApprovedDevice(user.id, signature);
    if (!device) {
      this.closeSession(client, 'Device is not approved');
      return;
    }

    let role = device.role;
    if (role === 'secondary') {
      const hasRemote = await this.database.hasRemoteAccess(user.id);
      const hasPrimary = await this.hasActivePrimary(user.id);
      if (!hasPrimary) {
        if (clientKind === 'electron') {
          role = 'primary';
        } else {
          this.closeSession(client, 'Primary device is offline');
          return;
        }
      } else if (!hasRemote) {
        this.send(client, {
          type: 'connection_closed',
          code: 'remote_not_subscribed',
          message: 'Remote secondary device access is not included in your active subscription plan. Please upgrade your plan to enable remote devices.',
        });
        client.close(4003, 'Remote subscription required');
        return;
      }
    }
    if (client.readyState !== WebSocket.OPEN) return;

    const session: DeviceSession = {
      authorization, signature, userId: user.id, deviceId: device.id, role,
    };

    // Register in primary session map and O(1) hash indexes
    this.sessions.set(client, session);
    this.socketByDeviceId.set(session.deviceId, client);

    if (session.role === 'primary') {
      this.primaryByUserId.set(session.userId, client);
    } else {
      let secSet = this.secondariesByUserId.get(session.userId);
      if (!secSet) {
        secSet = new Set();
        this.secondariesByUserId.set(session.userId, secSet);
      }
      secSet.add(client);
    }

    return session;
  }
  private async browserDevice(userId:string,signature:string){return (await this.database.query("SELECT id,device_role,approval_status,display_name,can_read,can_write,can_print FROM auric.devices WHERE user_id=$1 AND device_identity_signature=$2 AND device_type='browser'",[userId,signature])).rows[0];}
  private async updateBrowserDevice(session:DeviceSession,message:any,primary:WebSocket){
    const action=message.type==='device.delete_request'?'disconnect':message.action;
    if(!['approve','deny','disconnect','unblock','disconnect_all',undefined].includes(action)){this.send(primary,{type:'error',code:'invalid_device_action'});return;}
    const id=message.device_id;
    if(action!=='disconnect_all'&&(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))){this.send(primary,{type:'error',code:'invalid_device_id'});return;}
    const permissions=message.permissions;
    if(permissions&&(['read','write','print'].some(key=>permissions[key]!==undefined&&typeof permissions[key]!=='boolean'))){this.send(primary,{type:'error',code:'invalid_permissions'});return;}
    const {rows}=await this.database.query(`UPDATE auric.devices SET approval_status=CASE WHEN $3 IN ('approve','unblock') THEN 'approved' WHEN $3='deny' THEN 'rejected' WHEN $3 IN ('disconnect','disconnect_all') THEN 'pending' ELSE approval_status END,can_read=COALESCE($4,can_read),can_write=COALESCE($5,can_write),can_print=COALESCE($6,can_print),last_seen_at=now() WHERE user_id=$1 AND device_type='browser' AND device_role='secondary' AND ($3='disconnect_all' OR id=$2::uuid) RETURNING id,approval_status,can_read,can_write,can_print`,[session.userId,action==='disconnect_all'?null:id,action??null,permissions?.read??null,permissions?.write??null,permissions?.print??null]);
    for(const row of rows){const socket=this.findSecondarySocket(session.userId,row.id);if(!socket)continue;const connected=this.sessions.get(socket);if(row.approval_status==='approved'){if(connected)connected.approved=true;this.send(socket,{type:'device_approved',device_id:row.id,permissions:{read:row.can_read,write:row.can_write,print:row.can_print}});}else{this.send(socket,{type:'device_rejected',message:typeof message.reason==='string'?message.reason.slice(0,200):'Remote access was denied or disconnected by the main device.'});this.closeSession(socket,'Remote access was denied or disconnected');}}
    this.send(primary,{type:'device.list_updated'});
  }

  private async validateDevice(client: WebSocket, session: DeviceSession) {
    try {
      const user = await this.auth.currentUser(session.authorization);
      const device = await this.database.getApprovedDevice(user.id, session.signature);
      if (user.id !== session.userId || device?.id !== session.deviceId || device.role !== session.role) {
        this.closeSession(client, 'Device is not approved or its role changed');
        return;
      }
      if (client.readyState === WebSocket.OPEN && this.sessions.get(client) === session) return user;
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      this.closeSession(client, 'Invalid or expired session');
    }
  }

  private async hasActivePrimary(userId: string) {
    const primarySocket = this.findPrimarySocket(userId);
    if (!primarySocket) return false;
    const session = this.sessions.get(primarySocket);
    if (!session) return false;
    return (await this.validateDevice(primarySocket, session)) !== undefined;
  }

  // O(1) Instant Lookup - Zero Loops
  private findPrimarySocket(userId: string): WebSocket | undefined {
    const socket = this.primaryByUserId.get(userId);
    return socket && socket.readyState === WebSocket.OPEN ? socket : undefined;
  }

  // O(1) Instant Lookup - Zero Loops
  private findSecondarySocket(userId: string, deviceId: string): WebSocket | undefined {
    const socket = this.socketByDeviceId.get(deviceId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      const session = this.sessions.get(socket);
      if (session?.userId === userId && session.role === 'secondary') return socket;
    }
    return undefined;
  }

  // O(1) Access to User's Specific Secondaries Set
  private findAllSecondarySockets(userId: string): WebSocket[] {
    const set = this.secondariesByUserId.get(userId);
    if (!set) return [];
    return [...set].filter((s) => s.readyState === WebSocket.OPEN&&this.sessions.get(s)?.approved!==false);
  }

  public notifyUser(userId: string, message: any): void {
    const primary = this.findPrimarySocket(userId);
    if (primary && primary.readyState === WebSocket.OPEN) {
      this.send(primary, message);
    }
    const secondaries = this.findAllSecondarySockets(userId);
    for (const sec of secondaries) {
      if (sec.readyState === WebSocket.OPEN) {
        this.send(sec, message);
      }
    }
  }

  private closeSession(client: WebSocket, reason: string) {
    client.close(1008, reason);
    this.removeSession(client);
  }

  private removeSession(client: WebSocket) {
    const ended = this.sessions.get(client);
    this.sessions.delete(client);
    if (!ended) return;

    this.socketByDeviceId.delete(ended.deviceId);

    // If Primary disconnected -> clean up and close all secondaries for this user
    if (ended.role === 'primary') {
      if (this.primaryByUserId.get(ended.userId) === client) {
        this.primaryByUserId.delete(ended.userId);
      }
      const secondaries = this.secondariesByUserId.get(ended.userId);
      if (secondaries) {
        this.secondariesByUserId.delete(ended.userId);
        for (const secSocket of secondaries) {
          this.closeSession(secSocket, 'Primary device is offline');
        }
      }
      return;
    }

    // If Secondary disconnected -> remove from set and notify primary (O(1))
    if (ended.role === 'secondary') {
      const secSet = this.secondariesByUserId.get(ended.userId);
      if (secSet) {
        secSet.delete(client);
        if (secSet.size === 0) this.secondariesByUserId.delete(ended.userId);
      }
      const primarySocket = this.findPrimarySocket(ended.userId);
      if (primarySocket) {
        this.send(primarySocket, {
          type: 'secondary_disconnected',
          deviceId: ended.deviceId,
        });
      }
    }
  }

  private send(client: WebSocket, message: object) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1_048_576) {
      client.terminate();
      return;
    }
    client.send(JSON.stringify(message));
  }

  onModuleDestroy() {
    clearInterval(this.heartbeat);
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
