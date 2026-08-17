// Deterministic repair: remove JSON-file storage entirely, make Firestore the only storage.
import { readFile, writeFile } from "node:fs/promises";

const path = "C:/Users/Volo/Documents/New project 2/system/server.ts";
const content = await readFile(path, "utf8");
let src = content.replace(/\r\n/g, "\n");
let count = 0;

const rep = (oldS, newS) => {
  if (!src.includes(oldS)) throw new Error("NOT FOUND: " + oldS.slice(0, 100).replace(/\n/g, "\\n"));
  src = src.split(oldS).join(newS);
  count++;
};

// 1. Remove DATA_DIR / DATA_FILE constants
rep(
  `const DATA_DIR = process.env.VERCEL ? join(tmpdir(), "kismart-data") : join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "kismart-state.json");
`,
  ``
);

// 2. Remove cachedJsonMtimeMs
rep(
  `let cachedStateLoadedAt = 0;
let cachedJsonMtimeMs = 0;
`,
  `let cachedStateLoadedAt = 0;
`
);

// 3. Delete loadJsonState function (up to function isSupabaseStorage)
{
  const start = src.indexOf(`async function loadJsonState(): Promise<AppState> {`);
  const end = src.indexOf(`function isSupabaseStorage() {`, start);
  if (start < 0 || end < 0) throw new Error("loadJsonState region not found");
  src = src.slice(0, start) + src.slice(end);
  count++;
}

// 4. Replace currentStorageMode / remoteStorageReady / storageDescription
{
  const start = src.indexOf(`function currentStorageMode() {`);
  const end = src.indexOf(`function assertSupabaseConfigured() {`, start);
  if (start < 0 || end < 0) throw new Error("storage helpers not found");
  const block = `function currentStorageMode() {
  return "firestore";
}

function remoteStorageReady() {
  return true;
}

function storageDescription() {
  return \`Firestore (\${FIREBASE_PROJECT_ID}/\${FIRESTORE_DATABASE || "(default)"}/top-level collections)\`;
}

`;
  src = src.slice(0, start) + block + src.slice(end);
  count++;
}

// 5. Delete broken queueDeviceRuntimeSave(g) duplicate
{
  const start = src.indexOf(`function queueDeviceRuntimeSave(g) {`);
  const end = src.indexOf(`function queueDeviceRuntimeSave(`, start + 10);
  if (start < 0 || end < 0) throw new Error("broken queueDeviceRuntimeSave not found");
  src = src.slice(0, start) + src.slice(end);
  count++;
}

// 6. saveDeviceRuntimeChangesNow head: remove supabase + JSON branches
{
  const start = src.indexOf(`async function saveDeviceRuntimeChangesNow(`);
  const bodyStart = src.indexOf(`  try {`, start);
  if (start < 0 || bodyStart < 0) throw new Error("runtime save head not found");
  const block = `async function saveDeviceRuntimeChangesNow(
  state: AppState,
  changes: RuntimeSaveChanges
) {
  if (!isFirestoreStorage()) {
    throw new HttpError(503, firestoreLastError
      ? \`Firestore runtime save failed: \${firestoreLastError}\`
      : "Firestore runtime save failed: Firestore is temporarily unavailable");
  }

`;
  src = src.slice(0, start) + block + src.slice(bodyStart);
  count++;
}

// 7. saveDeviceRuntimeChangesNow catch: remove JSON fallback
rep(
  `  } catch (error) {
    markFirestoreUnavailable(error);
    if (STORAGE_MODE === "firestore") {
      throw new HttpError(503, \`Firestore runtime save failed: \${error instanceof Error ? error.message : String(error)}\`);
    }
    await saveJsonState(state);
  }
}`,
  `  } catch (error) {
    markFirestoreUnavailable(error);
    throw new HttpError(503, \`Firestore runtime save failed: \${error instanceof Error ? error.message : String(error)}\`);
  }
}`
);

// 8. Delete saveJsonState / jsonStateFileChanged / jsonStateMtimeMs
{
  const start = src.indexOf(`async function saveJsonState(state: AppState) {`);
  const end = src.indexOf(`async function loadFirestoreState(): Promise<AppState> {`, start);
  if (start < 0 || end < 0) throw new Error("saveJsonState family not found");
  src = src.slice(0, start) + src.slice(end);
  count++;
}

