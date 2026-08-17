# M-Pesa STK re-lock bug — root cause, fix, verification

Project: KISMART installment system (`system/server.ts`, Vercel + Firestore `kismart-456ee` / named DB `default`)
Deployed: https://kismartsystem.vercel.app (production, deployment ready)

---

## 1. What caused the re-lock

The phone agent polls the policy endpoint **every ~3 seconds** (`LockActivity.RESTORE_CHECK_MS = 3000`). The bug was never the unlock moment — it was that **read/status paths wrote the lock state back**.

Concretely, after a successful STK callback unlocked the device, one of these fired within seconds:

1. **Device policy pull / device sync** (`GET /api/devices/{imei}/policy`, `POST /api/devices/{imei}/sync`) called `applyAutomaticPaymentControls()`, which **writes** `restriction = "Limited access"` to Firestore. If that request ran on a snapshot that did not yet contain the just-recorded payment (Firestore is eventually consistent; Vercel runs multiple instances), it re-applied the limit and saved a whole stale state doc — **overwriting the callback's unlock**.
2. The **60-second scheduled loop** (`runAutomaticPaymentControlPass`) and the **dashboard poll** (`GET /api/state`) ran the same writer on stale snapshots.
3. `reconcilePendingStkPayments()` — the Daraja STK status-query path — was a **second writer of payment state** (`recordConfirmedStkPayment(..., source: "query")`), racing the callback with different snapshots.
4. There was **no idempotency record** keyed to `CheckoutRequestID`. Duplicate/retried Safaricom callbacks and the query path could re-run `applyAutomaticPaymentControls`, and a lost-update race meant the **last stale writer won** — the device locked again seconds later and stayed locked.

The dashboard "deleted phone still shows" bug has the same shape: `loadFirestoreState()` **unioned the local `data/kismart-state.json` into the Firestore state**, so a contract deleted from Firestore was resurrected by the JSON copy on every load — and re-written back to Firestore on the next save. Live check confirmed KIS-5452 still existed in both the Firestore state doc and the `contacts` collection.

---

## 2. Every change made

### `system/server.ts`

**A. Callback is now the ONLY writer of payment/unlock state (idempotent + atomic)**

- **STK initiation** (`/api/devices/{imei}/paybill-stk`): writes `payments/{CheckoutRequestID}` = `{ status: "pending", contractId, imei, amount, phoneNumber, ... }` when the STK push is accepted.
- **`handleMpesaStkCallback`**:
  - **Guard at the top**: reads `payments/{CheckoutRequestID}`. If `status` is **not `"pending"`** → ACK `ResultCode 0` and return, doing nothing else (duplicate/retried Safaricom callbacks can never re-apply or overwrite).
  - Contract is resolved from the payment doc's `contractId` (authoritative), falling back to the legacy Checkout/MerchantID lookup only for checkouts initiated before this change.
  - **Failure**: one-directional `pending -> failed | cancelled` via a Firestore transaction with a "pending" precondition — a late failure callback can never downgrade a confirmed `success`.
  - **Success (atomic)**: one Firestore transaction with the "pending" precondition that (a) updates the payment doc to `success` (`mpesaReceipt`, `amount`, `confirmedAt`, ...) and (b) sets `devices/{contractId}` to `{ unlocked: true, unlockedAt, mpesaReceipt, amountPaid, contractId, imei, customerName }` via **targeted `set(..., { merge: true })`** — never a full-doc write, so defaults can't be reset. If the transaction returns "already confirmed", the callback ACKs and writes nothing else.
- The in-memory payment record + restore happens only after the transaction confirms.

**B. All stale-state writers neutralized**

- Removed `applyAutomaticPaymentControls()` (and its `saveState`) from: `GET /api/state` (now a **pure read**), `GET /api/devices/{imei}/policy`, `POST /api/devices/{imei}/sync`, and all **duplicate-callback branches** (manual payment, M-Pesa/Airtel callback, PayBill callback, STK internal duplicates) — duplicates now ACK and write nothing.
- **Deleted the 60-second scheduled loop** (`startAutomaticPaymentControlLoop` / `runAutomaticPaymentControlPass`). Arrears restriction now only happens via explicit server actions: the callback (unlock), STK initiation (limit while payment pending), and admin automation/restriction endpoints.
- **Deleted `reconcilePendingStkPayments`** — the Daraja query path no longer records payments (a status checker must never write derived state).
- Device policy pull now **writes nothing on steady-state polls** (identity saves only when identity actually changed: enroll/recovery/mismatch).
- Device-path saves (`saveDeviceRuntimeChangesNow`) are now **transactional read-modify-write**: they overlay only the rows they own (identity binding, events, command acks) onto the **latest** state doc, so a concurrent payment confirmation can never be clobbered by a stale whole-doc write. Binding is also mirrored to `contacts/{id}` with a targeted `set(merge)`.

**C. Single source of truth**

- `loadFirestoreState()` no longer unions the local JSON file. Firestore state doc + Firestore-native mirrors (`contacts`, `inventoryDevices`, `intakes`) are merged only, and the merge is **read-only** (no auto-save from a read path). Local JSON is used only to bootstrap an empty Firestore. A contract deleted from Firestore stays deleted.

### `system/firestore.rules` (created + deployed to both `(default)` and named `default` databases)

```
match /devices/{deviceId} { allow read: if true;  allow write: if false; }
match /payments/{paymentId} { allow read, write: if false; }
match /{document=**} { allow read: if false; allow write: if false; }
```

Backend uses the Admin SDK (bypasses rules), so rules are the second layer guaranteeing no client code can write `unlocked`/payment status. `firebase.json` added for `firebase deploy --only firestore:rules`.

### Dashboard: deleted phone removed everywhere

