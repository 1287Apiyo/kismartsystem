import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectId = clean(process.env.FIREBASE_PROJECT_ID) || "kismart-456ee";
const serviceAccountPath = resolveServiceAccountPath();
const databaseId = normalizeFirestoreDatabase(process.env.KISMART_FIRESTORE_DATABASE || "");
const rootCollection = process.env.KISMART_FIRESTORE_COLLECTION || "kismartApp";
const rootDocument = process.env.KISMART_FIRESTORE_DOCUMENT || "state";
const settingsCollection = process.env.KISMART_FIRESTORE_SETTINGS_COLLECTION || "settings";
const settingsDocument = process.env.KISMART_FIRESTORE_SETTINGS_DOCUMENT || "main";
const recordCollections = {
  contracts: process.env.KISMART_FIRESTORE_CONTRACTS_COLLECTION || "contacts",
  intakes: process.env.KISMART_FIRESTORE_INTAKES_COLLECTION || "intakes",
  notifications: process.env.KISMART_FIRESTORE_NOTIFICATIONS_COLLECTION || "notifications",
  syncEvents: process.env.KISMART_FIRESTORE_SYNC_EVENTS_COLLECTION || "syncEvents",
  deviceEvents: process.env.KISMART_FIRESTORE_DEVICE_EVENTS_COLLECTION || "deviceEvents",
  inventoryDevices: process.env.KISMART_FIRESTORE_INVENTORY_DEVICES_COLLECTION || "inventoryDevices",
  audit: process.env.KISMART_FIRESTORE_AUDIT_COLLECTION || "audit",
};

const statePath = join(__dirname, "data", "kismart-state.json");
const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));
const localState = JSON.parse(await readFile(statePath, "utf8"));
const app = initializeApp({ credential: cert(serviceAccount), projectId });
const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
const now = new Date().toISOString();

const compactState = compactStateForStorage(normalizeLocalState(localState));

console.log(`Rebuilding Firestore state for ${projectId}/${databaseId || "(default)"}`);
console.log(`Source: ${statePath}`);
console.log(`Target: ${rootCollection}/${rootDocument}`);

await db.collection(rootCollection).doc(rootDocument).set({
  updatedAt: now,
  version: "rebuild-script",
  state: compactState,
});

await db.collection(settingsCollection).doc(settingsDocument).set({
  ...compactState.settings,
  updatedAt: now,
  version: "rebuild-script",
});

await syncTopLevelCollection(recordCollections.contracts, compactState.contracts, (item) => item.id);
await syncTopLevelCollection(recordCollections.intakes, compactState.intakes, (item) => item.id);
await syncTopLevelCollection(recordCollections.notifications, compactState.notifications, (item) => item.id);
await syncTopLevelCollection(recordCollections.syncEvents, compactState.syncEvents, (item) => item.id);
await syncTopLevelCollection(recordCollections.deviceEvents, compactState.deviceEvents, (item) => item.id);
await syncTopLevelCollection(recordCollections.inventoryDevices, compactState.inventoryDevices, (item) => item.id);
await syncTopLevelCollection(recordCollections.audit, compactState.audit, (item) => item.id);

const stateDoc = await db.collection(rootCollection).doc(rootDocument).get();
const contractsSnapshot = await db.collection(recordCollections.contracts).get();

console.log(
  JSON.stringify(
    {
      ok: true,
      projectId,
      database: databaseId || "(default)",
      stateDocExists: stateDoc.exists,
      contracts: compactState.contracts.length,
      mirroredContracts: contractsSnapshot.size,
      syncEvents: compactState.syncEvents.length,
      deviceEvents: compactState.deviceEvents.length,
      audit: compactState.audit.length,
    },
    null,
    2
  )
);

function resolveServiceAccountPath() {
  const configured = clean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  const candidates = [
    configured ? (isAbsolute(configured) ? configured : join(__dirname, configured)) : "",
    join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json"),
    join(__dirname, "firebase-service-account.json"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`No Firebase service account found. Checked: ${candidates.join(", ")}`);
  return found;
}

function normalizeFirestoreDatabase(value) {
  const cleaned = clean(value);
  if (!cleaned || cleaned === "(default)") return "";
  if (cleaned.toLowerCase() === "named:default") return "default";
  if (cleaned.toLowerCase() === "default") return "";
  return cleaned;
}

function normalizeLocalState(state) {
  return {
    settings: state.settings || {},
    contracts: Array.isArray(state.contracts) ? state.contracts : [],
    intakes: Array.isArray(state.intakes) ? state.intakes : [],
    notifications: Array.isArray(state.notifications) ? state.notifications : [],
    syncEvents: Array.isArray(state.syncEvents) ? state.syncEvents : [],
    deviceEvents: Array.isArray(state.deviceEvents) ? state.deviceEvents : [],
    inventoryDevices: Array.isArray(state.inventoryDevices) ? state.inventoryDevices : [],
    soldPhones: Array.isArray(state.soldPhones) ? state.soldPhones : [],
    supplies: Array.isArray(state.supplies) ? state.supplies : [],
    audit: Array.isArray(state.audit) ? state.audit : [],
    mpesaCheckouts: state.mpesaCheckouts && typeof state.mpesaCheckouts === "object" ? state.mpesaCheckouts : {},
  };
}

function compactStateForStorage(state) {
  const keep = (items, max) => (Array.isArray(items) ? items.slice(0, max) : []);
  return {
    ...state,
    notifications: keep(state.notifications, 200),
    syncEvents: keep(state.syncEvents, 300),
    deviceEvents: keep(state.deviceEvents, 300),
    audit: keep(state.audit, 200),
  };
}

async function syncTopLevelCollection(collectionName, items, idForItem) {
  const collection = db.collection(collectionName);
  const snapshot = await collection.get();
  const wantedIds = new Set(items.map(idForItem).filter(Boolean));
  const operations = [];

  snapshot.docs.forEach((record) => {
    if (!wantedIds.has(record.id)) {
      operations.push((batch) => batch.delete(record.ref));
    }
  });

  items.forEach((item) => {
    const id = idForItem(item);
    if (!id) return;
    operations.push((batch) => batch.set(collection.doc(id), JSON.parse(JSON.stringify(item))));
  });

  await commitOperations(operations);
}

async function commitOperations(operations) {
  for (let index = 0; index < operations.length; index += 450) {
    const batch = db.batch();
    operations.slice(index, index + 450).forEach((operation) => operation(batch));
    await batch.commit();
  }
}

function clean(value) {
  return String(value || "").trim();
}
