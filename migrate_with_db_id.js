import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json");

async function run() {
  const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));

  const app = initializeApp({
    credential: cert(serviceAccount),
    projectId: "kismart-456ee"
  });

  // Explicitly specify the database ID
  const db = getFirestore(app, "default");
  
  const sourceCollection = "contracts";
  const targetCollection = "contacts";

  console.log(`Copying documents from ${sourceCollection} to ${targetCollection} (Database: default)...`);

  const ids = ["KIS-5452", "KIS-7406"];

  for (const id of ids) {
    console.log(`Reading ${id} from ${sourceCollection}...`);
    const docRef = db.collection(sourceCollection).doc(id);
    const doc = await docRef.get();

    if (doc.exists) {
      const data = doc.data();
      console.log(`Found ${id}. Saving to ${targetCollection}...`);
      await db.collection(targetCollection).doc(id).set(data);
      console.log(`Successfully moved ${id} to ${targetCollection}.`);
    } else {
      console.log(`${id} not found in ${sourceCollection}.`);
      
      // Fallback: write the data I have locally just in case
      const localStateRaw = await readFile(join(__dirname, "data", "kismart-state.json"), "utf8");
      const localState = JSON.parse(localStateRaw);
      const localContract = localState.contracts.find(c => c.id === id);
      
      if (localContract) {
        console.log(`Found ${id} in local state. Writing to ${targetCollection}...`);
        await db.collection(targetCollection).doc(id).set(localContract);
        console.log(`Successfully wrote ${id} from local state to ${targetCollection}.`);
      }
    }
  }
}

run().catch(console.error);
