# Auric

Auric runs on NestJS 11 and Node.js 22. It shares the database used by the
Auth stack in the sibling `API` directory, with its own `auric` schema and
restricted `auric_app` credentials.

Start Docker Desktop and bring up the Auth stack. Start Auric with these
commands from PowerShell in this directory:

```powershell
docker compose up --build --wait
Invoke-RestMethod http://127.0.0.1:3001/health
```

The local `.env` holds the password for the provisioned `auric_app` role.
The health endpoint returns
`{"status":"ok","database":"up"}` after the service connects with its own
credentials. Set `AURIC_PORT` in `.env` to change the host port. If the Auth
stack uses a database name other than `app`, set `AURIC_PG_DATABASE` to that name.

Devices and subscriptions require an existing Auth user. Deleting that user
removes their devices. Subscription history blocks hard deletion, so disable
the account and handle billing separately. Payments reference their
subscription, and repeated provider payment IDs cannot create duplicate
records. Auric payments are INR only. The `amount_minor` column stores whole
paise, so a payment of ₹499.50 is stored as `49950`. Payment integrations must
reject other currencies before writing to this table.

Sign in with Auth, then call Auric with the access token:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/subscription/status -Headers @{ Authorization = "Bearer $accessToken" }
```

Auric validates the token with Auth on every request and scopes the result to
the authenticated user.

| Endpoint | Response |
| --- | --- |
| `GET /profile` | User details and their shop profile, or `null` for a missing shop profile. |
| `GET /devices` | The user's devices, type (`electron` or `browser`), role (`primary` or `secondary`), and approval status. Permissions are false until a device is approved. |
| `GET /subscription/status` | `active` with the user's current subscriptions and plan modules, or `inactive` with an empty list. |
| `GET /payments` | Up to 20 recent payments, with amounts as strings in whole paise. |
| `POST /updates/register` | Register a new Electron app version release with block map, channel (`stable`, `beta`, `alpha`), windows version (`win10_11`, `win7`), checksum, and `pushedBy` attribution. (Requires Auth Bearer token). |
| `GET /updates/versions` | List releases with optional filters (`channel`, `windows_version`, `is_latest`, `limit`, `offset`). (Requires Auth Bearer token). |
| `GET /updates/latest.yml` | Public auto-updater manifest feed for `stable` channel (with `blockMapSize` for differential updates). |
| `GET /updates/beta.yml` | Public auto-updater manifest feed for `beta` channel. |
| `GET /updates/alpha.yml` | Public auto-updater manifest feed for `alpha` channel. |
| `GET /updates/:channel/latest.yml` | Public auto-updater feed route supporting `/updates/stable/latest.yml`, `/updates/beta/latest.yml`, and `/updates/alpha/latest.yml`. |
| `GET /updates/status` | Public overview of active versions across all 3 channels and platforms. |

Credentials and tokens are excluded from responses.
The device identity signature is also excluded from device listings. New
devices default to `secondary`, and each account can have one `primary` device.

For a direct connection from the app to Auric, open
`ws://127.0.0.1:3001/ws` locally and send this JSON as the first message:

```json
{"type":"auth","token":"<Auth access token>","fingerprint":"<device fingerprint>"}
```

(The legacy `"accessToken"` and `"deviceIdentitySignature"` fields are also accepted for backward compatibility.)

Only approved devices for the signed-in account can connect. The primary
device connects first. A secondary can connect while that account's primary
is online and is disconnected when the last primary socket goes offline.

Once authenticated, the server returns:
```json
{"type":"ready","deviceId":"<device-uuid>","deviceRole":"primary"}
```

### Device-to-Device Relay Bridge

The WebSocket acts as a real-time bridge between the Primary device (e.g. main POS/counter) and Secondary devices (tablets/remote stations). It does not serve database reads directly (use the HTTP REST API for `/profile`, `/devices`, etc.).

1. **Secondary Device sends request/trigger to Primary:**
```json
{
  "action": "create_order",
  "requestId": "req-1",
  "data": { "itemCode": "GOLD-RING-01", "qty": 1 }
}
```
Auric forwards this directly to the Primary device:
```json
{
  "type": "secondary_message",
  "fromDeviceId": "<secondary-device-uuid>",
  "requestId": "req-1",
  "action": "create_order",
  "data": { "itemCode": "GOLD-RING-01", "qty": 1 }
}
```

2. **Primary Device responds or pushes data to Secondary:**
```json
{
  "targetDeviceId": "<secondary-device-uuid>",
  "requestId": "req-1",
  "action": "order_confirmed",
  "data": { "orderId": "ORD-9876", "totalPaise": 4500000 }
}
```
*(Omit `"targetDeviceId"` to broadcast the message to all connected secondary devices for this account).*