// 9. Rebuild the corrupted bootstrap/mergeState/saveFirestoreState region
{
  const start = src.indexOf(`  // Firestore is completely empty`);
  const end = src.indexOf(`async function saveFirestoreCoreRecord(`);
  if (start < 0 || end < 0 || end <= start) throw new Error("bootstrap region not found");
  const block = `  // Firestore is completely empty — seed a fresh state (env bootstrap contracts apply).
  const jsonState = seedBootstrapState();
  queueStateSave(jsonState, "Initial Firestore state save");
  return jsonState;
}

function mergeState(firestoreState: AppState, jsonState: AppState): { state: AppState; changed: boolean } {
  let changed = false;
  const state = { ...firestoreState };

  const mergeCollections = <T extends { id: string }>(fireItems: T[], jsonItems: T[]) => {
    const items = [...fireItems];
    const fireIndexById = new Map(items.map((item, index) => [item.id, index]));
    jsonItems.forEach((jsonItem) => {
      const index = fireIndexById.get(jsonItem.id);
      if (index == null) {
        fireIndexById.set(jsonItem.id, items.length);
        items.push(jsonItem);
        changed = true;
      }
    });
    return items;
  };

  state.contracts = mergeCollections(state.contracts, jsonState.contracts);
  state.intakes = mergeCollections(state.intakes, jsonState.intakes);
  state.notifications = mergeCollections(state.notifications, jsonState.notifications);
  state.syncEvents = mergeCollections(state.syncEvents, jsonState.syncEvents);
  state.deviceEvents = mergeCollections(state.deviceEvents, jsonState.deviceEvents);
  state.inventoryDevices = mergeCollections(state.inventoryDevices, jsonState.inventoryDevices);
  state.soldPhones = mergeCollections(state.soldPhones || [], jsonState.soldPhones || []);
  state.supplies = mergeCollections(state.supplies || [], jsonState.supplies || []);
  state.audit = mergeCollections(state.audit, jsonState.audit);

  return { state, changed };
}

async function saveFirestoreState(state: AppState) {
  // Single-document write keeps STK checkout maps + full state durable.
  // The contacts collection is also canonical for Firebase Console/admin workflows, so always mirror it.
  const firestore = getFirestoreDb();
  const compact = compactStateForStorage(state);
  // Parallel writes cut Vercel latency vs sequential sets (helps stay under cold-start budgets).
  await Promise.all([
    getFirestoreStateDoc().set({
      updatedAt: nowIso(),
      version: VERSION,
      state: toFirestoreRecord(compact),
    }),
    firestore.collection(FIRESTORE_SETTINGS_COLLECTION).doc(FIRESTORE_SETTINGS_DOCUMENT).set({
      ...toFirestoreRecord(state.settings),
      updatedAt: nowIso(),
      version: VERSION,
    }),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.contracts, state.contracts, (item: Contract) => item.id),
  ]);

  const mirrorCollections = (process.env.KISMART_FIRESTORE_MIRROR_COLLECTIONS || "false").toLowerCase() === "true";
  if (!mirrorCollections) return;

  await Promise.all([
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.intakes, state.intakes, (item: IntakeRecord) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.notifications, state.notifications, (item: NotificationRecord) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.syncEvents, state.syncEvents, (item: AppState["syncEvents"][number]) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.deviceEvents, state.deviceEvents, (item: DeviceEvent) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.inventoryDevices, state.inventoryDevices, (item: InventoryDevice) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.audit, state.audit, (item: AuditRecord) => item.id),
  ]);
}

`;
  src = src.slice(0, start) + block + src.slice(end);
  count++;
}

// 10. saveFirestoreCoreRecord: remove supabase branch, simplify required check
rep(
  `  if (!id) return;
  if (isSupabaseStorage()) {
    await saveSupabaseRecord(collectionKey, id, value);
    return;
  }
  if (!isFirestoreStorage()) {
    if (required && STORAGE_MODE === "firestore") {
      throw new HttpError(503, firestoreLastError
        ? \`Firebase \${collectionKey}/\${id} save failed: \${firestoreLastError}\`
        : \`Firebase \${collectionKey}/\${id} save failed: Firestore is temporarily unavailable\`);
    }
    return;
  }`,
  `  if (!id) return;
  if (!isFirestoreStorage()) {
    if (required) {
      throw new HttpError(503, firestoreLastError
        ? \`Firebase \${collectionKey}/\${id} save failed: \${firestoreLastError}\`
        : \`Firebase \${collectionKey}/\${id} save failed: Firestore is temporarily unavailable\`);
    }
    return;
  }`
);

// 11. deleteFirestoreCoreRecord: remove supabase branch, simplify required check
rep(
  `  if (!id) return;
  if (isSupabaseStorage()) {
    await deleteSupabaseRecord(collectionKey, id);
    return;
  }
  if (!isFirestoreStorage()) {
    if (required && STORAGE_MODE === "firestore") {
      throw new HttpError(503, firestoreLastError
        ? \`Firebase \${collectionKey}/\${id} delete failed: \${firestoreLastError}\`
        : \`Firebase \${collectionKey}/\${id} delete failed: Firestore is temporarily unavailable\`);
    }
    return;
  }`,
  `  if (!id) return;
  if (!isFirestoreStorage()) {
    if (required) {
      throw new HttpError(503, firestoreLastError
        ? \`Firebase \${collectionKey}/\${id} delete failed: \${firestoreLastError}\`
        : \`Firebase \${collectionKey}/\${id} delete failed: Firestore is temporarily unavailable\`);
    }
    return;
  }`
);

// 12. markFirestoreUnavailable: no JSON fallback message
rep(
  `    console.error(\`Firestore unavailable; falling back to JSON storage: \${message}\`);`,
  `    console.error(\`Firestore unavailable (no fallback — Firestore is the only storage): \${message}\`);`
);

// 13. Rename seedJsonState -> seedBootstrapState
rep(`function seedJsonState(): AppState {`, `function seedBootstrapState(): AppState {`);

// 14. Dead supabase loader's dangling loadJsonState call
rep(`    const localState = await loadJsonState();`, `    const localState = seedBootstrapState();`);

await writeFile(path, src);
console.log("OK replacements applied:", count);
