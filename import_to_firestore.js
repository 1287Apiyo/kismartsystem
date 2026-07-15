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
  const targetCollection = "contacts";

  const contracts = [
    {
      "id": "KIS-5452",
      "createdAt": "2026-06-04",
      "customer": {
        "name": "Anne Apiyo",
        "phone": "0746821567",
        "nationalId": "39634612",
        "address": "Kabiria Road",
        "branch": "Kisumu",
        "documentName": ""
      },
      "device": {
        "model": "SAMSUNG A15",
        "imei": "357527486213862",
        "serial": "RF8X909BXAK",
        "platform": "Android",
        "controlProfile": "Android device owner",
        "binding": {
          "androidId": "2fd8394f4c0a74cf",
          "brand": "samsung",
          "model": "SAMSUNG A15",
          "sdk": "36",
          "installId": "unknown",
          "fingerprint": "unknown",
          "tokenHash": "unknown",
          "tokenIssuedAt": "2026-06-04T00:00:00.000Z",
          "firstSeenAt": "2026-06-04T00:00:00.000Z",
          "lastSeenAt": "2026-06-04T00:00:00.000Z",
          "lastMismatchAt": null,
          "mismatchCount": 0
        }
      },
      "plan": {
        "devicePrice": 20000,
        "deposit": 10000,
        "installment": 1000,
        "frequency": "Daily",
        "periodCount": 4,
        "graceDays": 2,
        "customDates": []
      },
      "payments": [
        {
          "id": "PAY-mpzo7xlj-ynhppu",
          "date": "2026-06-04",
          "method": "Deposit",
          "reference": "DEP-KIS-5452",
          "amount": 10000,
          "status": "Synced"
        }
      ],
      "warningsSent": [],
      "restriction": {
        "active": false,
        "level": "None",
        "appliedAt": null
      }
    },
    {
      "id": "KIS-7406",
      "createdAt": "2026-06-11",
      "customer": {
        "name": "Taff",
        "phone": "0745050431",
        "nationalId": "39879456",
        "address": "Kisumu",
        "branch": "Kisumu",
        "documentName": "397788654368"
      },
      "device": {
        "model": "Mi 10S",
        "imei": "862375054412518",
        "serial": "703A7C61",
        "platform": "Android",
        "controlProfile": "Android device owner",
        "binding": {
          "androidId": "45f4b1d5062dcb46",
          "brand": "Xiaomi",
          "fingerprint": "Xiaomi/thyme/thyme:13/TKQ1.221114.001/V816.0.4.0.TGACNXM:user/release-keys",
          "firstSeenAt": "2026-06-24T08:38:08.568Z",
          "installId": "c83704f1-bcde-4930-8176-2211706df15c",
          "lastMismatchAt": null,
          "lastSeenAt": "2026-06-24T08:50:30.162Z",
          "manufacturer": "Xiaomi",
          "mismatchCount": 0,
          "model": "M2102J2SC",
          "sdk": "33",
          "tokenHash": "xvwX-3AQMMwsuOxfgXlJTRh1orjV2oRt2mzjypKUXEc",
          "tokenIssuedAt": "2026-06-24T08:38:08.568Z"
        }
      },
      "plan": {
        "devicePrice": 28000,
        "deposit": 10000,
        "installment": 8250,
        "frequency": "Daily",
        "periodCount": 4,
        "graceDays": 2,
        "customDates": []
      },
      "payments": [
        {
          "id": "PAY-mq9796ax-9ewa87",
          "date": "2026-06-11",
          "method": "Deposit",
          "reference": "DEP-KIS-7406",
          "amount": 1000,
          "status": "Synced"
        }
      ],
      "warningsSent": [],
      "restriction": {
        "active": false,
        "level": "None",
        "appliedAt": null
      }
    }
  ];

  console.log(`Importing ${contracts.length} documents into ${targetCollection}...`);

  for (const contract of contracts) {
    console.log(`Importing ${contract.id}...`);
    await db.collection(targetCollection).doc(contract.id).set(contract);
    console.log(`Successfully imported ${contract.id}.`);
  }
}

run().catch(console.error);