Auric forwards this directly to the secondary device:
```json
{
  "type": "primary_message",
  "fromDeviceId": "<primary-device-uuid>",
  "requestId": "req-1",
  "action": "order_confirmed",
  "data": { "orderId": "ORD-9876", "totalPaise": 4500000 }
}
```

Run `docker compose up --build --wait` to rebuild after changing the source.
Run `docker compose down` to stop Auric. Stop Auric before taking down the
full Auth Compose stack because Auric uses its network to reach PostgreSQL.
## Support request management

The support server matches the existing desktop files `Reactgui/src/lib/support-request.ts` and `components/TOPBAR/support-dialog.tsx`; no desktop source changes are required to submit reports. The Electron `serverPost` bridge already attaches the Auth bearer token to these calls.

| Method and path | Purpose |
| --- | --- |
| `POST /api/support/requests/` | Submit a support request with category `bug`, `help`, or `feedback`. Returns `{success, request_id, message, duplicate}`. |
| `POST /api/support/request/` | Compatible fallback alias; identical submissions by the same account within 60 seconds return the existing ID. |
| `POST /api/support/error-report/` | Submit the existing “Send to admin” error payload (`title`, `description`, `variant`, `context`, `appContext`). Returns `report_id`. |
| `GET /api/support/requests` | List the authenticated customer's requests only. Supports pagination and queue filters. |
| `GET /api/support/requests/:id` | Customer-visible details and public replies. Internal notes, admin history and diagnostics are excluded. |
| `POST /api/support/requests/:id/replies` | Add a customer reply. Replies reopen waiting/resolved requests. Closed requests require a new report. |
| `GET /admin/support/requests` | Admin queue; filters: `status`, `category`, `priority`, `kind`, `userId`, `search`, `limit`, `offset`. |
| `GET /admin/support/summary` | Counts by status, including client error reports. |
| `GET /admin/support/assignees` | Active administrators available for assignment. |
| `GET /admin/support/requests/:id` | Full report, sanitized diagnostics, public/internal messages and history. |
| `GET /admin/support/requests/:id/screenshot` | Authenticated screenshot as `{mimeType,data}` with base64 raster bytes. |
| `PATCH /admin/support/requests/:id` | Change `status`, `priority`, or `assigneeId` (`null` unassigns). Requires the current numeric `version`; stale edits return 409. |
| `POST /admin/support/requests/:id/replies` | Add `{message,visibility}`, where visibility is `public` or `internal`. |

Statuses: `open`, `in_progress`, `waiting_customer`, `resolved`, `closed`. Priorities: `low`, `normal`, `high`, `urgent`. Changes and replies increment the version atomically and append ticket history; administrative writes also use the existing audit trail. Assignees must be active Auth administrators. A payload's `user` field never controls ownership: identity comes from the bearer token.

Open the admin panel's **Auric → Support requests** queue at `http://127.0.0.1:3100/#support`. The current panel source is `D:\UI\Admin`. Reports and errors appear together with searchable status/category/type filters, assignment, conversation, diagnostics and history. The queue refreshes every 15 seconds.

The existing desktop support dialog submits reports only. Public replies are stored and readable through the customer API; this implementation does not add a desktop conversation inbox, email delivery or reply notifications.

Support JSON bodies allow up to 8 MiB; other Auric JSON routes allow 256 KiB. Individual messages allow 12,000 characters, subjects 200 characters, screenshots 4 MiB (PNG/JPEG raster signatures only), and diagnostics up to 100 entries per log array with a 256 KiB budget per array. Screenshot/log opt-outs discard those fields even if sent. Common credential patterns in diagnostics are redacted recursively before persistence; screenshots and free-form customer messages can still contain business data. Screenshots are stored as PostgreSQL `bytea`, not in Cove. Restrict database/backup access and set a retention policy appropriate to support data. Tickets have no public or admin permanent-delete endpoint.

Submission limits are 10 support requests or 30 client-error reports per account per 15 minutes; replies are limited to 30 per account per 15 minutes, in addition to the existing API limits. Repeated identical content is deduplicated for 60 seconds, including the desktop fallback alias. This prevents immediate retry duplication; it is not indefinite idempotency.

`011_auric_support_requests` is an additive migration with request, message and event tables. `node scripts/deploy-support.cjs` backs up PostgreSQL, builds Auric, applies this migration and recreates only Auric with a health check. Auth/PostgreSQL must already be running. The host script reads existing Auth database settings in memory; it does not change database passwords, encryption keys or stored customer files. Database backups are placed under the current admin panel's `.runtime/backups` folder (with the original `Servers/Admin` location as fallback).

Run `npm test` for validation checks. For the full server workflow, set `AURIC_SUPPORT_INTEGRATION=1`; additionally set `AURIC_SUPPORT_GATEWAY=1` to verify the live admin proxy and CSRF checks. Integration checks create and remove their own disposable accounts/reports and do not edit existing customer tickets.