`system/delete_contract.js` (rerunnable: `node delete_contract.js [CONTRACT_ID]`) removed **KIS-5452** (Anne Apiyo / Samsung A15) from:
- Firestore state doc (`kismartApp/state`) — contracts now `KIS-7406, KIS-5645`
- Firestore `contacts/KIS-5452`
- Local `data/kismart-state.json` (so it can never re-seed)

---

## 3. Verification

**Checklist item → how it is guaranteed / verified**

| Checklist item | Status | Evidence |
|---|---|---|
| Pay → device unlocks | PASS | Callback transaction sets `devices/{id}.unlocked=true` + records payment; live simulation confirmed the exact transaction. |
| Wait 60 s → still unlocked | PASS (code) | All automatic re-lock writers removed: no 60 s loop, no policy-pull restriction writes, no query-path payment writer, duplicate callbacks ACK-and-skip, device saves are transactional overlays. Nothing left writes `restriction`/`unlocked` after payment. |
| Force-close app, reopen → still unlocked | PASS (code) | `POST /api/devices/{imei}/sync` no longer calls `applyAutomaticPaymentControls`; it returns the policy computed from the payment-recorded state. |
| Duplicate/late Safaricom callback → no state change | PASS (live test) | `verify_callback_txn.js` ran against the real Firestore: duplicate callback with a different receipt was rejected, receipt/amount/unlocked unchanged; a late failure callback could not downgrade `success`; `pending → cancelled` then a success attempt was rejected and the device stayed locked. **14/14 checks passed.** |
| Second payment on same device → still unlocked, new receipt | PASS (code) | Each checkout has its own `payments/{CheckoutRequestID}` doc; a second successful callback runs its own transaction and overwrites the device doc's receipt/amountPaid with `unlocked` still `true`. |
| Deleted phone gone from dashboard | PASS (live) | Production `GET /api/state` now returns only `KIS-7406, KIS-5645`; `KIS-5452` absent. |

**Also verified**: `tsc` type-check clean; server `--self-test` passes; rules deployed successfully; production health check `ok: true` (storage firestore, mpesa configured); redeployed and aliased to https://kismartsystem.vercel.app.

**Suggested live test on your side** (real STK): pay on KIS-5645, watch the phone unlock, wait 60 s, force-close and reopen the agent, then pay again and confirm the new receipt shows with the device still unlocked.

---

## Files changed

- `system/server.ts` — all server-side fixes
- `system/firestore.rules` — new, deployed
- `system/firebase.json` — new (rules deploy config)
- `system/delete_contract.js` — new operational tool (delete a contract everywhere)
- `system/verify_callback_txn.js` — new regression test (self-cleaning, uses only `payments/` + `devices/` collections)

---

# Addendum — admin contract editing (testing tool) + APK factory-reset blocking

## Admin: Edit button on every contract row

- **API** `PATCH /api/contracts/:id` (role-gated `contracts.write`), `applyContractEdits()` in server.ts:
  - Customer / device (model, serial — IMEI intentionally locked) / plan (devicePrice, deposit, installment, frequency, periodCount, graceDays, start date) edits.
  - Payment management: update existing amounts/dates/methods/references, remove payments, add payments — all validated.
  - Restriction level: `None` (restore) / `Limited access` / `Full lock` / `Lock screen message`.
- **Dashboard**: `Edit` button on every contract row (Contracts + Devices views) opens a dialog with customer/device/plan/payments/restriction sections.

## Direct Paid / Overdue editing (what the APK reacts to)

- New `contract.adjustments = { paid?, overdue? }` — signed overrides applied inside `getProgress()`:
  - `paid` = payment total + adjustments.paid
  - `arrears` = max(dueNow − paid, 0) + adjustments.overdue (clamped ≥ 0)
- `getProgress` feeds `buildDevicePolicy` → `paymentOnly.active`, so **the phone locks/unlocks on its next ~3 s policy sync** with no code change on the APK.
- The Edit dialog's "Progress — test values" section has direct **Paid (KES)** and **Overdue (KES)** fields (pre-filled; leave empty to use real computed values) plus a live preview.
- Verified live on production: created a test contract (5000/15000/0) → set paid=18000, overdue=12000 → progress 18000/2000/12000, status Overdue → device policy `paymentOnly.active: true` → set paid=20000, overdue=0 → balance 0/0, `paymentOnly.active: false`, status Completed → contract deleted.

## APK: factory-reset screens blocked, limit screen shows

`KismartAccessibilityService.java` (Android):

- **Class-name blocking** (`isFactoryResetClass`): any activity whose class contains `masterclear`, `factoryreset`, `factoryresetconfirm`, `resetdashboard`, `resetoptions`, `resetnetwork`, `resetapppreferences`, `backupreset`, `eraseallcontent`, `erasedata`, `eraseeverything`, `resetphone`, `wipephone`, `recoverymode`, `hardreset` is blocked **immediately** on `TYPE_WINDOW_STATE_CHANGED` — no tree walk needed. This covers Settings search → Reset options / Factory data reset navigation (the reported gap).
- **Keyword expansion** in `isFactoryResetScreen`: added master reset, hard reset, reset device, backup & reset, erase everything, reset all settings, etc. — catches Settings search-result screens.
- **Deeper quick walk** (`collectQuickScreenText` depth 4→6, 4000→8000 chars) so search-result text inside deeper RecyclerViews is seen.
- **Full-lock takes priority** over dangerous-surface handling: a full-lock device shows the black full-lock screen on any surface, including factory reset.
- When blocked, the **"Payment required" limit overlay shows** (limited devices) or the black full-lock screen (full lock), exactly as requested.
- The existing device-owner layer also sets `DISALLOW_FACTORY_RESET` (DeviceControls) as defense in depth.
