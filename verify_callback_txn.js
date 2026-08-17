// Verification of the new idempotent M-Pesa callback logic against real Firestore.
// Uses ONLY the payments/ and devices/ collections (both were empty) and deletes all
// test docs afterward. Mirrors the exact transaction code in handleMpesaStkCallback
// and finalizeStkPaymentDoc from server.ts.
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sa = JSON.parse(readFileSync(join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json"), "utf8"));
initializeApp({ credential: cert(sa), projectId: "kismart-456ee" });
const db = getFirestore("default");

const CHECKOUT_A = "TEST-CHECKOUT-A";
const CHECKOUT_B = "TEST-CHECKOUT-B";
const DEVICE_A = "TEST-DEV-A";
const DEVICE_B = "TEST-DEV-B";

const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function confirmSuccessTransaction(checkout, contractId, receipt, amount) {
  // Mirror of the callback success transaction in server.ts
  return db.runTransaction(async (tx) => {
    const paymentRef = db.collection("payments").doc(checkout);
    const paymentSnap = await tx.get(paymentRef);
    if (paymentSnap.exists && paymentSnap.get("status") !== "pending") return false;
    if (paymentSnap.exists) {
      tx.update(paymentRef, { status: "success", mpesaReceipt: receipt, amount, confirmedAt: new Date().toISOString() });
    } else {
      tx.set(paymentRef, { status: "success", checkoutRequestId: checkout, contractId, amount, mpesaReceipt: receipt, confirmedAt: new Date().toISOString(), migrated: true }, { merge: true });
    }
    tx.set(db.collection("devices").doc(contractId), {
      unlocked: true,
      unlockedAt: new Date().toISOString(),
      mpesaReceipt: receipt,
      amountPaid: amount,
      contractId,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return true;
  });
}

async function failTransaction(checkout, status) {
  // Mirror of finalizeStkPaymentDoc in server.ts
  return db.runTransaction(async (tx) => {
    const paymentRef = db.collection("payments").doc(checkout);
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) return;
    if (paymentSnap.get("status") !== "pending") return;
    tx.update(paymentRef, { status, resultDesc: "test failure", updatedAt: new Date().toISOString() });
  });
}

const nowIso = () => new Date().toISOString();

// ── Scenario 1: pending → success, then duplicate callback → no change ──
await db.collection("payments").doc(CHECKOUT_A).set({ status: "pending", checkoutRequestId: CHECKOUT_A, contractId: DEVICE_A, createdAt: nowIso() });

const first = await confirmSuccessTransaction(CHECKOUT_A, DEVICE_A, "RCV-TEST-001", 1000);
pass("A: first callback confirms (transaction returned true)", first === true);

const docA1 = (await db.collection("payments").doc(CHECKOUT_A).get()).data();
const devA1 = (await db.collection("devices").doc(DEVICE_A).get()).data();
pass("A: payment doc status=success", docA1?.status === "success", docA1?.status);
pass("A: receipt recorded", docA1?.mpesaReceipt === "RCV-TEST-001");
pass("A: device unlocked=true", devA1?.unlocked === true, String(devA1?.unlocked));
pass("A: amountPaid recorded", devA1?.amountPaid === 1000, String(devA1?.amountPaid));

// Duplicate / retried callback with a DIFFERENT receipt: must be ignored entirely.
const second = await confirmSuccessTransaction(CHECKOUT_A, DEVICE_A, "RCV-TEST-999", 5000);
pass("A: duplicate callback rejected (transaction returned false)", second === false, String(second));
const docA2 = (await db.collection("payments").doc(CHECKOUT_A).get()).data();
const devA2 = (await db.collection("devices").doc(DEVICE_A).get()).data();
pass("A: duplicate did not change receipt", docA2?.mpesaReceipt === "RCV-TEST-001", docA2?.mpesaReceipt);
pass("A: duplicate did not change amountPaid", devA2?.amountPaid === 1000, String(devA2?.amountPaid));
pass("A: duplicate did not change unlocked", devA2?.unlocked === true, String(devA2?.unlocked));

// A late FAILURE callback on an already-success checkout must NOT downgrade it.
await failTransaction(CHECKOUT_A, "failed");
const docA3 = (await db.collection("payments").doc(CHECKOUT_A).get()).data();
pass("A: late failed callback cannot downgrade success", docA3?.status === "success", docA3?.status);

// ── Scenario 2: pending → failed (cancelled), then success must NOT apply ──
await db.collection("payments").doc(CHECKOUT_B).set({ status: "pending", checkoutRequestId: CHECKOUT_B, contractId: DEVICE_B, createdAt: nowIso() });
await failTransaction(CHECKOUT_B, "cancelled");
const docB1 = (await db.collection("payments").doc(CHECKOUT_B).get()).data();
pass("B: pending -> cancelled transition applied", docB1?.status === "cancelled", docB1?.status);

const successAfterFail = await confirmSuccessTransaction(CHECKOUT_B, DEVICE_B, "RCV-TEST-002", 1000);
pass("B: success on cancelled checkout rejected", successAfterFail === false, String(successAfterFail));
const devB = (await db.collection("devices").doc(DEVICE_B).get()).data();
pass("B: device was NOT unlocked by rejected callback", devB?.unlocked !== true, String(devB?.unlocked));

// ── Cleanup ──
await Promise.all([
  db.collection("payments").doc(CHECKOUT_A).delete(),
  db.collection("payments").doc(CHECKOUT_B).delete(),
  db.collection("devices").doc(DEVICE_A).delete(),
  db.collection("devices").doc(DEVICE_B).delete(),
]);
const leftover = await db.collection("payments").get();
pass("cleanup: payments collection empty again", leftover.size === 0, `size=${leftover.size}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${results.length} total)`);
process.exit(failed.length === 0 ? 0 : 1);
