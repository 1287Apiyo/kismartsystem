import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sa = JSON.parse(await readFile(join(__dirname, "kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json"), "utf8"));
const app = getApps()[0] || initializeApp({ credential: cert(sa), projectId: "kismart-456ee" });
const db = getFirestore(app, "default");

const s = await db.collection("kismartApp").doc("state").get();
const st = s.data().state || s.data();
const c = st.contracts.find((x) => x.id === "KIS-5645");
const paid = c.payments.reduce((a, p) => a + Number(p.amount), 0);
console.log("payments:", JSON.stringify(c.payments));
console.log("restriction:", JSON.stringify(c.restriction));
console.log("total paid:", paid, "| balance:", Math.max(100 - paid, 0));
const top = st.syncEvents.filter((e) => e.contractId === "KIS-5645").slice(0, 3).map((e) => ({ provider: e.provider, reference: e.reference, status: e.status, message: e.message }));
console.log("latest events:", JSON.stringify(top, null, 1));
const cs = await db.collection("contacts").doc("KIS-5645").get();
console.log("contacts mirror payments:", JSON.stringify(cs.data().payments));
process.exit(0);
