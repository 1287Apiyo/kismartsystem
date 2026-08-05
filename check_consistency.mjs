
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFile } from 'node:fs/promises';

const sa = JSON.parse(await readFile('kismart-456ee-firebase-adminsdk-fbsvc-cb69615c3e.json', 'utf8'));
const app = getApps()[0] || initializeApp({ credential: cert(sa), projectId: 'kismart-456ee' });
const db = getFirestore(app, 'default');

const s = await db.collection('kismartApp').doc('state').get();
const data = s.data();
const st = data.state || data;
console.log('Contract count:', st.contracts.length);
console.log('Contract IDs:', st.contracts.map(c => c.id).join(', '));
const c5452 = st.contracts.find(x => x.id === 'KIS-5452');
const c7406 = st.contracts.find(x => x.id === 'KIS-7406');
console.log('KIS-5452 restriction active:', c5452?.restriction?.active);
console.log('KIS-7406 restriction active:', c7406?.restriction?.active);
process.exit(0);

