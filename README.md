# KISMART Global Installment Management System

TypeScript backend for managing phone installment contracts, payments, warnings, device restrictions, reports, and audit logs.

## Run Locally

```powershell
cd "C:\Users\Volo\Documents\New project 2\system"
npm run start
```

Open:

```text
http://localhost:8787
```

The root page is a landing page. Click **Get Started** or open:

```text
http://localhost:8787/admin
```

Local demo admin credentials:

```text
admin@kismart.local / kismart-admin
```

Override these before sharing the system:

```powershell
$env:KISMART_ADMIN_EMAIL="admin@yourshop.co.ke"
$env:KISMART_ADMIN_PASSWORD="use-a-long-password"
$env:KISMART_SESSION_SECRET="use-a-long-random-session-secret"
```

## Persistence and Authentication

- Local fallback persistence is file-based JSON at `data/kismart-state.json`.
- Firestore persistence is supported through the Firebase Admin SDK.
- The admin dashboard is protected by an HttpOnly session cookie.
- Browser/admin APIs require an authenticated admin session.
- Android device policy, sync, and tamper APIs keep using `KISMART_DEVICE_SYNC_SECRET`.
- Mobile-money callbacks keep using `KISMART_CALLBACK_SECRET`.
- For production scale, use Firestore or another managed database and rotate all default secrets.

## Firestore Setup

The Firebase web app config is public browser configuration. This backend uses a Firebase Admin service account for secure Firestore reads and writes.

1. In Firebase Console, open **Project settings > Service accounts**.
2. Generate a new private key for project `kismart-456ee`.
3. Save the downloaded JSON file as:

```text
system/firebase-service-account.json
```

4. Create `system/.env` from `.env.example` and set:

```text
KISMART_STORAGE=firestore
FIREBASE_PROJECT_ID=kismart-456ee
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
KISMART_FIRESTORE_DATABASE=default
KISMART_FIRESTORE_SETTINGS_COLLECTION=settings
KISMART_FIRESTORE_SETTINGS_DOCUMENT=main
KISMART_FIRESTORE_CONTRACTS_COLLECTION=contracts
KISMART_FIRESTORE_INTAKES_COLLECTION=intakes
KISMART_FIRESTORE_NOTIFICATIONS_COLLECTION=notifications
KISMART_FIRESTORE_SYNC_EVENTS_COLLECTION=syncEvents
KISMART_FIRESTORE_DEVICE_EVENTS_COLLECTION=deviceEvents
KISMART_FIRESTORE_AUDIT_COLLECTION=audit
```

5. Restart:

```powershell
npm run start
```

Firestore storage uses top-level collections:

- `contracts`
- `intakes`
- `notifications`
- `syncEvents`
- `deviceEvents`
- `audit`
- `settings/main`

On first Firestore start, if these collections are empty, the backend migrates the existing local `data/kismart-state.json` state, the older single-document Firestore state, or the older nested `kismartApp/state` layout into these top-level collections automatically.

## Phone SMS Setup

The warning/reminder outbox can now send to the customer's actual phone number through SMS. Local mode stays simulated until a provider is configured.

### Option 1: Africa's Talking

```text
KISMART_SMS_PROVIDER=africas-talking
KISMART_SMS_DEFAULT_COUNTRY_CODE=254
KISMART_SMS_SENDER=KISMART
AFRICASTALKING_USERNAME=your_username
AFRICASTALKING_API_KEY=your_api_key
AFRICASTALKING_ENV=production
AFRICASTALKING_SENDER_ID=KISMART
```

### Option 2: Generic SMS Webhook

```text
KISMART_SMS_PROVIDER=webhook
KISMART_SMS_DEFAULT_COUNTRY_CODE=254
KISMART_SMS_SENDER=KISMART
KISMART_SMS_WEBHOOK_URL=https://your-sms-provider.example/send
KISMART_SMS_WEBHOOK_TOKEN=your_provider_token
```

Webhook mode sends this JSON payload:

```json
{
  "to": "+254700000000",
  "message": "KISMART Global: payment reminder...",
  "sender": "KISMART",
  "contractId": "KIS-1234",
  "customerName": "Customer Name",
  "noticeId": "NTC-...",
  "noticeType": "Payment reminder"
}
```

