// End-to-end test: admin-set overdue digits are saved exactly, persist across
// reloads, and are reduced by posted payments (payment cycle). Uses the local
// dev server on :8787. Cleanup restores the test contract to baseline.
const BASE = "http://localhost:8787";
const CONTRACT = "KIS-5493";
let cookie = "";

function j(res) { return res.json(); }

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@kismart.local", password: "kismart-admin" }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("no session cookie returned");
  console.log("[PASS] login ok, cookie:", cookie.slice(0, 24) + "...");
}

async function authed(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { cookie, ...(options.headers || {}) },
    redirect: "manual",
  });
  return res;
}

async function getState() {
  const res = await authed("/api/state");
  if (res.status !== 200) throw new Error(`state failed: ${res.status}`);
  const s = await j(res);
  const c = s.contracts.find((x) => x.id === CONTRACT);
  if (!c) throw new Error(`contract ${CONTRACT} not found in state`);
  return c;
}

async function patch(body) {
  const res = await authed(`/api/contracts/${CONTRACT}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`PATCH failed: ${res.status} ${await res.text()}`);
  return j(res);
}

async function postPayment(amount, reference) {
  const res = await authed(`/api/contracts/${CONTRACT}/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount, method: "Cash", reference, date: new Date().toISOString().slice(0, 10) }),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`payment failed: ${res.status} ${await res.text()}`);
  return j(res);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
}

// 1. UI markup served to admin
const admin = await authed("/admin");
const html = await admin.text();
check("UI: no 'test values' framing", !/test values|OVERRIDES DERIVED/i.test(html), "");
check("UI: 'Overdue &amp; paid' section present", html.includes("Overdue &amp; paid"), "");
check("UI: 2-column dialog body CSS", html.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"), "");
check("UI: dialog max-width 960px", html.includes("max-width: 960px"), "");
check("UI: helper hint present", html.includes("edit-field-hint"), "");

// 2. Baseline
const base = await getState();
check("baseline arrears = 0", base.progress.arrears === 0, `arrears=${base.progress.arrears}, paid=${base.progress.paid}`);

// 3. Set overdue to exactly 1500
const afterSet = await patch({ progress: { overdue: 1500, paid: "" } });
check("set overdue=1500 → saved exact digit", afterSet.progress.arrears === 1500, `arrears=${afterSet.progress.arrears}`);

// 4. Persists across a state reload
const afterReload = await getState();
check("overdue=1500 persists after reload", afterReload.progress.arrears === 1500, `arrears=${afterReload.progress.arrears}`);

// 5. Payment reduces the overdue (payment cycle)
const pay = await postPayment(500, `E2E-TEST-${Date.now()}`);
const afterPay = await getState();
check("payment of 500 → arrears=1000", afterPay.progress.arrears === 1000, `arrears=${afterPay.progress.arrears}, paid=${afterPay.progress.paid}`);
const payId = pay.payment?.id || (Array.isArray(pay) ? pay[0]?.id : null) || (afterPay.payments || []).find((p) => p.reference?.startsWith("E2E-TEST-"))?.id;

// 6. Clear overdue → back to derived (0) and remove test payment
await patch({ progress: { overdue: "", paid: "" } });
if (payId) {
  await patch({ payments: { update: [], remove: [payId], add: [] } });
}
const final = await getState();
check("cleanup: arrears back to 0", final.progress.arrears === 0, `arrears=${final.progress.arrears}`);
check("cleanup: paid back to 0", final.progress.paid === 0, `paid=${final.progress.paid}`);
check("cleanup: test payment removed", (final.payments || []).length === 0, `payments=${(final.payments || []).length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
process.exit(failed.length ? 1 : 0);
