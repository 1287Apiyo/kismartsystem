// Quick scan of Firestore contracts for `adjustments` (read-only).
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

const serviceAccount = JSON.parse(
  readFileSync("./kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json", "utf8")
);
const app = initializeApp({ credential: cert(serviceAccount) }, "scan-adjustments");
const db = getFirestore(app);
db.settings({ databaseId: "default" });

const col = process.argv[2] || "contacts";
const snap = await db.collection(col).get();
let total = 0, withAdjustments = 0;
const hits = [];
for (const doc of snap.docs) {
  total++;
  const c = doc.data();
  if (c && c.adjustments && (c.adjustments.paid !== undefined || c.adjustments.overdue !== undefined)) {
    withAdjustments++;
    hits.push({ id: doc.id, adjustments: c.adjustments, paid: c.progress?.paid, arrears: c.progress?.arrears, payments: (c.payments || []).length });
  }
}
console.log(`collection=${col} contracts=${total} withAdjustments=${withAdjustments}`);
console.log(JSON.stringify(hits, null, 2).slice(0, 4000));
process.exit(0);