After changing SMS settings, restart the server and use **Operations > Dispatch Notices**.

## iOS / Apple MDM Setup

iOS does not run the Android APK. For real iPhone restriction/restore controls, the phone must be supervised and enrolled in Apple MDM. KISMART can queue Apple MDM commands locally and either simulate them or post them to your MDM provider webhook.

Local pilot mode:

```text
KISMART_IOS_MDM_PROVIDER=simulate
```

Generic MDM webhook mode:

```text
KISMART_IOS_MDM_PROVIDER=webhook
KISMART_IOS_MDM_WEBHOOK_URL=https://your-mdm-provider.example/kismart/commands
KISMART_IOS_MDM_WEBHOOK_TOKEN=your_mdm_webhook_token
```

Webhook mode sends JSON payloads containing `command`, `contractId`, `customerName`, `imei`, `serial`, `model`, `restriction`, and `message`. KISMART maps **Full lock** to an Apple MDM Lost Mode style command, **Limited access** to supervised restrictions, and **Restore** to disabling Lost Mode / clearing restrictions. After changing MDM settings, restart the server and use **Operations > Dispatch MDM**.

## Verification

```powershell
npm run check
npm run self-test
```

## Android Device Agent

The installable Android pilot APK is in:

```text
..\device-agent\dist\KismartDeviceAgent-debug.apk
```

Use it to test device policy sync, Device Admin activation, lock commands, restore commands, and tamper alerts against this backend.

`Limit` sends strict KISMART-only mode to the Android agent. In Android Device Owner mode the agent keeps KISMART available, disables risky settings paths, enters lock-task mode, and suspends other launchable user apps until **Restore**. The agent's in-app **Pay** button starts a **real M-Pesa STK Push** (Lipa Na M-Pesa Online) against your production PayBill. Payment is only applied after Safaricom posts the STK result callback. Fake STK (`/api/devices/:imei/stk-test`) is disabled unless `KISMART_ALLOW_FAKE_STK=true`.

### M-Pesa production (Daraja)

Set these on the production host (for example Vercel environment variables):

```text
KISMART_PAYBILL_ENABLED=true
KISMART_PAYBILL_BUSINESS_NUMBER=4749801
KISMART_PAYBILL_API_KEY=...
KISMART_PAYBILL_API_SECRET=...
KISMART_PAYBILL_PASSKEY=...
KISMART_PAYBILL_CALLBACK_URL=https://kismartsystem.vercel.app/api/payments/paybill-callback
KISMART_MPESA_API_BASE_URL=https://api.safaricom.co.ke
KISMART_ALLOW_FAKE_STK=false
```

Register the same callback URL in the Daraja app for STK result notifications. Use **production** host `https://api.safaricom.co.ke` (not sandbox).

Configured payment packages:

```text
KISMART_PAYMENT_APP_PACKAGES=com.safaricom.mpesa,com.safaricom.mpesa.lifestyle,ke.co.safaricom.mpesa
```

The payment package list is kept for normal payment launching outside strict KISMART-only mode. It is not allowlisted while `KISMART only` is active. STK Push does not require opening the M-Pesa app.

## Core APIs

- `GET /api/state` - dashboard state, contracts, reports, readiness, payments
- `GET /api/events` - live admin refresh events
- `POST /api/contracts` - create customer/device financing contract
- `DELETE /api/contracts/:id` - delete a contract after admin confirmation
- `DELETE /api/intakes/:id` - delete a pending customer intake after admin confirmation
- `POST /api/contracts/:id/payments` - record payment
- `POST /api/payments/mpesa-callback` - reconcile M-Pesa callback (also accepts native STK result payloads)
- `POST /api/payments/paybill-callback` - production STK + PayBill callback from Safaricom
- `POST /api/payments/airtel-callback` - reconcile Airtel Money callback
- `POST /api/contracts/:id/warnings` - queue warning notice
- `POST /api/contracts/:id/restrictions` - apply device restriction
- `DELETE /api/contracts/:id/restrictions?role=Admin` - restore device
- `POST /api/automation/run` - run reminders, warning escalation, restrictions, and restoration
- `POST /api/notifications/dispatch` - dispatch pending phone SMS notices or simulate them locally
- `POST /api/device-commands/dispatch` - dispatch pending Apple MDM commands or simulate them locally
- `GET /api/devices/:imei/policy` - return phone-side policy, balance, arrears, and restriction state
- `POST /api/devices/:imei/sync` - acknowledge pending device commands from the phone agent
- `POST /api/devices/:imei/paybill-stk` - start real M-Pesa STK Push for the bound device
- `POST /api/devices/:imei/tamper` - report device-agent tamper or app-removal attempts
- `GET /api/reports/summary` - portfolio metrics
- `GET /api/export/contracts.csv` - contract export

