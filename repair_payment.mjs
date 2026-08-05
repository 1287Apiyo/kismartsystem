// Repair: record missing Ksh 45 payment (UH53X24CIP) for KIS-5645 (Taff3 / IMEI 862933060264263)
// in the live Firestore (named DB "default", project kismart-456ee) + mirror to local JSON.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CID = "KIS-5645";
const IMEI = "862933060264263";
const REF = "UH53X24CIP";
const AMOUNT = 45;
const PAYMENT_DATE = "2026-08-05";

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowIso = () => new Date().toISOString();
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const serviceAccount = JSON.parse(await readFile(join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json"), "utf8"));
const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount), projectId: "kismart-456ee" });
const db = getFirestore(app, "default");

// ---- 1. Load current state ----
const stateDocRef = db.collection("kismartApp").doc("state");
const snap = await stateDocRef.get();
if (!snap.exists) throw new Error("state doc does not exist");
const docData = snap.data();
const state = (docData.state && Array.isArray(docData.state.contracts) ? docData.state : docData);
const contract = state.contracts.find((c) => c.id === CID);
if (!contract) throw new Error(`${CID} not found in state doc`);

console.log("BEFORE:");
console.log("  payments:", JSON.stringify(contract.payments));
console.log("  restriction:", JSON.stringify(contract.restriction));

// ---- 2. Guard: never duplicate the same reference ----
if (contract.payments.some((p) => p.reference === REF)) {
  throw new Error(`Payment with reference ${REF} already exists — aborting to avoid duplicate.`);
}

// ---- 3. Apply the same transformations the server would ----
const payment = { id: uid("PAY"), date: PAYMENT_DATE, method: "M-Pesa", reference: REF, amount: AMOUNT, status: "Synced" };
contract.payments.push(payment);

// supersede pending device commands (mirror supersedePendingDeviceCommands)
state.syncEvents.forEach((e) => {
  if (e.contractId === CID && (e.provider === "Device command" || e.provider === "Apple MDM") && e.status === "Pending") {
    e.status = "Failed";
    e.message = `Superseded by Restore command for ${IMEI}`;
  }
});

// payment sync event
state.syncEvents.unshift({
  id: uid("SYNC"),
  time: nowIso(),
  contractId: CID,
  provider: "M-Pesa",
  reference: REF,
  status: "Synced",
  message: `Ksh ${AMOUNT} allocated to ${contract.customer.name} (manual reconciliation of receipt ${REF})`,
});

// restore command (mirror restoreDevice)
contract.restriction = { active: false, level: "None", appliedAt: null, holdAutoRestrict: false };
state.syncEvents.unshift({
  id: uid("SYNC"),
  time: nowIso(),
  contractId: CID,
  provider: "Device command",
  reference: "Restore",
  status: "Pending",
  message: `Device command restore command queued for ${IMEI}`,
});

// audit trail
const audit = state.audit || [];
audit.unshift({ id: uid("AUD"), time: nowIso(), role: "Admin", action: "Payment recorded", record: `${CID} - Ksh ${AMOUNT} (${REF}) reconciled` });
audit.unshift({ id: uid("AUD"), time: nowIso(), role: "System", action: "Device restored after arrears cleared", record: CID });

// ---- 4. Compact like compactStateForStorage (match server caps) ----
const keep = (items, max) => (Array.isArray(items) ? items.slice(0, max) : []);
const compact = {
  ...state,
  notifications: keep(state.notifications, 200),
  syncEvents: keep(state.syncEvents, 300),
  deviceEvents: keep(state.deviceEvents, 300),
  audit: keep(audit, 200),
};

console.log("AFTER:");
console.log("  payments:", JSON.stringify(contract.payments));
console.log("  restriction:", JSON.stringify(contract.restriction));

// ---- 5. Write Firestore (state doc + contacts mirror, like saveFirestoreState) ----
const updatedAt = nowIso();
await stateDocRef.set({ updatedAt, version: "1.3.1", state: JSON.parse(JSON.stringify(compact)) });
await db.collection("contacts").doc(CID).set(JSON.parse(JSON.stringify(contract)));
console.log("Firestore written: kismartApp/state + contacts/" + CID);

// ---- 6. Mirror to local JSON so the local copy stays consistent ----
const localPath = join(__dirname, "data", "kismart-state.json");
try {
  const local = JSON.parse(readFileSync(localPath, "utf8"));
  const localContract = (local.contracts || []).find((c) => c.id === CID);
  if (localContract) {
    if (!localContract.payments.some((p) => p.reference === REF)) localContract.payments.push(payment);
    localContract.restriction = { ...contract.restriction };
    writeFileSync(localPath, JSON.stringify(local, null, 2));
    console.log("Local JSON updated:", localPath);
  } else {
    console.log("Local JSON: contract not present, skipped");
  }
} catch (e) {
  console.log("Local JSON not updated:", e.message);
}

process.exit(0);
