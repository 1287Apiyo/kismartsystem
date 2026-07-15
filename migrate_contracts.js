import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json");

async function run() {
  const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));

  initializeApp({
    credential: cert(serviceAccount),
    projectId: "kismart-456ee"
  });

  const db = getFirestore();
  const sourceCollection = "contracts";
  const targetCollection = "contacts";

  console.log(`Copying documents from ${sourceCollection} to ${targetCollection}...`);

  const ids = ["KIS-5452", "KIS-7406"];

  for (const id of ids) {
    const docRef = db.collection(sourceCollection).doc(id);
    const doc = await docRef.get();

    if (doc.exists) {
      const data = doc.data();
      console.log(`Found ${id} in ${sourceCollection}. Copying to ${targetCollection}...`);
      await db.collection(targetCollection).doc(id).set(data);
      console.log(`Successfully copied ${id}.`);
    } else {
      console.log(`${id} not found in ${sourceCollection}.`);
      // If not found in source, maybe I should use the data I have from the browser/prompt?
    }
  }
}

run().catch(console.error);