## Remote phone control (any network)

Phones must reach a **public HTTPS** control URL, not a laptop LAN IP. Configure:

```text
KISMART_PUBLIC_BASE_URL=https://kismartsystem.vercel.app
KISMART_STORAGE=firestore
KISMART_DEVICE_SYNC_SECRET=4321
KISMART_FIRESTORE_DATABASE=
```

Deploy this backend to that public host (Vercel is already wired via `api/index.js` + `vercel.json`). **Admin dashboard and phones must share the same Firestore data** so lock/restore commands issued in the dashboard are seen by phones on mobile data or other Wi-Fi. Ephemeral JSON on Vercel cannot do that.

Before remote lock works in production:

1. In Firebase Console for `kismart-456ee`, create a **Firestore Native** database (system default).
2. Set Vercel env vars: `KISMART_STORAGE=firestore`, `KISMART_DEVICE_SYNC_SECRET=4321`, `KISMART_PUBLIC_BASE_URL=https://kismartsystem.vercel.app`, plus Firebase credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or the bundled service-account file).
3. Confirm `GET /api/health` returns `"storage":"firestore"` and `"remoteReady":true`.
4. Install the latest agent APK; default backend URL is the public HTTPS host and secret is `4321`.

Health check:

```text
GET /api/health
```

Device identity: the first trusted sync binds the contract to the handset **Android ID**. Reinstalls on the same phone re-bind automatically without admin Reset ID. **Reset ID** is only for a different physical handset (or a rare factory reset that changes Android ID).

Admin **Restore** is sticky: automatic arrears limiting will not immediately re-lock the phone until admin applies Limit/Lock again (or arrears clear and later re-accumulate under automation rules).

## Production Notes

- Set `KISMART_CALLBACK_SECRET` before exposing mobile-money callback URLs publicly.
- Set `KISMART_DEVICE_SYNC_SECRET` before exposing device policy, sync, or tamper routes publicly.
- Set `KISMART_PUBLIC_BASE_URL` to the HTTPS origin phones should use from any network.
- Set `KISMART_ADMIN_PASSWORD` and `KISMART_SESSION_SECRET` before exposing the admin dashboard.
- Use Firestore security controls and keep service-account keys out of source control.
- Put the server behind HTTPS with a reverse proxy or cloud platform.
- Integrate SMS provider credentials for live reminders and warnings.
- Android restriction depth should use device-owner enrollment where policy allows.
- Android payment-only mode depends on Device Owner. Normal Device Admin can test locking, but cannot reliably block Settings, package control, USB debugging, or other apps.
- A normal Android APK cannot survive a physical factory reset. For reset-resilient production rollout, use Android zero-touch/EMM re-enrollment or an OEM/system-app image so the agent is restored after wipe.
- iOS restrictions require supervised Apple MDM enrollment and supported Apple policy controls.
- Keep emergency calling available where required by law and platform limitation.

## Current MVP Coverage

- Customer and device registration
- Deposit, daily, weekly, monthly, and custom schedule support
- Balance, arrears, next due date, and repayment status calculations
- M-Pesa and Airtel Money callback endpoints
- Warning stages before restriction
- Device command queue for Android restriction/restoration and Apple MDM command dispatch
- Device policy sync endpoint for Android agent / Apple MDM bridge pilots
- Tamper alert and command acknowledgement event logs
- Daily automation runner for reminders, warnings, restrictions, and paid-account restoration
- Pending notification dispatcher for phone SMS, webhook, and local simulation workflows
- Role-based permission checks for sensitive actions
- Administrator audit trail
- Branch performance and investor snapshot
