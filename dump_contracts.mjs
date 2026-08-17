// Dump the 3 Firestore contracts (read-only) to understand structure.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const serviceAccount = JSON.parse(
  readFileSync("./kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json", "utf8")
);
const app = initializeApp({ credential: cert(serviceAccount) }, "dump-contracts");
const db = getFirestore(app);
db.settings({ databaseId: "default" });

const snap = await db.collection("contacts").get();
for (const doc of snap.docs) {
  const c = doc.data();
  console.log("===== " + doc.id + " =====");
  console.log(JSON.stringify({
    id: c.id, createdAt: c.createdAt,
    customer: c.customer,
    device: c.device,
    plan: c.plan,
    progress: c.progress,
    payments: (c.payments || []).map(p => ({ id: p.id, amount: p.amount, date: p.date, method: p.method, reference: p.reference, status: p.status })),
    adjustments: c.adjustments,
    restriction: c.restriction,
  }, null, 1).slice(0, 3000));
  console.log("");
}
process.exit(0);
