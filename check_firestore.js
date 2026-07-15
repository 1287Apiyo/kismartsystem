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
  const collectionName = "contacts";

  console.log(`Checking collection: ${collectionName}`);
  const snapshot = await db.collection(collectionName).get();
  
  if (snapshot.empty) {
    console.log("Collection is empty.");
  } else {
    console.log(`Found ${snapshot.size} documents:`);
    snapshot.forEach(doc => {
      console.log(`- ${doc.id}`);
    });
  }
}

run().catch(console.error);
