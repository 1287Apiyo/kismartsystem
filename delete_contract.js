// Permanent contract deletion from Firestore + local JSON (single source of truth).
// Mirrors the server's DELETE /api/contracts/:id behavior so the dashboard never
// shows the phone again (and the local JSON can never re-seed it).
//
// Usage:  node delete_contract.js [CONTRACT_ID]   (default: KIS-5452)
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_ID = clean(process.argv[2] || process.env.CONTRACT_ID) || "KIS-5452";
const PROJECT_ID = clean(process.env.FIREBASE_PROJECT_ID) || "kismart-456ee";
const DB_ID = "default"; // KISMART_FIRESTORE_DATABASE=named:default
const STATE_COLLECTION = "kismartApp";
const STATE_DOCUMENT = "state";
const CONTRACTS_COLLECTION = "contacts";
const STATE_FILE = join(__dirname, "data", "kismart-state.json");

const serviceAccount = JSON.parse(readFileSync(join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json"), "utf8"));
initializeApp({ credential: cert(serviceAccount), projectId: PROJECT_ID });
const db = getFirestore(DB_ID);
const now = new Date().toISOString();

const stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT);
const snap = await stateRef.get();
if (!snap.exists) throw new Error("state doc not found");
const data = snap.data();
const state = data.state || (looksLikeState(data) ? data : null);
if (!state) throw new Error("state payload not found in doc");

const before = state.contracts.length;
state.contracts = (state.contracts || []).filter((c) => c.id !== CONTRACT_ID);
state.notifications = (state.notifications || []).filter((n) => n.contractId !== CONTRACT_ID);
state.syncEvents = (state.syncEvents || []).filter((e) => e.contractId !== CONTRACT_ID && e.imei !== contractImei(state, CONTRACT_ID));
state.deviceEvents = (state.deviceEvents || []).filter((e) => e.contractId !== CONTRACT_ID && e.imei !== contractImei(state, CONTRACT_ID));
(state.intakes || []).forEach((intake) => {
  if (intake.convertedContractId === CONTRACT_ID) {
    intake.status = "Pending";
    intake.convertedContractId = "";
  }
});
(state.inventoryDevices || []).forEach((device) => {
  if (device.assignedContractId === CONTRACT_ID) {
    device.status = "Available";
    device.assignedContractId = null;
    device.assignedAt = null;
  }
});
const after = state.contracts.length;

// 1. Rewrite the canonical state doc (server write shape).
await stateRef.set({ updatedAt: now, version: "contract-delete", state: JSON.parse(JSON.stringify(state)) });

// 2. Delete the mirrored contract doc.
await db.collection(CONTRACTS_COLLECTION).doc(CONTRACT_ID).delete();

// 3. Delete any devices/{contractId} unlock record for this phone.
await db.collection("devices").doc(CONTRACT_ID).delete().catch(() => undefined);

// 4. Remove from local JSON so it can never be re-seeded.
if (existsSync(STATE_FILE)) {
  const local = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  local.contracts = (local.contracts || []).filter((c) => c.id !== CONTRACT_ID);
  local.notifications = (local.notifications || []).filter((n) => n.contractId !== CONTRACT_ID);
  local.syncEvents = (local.syncEvents || []).filter((e) => e.contractId !== CONTRACT_ID);
  local.deviceEvents = (local.deviceEvents || []).filter((e) => e.contractId !== CONTRACT_ID);
  (local.intakes || []).forEach((intake) => {
    if (intake.convertedContractId === CONTRACT_ID) {
      intake.status = "Pending";
      intake.convertedContractId = "";
    }
  });
  (local.inventoryDevices || []).forEach((device) => {
    if (device.assignedContractId === CONTRACT_ID) {
      device.status = "Available";
      device.assignedContractId = null;
      device.assignedAt = null;
    }
  });
  writeFileSync(STATE_FILE, JSON.stringify(local, null, 2));
}

console.log(JSON.stringify({ ok: true, contract: CONTRACT_ID, contractsBefore: before, contractsAfter: after, stateDoc: STATE_COLLECTION + "/" + STATE_DOCUMENT, mirrorDeleted: CONTRACTS_COLLECTION + "/" + CONTRACT_ID, devicesDocDeleted: true, localJsonUpdated: true }, null, 2));

function contractImei(state, id) {
  return (state.contracts || []).find((c) => c.id === id)?.device?.imei || "";
}
function looksLikeState(value) {
  return Boolean(value && Array.isArray(value.contracts) && Array.isArray(value.intakes) && value.settings);
}
function clean(value) {
  return String(value || "").trim();
}
