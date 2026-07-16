import { createServer } from "node:http";
// Reconnected to Firestore for kismart-456ee
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

type Frequency = "Daily" | "Weekly" | "Monthly" | "Custom";
type Platform = "Android" | "iOS";
type Status = "Active" | "Overdue" | "Restricted" | "Completed";
type RestrictionLevel = "None" | "Lock screen message" | "Limited access" | "Full lock";
type PaymentMethod = "Deposit" | "M-Pesa" | "Airtel Money" | "Bank" | "Cash";
type SmsProviderMode = "simulate" | "webhook" | "africas-talking";
type IosMdmProviderMode = "simulate" | "webhook";

interface SmsSendResult {
  ok: boolean;
  provider: string;
  reference: string;
  detail: string;
}

interface Customer {
  name: string;
  phone: string;
  nationalId: string;
  address: string;
  branch: string;
  documentName: string;
}

interface Device {
  model: string;
  imei: string;
  serial: string;
  platform: Platform;
  controlProfile: string;
  binding: DeviceBinding | null;
}

interface InventoryDevice {
  id: string;
  createdAt: string;
  model: string;
  imei: string;
  serial: string;
  platform: Platform;
  controlProfile: string;
  price: number;
  notes: string;
  status: "Available" | "Assigned";
  assignedContractId: string | null;
  assignedAt: string | null;
}

interface DeviceBinding {
  installId: string;
  androidId: string;
  fingerprint: string;
  tokenHash: string;
  tokenIssuedAt: string;
  manufacturer: string;
  brand: string;
  model: string;
  sdk: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastMismatchAt: string | null;
  mismatchCount: number;
}

interface Plan {
  devicePrice: number;
  deposit: number;
  installment: number;
  frequency: Frequency;
  periodCount: number;
  graceDays: number;
  customDates: string[];
}

interface Payment {
  id: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  amount: number;
  status: "Pending" | "Synced" | "Failed";
}

interface WarningNotice {
  id: string;
  stage: string;
  date: string;
  amount: number;
  message: string;
}

interface RestrictionState {
  active: boolean;
  level: RestrictionLevel;
  appliedAt: string | null;
}

interface Contract {
  id: string;
  createdAt: string;
  customer: Customer;
  device: Device;
  plan: Plan;
  payments: Payment[];
  warningsSent: WarningNotice[];
  restriction: RestrictionState;
}

interface NotificationRecord {
  id: string;
  time: string;
  contractId: string;
  type: string;
  channel: "SMS" | "In-app" | "System";
  status: "Pending" | "Sent" | "Failed";
  message: string;
}

interface IntakeRecord {
  id: string;
  time: string;
  status: "Pending" | "Converted";
  customerName: string;
  phone: string;
  nationalId: string;
  address: string;
  branch: string;
  notes: string;
  convertedContractId: string | null;
}

interface AuditRecord {
  id: string;
  time: string;
  role: string;
  action: string;
  record: string;
}

interface WarningStage {
  name: string;
  daysAfterDue: number;
  consequence: string;
}

interface DeviceEvent {
  id: string;
  time: string;
  contractId: string;
  imei: string;
  type: "Policy sync" | "Heartbeat" | "Tamper alert" | "Command acknowledged" | "Identity enrolled" | "Identity verified";
  status: "Online" | "Attention" | "Offline";
  message: string;
  metadata: Record<string, string | number | boolean | null>;
}

interface AppState {
  settings: {
    reminderLeadDays: number;
    restrictionGraceDays: number;
    defaultRestrictionLevel: RestrictionLevel;
    warningStages: WarningStage[];
    roles: { name: string; permissions: string[] }[];
    security: { title: string; detail: string }[];
  };
  deviceEvents: DeviceEvent[];
  syncEvents: {
    id: string;
    time: string;
    contractId: string;
    provider: string;
    reference: string;
    status: "Pending" | "Synced" | "Failed";
    message: string;
  }[];
  notifications: NotificationRecord[];
  intakes: IntakeRecord[];
  inventoryDevices: InventoryDevice[];
  audit: AuditRecord[];
  contracts: Contract[];
}

interface Progress {
  paid: number;
  balance: number;
  arrears: number;
  nextDue: string | null;
  nextAmount: number;
  overdueDays: number;
}

function loadLocalEnvFile(path: string) {
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index <= 0) return;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    });
  } catch {
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadLocalEnvFile(join(__dirname, ".env"));
const DATA_DIR = process.env.VERCEL ? join(tmpdir(), "kismart-data") : join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "kismart-state.json");
const PORT = Number(process.env.KISMART_PORT || 8787);
const VERSION = "1.3.0";
const SHOP_NAME = process.env.KISMART_SHOP_NAME || "KISMART Global";
const CALLBACK_SECRET = process.env.KISMART_CALLBACK_SECRET || "";
const DEVICE_SYNC_SECRET = process.env.KISMART_DEVICE_SYNC_SECRET || "";
const ADMIN_EMAIL = process.env.KISMART_ADMIN_EMAIL || "admin@kismart.local";
const ADMIN_PASSWORD = process.env.KISMART_ADMIN_PASSWORD || "kismart-admin";
const SESSION_SECRET = process.env.KISMART_SESSION_SECRET || "local-dev-session-secret";
// Public HTTPS origin phones use from any network (not LAN). Keep this stable in production.
const PUBLIC_BASE_URL = resolvePublicBaseUrl(
  process.env.KISMART_PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "https://kismartsystem.vercel.app"
);
// Binding tokens must not break when only the admin session secret is rotated.
const BINDING_TOKEN_SECRET = String(process.env.KISMART_BINDING_SECRET || DEVICE_SYNC_SECRET || SESSION_SECRET).trim() || SESSION_SECRET;
const SESSION_COOKIE = "kismart_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const STORAGE_MODE = String(process.env.KISMART_STORAGE || "json").trim().toLowerCase();
const FIREBASE_PROJECT_ID = clean(process.env.FIREBASE_PROJECT_ID || "kismart-456ee").replace(/^\uFEFF/, "");
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "";
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
const FIRESTORE_DATABASE = normalizeFirestoreDatabase(process.env.KISMART_FIRESTORE_DATABASE || "");
const FIRESTORE_COLLECTION = process.env.KISMART_FIRESTORE_COLLECTION || "kismartApp";
const FIRESTORE_DOCUMENT = process.env.KISMART_FIRESTORE_DOCUMENT || "state";
const FIRESTORE_SETTINGS_COLLECTION = process.env.KISMART_FIRESTORE_SETTINGS_COLLECTION || "settings";
const FIRESTORE_SETTINGS_DOCUMENT = process.env.KISMART_FIRESTORE_SETTINGS_DOCUMENT || "main";
const FIRESTORE_RECORD_COLLECTIONS = {
  contracts: process.env.KISMART_FIRESTORE_CONTRACTS_COLLECTION || "contracts",
  intakes: process.env.KISMART_FIRESTORE_INTAKES_COLLECTION || "intakes",
  notifications: process.env.KISMART_FIRESTORE_NOTIFICATIONS_COLLECTION || "notifications",
  syncEvents: process.env.KISMART_FIRESTORE_SYNC_EVENTS_COLLECTION || "syncEvents",
  deviceEvents: process.env.KISMART_FIRESTORE_DEVICE_EVENTS_COLLECTION || "deviceEvents",
  inventoryDevices: process.env.KISMART_FIRESTORE_INVENTORY_DEVICES_COLLECTION || "inventoryDevices",
  audit: process.env.KISMART_FIRESTORE_AUDIT_COLLECTION || "audit",
};
const SMS_PROVIDER = normalizeSmsProviderName(process.env.KISMART_SMS_PROVIDER || "simulate");
const SMS_DEFAULT_COUNTRY_CODE = cleanDigits(process.env.KISMART_SMS_DEFAULT_COUNTRY_CODE || "254");
const SMS_SENDER = clean(process.env.KISMART_SMS_SENDER || process.env.AFRICASTALKING_SENDER_ID || process.env.AFRICAS_TALKING_SENDER_ID);
const SMS_WEBHOOK_URL = clean(process.env.KISMART_SMS_WEBHOOK_URL);
const SMS_WEBHOOK_TOKEN = clean(process.env.KISMART_SMS_WEBHOOK_TOKEN);
const AFRICAS_TALKING_USERNAME = clean(process.env.AFRICASTALKING_USERNAME || process.env.AFRICAS_TALKING_USERNAME);
const AFRICAS_TALKING_API_KEY = clean(process.env.AFRICASTALKING_API_KEY || process.env.AFRICAS_TALKING_API_KEY);
const AFRICAS_TALKING_ENV = clean(process.env.AFRICASTALKING_ENV || process.env.KISMART_SMS_ENV || "production").toLowerCase();
const IOS_MDM_PROVIDER = normalizeIosMdmProviderName(process.env.KISMART_IOS_MDM_PROVIDER || "simulate");
const IOS_MDM_WEBHOOK_URL = clean(process.env.KISMART_IOS_MDM_WEBHOOK_URL);
const IOS_MDM_WEBHOOK_TOKEN = clean(process.env.KISMART_IOS_MDM_WEBHOOK_TOKEN);
const PAYBILL_ENABLED = (process.env.KISMART_PAYBILL_ENABLED || "false").toLowerCase() === "true";
const PAYBILL_BUSINESS_NUMBER = clean(process.env.KISMART_PAYBILL_BUSINESS_NUMBER || "400200");
const PAYBILL_ACCOUNT_NUMBER = clean(process.env.KISMART_PAYBILL_ACCOUNT_NUMBER || "1171170");
const PAYBILL_BUSINESS_NAME = clean(process.env.KISMART_PAYBILL_BUSINESS_NAME || "KISMART GLOBAL");
const PAYBILL_API_KEY = clean(process.env.KISMART_PAYBILL_API_KEY);
const PAYBILL_API_SECRET = clean(process.env.KISMART_PAYBILL_API_SECRET);
const PAYBILL_PASSKEY = clean(process.env.KISMART_PAYBILL_PASSKEY);
const PAYBILL_CALLBACK_URL = clean(process.env.KISMART_PAYBILL_CALLBACK_URL);
const MPESA_API_BASE_URL = (process.env.KISMART_MPESA_API_BASE_URL || "https://api.safaricom.co.ke").replace(/\/$/, "");
const DEFAULT_PAYMENT_APP_PACKAGES = ["com.safaricom.mpesa", "com.safaricom.mpesa.lifestyle", "ke.co.safaricom.mpesa"];
const PAYMENT_APP_PACKAGES = paymentAppPackagesFromEnv(process.env.KISMART_PAYMENT_APP_PACKAGES);
const ANDROID_AGENT_PACKAGE = "africa.volo.kismart.agent";
const FIRESTORE_OPERATION_TIMEOUT_MS = numberFrom(process.env.KISMART_FIRESTORE_TIMEOUT_MS, 5000);

const ROLE_PERMISSIONS: Record<string, string[]> = {
  Admin: ["contracts.write", "payments.write", "notices.write", "restrictions.write", "reports.read"],
  "Branch Manager": ["contracts.write", "payments.write", "notices.write", "reports.read"],
  Cashier: ["payments.write", "reports.read"],
  "Support Agent": ["notices.write", "restrictions.write", "reports.read"],
};

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type DeviceIdentityInput = {
  installId: string;
  androidId: string;
  fingerprint: string;
  bindingToken: string;
  manufacturer: string;
  brand: string;
  model: string;
  sdk: string;
};

type RuntimeSaveChanges = {
  syncEventIds?: string[];
  deviceEventIds?: string[];
  contractIds?: string[];
  notificationIds?: string[];
  auditIds?: string[];
};

type AutomaticPaymentControlResult = {
  changed: boolean;
  actions: { contractId: string; type: string; message: string }[];
  changes: RuntimeSaveChanges;
};

let cachedState: AppState | null = null;
let cachedJsonMtimeMs = 0;
const eventClients = new Set<any>();
let firestoreDb: any = null;
let firestoreStateDoc: any = null;
let firestoreUnavailable = false;
let firestoreLastError: string | null = null;
let automaticPaymentControlRunning = false;
let automaticPaymentControlLoopStarted = false;
let runtimeReady: Promise<void> | null = null;

const isMainModule = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMainModule && process.argv.includes("--self-test")) {
  await runSelfTest();
} else if (isMainModule) {
  await startServer(PORT);
}

async function startServer(port: number) {
  await prepareRuntime({ startBackgroundJobs: true });

  const server = createServer(handleRequest);

  // Bind all interfaces so LAN and reverse-proxy / tunnel traffic can reach the API.
  server.listen(port, "0.0.0.0", () => {
    console.log(`KISMART backend running at http://0.0.0.0:${port}`);
    console.log(`Public device control URL: ${PUBLIC_BASE_URL}`);
    console.log(`Storage mode: ${isFirestoreStorage() ? `Firestore (${FIREBASE_PROJECT_ID}/${FIRESTORE_DATABASE || "(default)"}/top-level collections)` : `JSON (${DATA_FILE})`}`);
  });
}

async function prepareRuntime(options: { startBackgroundJobs?: boolean } = {}) {
  if (!runtimeReady) {
    runtimeReady = loadState().then(() => undefined);
  }
  await runtimeReady;
  if (options.startBackgroundJobs) {
    startAutomaticPaymentControlLoop();
  }
}

export default async function handleRequest(request: any, response: any) {
  try {
    await prepareRuntime();
    await routeRequest(request, response);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    sendJson(response, statusCode, {
      error: statusCode === 500 ? "Internal server error" : "Request failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function routeRequest(request: any, response: any) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    sendEmpty(response, 204);
    return;
  }

  if (method === "GET" && (url.pathname === "/api/health" || url.pathname === "/health")) {
    sendJson(response, 200, {
      ok: true,
      service: SHOP_NAME,
      version: VERSION,
      publicBaseUrl: PUBLIC_BASE_URL,
      storage: isFirestoreStorage() ? "firestore" : "json",
      time: nowIso(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    sendHtml(response, renderSaasLanding());
    return;
  }

  if (method === "GET" && url.pathname === "/admin") {
    if (!getAdminSession(request)) {
      sendRedirect(response, "/login");
      return;
    }
    sendHtml(response, renderDashboard());
    return;
  }

  if (method === "GET" && url.pathname === "/login") {
    if (getAdminSession(request)) {
      sendRedirect(response, "/admin");
      return;
    }
    sendHtml(response, renderLogin());
    return;
  }

  if (method === "GET" && url.pathname === "/intake") {
    sendHtml(response, renderCustomerIntake());
    return;
  }

  if (method === "POST" && url.pathname === "/intake") {
    const body = await readForm(request);
    const state = await loadState();
    const intake = createIntakeFromForm(body);
    validateIntakePayload(intake);
    state.intakes.unshift(intake);
    await saveState(state);
    sendHtml(response, renderCustomerIntake("received"));
    return;
  }

  if (method === "POST" && url.pathname === "/login") {
    const body = await readForm(request);
    if (!isValidAdminLogin(body.get("email") || "", body.get("password") || "")) {
      sendHtml(response, renderLogin("Invalid admin email or password."), 401);
      return;
    }
    const token = createAdminSession(ADMIN_EMAIL);
    sendRedirect(response, "/admin", { "Set-Cookie": sessionCookie(token) });
    return;
  }

  if (method === "POST" && url.pathname === "/logout") {
    clearAdminSession(request);
    sendRedirect(response, "/", { "Set-Cookie": clearSessionCookie() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/auth/session") {
    const session = getAdminSession(request);
    sendJson(response, 200, { authenticated: Boolean(session), email: session?.email || null });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    if (!isValidAdminLogin(body.email || "", body.password || "")) {
      sendJson(response, 401, { error: "Invalid admin email or password" });
      return;
    }
    const token = createAdminSession(ADMIN_EMAIL);
    sendJson(response, 200, { ok: true, redirect: "/admin" }, { "Set-Cookie": sessionCookie(token) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    clearAdminSession(request);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    return;
  }

  if (method === "GET" && /^(\/assets\/feature-(register|payment|arrears|sync)|\/assets\/landing-hero-bg)\.jpg$/.test(url.pathname)) {
    const fileName = url.pathname.split("/").pop() || "";
    const filePath = join(__dirname, "assets", fileName);
    if (!existsSync(filePath)) {
      sendJson(response, 404, { error: "Image not found" });
      return;
    }
    sendBinary(response, 200, "image/jpeg", await readFile(filePath));
    return;
  }

  if (method === "GET" && url.pathname === "/assets/app.css") {
    sendText(response, 200, "text/css; charset=utf-8", renderStyles());
    return;
  }

  if (method === "GET" && url.pathname === "/assets/app.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", renderClientScript());
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: `${SHOP_NAME} Installment Management Backend`,
      version: VERSION,
      storageMode: isFirestoreStorage() ? "firestore" : "json",
      firestoreLastError: firestoreLastError,
      time: nowIso(),
    });
    return;
  }

  if (url.pathname.startsWith("/api/") && requiresAdminAuth(url.pathname)) {
    assertAdminSession(request);
  }

  if (method === "GET" && url.pathname === "/api/events") {
    openEventStream(request, response);
    return;
  }

  if (method === "GET" && url.pathname === "/api/state") {
    const state = await loadState();
    sendJson(response, 200, buildPublicState(state));
    return;
  }

  if (method === "GET" && url.pathname === "/api/contracts") {
    const state = await loadState();
    sendJson(response, 200, state.contracts.map(enrichContract));
    return;
  }

  if (method === "GET" && url.pathname === "/api/inventory-devices") {
    const state = await loadState();
    sendJson(response, 200, state.inventoryDevices.map((device) => enrichInventoryDevice(state, device)));
    return;
  }

  if (method === "POST" && url.pathname === "/api/inventory-devices") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "contracts.write");
    const state = await loadState();
    validateInventoryDevicePayload(state, body);
    const device = createInventoryDeviceFromPayload(body);
    state.inventoryDevices.unshift(device);
    addAudit(state, body.role || "Admin", "Inventory device added", `${device.model} - ${device.imei || device.serial || device.id}`);
    await saveState(state);
    sendJson(response, 201, enrichInventoryDevice(state, device));
    return;
  }

  if (method === "POST" && url.pathname === "/api/contracts") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "contracts.write");
    const state = await loadState();
    validateContractPayload(state, body);
    const contract = createContractFromPayload(body);
    state.contracts.unshift(contract);
    markIntakeConverted(state, body.intakeId, contract.id);
    markInventoryDeviceAssigned(state, body.inventoryDeviceId, contract);
    addAudit(state, body.role || "Admin", "Contract created", contract.id);
    await saveState(state);
    sendJson(response, 201, enrichContract(contract));
    return;
  }

  const contractDeleteMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)$/);
  if (method === "DELETE" && contractDeleteMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "contracts.write");
    const state = await loadState();
    const contractId = decodeURIComponent(contractDeleteMatch[1]);
    const index = state.contracts.findIndex((contract) => contract.id === contractId);
    if (index < 0) throw new HttpError(404, `Contract ${contractId} not found`);
    const [contract] = state.contracts.splice(index, 1);
    state.notifications = state.notifications.filter((notice) => notice.contractId !== contract.id);
    state.syncEvents = state.syncEvents.filter((event) => event.contractId !== contract.id);
    state.deviceEvents = state.deviceEvents.filter((event) => event.contractId !== contract.id && event.imei !== contract.device.imei);
    state.intakes.forEach((intake) => {
      if (intake.convertedContractId === contract.id) {
        intake.status = "Pending";
        intake.convertedContractId = "";
      }
    });
    releaseInventoryDevice(state, contract.id);
    addAudit(state, body.role || "Admin", "Contract deleted", `${contract.id} - ${contract.customer.name}`);
    await saveState(state);
    sendJson(response, 200, { ok: true, deleted: contract.id });
    return;
  }

  const inventoryDeleteMatch = url.pathname.match(/^\/api\/inventory-devices\/([^/]+)$/);
  if (method === "DELETE" && inventoryDeleteMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "contracts.write");
    const state = await loadState();
    const deviceId = decodeURIComponent(inventoryDeleteMatch[1]);
    const index = state.inventoryDevices.findIndex((device) => device.id === deviceId);
    if (index < 0) throw new HttpError(404, `Inventory device ${deviceId} not found`);
    const targetDevice = state.inventoryDevices[index];
    const linkedContract = state.contracts.find((contract) => contract.id === targetDevice.assignedContractId || (!!targetDevice.imei && contract.device.imei === targetDevice.imei) || (!!targetDevice.serial && contract.device.serial === targetDevice.serial));
    if (linkedContract) throw new HttpError(409, `Device is assigned to contract ${linkedContract.id}`);
    const [device] = state.inventoryDevices.splice(index, 1);
    addAudit(state, body.role || "Admin", "Inventory device deleted", `${device.model} - ${device.imei || device.serial || device.id}`);
    await saveState(state);
    sendJson(response, 200, { ok: true, deleted: device.id });
    return;
  }

  const intakeDeleteMatch = url.pathname.match(/^\/api\/intakes\/([^/]+)$/);
  if (method === "DELETE" && intakeDeleteMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "contracts.write");
    const state = await loadState();
    const intakeId = decodeURIComponent(intakeDeleteMatch[1]);
    const index = state.intakes.findIndex((intake) => intake.id === intakeId);
    if (index < 0) throw new HttpError(404, `Intake ${intakeId} not found`);
    const [intake] = state.intakes.splice(index, 1);
    addAudit(state, body.role || "Admin", "Customer intake deleted", `${intake.customerName} - ${intake.phone}`);
    await saveState(state);
    sendJson(response, 200, { ok: true, deleted: intake.id });
    return;
  }

  const paymentMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)\/payments$/);
  if (method === "POST" && paymentMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Cashier", "payments.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, paymentMatch[1]);
    validatePaymentPayload(body);
    const methodName = normalizePaymentMethod(body.method || "M-Pesa");
    const reference = clean(body.reference || `MANUAL-${Date.now()}`);
    const existingPayment = findPaymentByReference(state, reference, methodName);
    if (existingPayment) {
      sendJson(response, 200, { duplicate: true, payment: existingPayment.payment, contract: enrichContract(existingPayment.contract) });
      return;
    }
    const payment = addPayment(contract, {
      amount: numberFrom(body.amount),
      method: methodName,
      reference,
      date: clean(body.date || todayIso()),
      status: "Synced",
    });
    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: contract.id,
      provider: payment.method,
      reference: payment.reference,
      status: "Synced",
      message: `${formatKes(payment.amount)} allocated to ${contract.customer.name}`,
    });
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (automaticControls.changed) {
      await dispatchPendingDeviceCommands(state, 25);
    }
    addAudit(state, body.role || "Cashier", "Payment recorded", `${contract.id} - ${formatKes(payment.amount)}`);
    await saveState(state);
    sendJson(response, 201, { payment, contract: enrichContract(contract) });
    return;
  }

  if (method === "POST" && ["/api/payments/mpesa-callback", "/api/payments/airtel-callback"].includes(url.pathname)) {
    assertCallbackSecret(request);
    const body = await readJson(request);
    const state = await loadState();
    const contract = resolveContractForCallback(state, body);
    if (!contract) {
      sendJson(response, 404, { error: "No matching contract found for callback" });
      return;
    }
    const provider: PaymentMethod = url.pathname.includes("mpesa") ? "M-Pesa" : "Airtel Money";
    validatePaymentPayload(body);
    const callbackReference = clean(body.reference || body.transactionCode || `CALLBACK-${Date.now()}`);
    const existingPayment = findPaymentByReference(state, callbackReference, provider);
    if (existingPayment) {
      sendJson(response, 200, { duplicate: true, payment: existingPayment.payment, contract: enrichContract(existingPayment.contract) });
      return;
    }
    const payment = addPayment(contract, {
      amount: numberFrom(body.amount),
      method: provider,
      reference: callbackReference,
      date: clean(body.date || todayIso()),
      status: "Synced",
    });
    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: contract.id,
      provider,
      reference: payment.reference,
      status: "Synced",
      message: `${provider} callback reconciled automatically`,
    });
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (automaticControls.changed) {
      await dispatchPendingDeviceCommands(state, 25);
    }
    addAudit(state, "System", `${provider} callback processed`, contract.id);
    await saveState(state);
    sendJson(response, 200, { payment, contract: enrichContract(contract) });
    return;
  }

  // PayBill callback endpoint - handles real M-Pesa payment confirmations
  if (method === "POST" && url.pathname === "/api/payments/paybill-callback") {
    const body = await readJson(request);
    const stk = parseMpesaStkCallback(body);

    if (stk) {
      // Safaricom STK Push callback structure detected
      const state = await loadState();
      const contract = resolveContractByMpesaReference(state, stk.checkoutRequestId);
      if (!contract) {
        state.syncEvents.unshift({
          id: uid("SYNC"),
          time: nowIso(),
          contractId: "UNKNOWN",
          provider: "M-Pesa STK",
          reference: stk.checkoutRequestId,
          status: "Failed",
          message: `STK callback received but no matching contract found for CheckoutID: ${stk.checkoutRequestId}`,
        });
        await saveState(state);
        sendJson(response, 200, { ResultCode: 0, ResultDesc: "Success (Unmatched)" });
        return;
      }

      if (stk.resultCode !== 0) {
        state.syncEvents.unshift({
          id: uid("SYNC"),
          time: nowIso(),
          contractId: contract.id,
          provider: "M-Pesa STK",
          reference: stk.checkoutRequestId,
          status: "Failed",
          message: `STK Push cancelled or failed: ${stk.resultDesc} (${stk.resultCode})`,
        });
        await saveState(state);
        sendJson(response, 200, { ResultCode: 0, ResultDesc: "Success (Failure recorded)" });
        return;
      }

      // Successful STK Push payment
      const existingPayment = findPaymentByReference(state, stk.receiptNumber, "M-Pesa");
      if (existingPayment) {
        sendJson(response, 200, { ResultCode: 0, ResultDesc: "Success (Duplicate)" });
        return;
      }

      const payment = addPayment(contract, {
        amount: stk.amount,
        method: "M-Pesa",
        reference: stk.receiptNumber,
        date: todayIso(),
        status: "Synced",
      });
      state.syncEvents.unshift({
        id: uid("SYNC"),
        time: nowIso(),
        contractId: contract.id,
        provider: "M-Pesa STK",
        reference: stk.checkoutRequestId,
        status: "Synced",
        message: `STK Push payment confirmed - ${stk.receiptNumber} for ${formatKes(stk.amount)}`,
      });
      const automaticControls = applyAutomaticPaymentControls(state, [contract]);
      if (automaticControls.changed) {
        await dispatchPendingDeviceCommands(state, 25);
      }
      addAudit(state, "System", "STK Push payment confirmed", `${contract.id} - ${formatKes(payment.amount)} (${stk.receiptNumber})`);
      await saveState(state);
      sendJson(response, 200, { ResultCode: 0, ResultDesc: "Success" });
      return;
    }

    // Normal PayBill (C2B) callback handling
    assertCallbackSecret(request);
    const state = await loadState();
    // Try to resolve contract by account number + reference or phone number
    let contract = null;
    if (body.accountNumber === PAYBILL_ACCOUNT_NUMBER) {
      contract = resolveContractForCallback(state, body);
    }
    if (!contract) {
      // Log failed callback for manual investigation
      state.syncEvents.unshift({
        id: uid("SYNC"),
        time: nowIso(),
        contractId: "UNKNOWN",
        provider: "M-Pesa PayBill",
        reference: clean(body.transactionCode || body.reference || "UNKNOWN"),
        status: "Failed",
        message: `PayBill callback received but no matching contract found. Amount: ${numberFrom(body.amount, 0)}, Phone: ${clean(body.phoneNumber || "")}`,
      });
      await saveState(state);
      sendJson(response, 404, { error: "No matching contract found for PayBill callback", reference: body.transactionCode });
      return;
    }
    validatePaymentPayload(body);
    const transactionRef = clean(body.transactionCode || `PAYBILL-${Date.now()}`);
    const existingPayment = findPaymentByReference(state, transactionRef, "M-Pesa");
    if (existingPayment) {
      sendJson(response, 200, { duplicate: true, payment: existingPayment.payment, contract: enrichContract(existingPayment.contract) });
      return;
    }
    const payment = addPayment(contract, {
      amount: numberFrom(body.amount),
      method: "M-Pesa",
      reference: transactionRef,
      date: clean(body.completedTime || body.transactionDate || todayIso()),
      status: "Synced",
    });
    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: contract.id,
      provider: "M-Pesa PayBill",
      reference: payment.reference,
      status: "Synced",
      message: `PayBill payment confirmed - Account ${PAYBILL_ACCOUNT_NUMBER}/${PAYBILL_BUSINESS_NUMBER} received ${formatKes(payment.amount)}`,
    });
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (automaticControls.changed) {
      await dispatchPendingDeviceCommands(state, 25);
    }
    addAudit(state, "System", "PayBill callback processed", `${contract.id} - ${formatKes(payment.amount)}`);
    await saveState(state);
    sendJson(response, 200, { payment, contract: enrichContract(contract) });
    return;
  }

  const reminderMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)\/reminders$/);
  if (method === "POST" && reminderMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Support Agent", "notices.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, reminderMatch[1]);
    const notice = queueReminder(state, contract, body.type || "Payment reminder");
    addAudit(state, body.role || "Support Agent", "Reminder queued", contract.id);
    await saveState(state);
    sendJson(response, 201, notice);
    return;
  }

  const warningMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)\/warnings$/);
  if (method === "POST" && warningMatch) {
    const body = await readJson(request);
    assertRole(body.role || "Support Agent", "notices.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, warningMatch[1]);
    const warning = issueWarning(state, contract);
    addAudit(state, body.role || "Support Agent", `${warning.stage} queued`, contract.id);
    await saveState(state);
    sendJson(response, 201, { warning, contract: enrichContract(contract) });
    return;
  }

  const restrictionMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)\/restrictions$/);
  if (restrictionMatch && method === "POST") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "restrictions.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, restrictionMatch[1]);
    applyRestriction(state, contract, normalizeRestrictionLevel(body.level || "Full lock"));
    const mdmDispatch = await dispatchPendingDeviceCommands(state, 25);
    addAudit(state, body.role || "Admin", "Device restriction applied", `${contract.id} - ${contract.restriction.level}`);
    await saveState(state);
    sendJson(response, 200, { contract: enrichContract(contract), mdmDispatch });
    return;
  }

  if (restrictionMatch && method === "DELETE") {
    assertRole(url.searchParams.get("role") || "Admin", "restrictions.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, restrictionMatch[1]);
    restoreDevice(state, contract, "Manual restoration");
    const mdmDispatch = await dispatchPendingDeviceCommands(state, 25);
    await saveState(state);
    sendJson(response, 200, { contract: enrichContract(contract), mdmDispatch });
    return;
  }

  const deviceBindingMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)\/device-binding$/);
  if (deviceBindingMatch && method === "DELETE") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "restrictions.write");
    const state = await loadState();
    const contract = findContractOrThrow(state, decodeURIComponent(deviceBindingMatch[1]));
    contract.device.binding = null;
    addAudit(state, body.role || "Admin", "Device identity binding reset", `${contract.id} - ${contract.device.imei}`);
    await saveState(state);
    sendJson(response, 200, enrichContract(contract));
    return;
  }

  if (method === "GET" && url.pathname === "/api/reports/summary") {
    const state = await loadState();
    sendJson(response, 200, getSummary(state));
    return;
  }

  if (method === "GET" && url.pathname === "/api/reports/branches") {
    const state = await loadState();
    sendJson(response, 200, getBranchPerformance(state));
    return;
  }

  if (method === "GET" && url.pathname === "/api/readiness") {
    const state = await loadState();
    sendJson(response, 200, getReadiness(state));
    return;
  }

  if (method === "GET" && url.pathname === "/api/export/contracts.csv") {
    const state = await loadState();
    sendText(response, 200, "text/csv; charset=utf-8", buildContractsCsv(state));
    return;
  }

  if (method === "GET" && url.pathname === "/api/audit") {
    const state = await loadState();
    sendJson(response, 200, state.audit);
    return;
  }

  if (method === "POST" && url.pathname === "/api/automation/run") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "restrictions.write");
    const state = await loadState();
    const result = runAutomation(state);
    const mdmDispatch = await dispatchPendingDeviceCommands(state, numberFrom(body.limit, 50));
    addAudit(state, body.role || "Admin", "Automation run", `${result.actions.length} action(s) completed, ${mdmDispatch.synced} Apple MDM command(s) dispatched`);
    await saveState(state);
    sendJson(response, 200, { ...result, mdmDispatch });
    return;
  }

  if (method === "POST" && url.pathname === "/api/notifications/dispatch") {
    const body = await readJson(request);
    assertRole(body.role || "Support Agent", "notices.write");
    const state = await loadState();
    const result = await dispatchPendingNotifications(state, numberFrom(body.limit, 50));
    addAudit(state, body.role || "Support Agent", "Notifications dispatched", `${result.sent} sent, ${result.failed} failed, ${result.pending} pending`);
    await saveState(state);
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && url.pathname === "/api/device-commands/dispatch") {
    const body = await readJson(request);
    assertRole(body.role || "Admin", "restrictions.write");
    const state = await loadState();
    const result = await dispatchPendingDeviceCommands(state, numberFrom(body.limit, 50));
    addAudit(state, body.role || "Admin", "Apple MDM commands dispatched", `${result.synced} synced, ${result.failed} failed, ${result.pending} pending`);
    await saveState(state);
    sendJson(response, 200, result);
    return;
  }

  const devicePolicyMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/policy$/);
  if (method === "GET" && devicePolicyMatch) {
    assertDeviceSecret(request);
    const state = await loadState();
    const contract = findContractByImeiOrThrow(state, decodeURIComponent(devicePolicyMatch[1]));
    const identityCheck = verifyDeviceIdentity(state, contract, readDeviceIdentity(request), "Policy pull");
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (!identityCheck.allowed) {
      queueDeviceRuntimeSave(state, mergeRuntimeSaveChanges(identityCheck.changes, automaticControls.changes));
      sendJson(response, 423, { error: "Device identity mismatch", detail: identityCheck.detail });
      return;
    }
    queueDeviceRuntimeSave(state, mergeRuntimeSaveChanges(identityCheck.changes, automaticControls.changes));
    sendJson(response, 200, buildDevicePolicy(state, contract, identityCheck.bindingToken));
    return;
  }

  const deviceSyncMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/sync$/);
  if (method === "POST" && deviceSyncMatch) {
    assertDeviceSecret(request);
    const body = await readJson(request);
    const state = await loadState();
    const contract = findContractByImeiOrThrow(state, decodeURIComponent(deviceSyncMatch[1]));
    const deviceEventIdsBefore = new Set(state.deviceEvents.map((event) => event.id));
    const identityCheck = verifyDeviceIdentity(state, contract, readDeviceIdentity(request, body), "Policy sync");
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (!identityCheck.allowed) {
      queueDeviceRuntimeSave(state, mergeRuntimeSaveChanges(identityCheck.changes, automaticControls.changes));
      sendJson(response, 423, { error: "Device identity mismatch", detail: identityCheck.detail });
      return;
    }
    const appliedCommands = acknowledgeDeviceCommands(state, contract, readAppliedDeviceCommandIds(body));
    const commands = currentPendingDeviceCommands(state, contract).map(deviceCommandPayload);
    const policySyncEvent = recordDeviceEvent(state, contract, "Policy sync", "Online", clean(body.message || "Device synced with backend policy"), {
      appVersion: clean(body.appVersion || "unknown"),
      network: clean(body.network || "unknown"),
      battery: numberFrom(body.battery, 0),
      commandsDelivered: commands.length,
      commandsApplied: appliedCommands.length,
      identity: contract.device.binding ? "verified" : "pending",
      offlineSafe: true,
    });
    queueDeviceRuntimeSave(state, mergeRuntimeSaveChanges(identityCheck.changes, automaticControls.changes, {
      syncEventIds: appliedCommands.map((command) => command.id),
      deviceEventIds: state.deviceEvents
        .filter((event) => event.id === policySyncEvent.id || !deviceEventIdsBefore.has(event.id))
        .map((event) => event.id),
    }));
    sendJson(response, 200, {
      policy: buildDevicePolicy(state, contract, identityCheck.bindingToken),
      commands,
      appliedCommands,
      delivery: {
        mode: "queued-until-device-sync",
        detail: commands.length
          ? "Admin command delivered to this device sync. The agent will confirm it on the next successful sync."
          : "No pending admin command for this device.",
      },
    });
    return;
  }

  const deviceStkTestMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/stk-test$/);
  if (method === "POST" && deviceStkTestMatch) {
    assertDeviceSecret(request);
    const body = await readJson(request);
    const state = await loadState();
    const contract = findContractByImeiOrThrow(state, decodeURIComponent(deviceStkTestMatch[1]));
    const identityCheck = verifyDeviceIdentity(state, contract, readDeviceIdentity(request, body), "STK test");
    if (!identityCheck.allowed) {
      queueDeviceRuntimeSave(state, identityCheck.changes);
      sendJson(response, 423, { error: "Device identity mismatch", detail: identityCheck.detail });
      return;
    }
    const progress = getProgress(contract);
    const fallbackAmount = progress.arrears > 0 ? progress.arrears : Math.min(progress.balance, progress.nextAmount || contract.plan.installment || 1000);
    const amount = Math.min(progress.balance, Math.max(0, Math.round(numberFrom(body.amount, fallbackAmount))));
    if (amount <= 0) {
      throw new HttpError(400, "No outstanding balance is available for STK test payment");
    }
    const reference = clean(body.reference || uid("STK-TEST"));
    const payment = addPayment(contract, {
      date: todayIso(),
      method: "M-Pesa",
      reference,
      amount,
      status: "Synced",
    });
    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: contract.id,
      provider: "M-Pesa STK Test",
      reference,
      status: "Synced",
      message: `${formatKes(amount)} fake STK payment recorded from KISMART agent`,
    });
    recordDeviceEvent(state, contract, "Heartbeat", "Online", `Fake STK payment prompt completed for ${formatKes(amount)}`, {
      appVersion: clean(body.appVersion || "unknown"),
      reference,
      amount,
      identity: "verified",
    });
    applyAutomaticPaymentControls(state, [contract]);
    addAudit(state, "Device Agent", "Fake STK payment recorded", `${contract.id} - ${formatKes(amount)}`);
    await saveState(state);
    sendJson(response, 201, { payment, contract: enrichContract(contract), policy: buildDevicePolicy(state, contract, identityCheck.bindingToken) });
    return;
  }

  // PayBill STK Push endpoint - real M-Pesa payment integration
  const devicePaybillMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/paybill-stk$/);
  if (method === "POST" && devicePaybillMatch) {
    assertDeviceSecret(request);
    const body = await readJson(request);
    const state = await loadState();
    const contract = findContractByImeiOrThrow(state, decodeURIComponent(devicePaybillMatch[1]));
    const identityCheck = verifyDeviceIdentity(state, contract, readDeviceIdentity(request, body), "PayBill STK");
    if (!identityCheck.allowed) {
      queueDeviceRuntimeSave(state, identityCheck.changes);
      sendJson(response, 423, { error: "Device identity mismatch", detail: identityCheck.detail });
      return;
    }
    if (!PAYBILL_ENABLED) {
      throw new HttpError(503, "PayBill integration is not enabled. Enable KISMART_PAYBILL_ENABLED in environment.");
    }
    const progress = getProgress(contract);
    const fallbackAmount = progress.arrears > 0 ? progress.arrears : Math.min(progress.balance, progress.nextAmount || contract.plan.installment || 1000);
    const amount = Math.min(progress.balance, Math.max(100, Math.round(numberFrom(body.amount, fallbackAmount))));
    if (amount <= 0) {
      throw new HttpError(400, "No outstanding balance is available for payment");
    }

    const phoneNumber = clean(body.phoneNumber || contract.customer.phone);
    const reference = clean(body.reference || uid("PAYBILL"));

    // Initiate real M-Pesa STK push using Safaricom API
    let stkResult: any;
    try {
      stkResult = await initiateMpesaStkPush(phoneNumber, amount, PAYBILL_ACCOUNT_NUMBER);
    } catch (error) {
      state.syncEvents.unshift({
        id: uid("SYNC"),
        time: nowIso(),
        contractId: contract.id,
        provider: "M-Pesa PayBill",
        reference,
        status: "Failed",
        message: `PayBill STK prompt failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      await saveState(state);
      throw error;
    }

    const checkoutRequestId = stkResult.CheckoutRequestID || reference;
    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: contract.id,
      provider: "M-Pesa PayBill",
      reference: checkoutRequestId,
      status: "Pending",
      message: `PayBill STK prompt initiated - ${PAYBILL_BUSINESS_NUMBER}/${PAYBILL_ACCOUNT_NUMBER} for ${formatKes(amount)} on ${phoneNumber}`,
    });
    recordDeviceEvent(state, contract, "Heartbeat", "Online", `PayBill STK prompt initiated for ${formatKes(amount)} to ${phoneNumber}`, {
      appVersion: clean(body.appVersion || "unknown"),
      reference: checkoutRequestId,
      amount,
      phoneNumber,
      paybillNumber: PAYBILL_BUSINESS_NUMBER,
      accountNumber: PAYBILL_ACCOUNT_NUMBER,
      identity: "verified",
    });
    addAudit(state, "Device Agent", "PayBill STK initiated", `${contract.id} - ${formatKes(amount)} to ${phoneNumber} (CheckoutID: ${checkoutRequestId})`);
    await saveState(state);
    sendJson(response, 202, {
      message: "PayBill STK prompt sent. Waiting for customer to confirm on M-Pesa.",
      reference: checkoutRequestId,
      amount,
      phoneNumber,
      paybill: PAYBILL_BUSINESS_NUMBER,
      account: PAYBILL_ACCOUNT_NUMBER,
      stkResult,
    });
    return;
  }

  const deviceTamperMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/tamper$/);
  if (method === "POST" && deviceTamperMatch) {
    assertDeviceSecret(request);
    const body = await readJson(request);
    const state = await loadState();
    const contract = findContractByImeiOrThrow(state, decodeURIComponent(deviceTamperMatch[1]));
    const identityCheck = verifyDeviceIdentity(state, contract, readDeviceIdentity(request, body), "Tamper report");
    if (!identityCheck.allowed) {
      queueDeviceRuntimeSave(state, identityCheck.changes);
      sendJson(response, 423, { error: "Device identity mismatch", detail: identityCheck.detail });
      return;
    }
    const reason = clean(body.reason || "Device agent reported a tamper or removal attempt");
    recordDeviceEvent(state, contract, "Tamper alert", "Attention", reason, {
      appVersion: clean(body.appVersion || "unknown"),
      network: clean(body.network || "unknown"),
      attemptedRemoval: Boolean(body.attemptedRemoval),
      identity: "verified",
    });
    state.notifications.unshift({
      id: uid("NTC"),
      time: nowIso(),
      contractId: contract.id,
      type: "Tamper alert",
      channel: "System",
      status: "Pending",
      message: `${contract.customer.name} device ${contract.device.imei}: ${reason}`,
    });
    addAudit(state, "Device Agent", "Tamper alert received", contract.id);
    await saveState(state);
    sendJson(response, 201, { event: state.deviceEvents[0], policy: buildDevicePolicy(state, contract) });
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
}

function escapeHtml(value: unknown) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderSaasLanding() {
  const shop = escapeHtml(SHOP_NAME);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d6b45">
  <meta name="description" content="${shop} phone installment management for contracts, payments, and device control.">
  <title>${shop} | Phone Installment Management</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="ks-site">
  <header class="ks-topbar">
    <div class="ks-wrap ks-topbar-inner">
      <a class="ks-logo" href="/"><span class="ks-mark" aria-hidden="true"></span>KISMART</a>
      <nav class="ks-nav" aria-label="Primary">
        <a href="#solutions">Solutions</a>
        <a href="#workflow">Workflow</a>
        <a href="#features">Features</a>
        <a href="#security">Security</a>
      </nav>
      <div class="ks-top-actions">
        <a class="ks-link" href="/login">Sign in</a>
        <a class="ks-btn ks-btn-primary" href="/login">Open dashboard</a>
      </div>
    </div>
  </header>

  <main>
    <section class="ks-hero">
      <div class="ks-wrap ks-hero-grid">
        <div class="ks-hero-copy">
          <p class="ks-kicker">Phone installment management</p>
          <h1>Contracts, payments, and device control in one place.</h1>
          <p class="ks-lead">KISMART helps phone shops register financed devices, track repayments, follow up on arrears, and control enrolled handsets from the admin dashboard.</p>
          <div class="ks-actions">
            <a class="ks-btn ks-btn-primary" href="/login">Sign in to admin</a>
            <a class="ks-btn ks-btn-ghost" href="#workflow">See how it works</a>
          </div>
          <dl class="ks-hero-facts">
            <div><dt>Collections</dt><dd>Cash, M-Pesa, Airtel, bank</dd></div>
            <div><dt>Devices</dt><dd>Android agent &amp; Apple MDM</dd></div>
            <div><dt>Control</dt><dd>Limit, lock, restore remotely</dd></div>
          </dl>
        </div>
        <aside class="ks-hero-card" aria-label="Portfolio preview">
          <div class="ks-card-head">
            <span>Admin overview</span>
            <strong>Portfolio summary</strong>
          </div>
          <div class="ks-stat-row">
            <div class="ks-stat"><span>Collected</span><strong>—</strong></div>
            <div class="ks-stat"><span>Outstanding</span><strong>—</strong></div>
            <div class="ks-stat"><span>Restricted</span><strong>—</strong></div>
          </div>
          <ul class="ks-task-list">
            <li><strong>Register contract</strong><span>Customer and IMEI</span><em>Ready</em></li>
            <li><strong>Record payment</strong><span>Cash or M-Pesa</span><em>Ready</em></li>
            <li><strong>Device policy</strong><span>Limit or restore</span><em>Ready</em></li>
          </ul>
        </aside>
      </div>
    </section>

    <section class="ks-band" aria-label="Supported methods">
      <div class="ks-wrap ks-band-inner">
        <p>Works with</p>
        <ul>
          <li>M-Pesa</li>
          <li>Airtel Money</li>
          <li>Cash</li>
          <li>Bank transfer</li>
          <li>Android agent</li>
          <li>Apple MDM</li>
        </ul>
      </div>
    </section>

    <section class="ks-section" id="solutions">
      <div class="ks-wrap">
        <div class="ks-section-head">
          <p class="ks-kicker">Solutions</p>
          <h2>Day-to-day tools for the installment desk</h2>
          <p>Keep customer records, balances, due dates, and device status together so the team does not rely on separate spreadsheets.</p>
        </div>
        <div class="ks-quad">
          <article>
            <span class="ks-num">01</span>
            <h3>Register the sale</h3>
            <p>Capture customer details, phone model, IMEI, deposit, and repayment plan.</p>
          </article>
          <article>
            <span class="ks-num">02</span>
            <h3>Record payments</h3>
            <p>Post collections as they come in and keep the balance up to date.</p>
          </article>
          <article>
            <span class="ks-num">03</span>
            <h3>Follow up arrears</h3>
            <p>See overdue accounts, send reminders, and apply approved restrictions.</p>
          </article>
          <article>
            <span class="ks-num">04</span>
            <h3>Control devices</h3>
            <p>Sync policy to enrolled Android agents or supervised iPhones.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="ks-section ks-section-alt" id="workflow">
      <div class="ks-wrap ks-split">
        <div class="ks-section-head tight">
          <p class="ks-kicker">Workflow</p>
          <h2>From first deposit to final repayment</h2>
          <p>A clear operating path for branch staff and managers.</p>
        </div>
        <ol class="ks-steps">
          <li>
            <strong>Sign in to admin</strong>
            <p>Use the protected dashboard for contracts, payments, and device actions.</p>
          </li>
          <li>
            <strong>Enroll the handset</strong>
            <p>Install the device agent, enter the registered IMEI, and complete the first sync.</p>
          </li>
          <li>
            <strong>Manage the book</strong>
            <p>Record payments and apply limit or restore when policy requires it.</p>
          </li>
        </ol>
      </div>
    </section>

    <section class="ks-section" id="features">
      <div class="ks-wrap">
        <div class="ks-section-head">
          <p class="ks-kicker">Features</p>
          <h2>What the system covers</h2>
        </div>
        <div class="ks-features">
          <article>
            <img src="/assets/feature-register.jpg" alt="Customer using a smartphone" width="640" height="360" loading="lazy">
            <div class="ks-feature-body">
              <p class="ks-tag">Contracts</p>
              <h3>Customer and device records</h3>
              <p>Name, phone, national ID, IMEI, plan, branch, and control profile on one contract.</p>
            </div>
          </article>
          <article>
            <img src="/assets/feature-payment.jpg" alt="Phone payment at a counter" width="640" height="360" loading="lazy">
            <div class="ks-feature-body">
              <p class="ks-tag">Payments</p>
              <h3>Collections ledger</h3>
              <p>Deposits, cash, M-Pesa, Airtel Money, and bank payments against the right account.</p>
            </div>
          </article>
          <article>
            <img src="/assets/feature-arrears.jpg" alt="Dashboard used for account follow-up" width="640" height="360" loading="lazy">
            <div class="ks-feature-body">
              <p class="ks-tag">Operations</p>
              <h3>Arrears and notices</h3>
              <p>Due dates, arrears totals, warning stages, and restore after payment.</p>
            </div>
          </article>
          <article>
            <img src="/assets/feature-sync.jpg" alt="Smartphone for device sync" width="640" height="360" loading="lazy">
            <div class="ks-feature-body">
              <p class="ks-tag">Devices</p>
              <h3>Policy sync</h3>
              <p>Android agent and Apple MDM routes for limit, lock, restore, and event history.</p>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="ks-section ks-section-alt" id="security">
      <div class="ks-wrap">
        <div class="ks-section-head">
          <p class="ks-kicker">Security</p>
          <h2>Built for controlled device finance</h2>
        </div>
        <div class="ks-security">
          <article>
            <h3>Admin sessions</h3>
            <p>Dashboard access is session protected for authorized operators only.</p>
          </article>
          <article>
            <h3>Device sync secret</h3>
            <p>Phone agents use a separate secret from admin login credentials.</p>
          </article>
          <article>
            <h3>Handset binding</h3>
            <p>First trusted sync binds the contract to the enrolled phone identity.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="ks-cta" id="contact">
      <div class="ks-wrap ks-cta-inner">
        <div>
          <p class="ks-kicker light">Admin access</p>
          <h2>Open the dashboard to manage live accounts</h2>
          <p>Sign in for contracts, collections, and device operations. Use the intake form for new customer details.</p>
        </div>
        <div class="ks-actions">
          <a class="ks-btn ks-btn-on-dark" href="/login">Sign in</a>
          <a class="ks-btn ks-btn-outline-light" href="/intake">Customer intake</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="ks-footer">
    <div class="ks-wrap ks-footer-grid">
      <div>
        <a class="ks-logo" href="/"><span class="ks-mark" aria-hidden="true"></span>KISMART</a>
        <p>${shop}. Phone installment contracts, collections, and device policy.</p>
      </div>
      <div>
        <strong>Product</strong>
        <a href="#solutions">Solutions</a>
        <a href="#features">Features</a>
        <a href="#workflow">Workflow</a>
      </div>
      <div>
        <strong>Access</strong>
        <a href="/login">Admin login</a>
        <a href="/intake">Customer intake</a>
        <span>Version ${VERSION}</span>
      </div>
    </div>
    <div class="ks-wrap ks-footer-meta">
      <span>Admin sessions protected</span>
      <span>Device sync uses a separate secret</span>
    </div>
  </footer>
</body>
</html>`;
}

function renderLanding() {
  return renderSaasLanding();
}

function renderLogin(error = "") {
  const shop = escapeHtml(SHOP_NAME);
  const errorMarkup = error ? `<div class="ks-alert" role="alert">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d1f17">
  <title>Admin sign in | ${shop}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="ks-auth">
  <div class="ks-auth-shell">
    <aside class="ks-auth-brand">
      <a class="ks-logo light" href="/"><span class="ks-mark light" aria-hidden="true"></span>KISMART</a>
      <h1>Admin workspace for installment operations</h1>
      <p>Manage contracts, payments, and device policy from one protected dashboard.</p>
      <ul>
        <li>Portfolio and collections</li>
        <li>Device limit and restore</li>
        <li>Audit and sync history</li>
      </ul>
    </aside>
    <main class="ks-auth-main">
      <div class="ks-auth-card">
        <p class="ks-kicker">Admin sign in</p>
        <h2>Welcome back</h2>
        <p class="ks-auth-sub">Sign in to manage contracts, payments, and device operations.</p>
        <form class="ks-form" method="post" action="/login">
          ${errorMarkup}
          <label><span>Email</span><input name="email" type="email" value="${escapeHtml(ADMIN_EMAIL)}" autocomplete="username" required autofocus></label>
          <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
          <button class="ks-btn ks-btn-primary ks-btn-block" type="submit">Sign in</button>
        </form>
        <p class="ks-auth-demo">Demo: ${escapeHtml(ADMIN_EMAIL)} / ${escapeHtml(ADMIN_PASSWORD)}</p>
        <p class="ks-auth-meta">${shop} · v${VERSION}</p>
      </div>
      <p class="ks-auth-foot"><a href="/">← Back to home</a></p>
    </main>
  </div>
</body>
</html>`;
}

function renderCustomerIntake(status = "") {
  const shop = escapeHtml(SHOP_NAME);
  const message =
    status === "received"
      ? `<div class="ks-alert ok" role="status">Details received. The shop team can now complete the device and payment setup.</div>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d6b45">
  <title>Customer intake | ${shop}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="ks-site ks-intake-page">
  <header class="ks-topbar">
    <div class="ks-wrap ks-topbar-inner">
      <a class="ks-logo" href="/"><span class="ks-mark" aria-hidden="true"></span>KISMART</a>
      <nav class="ks-nav" aria-label="Intake">
        <a href="/">Home</a>
        <a href="/login">Admin</a>
      </nav>
      <div class="ks-top-actions">
        <a class="ks-btn ks-btn-primary" href="/login">Sign in</a>
      </div>
    </div>
  </header>
  <main class="ks-intake">
    <div class="ks-wrap ks-intake-grid">
      <div class="ks-intake-copy">
        <p class="ks-kicker">Customer intake</p>
        <h1>Phone financing application</h1>
        <p>Submit your details. The shop team will complete the device, plan, and agreement.</p>
      </div>
      <form class="ks-form ks-intake-form" method="post" action="/intake">
        ${message}
        <label><span>Full name</span><input name="customerName" type="text" autocomplete="name" required></label>
        <label><span>Phone number</span><input name="phone" type="tel" autocomplete="tel" required></label>
        <label><span>National ID</span><input name="nationalId" type="text" inputmode="numeric"></label>
        <label><span>Address</span><input name="address" type="text" autocomplete="street-address"></label>
        <label><span>Preferred branch</span><select name="branch"><option>Kisumu</option><option>Nairobi</option><option>Mobile sales</option></select></label>
        <label class="ks-full"><span>Notes</span><textarea name="notes" rows="3"></textarea></label>
        <button class="ks-btn ks-btn-primary ks-btn-block" type="submit">Submit application</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function renderDashboard() {
  const shop = escapeHtml(SHOP_NAME);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d1f17">
  <title>${shop} | Admin</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="ks-dash">
  <div class="shell">
    <aside>
      <div class="brand">
        <div class="brand-lockup"><span class="brand-logo" aria-hidden="true"></span><div class="brand-word">KISMART</div></div>
        <span>${shop}</span>
      </div>
      <nav aria-label="Primary">
        ${navItem("overview", "Overview", "overview", true)}
        ${navItem("contracts", "Contracts", "contracts")}
        ${navItem("register", "Register", "register")}
        ${navItem("inventory", "Inventory", "inventory")}
        ${navItem("payments", "Payments", "payments")}
        ${navItem("devices", "Devices", "devices")}
        ${navItem("operations", "Operations", "operations")}
        ${navItem("audit", "Audit", "audit")}
      </nav>
      <div class="side-status">
        <span class="pulse"></span>
        <div><strong>System online</strong><small>v${VERSION}</small></div>
      </div>
    </aside>
    <main>
      <header class="dash-header">
        <div><p class="eyebrow" id="eyebrow">Operations</p><h1 id="title">Overview</h1></div>
        <div class="controls">
          <input id="search" type="search" placeholder="Search name, phone, IMEI">
          <select id="role" aria-label="Current role"><option>Admin</option><option>Branch Manager</option><option>Cashier</option><option>Support Agent</option></select>
          <button class="btn secondary" id="refresh" type="button">Refresh</button>
          <form class="logout-form" method="post" action="/logout"><button class="btn signout-btn" type="submit">Sign out</button></form>
        </div>
      </header>
      <section id="app"></section>
    </main>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}

function navItem(view: string, label: string, icon: string, active = false) {
  return `<button class="${active ? "active" : ""}" data-view="${view}" type="button">${navIcon(icon)}<span>${label}</span></button>`;
}

function navIcon(name: string) {
  const paths: Record<string, string> = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    contracts: '<path d="M7 3h7l5 5v13H7z"></path><path d="M14 3v5h5"></path><path d="M10 13h7"></path><path d="M10 17h5"></path>',
    register: '<path d="M15 20v-1.5a4.5 4.5 0 0 0-9 0V20"></path><circle cx="10.5" cy="8" r="3.5"></circle><path d="M18 8v6"></path><path d="M15 11h6"></path>',
    inventory: '<path d="M4 8h16"></path><path d="M6 8v11h12V8"></path><path d="M8 5h8l2 3H6z"></path><rect x="9" y="11" width="6" height="6" rx="1"></rect>',
    payments: '<rect x="3" y="6" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h4"></path>',
    devices: '<rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M10 18h4"></path>',
    operations: '<path d="M12 2v4"></path><path d="M12 18v4"></path><path d="M4.9 4.9l2.8 2.8"></path><path d="M16.3 16.3l2.8 2.8"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><circle cx="12" cy="12" r="3.5"></circle>',
    audit: '<path d="M12 3l7 3v5c0 4.5-2.8 8.4-7 10-4.2-1.6-7-5.5-7-10V6z"></path><path d="M9 12l2 2 4-4"></path>',
  };
  return `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.overview}</svg>`;
}

function renderStyles() {
  return String.raw`
:root {
  color-scheme: light;
  --bg: #fbfbfa;
  --surface: #ffffff;
  --surface-2: #f6f6f3;
  --surface-3: #ecece7;
  --ink: #121212;
  --muted: #6d6d67;
  --line: #dfe7df;
  --nav: #0f0f0f;
  --nav-2: #191919;
  --accent: #16a34a;
  --accent-soft: #dcfce7;
  --teal: #0f0f0f;
  --teal-soft: #dcfce7;
  --blue: #0f0f0f;
  --blue-soft: #dcfce7;
  --red: #3a3a3a;
  --red-soft: #f5f5f5;
  --green: #15803d;
  --green-soft: #dcfce7;
  --violet: #0f0f0f;
  --violet-soft: #dcfce7;
  --shadow: 0 14px 40px rgba(15, 15, 15, .06);
  font-family: Aptos, Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }
html { min-width: 320px; }
body { margin: 0; min-height: 100vh; color: var(--ink); background: var(--bg); font-size: 14px; letter-spacing: 0; }
a { color: inherit; text-decoration: none; }
button, input, select { font: inherit; }
button { cursor: pointer; }
strong { font-weight: 500; }

.landing-body { min-height: 100vh; color: #101415; background: #f6f7f1; font-family: Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif; }
.landing-body main { padding: 0; }
.landing-nav { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 22px; min-height: 74px; margin-bottom: 0; padding: 14px clamp(18px, 5vw, 64px); color: #f7f8f3; background: #101415; border-bottom: 1px solid rgba(255,255,255,.1); }
.landing-logo { color: #ffffff; font-size: 22px; line-height: 1; font-weight: 700; }
.landing-menu { display: flex; justify-content: center; gap: 24px; }
.landing-menu a { color: rgba(247,248,243,.72); font-size: 13px; font-weight: 600; }
.landing-menu a:hover { color: #ffffff; }
.landing-nav-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.landing-link { min-height: 38px; display: inline-flex; align-items: center; padding: 8px 12px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; color: #ffffff; font-size: 13px; font-weight: 600; }

.landing-hero { display: grid; grid-template-columns: minmax(0, .9fr) minmax(520px, 1.1fr); gap: clamp(26px, 5vw, 72px); align-items: center; min-height: 660px; padding: 58px clamp(18px, 5vw, 64px) 46px; background: #f6f7f1; }
.hero-content { max-width: 610px; }
.landing-hero .eyebrow { color: #138a5d; }
.landing-hero h1 { max-width: 620px; margin: 0; color: #101415; font-size: clamp(42px, 5.7vw, 74px); line-height: 1; font-weight: 750; }
.landing-copy { max-width: 560px; margin: 22px 0 0; color: #465150; font-size: 18px; line-height: 1.56; }
.landing-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.landing-actions .btn.secondary { color: #101415; background: #ffffff; border-color: #cdd5cf; }
.hero-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; max-width: 500px; margin-top: 30px; }
.hero-stats div { min-height: 78px; padding: 14px; border: 1px solid #dde4dc; border-radius: 8px; background: #ffffff; }
.hero-stats strong { display: block; color: #101415; font-size: 24px; line-height: 1; font-weight: 750; }
.hero-stats span { display: block; margin-top: 8px; color: #66716d; font-size: 12px; text-transform: uppercase; }

.hero-media { position: relative; min-height: 570px; }
.product-window { position: relative; width: 100%; min-height: 496px; padding: 16px; border: 1px solid #d7ded6; border-radius: 8px; color: #151d19; background: #ffffff; box-shadow: 0 24px 70px rgba(32, 42, 38, .12); }
.window-top { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; color: #68726f; font-size: 12px; }
.window-top b { width: 10px; height: 10px; border-radius: 50%; background: #d9dfd9; }
.window-top strong { margin-left: 10px; color: #46524e; font-size: 12px; font-weight: 700; }
.window-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.window-metric, .window-table { padding: 15px; border: 1px solid #dfe6df; border-radius: 8px; background: #fbfcf8; }
.window-metric { min-height: 122px; }
.window-metric.dark { color: #ffffff; background: #101415; border-color: #101415; }
.window-metric.accent { background: #eaf8f0; border-color: #b9dfc8; }
.window-metric span, .window-metric small, .landing-next span, .landing-next small, .auth-ledger span { display: block; color: #66716d; font-size: 11px; text-transform: uppercase; }
.window-metric.dark span, .window-metric.dark small { color: #c4cbc8; }
.window-metric strong { display: block; margin: 14px 0 8px; font-size: 24px; line-height: 1; font-weight: 750; }
.window-table { grid-column: 1 / -1; display: grid; min-height: 212px; }
.window-table div { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: center; padding: 13px 0; border-top: 1px solid #e4e9e4; }
.window-table div:first-child { border-top: 0; }
.window-table span { color: #65716c; }
.window-table em { min-width: 88px; padding: 6px 9px; border: 1px solid #dbe3db; border-radius: 999px; background: #ffffff; font-size: 12px; font-style: normal; text-align: center; }
.phone-preview { position: absolute; right: 26px; bottom: 0; display: grid; align-content: end; width: 160px; min-height: 292px; padding: 18px; border: 1px solid rgba(255,255,255,.18); border-radius: 24px; color: #ffffff; background: #101415; box-shadow: 0 18px 50px rgba(16, 20, 21, .25); }
.phone-preview span { width: 42px; height: 5px; margin: 0 auto auto; border-radius: 999px; background: #394240; }
.phone-preview strong { color: #16a34a; font-size: 21px; line-height: 1.1; }
.phone-preview small { margin-top: 8px; color: #d3dbd7; }

.landing-next { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; color: #101415; background: #dfe5df; border-top: 1px solid #dfe5df; border-bottom: 1px solid #dfe5df; }
.landing-next div { min-height: 102px; padding: 20px clamp(18px, 4vw, 44px); background: #ffffff; }
.landing-next strong { display: block; margin: 6px 0 5px; font-size: 18px; font-weight: 750; }
.landing-section, .platform-band, .proof-section, .final-cta { background: #f6f7f1; color: #101415; }
.landing-section { padding: 74px clamp(18px, 5vw, 64px); }
.section-copy { max-width: 760px; margin-bottom: 28px; }
.section-copy h2, .platform-copy h2, .final-cta h2 { margin-bottom: 12px; font-size: clamp(30px, 4.3vw, 54px); line-height: 1.04; font-weight: 750; }
.section-copy p, .platform-copy p { max-width: 640px; color: #56625e; font-size: 16px; }
.solution-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.solution-grid article { min-height: 220px; padding: 20px; border: 1px solid #dfe5df; border-radius: 8px; background: #ffffff; }
.solution-grid article:nth-child(2) { background: #f2f9fb; border-color: #d2e7ec; }
.solution-grid article:nth-child(3) { background: #ecfdf5; border-color: #86efac; }
.solution-grid article:nth-child(4) { background: #edf8f1; border-color: #c8e7d3; }
.solution-grid span { color: #138a5d; font-size: 12px; font-weight: 750; }
.solution-grid h3 { margin: 30px 0 10px; font-size: 20px; line-height: 1.18; font-weight: 750; }
.solution-grid p { margin: 0; color: #59635f; font-size: 14px; }
.brand-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 0 clamp(18px, 5vw, 64px) 74px; color: #101415; background: #f6f7f1; }
.brand-strip span { min-height: 70px; display: grid; place-items: center; border: 1px solid #dfe5df; border-radius: 8px; background: #ffffff; color: #56625e; font-weight: 750; text-align: center; }
.platform-band { display: grid; grid-template-columns: minmax(280px, .85fr) minmax(0, 1.15fr); gap: 34px; align-items: center; padding: 74px clamp(18px, 5vw, 64px); background: #101415; color: #ffffff; }
.platform-band .eyebrow, .final-cta .eyebrow { color: #86dbaa; }
.platform-copy p { color: #c9d3cf; }
.platform-copy .btn { margin-top: 10px; }
.platform-rows { display: grid; gap: 10px; }
.platform-rows div { display: grid; grid-template-columns: minmax(170px, .72fr) 1fr; gap: 16px; align-items: center; min-height: 74px; padding: 18px 20px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(255,255,255,.05); }
.platform-rows strong { color: #ffffff; font-size: 16px; font-weight: 750; }
.platform-rows span { color: #a9dbc0; font-size: 13px; overflow-wrap: anywhere; }
.proof-section { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); gap: 18px; padding: 74px clamp(18px, 5vw, 64px); }
.proof-card { padding: clamp(24px, 4vw, 42px); border: 1px solid #dfe5df; border-radius: 8px; background: #ffffff; }
.proof-card p { max-width: 850px; margin-bottom: 24px; color: #101415; font-size: clamp(23px, 3.2vw, 38px); line-height: 1.16; }
.proof-card strong { font-size: 15px; }
.proof-metrics { display: grid; gap: 12px; }
.proof-metrics div { display: grid; align-content: center; min-height: 122px; padding: 18px; border-radius: 8px; background: #edf8f1; border: 1px solid #c8e7d3; }
.proof-metrics div:nth-child(2) { background: #ecfdf5; border-color: #86efac; }
.proof-metrics div:nth-child(3) { background: #f2f9fb; border-color: #d2e7ec; }
.proof-metrics span { font-size: 32px; line-height: 1; font-weight: 750; }
.proof-metrics small { margin-top: 8px; color: #56625e; text-transform: uppercase; }
.final-cta { display: grid; justify-items: center; gap: 12px; padding: 78px clamp(18px, 5vw, 64px) 88px; text-align: center; background: #101415; color: #ffffff; }
.final-cta h2 { max-width: 780px; color: #ffffff; }

/* Simple landing reset inspired by the direct VOLO layout. */
.landing-body { color: #131313; background: #ffffff; font-family: Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif; }
.landing-body { overflow-x: hidden; }
.landing-body main { padding: 0; }
.landing-nav { min-height: 72px; padding: 14px clamp(18px, 5vw, 64px); background: #0f1110; }
.landing-logo { font-size: 21px; font-weight: 700; letter-spacing: 0; }
.landing-menu { gap: 26px; }
.landing-menu a, .landing-link { font-size: 13px; font-weight: 600; }
.landing-hero { grid-template-columns: minmax(0, .92fr) minmax(420px, .88fr); gap: clamp(28px, 6vw, 80px); min-height: 520px; padding: 58px clamp(18px, 5vw, 64px) 48px; background: #ffffff; overflow: hidden; }
.hero-content { max-width: 560px; }
.landing-hero .eyebrow { color: #16744f; }
.landing-hero h1 { max-width: 520px; font-size: clamp(34px, 4vw, 50px); line-height: 1.06; font-weight: 700; letter-spacing: 0; }
.landing-copy { max-width: 500px; margin-top: 18px; color: #4b4f4d; font-size: 16px; line-height: 1.6; }
.landing-actions { margin-top: 26px; gap: 10px; }
.landing-actions .btn.secondary { color: #131313; background: transparent; border-color: #cfd4ce; }
.hero-media { min-height: 0; }
.dashboard-preview { max-width: 560px; margin-left: auto; padding: 18px; border: 1px solid #d8ddd6; border-radius: 8px; background: #ffffff; box-shadow: 0 16px 50px rgba(24, 32, 28, .08); }
.preview-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid #e6ebe5; }
.preview-head span, .preview-stats span, .preview-note, .landing-next span { color: #68706b; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.preview-head strong { font-size: 13px; font-weight: 700; }
.preview-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 14px 0; }
.preview-stats div { min-height: 86px; padding: 13px; border: 1px solid #e1e7e0; border-radius: 8px; background: #fafbf7; }
.preview-stats strong { display: block; margin-top: 12px; font-size: 20px; line-height: 1; font-weight: 700; }
.preview-list { display: grid; border: 1px solid #e1e7e0; border-radius: 8px; overflow: hidden; }
.preview-list div { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: center; min-height: 58px; padding: 12px 14px; border-top: 1px solid #e8ede7; }
.preview-list div:first-child { border-top: 0; }
.preview-list span { color: #68706b; }
.preview-list em { min-width: 80px; padding: 5px 8px; border: 1px solid #d9dfd8; border-radius: 999px; font-size: 12px; font-style: normal; text-align: center; }
.preview-note { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.preview-note span { width: 8px; height: 8px; border-radius: 50%; background: #16744f; }
.landing-next { grid-template-columns: repeat(3, minmax(0, 1fr)); background: #e1e5df; }
.landing-next div { min-height: 104px; padding: 20px clamp(18px, 4vw, 44px); background: #ffffff; }
.landing-next strong { margin: 7px 0 5px; font-size: 18px; font-weight: 700; }
.landing-next small { color: #616964; text-transform: none; }
.landing-section, .how-section, .platform-band, .final-cta { padding: 72px clamp(18px, 5vw, 64px); }
.landing-section, .how-section { background: #ffffff; color: #131313; }
.section-copy { max-width: 700px; }
.section-copy h2, .how-section h2, .platform-copy h2, .final-cta h2 { max-width: 720px; font-size: clamp(28px, 3.7vw, 44px); line-height: 1.08; font-weight: 700; letter-spacing: 0; }
.section-copy p, .how-section p, .platform-copy p { max-width: 600px; color: #59605c; font-size: 15px; line-height: 1.55; }
.solution-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.solution-grid article { min-height: 206px; padding: 18px; background: #ffffff; }
.solution-grid span { color: #16744f; font-size: 12px; font-weight: 700; }
.solution-grid h3 { margin: 28px 0 10px; font-size: 19px; line-height: 1.18; font-weight: 700; }
.solution-grid p { color: #5b625e; font-size: 14px; line-height: 1.5; }
.how-section { display: grid; grid-template-columns: minmax(260px, .72fr) minmax(0, 1.28fr); gap: 36px; border-top: 1px solid #e0e5df; }
.how-steps { display: grid; gap: 10px; }
.how-steps article { display: grid; grid-template-columns: 42px 1fr; gap: 8px 16px; padding: 18px; border: 1px solid #dfe5df; border-radius: 8px; background: #ffffff; }
.how-steps span { grid-row: 1 / span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; color: #ffffff; background: #0f1110; font-weight: 700; }
.how-steps strong { font-size: 17px; font-weight: 700; }
.how-steps p { margin: 0; font-size: 14px; }
.platform-band { grid-template-columns: minmax(260px, .78fr) minmax(0, 1.22fr); background: #ffffff; color: #131313; border-top: 1px solid #e4e8e3; }
.platform-band .eyebrow, .final-cta .eyebrow { color: #16744f; }
.platform-copy p { color: #59605c; }
.platform-rows div { border-color: #dfe5df; background: #ffffff; }
.platform-rows strong { color: #131313; }
.platform-rows span { color: #59605c; }
.platform-rows div { min-height: 68px; }
.proof-section[hidden] { display: none !important; }
.final-cta { padding-top: 64px; padding-bottom: 74px; background: #ffffff; color: #131313; border-top: 1px solid #e4e8e3; }
.final-cta h2 { font-size: clamp(28px, 3.4vw, 42px); color: #131313; }
.landing-footer { display: grid; grid-template-columns: minmax(260px, 1fr) auto auto; gap: 28px; align-items: start; padding: 34px clamp(18px, 5vw, 64px); border-top: 1px solid #e4e8e3; color: #131313; background: #ffffff; }
.footer-logo { display: inline-block; margin-bottom: 10px; color: #131313; }
.landing-footer p { max-width: 420px; margin: 0; color: #59605c; font-size: 14px; line-height: 1.5; }
.footer-links { display: grid; gap: 8px; min-width: 130px; }
.footer-links a { color: #313735; font-size: 13px; font-weight: 600; }
.footer-meta { display: grid; gap: 8px; color: #68706b; font-size: 12px; text-align: right; text-transform: uppercase; }

.auth-body { min-height: 100vh; color: #111111; background: #0f0f0f; font-family: Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif; }
.auth-stage { position: relative; display: grid; grid-template-rows: auto 1fr auto; min-height: 100vh; padding: clamp(20px, 4vw, 56px) clamp(18px, 5vw, 68px); overflow: hidden; background: #ffffff; }
.auth-stage::before { content: ""; position: absolute; inset: auto 0 0; height: 34%; background: linear-gradient(180deg, rgba(15,15,15,0), rgba(22,163,74,.12)); pointer-events: none; }
.auth-nav { position: relative; z-index: 2; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 24px; min-height: 44px; margin: 0; padding: 0; border: 0; background: transparent; }
.auth-brand { display: inline-flex; align-items: center; gap: 10px; color: #111111; font-size: 20px; line-height: 1; font-weight: 800; }
.auth-mark { width: 24px; height: 24px; flex: 0 0 24px; background: radial-gradient(circle at 5px 5px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 13px 5px, #111111 0 3px, transparent 3.7px), radial-gradient(circle at 21px 5px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 5px 13px, #111111 0 3px, transparent 3.7px), radial-gradient(circle at 13px 13px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 21px 13px, #111111 0 3px, transparent 3.7px), radial-gradient(circle at 5px 21px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 13px 21px, #111111 0 3px, transparent 3.7px), radial-gradient(circle at 21px 21px, #16a34a 0 3px, transparent 3.7px); }
.auth-links { display: flex; align-items: center; justify-content: flex-end; gap: 22px; }
.auth-links a { color: #111111; font-size: 12px; font-weight: 700; }
.auth-demo { min-height: 38px; display: inline-flex; align-items: center; padding: 9px 18px; border-radius: 8px; background: #16a34a; border: 1px solid #15803d; }
.auth-scene { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(190px, 1fr) minmax(340px, 420px) minmax(190px, 1fr); gap: clamp(18px, 4vw, 48px); align-items: center; min-width: 0; min-height: 620px; }
.auth-panel { display: grid; justify-items: center; gap: 14px; width: 100%; max-width: 420px; min-width: 0; margin: 0 auto; padding: 0; background: transparent; }
.auth-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; width: 100%; min-width: 0; padding: 34px 36px 28px; border: 1px solid rgba(17,17,17,.04); border-radius: 28px; background: #ffffff; box-shadow: 0 28px 70px rgba(17,17,17,.12); }
.auth-form > div:first-child { text-align: center; }
.auth-form .eyebrow { margin-bottom: 8px; color: #166534; font-size: 11px; font-weight: 800; }
.auth-form h1 { margin: 0; color: #111111; font-size: 25px; line-height: 1.16; font-weight: 800; letter-spacing: 0; }
.auth-form p { margin: 9px 0 0; color: #555555; font-size: 13px; line-height: 1.45; }
.auth-form label { display: grid; gap: 8px; min-width: 0; color: #333333; font-size: 12px; font-weight: 700; }
.auth-form input { width: 100%; min-width: 0; min-height: 44px; border: 1px solid #dbe7dd; border-radius: 7px; padding: 10px 12px; color: #111111; background: #ffffff; font-size: 13px; }
.auth-form input:focus { border-color: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.22); }
.auth-help { width: fit-content; color: #111111; font-size: 12px; font-weight: 700; }
.auth-submit { width: 100%; min-height: 44px; margin-top: 2px; color: #111111; background: #16a34a; border-color: #16a34a; border-radius: 7px; font-size: 13px; font-weight: 800; box-shadow: none; }
.auth-submit:hover { background: #15803d; border-color: #15803d; }
.auth-error { padding: 11px 12px; border: 1px solid #111111; border-radius: 8px; color: #ffffff; background: #111111; font-size: 13px; }
.auth-divider { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; color: #777777; font-size: 11px; }
.auth-divider span { height: 1px; background: #dbe7dd; }
.auth-divider strong { font-weight: 700; }
.auth-access { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.auth-access span { display: grid; place-items: center; min-height: 38px; border: 1px solid #dbe7dd; border-radius: 8px; color: #111111; background: #f0fdf4; font-size: 11px; font-weight: 800; }
.auth-hint { margin: 0; color: #56625e; font-size: 11px; line-height: 1.45; text-align: center; }
.auth-note { display: flex; justify-content: center; gap: 8px; color: #56625e; font-size: 12px; }
.auth-note strong { color: #111111; font-weight: 800; }
.auth-side { position: relative; min-height: 430px; }
.auth-cardlet { position: absolute; left: 22%; top: 34%; width: 96px; height: 72px; border: 1px solid #111111; background: rgba(255,255,255,.52); }
.auth-cardlet span { position: absolute; left: 18px; right: 18px; height: 1px; background: #111111; }
.auth-cardlet span:first-child { top: 27px; }
.auth-cardlet span:nth-child(2) { top: 40px; }
.auth-cardlet.graph { left: 54%; top: 64%; width: 68px; height: 86px; background: #ffffff; }
.auth-cardlet.graph span { left: 30px; top: 24px; width: 22px; height: 22px; border-top: 1px solid #111111; border-right: 1px solid #111111; background: transparent; transform: rotate(-10deg); }
.auth-dots { position: absolute; left: 18%; top: 66%; width: 92px; height: 104px; background-color: #16a34a; background-image: radial-gradient(#111111 0 3px, transparent 3.5px); background-size: 22px 22px; }
.auth-dots.small { left: auto; right: 18%; top: 66%; width: 86px; height: 108px; }
.auth-squiggle { position: absolute; left: 18%; top: 22%; width: 150px; height: 45px; border-bottom: 1.5px solid #111111; border-radius: 50%; transform: rotate(-8deg); opacity: .68; }
.auth-squiggle::after { content: ""; position: absolute; left: 42px; top: 9px; width: 110px; height: 33px; border-top: 1.5px solid #111111; border-radius: 50%; }
.auth-squiggle.second { left: auto; right: 13%; top: 26%; transform: rotate(8deg); }
.auth-device-card { position: absolute; right: 38%; top: 35%; width: 80px; height: 64px; border: 1px solid #111111; background: rgba(255,255,255,.6); }
.auth-device-card span { position: absolute; left: 18px; right: 18px; top: 21px; height: 1px; background: #111111; box-shadow: 0 12px 0 #111111; }
.auth-device-card strong { position: absolute; right: -18px; bottom: -14px; min-height: 28px; display: grid; place-items: center; padding: 4px 10px; border-radius: 999px; color: #111111; background: #16a34a; font-size: 11px; font-weight: 800; }
.auth-operator { position: absolute; right: 24%; top: 42%; width: 160px; height: 220px; }
.auth-operator .head { position: absolute; right: 50px; top: 2px; width: 30px; height: 30px; border-radius: 50%; background: #111111; }
.auth-operator .body { position: absolute; right: 45px; top: 42px; width: 64px; height: 92px; border-radius: 32px 32px 8px 8px; background: #111111; transform: rotate(-14deg); }
.auth-operator .screen { position: absolute; left: 8px; top: 56px; width: 86px; height: 54px; border: 2px solid #16a34a; border-radius: 6px; background: #f0fdf4; transform: rotate(-14deg); }
.auth-operator::before { content: ""; position: absolute; right: 16px; bottom: 0; width: 98px; height: 130px; border: 1px solid #111111; background: #ffffff; z-index: -1; }
.auth-operator::after { content: ""; position: absolute; right: 56px; top: 126px; width: 76px; height: 76px; border-left: 13px solid #111111; border-bottom: 13px solid #111111; transform: rotate(-18deg); }
.auth-footer { position: relative; z-index: 1; display: flex; justify-content: center; gap: 10px; align-items: center; color: #4f4a41; font-size: 12px; }
.auth-footer span { width: 1px; height: 12px; background: #b9afa0; }

.intake-body { min-height: 100vh; color: #111111; background: #ffffff; font-family: Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif; }
.intake-stage { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; padding: clamp(20px, 4vw, 52px) clamp(18px, 5vw, 68px); background: #ffffff; }
.intake-nav { padding: 0; }
.intake-panel { align-self: center; display: grid; grid-template-columns: minmax(260px, .8fr) minmax(320px, 460px); gap: clamp(28px, 6vw, 86px); align-items: start; max-width: 1080px; width: 100%; margin: 0 auto; }
.intake-copy h1 { margin: 0; font-size: clamp(36px, 5vw, 64px); line-height: 1.02; font-weight: 700; letter-spacing: 0; }
.intake-copy p:not(.eyebrow) { max-width: 430px; color: #555555; font-size: 15px; line-height: 1.55; }
.intake-form { grid-template-columns: 1fr; gap: 12px; width: 100%; padding: 24px; border: 1px solid #dfe7df; border-radius: 8px; background: #ffffff; }
.intake-form .btn { width: 100%; min-height: 44px; }
.intake-success { padding: 11px 12px; border: 1px solid #16a34a; border-radius: 8px; color: #111111; background: #dcfce7; font-size: 13px; }

.shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
aside { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 24px; padding: 26px 16px 18px; color: #ffffff; background: var(--nav); border-right: 1px solid #0a0a0a; }
.brand { display: grid; gap: 7px; padding: 4px 8px 20px; border-bottom: 1px solid rgba(255,255,255,.14); }
.brand-lockup { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-logo { position: relative; width: 26px; height: 26px; flex: 0 0 26px; border: 1px solid rgba(22,163,74,.62); border-radius: 7px; }
.brand-logo::before { content: ""; position: absolute; left: 4px; top: 4px; width: 4px; height: 4px; border-radius: 50%; background: var(--accent); box-shadow: 8px 0 #ffffff, 16px 0 var(--accent), 0 8px #ffffff, 8px 8px var(--accent), 16px 8px #ffffff, 0 16px var(--accent), 8px 16px #ffffff, 16px 16px var(--accent); }
.brand-word { color: #ffffff; font-size: 19px; line-height: 1; font-weight: 700; }
.brand span { color: #bdbdb8; font-size: 12px; line-height: 1.35; }
nav { display: grid; gap: 5px; }
nav button { position: relative; display: flex; align-items: center; gap: 10px; min-height: 40px; border: 0; border-radius: 8px; padding: 8px 10px 8px 12px; color: #c9c9c6; background: transparent; text-align: left; font-size: 13px; font-weight: 400; }
nav button::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px; border-radius: 999px; background: transparent; }
nav button.active, nav button:hover { color: #ffffff; background: rgba(255,255,255,.07); }
nav button.active::before, nav button:hover::before { background: var(--accent); }
.nav-icon { width: 18px; height: 18px; flex: 0 0 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; opacity: .9; }
nav button.active .nav-icon, nav button:hover .nav-icon { color: var(--accent); opacity: 1; }
.side-status { display: grid; grid-template-columns: 12px 1fr; gap: 10px; align-items: start; margin-top: auto; padding: 14px 8px 4px; border-top: 1px solid rgba(255,255,255,.14); background: transparent; }
.side-status strong, .side-status small { display: block; }
.side-status strong { font-size: 12px; }
.side-status small { margin-top: 3px; color: #bdbdb8; font-size: 11px; }
.pulse { width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px rgba(22,163,74,.18); }

main { min-width: 0; padding: 24px 28px 34px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 22px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.eyebrow { margin: 0 0 5px; color: var(--muted); font-size: 11px; font-weight: 500; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: 22px; line-height: 1.12; font-weight: 700; }
h2 { margin-bottom: 4px; font-size: 14px; line-height: 1.25; font-weight: 700; }
h3 { margin-bottom: 7px; font-size: 13px; font-weight: 700; }
p { color: var(--muted); line-height: 1.45; }
.controls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
input, select, textarea { min-height: 38px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; color: var(--ink); background: #ffffff; outline: none; font-size: 13px; }
textarea { resize: vertical; }
input:focus, select:focus, textarea:focus { border-color: var(--ink); box-shadow: 0 0 0 3px rgba(22,163,74,.25); }

.btn, .tiny { display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; box-shadow: none; font-weight: 600; white-space: nowrap; text-decoration: none; }
.btn { min-height: 38px; border: 1px solid var(--ink); padding: 8px 12px; color: var(--ink); background: var(--accent); font-size: 13px; }
.btn.secondary { color: var(--ink); background: #ffffff; border-color: var(--ink); }
.btn.signout-btn { color: #ffffff; background: #b42323; border-color: #b42323; }
.btn.signout-btn:hover { background: #941b1b; border-color: #941b1b; }
.btn:disabled, .tiny:disabled, .btn.busy, .tiny.busy { opacity: .58; cursor: wait; }
.landing-actions .btn.secondary { color: #101415; background: #ffffff; border-color: #cdd5cf; }
.tiny { min-height: 30px; border: 1px solid var(--ink); padding: 5px 9px; color: var(--ink); background: var(--surface-2); font-size: 12px; }
.tiny[data-action="remind"], .tiny[data-action="warn"] { border-color: var(--accent); background: var(--accent); }
.tiny[data-action="restrict"] { color: #ffffff; border-color: var(--ink); background: var(--ink); }
.tiny[data-level="Lock screen message"] { color: var(--ink); border-color: var(--ink); background: #ffffff; }
.tiny[data-level="Limited access"] { color: #ffffff; border-color: #3a3a3a; background: #3a3a3a; }
.tiny.danger { color: var(--accent); border-color: var(--ink); background: var(--ink); }
.tiny.success { color: var(--ink); border-color: var(--accent); background: var(--accent); }
.tiny.delete { color: #ffffff; border-color: #9f1d1d; background: #9f1d1d; }

.command-band { display: grid; grid-template-columns: minmax(300px, .9fr) minmax(0, 1.1fr); gap: 18px; margin-bottom: 18px; }
.health-panel, .panel, .metric, .chart-panel { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: none; }
.health-panel { display: grid; align-content: space-between; min-height: 214px; padding: 18px; background: var(--nav); border-color: var(--nav); color: #ffffff; }
.health-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.health-score { display: grid; place-items: center; width: 74px; height: 54px; border: 1px solid rgba(22,163,74,.45); border-radius: 8px; color: var(--accent); font-size: 26px; font-weight: 700; }
.health-copy .eyebrow { color: #bdbdb8; }
.health-copy strong { display: block; max-width: 390px; font-size: 18px; line-height: 1.2; font-weight: 700; }
.health-copy p { margin: 8px 0 0; max-width: 430px; color: #c9c9c6; font-size: 13px; }
.health-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.12); }
.health-strip span, .metric span, .signal span { display: block; color: var(--muted); font-size: 10.5px; font-weight: 500; text-transform: uppercase; }
.health-strip span { color: #bdbdb8; }
.health-strip strong { display: block; margin-top: 5px; color: #ffffff; font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 12px; }
.command-band .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 0; }
.ecosystem-grid { margin-top: 8px; }
.metric { min-height: 102px; padding: 14px; position: relative; overflow: hidden; }
.metric::after { content: ""; position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; background: currentColor; opacity: .72; }
.metric strong { display: block; margin: 8px 0 6px; font-size: 20px; line-height: 1.08; font-weight: 700; overflow-wrap: anywhere; }
.metric small { color: var(--muted); line-height: 1.35; font-size: 12px; }
.metric.green strong { color: var(--green); }
.metric.blue strong { color: var(--blue); }
.metric.accent strong { color: var(--accent); }
.metric.red strong { color: var(--red); }
.metric.violet strong { color: var(--violet); }

.command-surface { margin-bottom: 24px; padding: 4px 0 24px; border-bottom: 1px solid var(--line); background: transparent; }
.command-lead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; }
.command-lead h2 { max-width: 680px; margin: 5px 0 0; font-size: 22px; line-height: 1.12; font-weight: 700; }
.command-lead p { max-width: 640px; margin: 8px 0 0; color: var(--muted); font-size: 13px; }
.command-score { min-width: 170px; padding-left: 22px; border-left: 1px solid var(--line); text-align: right; }
.command-score span, .command-score small, .command-metric span, .command-metric small, .portfolio-status-line > span, .status-pill span { display: block; color: var(--muted); font-size: 10.5px; font-weight: 500; text-transform: uppercase; }
.command-score strong { display: block; color: var(--ink); font-size: 28px; line-height: 1; font-weight: 700; }
.command-score small { margin-top: 6px; }
.command-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 24px; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--line); }
.command-metric { --accent: var(--ink); position: relative; min-height: 104px; padding: 15px 18px 16px; border-left: 1px solid var(--line); background: transparent; }
.command-metric:first-child { border-left: 0; }
.command-metric::before { content: ""; position: absolute; left: 18px; top: -2px; width: 44px; height: 2px; background: var(--accent); }
.command-metric.ink, .status-pill.ink { --accent: var(--ink); }
.command-metric.green-accent, .status-pill.green-accent { --accent: var(--accent); }
.command-metric.neutral, .status-pill.neutral { --accent: #8b8b82; }
.command-metric.dark, .status-pill.dark { --accent: #3a3a3a; }
.command-metric strong { display: block; margin: 10px 0 7px; color: var(--ink); font-size: 19px; line-height: 1.08; font-weight: 700; overflow-wrap: anywhere; }
.command-metric small { line-height: 1.35; text-transform: none; }
.command-insights { display: grid; grid-template-columns: minmax(280px, 430px) minmax(0, 1fr); gap: 28px; align-items: center; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.portfolio-status-line { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 14px; align-items: stretch; margin-top: 0; }
.portfolio-status-line > span { padding-top: 12px; }
.status-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.status-pill { position: relative; display: flex; justify-content: space-between; gap: 12px; align-items: center; min-height: 46px; padding: 10px 14px; border-left: 1px solid var(--line); }
.status-pill:first-child { border-left: 0; }
.status-pill::before { content: ""; width: 9px; height: 9px; flex: 0 0 9px; background: var(--accent); }
.status-pill strong { margin-left: auto; font-size: 14px; font-weight: 700; }
.command-chart { min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; }
.command-chart .chart-head { margin-bottom: 6px; }
.command-chart .chart-head h2 { font-size: 13px; font-weight: 700; }
.command-chart .chart-head p { font-size: 12px; }
.command-chart .badge { display: none; }
.command-chart .pie-layout { grid-template-columns: 146px minmax(0, 1fr); gap: 14px; min-height: 146px; }
.command-chart .pie-layout .chart-svg { min-height: 136px; }
.command-chart .pie-legend { gap: 7px; }
.command-chart .legend-item { font-size: 12px; }
.command-ledger { margin-bottom: 18px; background: transparent; }
.section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.section-head p { margin-bottom: 0; font-size: 13px; }
.command-ledger .table-wrap { border-bottom: 1px solid var(--line); }

.layout { display: grid; grid-template-columns: minmax(0, 1.42fr) minmax(320px, .78fr); gap: 18px; margin-bottom: 18px; }
.layout-even { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
.panel { padding: 18px; }
.panel + .panel { margin-top: 16px; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.panel-head p { margin-bottom: 0; font-size: 13px; }
.muted { color: var(--muted); }
.signal-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.signal { min-height: 88px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.signal strong { display: block; margin-top: 8px; font-size: 16px; font-weight: 700; }
.signal small { color: var(--muted); }

.table-wrap { width: 100%; overflow-x: auto; }
table { width: 100%; min-width: 980px; border-collapse: collapse; }
.table-wrap.compact table { min-width: 560px; }
th, td { padding: 11px 12px; border-top: 1px solid var(--line); text-align: left; vertical-align: middle; }
th { color: var(--muted); background: var(--surface-2); font-size: 10.5px; font-weight: 500; text-transform: uppercase; }
td { font-size: 13px; }
td.money-cell, .money-value { font-weight: 700; color: var(--ink); white-space: nowrap; }
tbody tr:hover td { background: #f0fdf4; }
.cell-main { display: grid; gap: 3px; }
.cell-main span { color: var(--muted); font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.badge { display: inline-flex; align-items: center; min-height: 22px; padding: 3px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; background: transparent; }
.badge.Active, .badge.Pending, .badge.Live { color: var(--ink); background: transparent; border: 1px solid var(--line); }
.badge.Completed, .badge.Synced, .badge.Ready, .badge.Online { color: var(--ink); background: var(--accent-soft); border: 1px solid #86efac; }
.badge.Overdue, .badge.Attention { color: var(--ink); background: var(--accent-soft); border: 1px solid var(--accent); }
.badge.Restricted, .badge.Failed, .badge.Blocked, .badge.Offline { color: #ffffff; background: var(--ink); border: 1px solid var(--ink); }

.queue { display: grid; }
.queue-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 12px 0; border-top: 1px solid var(--line); }
.queue-row:first-child { border-top: 0; padding-top: 0; }
.queue-row p { margin-bottom: 0; font-size: 13px; }

.bar-list { display: grid; gap: 12px; }
.bar-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) 92px; gap: 10px; align-items: center; font-size: 13px; }
.bar-track { height: 7px; overflow: hidden; border-radius: 999px; background: var(--surface-3); }
.bar-fill { height: 100%; border-radius: 999px; background: var(--blue); }
.pipeline { display: grid; gap: 12px; }
.pipeline-row { display: grid; grid-template-columns: 118px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.pipeline-row:first-child { border-top: 0; }
.pipeline-line { height: 7px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.pipeline-fill { height: 100%; border-radius: 999px; background: var(--teal); }
.compat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.compat-row { min-height: 122px; padding: 14px 0; border-top: 1px solid var(--line); }
.compat-row:first-child { border-top: 0; }
.chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
.chart-grid-single { grid-template-columns: minmax(280px, 520px); }
.chart-panel { padding: 18px; min-height: 250px; }
.chart-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.chart-head p { margin-bottom: 0; font-size: 13px; }
.chart-svg { display: block; width: 100%; height: auto; min-height: 190px; }
.chart-label { fill: var(--muted); font-size: 12px; font-weight: 400; }
.chart-title { fill: var(--ink); font-size: 14px; font-weight: 500; }
.chart-axis { stroke: var(--line); stroke-width: 1; }
.chart-blue { fill: var(--blue); stroke: var(--blue); }
.chart-teal { fill: var(--teal); stroke: var(--teal); }
.chart-accent { fill: var(--accent); stroke: var(--accent); }
.chart-red { fill: var(--red); stroke: var(--red); }
.chart-green { fill: var(--green); stroke: var(--green); }
.pie-layout { display: grid; grid-template-columns: 176px 1fr; gap: 18px; align-items: center; min-height: 190px; }
.pie-layout .chart-svg { min-height: 160px; }
.pie-legend { display: grid; gap: 10px; }
.legend-item { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
.legend-dot { width: 10px; height: 10px; border-radius: 999px; background: currentColor; }
.legend-dot.chart-blue { background: var(--blue); }
.legend-dot.chart-teal { background: var(--teal); }
.legend-dot.chart-accent { background: var(--accent); }
.legend-dot.chart-red { background: var(--red); }
.legend-dot.chart-green { background: var(--green); }

form { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 12px; }
.logout-form { display: block; }
.logout-form .btn { width: auto; }
label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.form-wide { grid-column: 1 / -1; }
.form-section { display: grid; grid-template-columns: minmax(140px, auto) minmax(0, 1fr); gap: 10px; align-items: end; padding-top: 8px; border-top: 1px solid var(--line); color: var(--ink); }
.form-section:first-of-type { padding-top: 0; border-top: 0; }
.form-section strong { font-size: 13px; font-weight: 500; }
.form-section span { color: var(--muted); font-size: 12px; line-height: 1.35; }
.form-summary { display: grid; grid-template-columns: minmax(140px, auto) minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 54px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--accent-soft); }
.form-summary span, .form-summary small { color: var(--muted); font-size: 12px; }
.form-summary strong { font-size: 18px; font-weight: 700; }
.readiness-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.readiness-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.readiness-row:first-child { border-top: 0; }
.readiness-row > p { grid-column: 1; margin-bottom: 0; }
.readiness-row > .badge { grid-column: 2; grid-row: 1 / span 2; justify-self: end; }
.toast { position: fixed; right: 18px; bottom: 18px; max-width: min(380px, calc(100vw - 36px)); padding: 12px 14px; border-radius: 8px; color: #ffffff; background: var(--nav); box-shadow: var(--shadow); opacity: 0; transform: translateY(10px); pointer-events: none; transition: opacity .2s ease, transform .2s ease; }
.toast.show { opacity: 1; transform: translateY(0); }
.empty { padding: 24px 8px; color: var(--muted); text-align: center; }

@media (max-width: 1120px) {
  .landing-hero { grid-template-columns: 1fr; min-height: auto; padding-top: 54px; }
  .hero-content { max-width: 720px; }
  .landing-hero .hero-content { order: 1; }
  .landing-hero .hero-media { order: 2; }
  .hero-media { min-height: 500px; }
  .product-window { max-width: 820px; }
  .phone-preview { right: 18px; }
  .solution-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .brand-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .platform-band, .proof-section { grid-template-columns: 1fr; }
  .command-band, .layout, .layout-even { grid-template-columns: 1fr; }
  .command-metrics, .status-strip, .metric-grid, .signal-grid, .readiness-grid, .compat-grid, .chart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
  .intake-panel { grid-template-columns: 1fr; align-self: start; padding-top: 42px; }
  .landing-nav { grid-template-columns: auto auto; justify-content: space-between; }
  .landing-menu { display: none; }
  .landing-nav-actions { gap: 8px; }
  .landing-hero { padding-top: 46px; }
  .hero-content { max-width: 560px; }
  .hero-media { min-height: 440px; }
  .product-window { min-height: 380px; }
  .phone-preview { right: 18px; width: 138px; min-height: 236px; }
  .landing-next, .brand-strip { grid-template-columns: 1fr; }
  .auth-body { grid-template-columns: 1fr; }
  .auth-art { min-height: 48vh; }
  .shell { grid-template-columns: 1fr; }
  aside { position: static; height: auto; gap: 16px; }
  nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  nav button { justify-content: center; text-align: center; padding: 8px; }
  nav button::before { display: none; }
  header { display: grid; }
  .controls { justify-content: stretch; }
  .controls > * { flex: 1 1 180px; }
  .command-lead { grid-template-columns: 1fr; align-items: start; }
  .command-score { min-width: 0; padding: 14px 0 0; border-left: 0; border-top: 1px solid var(--line); text-align: left; }
  .command-insights { grid-template-columns: 1fr; gap: 18px; }
  form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .landing-nav { grid-template-columns: 1fr; gap: 12px; align-items: start; }
  .landing-logo { font-size: 20px; }
  .landing-nav-actions { justify-content: stretch; }
  .landing-nav-actions .btn, .landing-nav-actions .landing-link { width: 100%; justify-content: center; }
  .landing-hero { padding: 42px 18px 46px; }
  .landing-hero h1 { font-size: 40px; }
  .landing-copy { max-width: 340px; font-size: 15px; }
  .hero-stats { grid-template-columns: 1fr; }
  .landing-actions .btn { width: 100%; }
  .hero-media { min-height: auto; width: 100%; overflow: hidden; }
  .product-window { width: 100%; min-height: auto; padding: 12px; transform: none; }
  .window-grid { grid-template-columns: 1fr; gap: 8px; }
  .window-metric { min-height: 96px; padding: 10px; }
  .window-metric strong { font-size: 18px; }
  .window-table { min-height: 150px; padding: 10px; }
  .window-table div { grid-template-columns: 1fr auto; }
  .window-table span { display: none; }
  .phone-preview { display: none; }
  .landing-section, .platform-band, .proof-section, .final-cta { padding-left: 18px; padding-right: 18px; }
  .solution-grid, .auth-visual { grid-template-columns: 1fr; }
  .platform-rows div { grid-template-columns: 1fr; }
  .proof-card p { font-size: 24px; }
  .auth-panel { align-items: start; }
  main { padding: 14px; }
  nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .command-metrics, .status-strip, .portfolio-status-line, .metric-grid, .signal-grid, .health-strip, .readiness-grid, .compat-grid, .chart-grid, form { grid-template-columns: 1fr; }
  .command-metric { border-left: 0; border-top: 1px solid var(--line); }
  .command-metric:first-child { border-top: 0; }
  .status-pill { border-left: 0; border-top: 1px solid var(--line); }
  .status-pill:first-child { border-top: 0; }
  .health-top, .section-head, .panel-head, .queue-row, .bar-row, .pipeline-row, .readiness-row, .pie-layout { display: grid; grid-template-columns: 1fr; }
  .btn { width: 100%; }
}

@media (max-width: 1120px) {
  .landing-body main { padding: 0; }
  .landing-hero { grid-template-columns: 1fr; gap: 34px; min-height: auto; padding-top: 52px; }
  .landing-hero .hero-content, .landing-hero .hero-media { order: initial; }
  .hero-media { min-height: 0; }
  .dashboard-preview { max-width: 720px; margin-left: 0; }
  .solution-grid, .how-section, .platform-band { grid-template-columns: 1fr; }
  .auth-main { grid-template-columns: 1fr; gap: 32px; min-height: auto; }
  .auth-panel { max-width: 560px; }
}

@media (max-width: 760px) {
  .auth-nav { grid-template-columns: 1fr; gap: 12px; align-items: start; padding: 16px 18px; }
  .auth-links { justify-content: flex-start; gap: 18px; }
  .auth-main { padding: 42px 18px 38px; }
  .auth-copy h1 { max-width: 330px; font-size: 32px; line-height: 1.08; }
  .auth-copy p { font-size: 15px; }
  .auth-summary { grid-template-columns: 1fr; margin-top: 26px; }
  .auth-summary div { min-height: auto; }
  .auth-form { padding: 20px; }
  .auth-note { display: grid; gap: 4px; }
  .landing-nav { grid-template-columns: 1fr auto; gap: 12px; }
  .landing-menu { display: none; }
  .landing-nav-actions { grid-column: 1 / -1; justify-content: stretch; }
  .landing-nav-actions .landing-link, .landing-nav-actions .btn { flex: 1 1 0; justify-content: center; }
  .landing-hero { padding: 42px 18px 38px; }
  .landing-hero h1 { max-width: 330px; font-size: 30px; line-height: 1.1; }
  .landing-copy { max-width: 100%; font-size: 15px; }
  .landing-actions .btn { width: 100%; }
  .landing-next, .preview-stats { grid-template-columns: 1fr; }
  .dashboard-preview { width: 100%; max-width: 100%; padding: 14px; overflow: hidden; }
  .preview-head { display: grid; grid-template-columns: 1fr; }
  .preview-list div { grid-template-columns: 1fr auto; }
  .preview-list div span { display: none; }
  .preview-list em { min-width: 76px; }
  .landing-section, .how-section, .platform-band, .final-cta { padding: 48px 18px; }
  .section-copy h2, .how-section h2, .platform-copy h2, .final-cta h2 { font-size: 28px; }
  .solution-grid { grid-template-columns: 1fr; }
  .platform-rows div, .how-steps article { grid-template-columns: 1fr; }
  .landing-footer { grid-template-columns: 1fr; gap: 20px; padding: 28px 18px; }
  .footer-meta { text-align: left; }
}

/* Dribbble-inspired dark SaaS landing. */
.landing-body { color: #f6efff; background: #1d1236; font-family: Inter, "Segoe UI", Arial, ui-sans-serif, system-ui, sans-serif; }
.landing-body .saas-landing { min-height: 100vh; padding: 0; background: #1d1236; }
.saas-hero { position: relative; isolation: isolate; max-width: 1368px; min-height: 748px; margin: 0 auto; overflow: hidden; color: #f8f2ff; background: #05010d; border: 1px solid rgba(216,198,254,.08); }
.saas-hero::before { content: ""; position: absolute; inset: 0; z-index: -3; background-image: radial-gradient(circle at 19% 18%, rgba(216,198,254,.36) 0 1px, transparent 2px), radial-gradient(circle at 57% 7%, rgba(216,198,254,.42) 0 1px, transparent 2px), radial-gradient(circle at 81% 25%, rgba(216,198,254,.3) 0 1px, transparent 2px), radial-gradient(circle at 72% 54%, rgba(216,198,254,.36) 0 1px, transparent 2px), radial-gradient(circle at 24% 57%, rgba(216,198,254,.24) 0 1px, transparent 2px); }
.saas-hero::after { content: ""; position: absolute; left: 50%; bottom: 94px; z-index: -2; width: 1240px; max-width: 145%; height: 360px; transform: translateX(-50%); border-radius: 50% 50% 0 0; background: radial-gradient(ellipse at center bottom, rgba(82,37,229,.72), rgba(56,33,176,.48) 30%, rgba(2,1,5,0) 72%); filter: blur(1px); }
.landing-body .landing-nav { position: relative; z-index: 2; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 28px; min-height: 90px; margin: 0; padding: 26px clamp(22px, 8vw, 118px); color: #f9f2ff; background: transparent; border: 0; }
.landing-body .landing-logo { display: inline-flex; align-items: center; gap: 10px; color: #f9f2ff; font-size: 23px; font-weight: 800; line-height: 1; letter-spacing: 0; }
.logo-symbol { position: relative; width: 27px; height: 27px; flex: 0 0 27px; border-radius: 8px; background: radial-gradient(circle at 6px 6px, #8e79fa 0 3px, transparent 3.8px), radial-gradient(circle at 14px 6px, #5225e5 0 3px, transparent 3.8px), radial-gradient(circle at 22px 6px, #d8c6fe 0 3px, transparent 3.8px), radial-gradient(circle at 6px 14px, #5225e5 0 3px, transparent 3.8px), radial-gradient(circle at 14px 14px, #8e79fa 0 3px, transparent 3.8px), radial-gradient(circle at 22px 14px, #5225e5 0 3px, transparent 3.8px), radial-gradient(circle at 6px 22px, #d8c6fe 0 3px, transparent 3.8px), radial-gradient(circle at 14px 22px, #5225e5 0 3px, transparent 3.8px), radial-gradient(circle at 22px 22px, #8e79fa 0 3px, transparent 3.8px); }
.landing-body .landing-menu { display: flex; justify-content: center; gap: clamp(18px, 3vw, 42px); }
.landing-body .landing-menu a { color: rgba(248,242,255,.74); font-size: 12px; font-weight: 600; }
.landing-body .landing-menu a:hover { color: #ffffff; }
.landing-body .landing-nav-actions { display: flex; justify-content: flex-end; }
.landing-body .landing-link { min-height: 41px; padding: 10px 18px; color: #ffffff; border: 1px solid rgba(142,121,250,.9); border-radius: 10px; background: rgba(82,37,229,.08); font-size: 12px; font-weight: 700; }
.hero-content { position: relative; z-index: 1; display: grid; justify-items: center; max-width: 930px; margin: 78px auto 0; padding: 0 22px; text-align: center; }
.saas-hero .eyebrow { margin-bottom: 16px; color: #d8c6fe; font-size: 12px; letter-spacing: 0; text-transform: uppercase; }
.saas-hero h1 { max-width: 1040px; margin: 0; color: #f5efff; font-size: clamp(48px, 6vw, 78px); line-height: 1.08; font-weight: 800; letter-spacing: 0; }
.saas-hero h1 span { display: block; margin-top: 8px; color: #9b6cff; }
.saas-hero .landing-copy { max-width: 560px; margin: 28px 0 0; color: rgba(248,242,255,.74); font-size: 14px; line-height: 1.55; }
.saas-hero .landing-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 18px; margin-top: 38px; }
.landing-body .btn { min-height: 53px; padding: 14px 25px; border-radius: 999px; border-color: #a56cff; color: #12051d; background: #a56cff; font-size: 13px; font-weight: 800; box-shadow: 0 16px 36px rgba(82,37,229,.26); }
.landing-body .btn.secondary { color: #ffffff; background: rgba(255,255,255,.02); border-color: rgba(216,198,254,.7); box-shadow: none; }
.hero-stars span { position: absolute; z-index: 1; width: 25px; height: 25px; }
.hero-stars span::before, .hero-stars span::after { content: ""; position: absolute; inset: 0; margin: auto; background: #8e79fa; }
.hero-stars span::before { width: 2px; height: 25px; }
.hero-stars span::after { width: 25px; height: 2px; }
.hero-stars span:nth-child(1) { left: 19%; top: 28%; }
.hero-stars span:nth-child(2) { right: 18%; top: 50%; transform: scale(.9); }
.hero-stars span:nth-child(3) { left: 45%; top: 7%; transform: scale(.35); opacity: .7; }
.hero-stars span:nth-child(4) { right: 28%; top: 35%; transform: scale(.3); opacity: .55; }
.hero-stars span:nth-child(5) { left: 62%; top: 53%; transform: scale(.28); opacity: .55; }
.hero-orbit { position: absolute; left: 50%; bottom: 118px; z-index: -1; width: 1320px; max-width: 152%; height: 330px; transform: translateX(-50%); border-bottom: 1px solid rgba(142,121,250,.18); border-radius: 0 0 50% 50%; background: linear-gradient(180deg, rgba(2,1,5,0), rgba(82,37,229,.11)); }
.partner-strip { position: relative; z-index: 1; display: grid; justify-items: center; gap: 26px; max-width: 1020px; margin: 178px auto 0; padding: 0 22px 42px; text-align: center; }
.partner-strip p { margin: 0; color: #ffffff; font-size: 19px; font-weight: 800; }
.partner-strip div { display: grid; grid-template-columns: repeat(7, minmax(64px, 1fr)); gap: clamp(14px, 4vw, 46px); align-items: center; width: 100%; }
.partner-strip span { display: grid; place-items: center; min-height: 44px; color: #d8c6fe; font-size: 16px; font-weight: 800; opacity: .88; }
.landing-body .landing-section, .landing-body .how-section, .landing-body .final-cta { max-width: 1368px; margin: 0 auto; padding: 86px clamp(22px, 8vw, 118px); color: #f8f2ff; background: #0a0614; border-top: 1px solid rgba(216,198,254,.1); }
.landing-body .section-copy { max-width: 760px; margin-bottom: 34px; }
.landing-body .section-copy h2, .landing-body .how-section h2, .landing-body .final-cta h2 { max-width: 760px; color: #ffffff; font-size: clamp(34px, 4.5vw, 58px); line-height: 1.08; font-weight: 800; letter-spacing: 0; }
.landing-body .section-copy p, .landing-body .how-section p { color: rgba(248,242,255,.68); font-size: 15px; line-height: 1.6; }
.showcase-grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(320px, .92fr); gap: 22px; align-items: stretch; }
.saas-landing .dashboard-preview { max-width: none; margin: 0; padding: 18px; color: #f8f2ff; border: 1px solid rgba(216,198,254,.16); border-radius: 18px; background: linear-gradient(145deg, rgba(49,37,90,.9), rgba(2,1,5,.92)); box-shadow: 0 26px 70px rgba(0,0,0,.28); }
.saas-landing .preview-head { border-bottom-color: rgba(216,198,254,.13); }
.saas-landing .preview-head span, .saas-landing .preview-stats span, .saas-landing .preview-note { color: rgba(216,198,254,.75); }
.saas-landing .preview-stats div, .saas-landing .preview-list { border-color: rgba(216,198,254,.15); background: rgba(255,255,255,.04); }
.saas-landing .preview-stats strong, .saas-landing .preview-list strong { color: #ffffff; }
.saas-landing .preview-list div { border-top-color: rgba(216,198,254,.12); }
.saas-landing .preview-list span { color: rgba(248,242,255,.58); }
.saas-landing .preview-list em { color: #d8c6fe; border-color: rgba(216,198,254,.28); background: rgba(142,121,250,.12); }
.saas-landing .preview-note span { background: #8e79fa; }
.landing-body .platform-rows { display: grid; gap: 12px; }
.landing-body .platform-rows div { display: grid; grid-template-columns: minmax(150px, .72fr) 1fr; gap: 16px; align-items: center; min-height: 78px; padding: 18px 20px; border: 1px solid rgba(216,198,254,.15); border-radius: 16px; background: rgba(255,255,255,.04); }
.landing-body .platform-rows strong { color: #ffffff; font-size: 16px; font-weight: 800; }
.landing-body .platform-rows span { color: rgba(248,242,255,.64); font-size: 13px; line-height: 1.45; }
.feature-band { background: #11091f !important; }
.landing-body .solution-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.landing-body .solution-grid article { min-height: 232px; padding: 22px; border: 1px solid rgba(216,198,254,.15); border-radius: 18px; background: linear-gradient(180deg, rgba(49,37,90,.72), rgba(12,6,24,.88)); }
.landing-body .solution-grid span { color: #d8c6fe; font-size: 12px; font-weight: 800; }
.landing-body .solution-grid h3 { margin: 54px 0 12px; color: #ffffff; font-size: 20px; line-height: 1.15; font-weight: 800; }
.landing-body .solution-grid p { color: rgba(248,242,255,.64); font-size: 14px; line-height: 1.55; }
.landing-body .how-section { display: grid; grid-template-columns: minmax(280px, .75fr) minmax(0, 1.25fr); gap: 34px; background: #0a0614; }
.landing-body .how-steps { display: grid; gap: 12px; }
.landing-body .how-steps article { display: grid; grid-template-columns: 42px 1fr; gap: 8px 16px; padding: 20px; border: 1px solid rgba(216,198,254,.15); border-radius: 18px; background: rgba(255,255,255,.04); }
.landing-body .how-steps span { grid-row: 1 / span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; color: #12051d; background: #a56cff; font-weight: 800; }
.landing-body .how-steps strong { color: #ffffff; font-size: 17px; font-weight: 800; }
.landing-body .how-steps p { margin: 0; font-size: 14px; }
.landing-body .final-cta { display: grid; justify-items: center; gap: 14px; text-align: center; background: #05010d; }
.landing-body .final-cta h2 { max-width: 760px; }
.landing-body > .landing-footer { display: grid; grid-template-columns: minmax(220px, .9fr) minmax(280px, 1fr) auto; gap: 28px; align-items: center; max-width: 1368px; margin: 0 auto; padding: 34px clamp(22px, 8vw, 118px); color: #f8f2ff; background: #05010d; border-top: 1px solid rgba(216,198,254,.1); }
.landing-body > .landing-footer p { max-width: 520px; margin: 0; color: rgba(248,242,255,.62); font-size: 14px; line-height: 1.5; }
.landing-body > .landing-footer .footer-meta { display: grid; gap: 8px; color: rgba(216,198,254,.72); font-size: 12px; text-align: right; text-transform: uppercase; }

@media (max-width: 1120px) {
  .saas-hero { min-height: 700px; }
  .landing-body .landing-nav { padding-inline: 28px; }
  .landing-body .landing-menu { gap: 18px; }
  .showcase-grid, .landing-body .how-section { grid-template-columns: 1fr; }
  .landing-body .solution-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .landing-body { overflow-x: hidden; }
  .saas-landing, .saas-hero { width: 100%; max-width: 100vw; overflow-x: hidden; }
  .landing-body .landing-nav { grid-template-columns: 1fr auto; gap: 14px; min-height: auto; padding: 20px 18px; }
  .landing-body .landing-menu { display: none; }
  .landing-body .landing-nav-actions { display: none; }
  .landing-body .landing-link { min-height: 38px; padding: 9px 13px; }
  .hero-content { margin-top: 58px; padding-inline: 18px; overflow: hidden; }
  .saas-hero { min-height: 674px; }
  .saas-hero h1 { max-width: 320px; font-size: 38px; }
  .saas-hero .landing-copy { max-width: 300px; font-size: 13px; }
  .saas-hero .landing-actions { width: 100%; max-width: 300px; gap: 12px; }
  .landing-body .btn { width: 100%; min-height: 48px; }
  .hero-stars span:nth-child(1) { left: 11%; top: 25%; }
  .hero-stars span:nth-child(2) { right: 11%; top: 55%; }
  .partner-strip { max-width: 320px; margin-top: 126px; padding: 0 18px 30px; overflow: hidden; }
  .partner-strip p { font-size: 15px; }
  .partner-strip div { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .partner-strip span { min-width: 0; min-height: 32px; font-size: 12px; }
  .landing-body .landing-section, .landing-body .how-section, .landing-body .final-cta { padding: 54px 18px; }
  .landing-body .section-copy h2, .landing-body .how-section h2, .landing-body .final-cta h2 { font-size: 31px; }
  .landing-body .solution-grid, .saas-landing .preview-stats { grid-template-columns: 1fr; }
  .landing-body .platform-rows div, .landing-body .how-steps article { grid-template-columns: 1fr; }
  .saas-landing .preview-list div { grid-template-columns: 1fr auto; }
  .saas-landing .preview-list div span { display: none; }
  .landing-body > .landing-footer { grid-template-columns: 1fr; gap: 16px; padding: 28px 18px; }
  .landing-body > .landing-footer .footer-meta { text-align: left; }
}

/* KISMART theme override: full-width black, white, and green. */
.landing-body { color: #ffffff; background: #050505; overflow-x: hidden; font-family: "Times New Roman", Times, serif; }
.landing-body .saas-landing { width: 100%; background: #050505; font-family: inherit; }
.saas-hero { width: 100%; max-width: none; min-height: 744px; border: 0; background: #050505; }
.saas-hero::before { background-image: radial-gradient(circle at 19% 18%, rgba(22,163,74,.48) 0 1px, transparent 2px), radial-gradient(circle at 57% 7%, rgba(255,255,255,.36) 0 1px, transparent 2px), radial-gradient(circle at 81% 25%, rgba(22,163,74,.34) 0 1px, transparent 2px), radial-gradient(circle at 72% 54%, rgba(255,255,255,.28) 0 1px, transparent 2px), radial-gradient(circle at 24% 57%, rgba(22,163,74,.3) 0 1px, transparent 2px); }
.saas-hero::after { background: radial-gradient(ellipse at center bottom, rgba(22,163,74,.46), rgba(22,163,74,.22) 34%, rgba(5,5,5,0) 72%); }
.landing-body .landing-nav { width: 100%; padding: 26px clamp(22px, 8vw, 118px); }
.logo-symbol { background: radial-gradient(circle at 6px 6px, #16a34a 0 3px, transparent 3.8px), radial-gradient(circle at 14px 6px, #ffffff 0 3px, transparent 3.8px), radial-gradient(circle at 22px 6px, #16a34a 0 3px, transparent 3.8px), radial-gradient(circle at 6px 14px, #ffffff 0 3px, transparent 3.8px), radial-gradient(circle at 14px 14px, #16a34a 0 3px, transparent 3.8px), radial-gradient(circle at 22px 14px, #ffffff 0 3px, transparent 3.8px), radial-gradient(circle at 6px 22px, #16a34a 0 3px, transparent 3.8px), radial-gradient(circle at 14px 22px, #ffffff 0 3px, transparent 3.8px), radial-gradient(circle at 22px 22px, #16a34a 0 3px, transparent 3.8px); }
.saas-hero .eyebrow { color: #16a34a; }
.saas-hero h1 { color: #ffffff; }
.saas-hero h1 span { color: #16a34a; }
.saas-hero .landing-copy { color: rgba(255,255,255,.72); }
.landing-body .btn { color: #0f0f0f; background: #16a34a; border-color: #16a34a; box-shadow: 0 18px 42px rgba(22,163,74,.2); }
.landing-body .btn.secondary { color: #ffffff; background: rgba(255,255,255,.02); border-color: rgba(255,255,255,.72); }
.landing-body .landing-link { color: #0f0f0f; background: #16a34a; border-color: #16a34a; }
.hero-stars span::before, .hero-stars span::after { background: #16a34a; }
.hero-orbit { border-bottom-color: rgba(22,163,74,.24); background: linear-gradient(180deg, rgba(5,5,5,0), rgba(22,163,74,.1)); }
.partner-strip p { color: #ffffff; }
.partner-strip span { color: rgba(255,255,255,.78); }
.landing-body .landing-section, .landing-body .how-section, .landing-body .final-cta { max-width: none; margin: 0; color: #ffffff; background: #050505; border-top: 1px solid #202020; }
.landing-body .section-copy h2, .landing-body .how-section h2 { color: #ffffff; }
.landing-body .section-copy p, .landing-body .how-section p { color: rgba(255,255,255,.68); }
.showcase-grid { width: 100%; }
.saas-landing .dashboard-preview { color: #ffffff; border-color: #222222; background: #0f0f0f; box-shadow: none; }
.saas-landing .preview-head { border-bottom-color: rgba(22,163,74,.22); }
.saas-landing .preview-head span, .saas-landing .preview-stats span, .saas-landing .preview-note { color: rgba(22,163,74,.78); }
.saas-landing .preview-stats div, .saas-landing .preview-list { border-color: rgba(22,163,74,.18); background: rgba(255,255,255,.04); }
.saas-landing .preview-list div { border-top-color: rgba(22,163,74,.14); }
.saas-landing .preview-list em { color: #0f0f0f; border-color: #16a34a; background: #16a34a; }
.saas-landing .preview-note span { background: #16a34a; }
.landing-body .platform-rows div { border-color: #252525; background: #101010; }
.landing-body .platform-rows strong { color: #ffffff; }
.landing-body .platform-rows span { color: rgba(255,255,255,.64); }
.landing-body .feature-band { color: #ffffff; background: #050505 !important; border-top-color: #202020; }
.landing-body .feature-band .section-copy h2 { color: #ffffff; }
.landing-body .feature-band .section-copy p { color: rgba(255,255,255,.68); }
.landing-body .solution-grid article { border-color: #242424; background: #151515; }
.landing-body .solution-grid span { color: #16a34a; }
.landing-body .solution-grid h3 { color: #ffffff; }
.landing-body .solution-grid p { color: rgba(255,255,255,.68); }
.landing-body .how-steps article { border-color: #252525; background: #101010; }
.landing-body .how-steps span { color: #0f0f0f; background: #16a34a; }
.landing-body .how-steps strong { color: #ffffff; }
.landing-body .final-cta { color: #ffffff; background: #050505; border-top-color: #050505; }
.landing-body .final-cta .eyebrow { color: #16a34a; }
.landing-body .final-cta h2 { color: #ffffff; }
.landing-body > .landing-footer { max-width: none; margin: 0; color: #ffffff; background: #050505; border-top: 1px solid #222222; }
.landing-body > .landing-footer p { color: rgba(255,255,255,.62); }
.landing-body > .landing-footer .footer-meta { color: rgba(22,163,74,.82); }

@media (max-width: 760px) {
  .saas-hero { min-height: 668px; }
  .saas-hero h1 { max-width: 320px; font-size: 36px; }
  .saas-hero .landing-copy { max-width: 300px; }
}

@media (max-width: 980px) {
  .auth-stage { min-height: 100vh; padding: 20px 18px 24px; }
  .auth-scene { grid-template-columns: 1fr; min-height: auto; padding: 42px 0 28px; }
  .auth-side { display: none; }
  .auth-panel { width: min(100%, 430px); max-width: calc(100vw - 36px); }
}

@media (max-width: 560px) {
  .auth-body, .auth-stage { overflow-x: hidden; }
  .auth-nav { grid-template-columns: 1fr; gap: 14px; }
  .auth-links { justify-content: flex-start; flex-wrap: wrap; gap: 12px; }
  .auth-demo { min-height: 34px; padding: 8px 12px; }
  .auth-scene { width: 100%; padding-top: 38px; }
  .auth-panel { width: 100%; max-width: 100%; }
  .auth-form { padding: 26px 20px 22px; border-radius: 22px; }
  .auth-access { grid-template-columns: 1fr; }
  .auth-footer { flex-wrap: wrap; text-align: center; }
}

.landing-body .solution-grid article { display: grid; align-content: start; overflow: hidden; padding: 0; }
.landing-body .solution-grid article img { display: block; width: 100%; height: 148px; object-fit: cover; border-bottom: 1px solid #242424; filter: saturate(.9) contrast(1.04); }
.landing-body .solution-grid article span, .landing-body .solution-grid article h3, .landing-body .solution-grid article p { margin-left: 22px; margin-right: 22px; }
.landing-body .solution-grid article span { margin-top: 20px; }
.landing-body .solution-grid article h3 { margin-top: 34px; }
.landing-body .solution-grid article p { margin-bottom: 22px; }
.saas-landing .dashboard-preview { color: #111111; border-color: #dbe7dd; background: #ffffff; box-shadow: 0 24px 70px rgba(22,163,74,.1); }
.saas-landing .preview-head { border-bottom-color: #dbe7dd; }
.saas-landing .preview-head span, .saas-landing .preview-stats span, .saas-landing .preview-note { color: #166534; }
.saas-landing .preview-stats div, .saas-landing .preview-list { border-color: #dbe7dd; background: #f0fdf4; }
.saas-landing .preview-stats strong, .saas-landing .preview-list strong { color: #111111; }
.saas-landing .preview-list div { border-top-color: #dbe7dd; }
.saas-landing .preview-list span { color: #555555; }
.saas-landing .preview-list em { color: #111111; border-color: #16a34a; background: #16a34a; }
.saas-landing .preview-note span { background: #16a34a; }
.landing-body .platform-rows div { border-color: #dbe7dd; background: #ffffff; box-shadow: 0 14px 38px rgba(22,163,74,.08); }
.landing-body .platform-rows strong { color: #111111; }
.landing-body .platform-rows span { color: #555555; }
#platform .section-copy h2 { color: #16a34a; }
.platform-flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 38px; }
.platform-flow article { position: relative; min-height: 260px; padding: 24px; overflow: hidden; border: 1px solid #292929; border-radius: 18px; background: radial-gradient(circle at 50% 0, rgba(22,163,74,.18), rgba(22,163,74,0) 42%), #101010; }
.platform-flow article::after { content: ""; position: absolute; left: 24px; right: 24px; bottom: 24px; height: 1px; background: linear-gradient(90deg, #16a34a, transparent); }
.platform-flow span { display: inline-grid; place-items: center; width: 42px; height: 42px; border: 1px solid rgba(22,163,74,.42); border-radius: 999px; color: #0f0f0f; background: #16a34a; font-size: 14px; font-weight: 800; }
.platform-flow h3 { margin: 52px 0 12px; color: #ffffff; font-size: 24px; line-height: 1.12; font-weight: 800; }
.platform-flow p { margin: 0; color: rgba(255,255,255,.68); font-size: 15px; line-height: 1.55; }

@media (max-width: 760px) {
  .landing-body .solution-grid article img { height: 176px; }
  .platform-flow { grid-template-columns: 1fr; }
  .platform-flow article { min-height: 220px; }
}

.landing-body .faq-section { grid-template-columns: minmax(300px, .8fr) minmax(0, 1.2fr); align-items: start; gap: clamp(28px, 5vw, 70px); background: radial-gradient(circle at 12% 18%, rgba(22,163,74,.14), rgba(22,163,74,0) 34%), #050505; }
.faq-copy h2 { color: #ffffff; }
.faq-copy > p:not(.eyebrow) { max-width: 430px; color: rgba(255,255,255,.66); }
.faq-highlight { display: grid; gap: 8px; max-width: 380px; margin-top: 34px; padding: 24px; border: 1px solid rgba(22,163,74,.36); border-radius: 18px; color: #0f0f0f; background: #16a34a; box-shadow: 0 26px 80px rgba(22,163,74,.14); }
.faq-highlight span { font-size: 58px; line-height: .9; font-weight: 800; }
.faq-highlight strong { font-size: 20px; line-height: 1.1; font-weight: 800; }
.faq-highlight small { color: rgba(15,15,15,.76); font-size: 14px; line-height: 1.45; }
.landing-body .faq-list { gap: 14px; }
.landing-body .faq-list article { grid-template-columns: 58px 1fr; gap: 18px; min-height: 126px; padding: 24px; border-color: #2a2a2a; border-radius: 18px; background: linear-gradient(135deg, rgba(255,255,255,.065), rgba(255,255,255,.025)); }
.landing-body .faq-list article:hover { border-color: rgba(22,163,74,.52); background: linear-gradient(135deg, rgba(22,163,74,.12), rgba(255,255,255,.035)); }
.landing-body .faq-list span { width: 44px; height: 44px; font-size: 14px; }
.landing-body .faq-list strong { display: block; margin-bottom: 8px; font-size: 21px; line-height: 1.15; }
.landing-body .faq-list p { max-width: 680px; color: rgba(255,255,255,.66); font-size: 15px; line-height: 1.55; }
.landing-body > .landing-footer { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(420px, 1.2fr); gap: clamp(28px, 5vw, 70px); align-items: start; padding-top: 64px; padding-bottom: 34px; border-top: 1px solid rgba(22,163,74,.42); background: radial-gradient(circle at 82% 0, rgba(22,163,74,.12), rgba(22,163,74,0) 34%), #050505; }
.footer-brand { display: grid; gap: 16px; }
.footer-logo { color: #ffffff; }
.landing-body > .landing-footer .footer-brand p { max-width: 360px; color: rgba(255,255,255,.72); font-size: 16px; line-height: 1.55; }
.footer-cta { width: fit-content; min-height: 42px; display: inline-flex; align-items: center; justify-content: center; padding: 10px 18px; border-radius: 999px; color: #0f0f0f; background: #16a34a; font-size: 14px; font-weight: 800; }
.footer-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.footer-columns div { display: grid; gap: 10px; min-height: 178px; padding: 22px; border: 1px solid #242424; border-radius: 18px; background: #101010; }
.footer-columns strong { color: #16a34a; font-size: 15px; line-height: 1; }
.footer-columns a, .footer-columns span { color: rgba(255,255,255,.72); font-size: 14px; line-height: 1.35; }
.footer-columns a:hover { color: #ffffff; }
.footer-bottom { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 10px; padding-top: 26px; border-top: 1px solid #242424; color: rgba(255,255,255,.58); font-size: 13px; }
.footer-bottom span { display: inline-flex; align-items: center; min-height: 30px; padding: 6px 10px; border: 1px solid #242424; border-radius: 999px; background: #0d0d0d; }

@media (max-width: 980px) {
  .landing-body .faq-section, .landing-body > .landing-footer { grid-template-columns: 1fr; }
  .footer-columns { grid-template-columns: 1fr; }
}

@media (max-width: 760px) {
  .landing-body .faq-list article { grid-template-columns: 1fr; }
  .faq-highlight span { font-size: 46px; }
  .landing-body > .landing-footer { padding: 48px 18px 28px; }
}

/* Landing-matched login theme. */
.auth-body { color: #ffffff; background: #050505; font-family: "Times New Roman", Times, serif; }
.auth-stage { background: radial-gradient(ellipse at center bottom, rgba(22,163,74,.2), rgba(5,5,5,0) 42%), #050505; }
.auth-stage::before { height: 52%; background: radial-gradient(ellipse at center bottom, rgba(22,163,74,.28), rgba(22,163,74,0) 68%); }
.auth-brand { color: #ffffff; font-size: 24px; }
.auth-mark { background: radial-gradient(circle at 5px 5px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 13px 5px, #ffffff 0 3px, transparent 3.7px), radial-gradient(circle at 21px 5px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 5px 13px, #ffffff 0 3px, transparent 3.7px), radial-gradient(circle at 13px 13px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 21px 13px, #ffffff 0 3px, transparent 3.7px), radial-gradient(circle at 5px 21px, #16a34a 0 3px, transparent 3.7px), radial-gradient(circle at 13px 21px, #ffffff 0 3px, transparent 3.7px), radial-gradient(circle at 21px 21px, #16a34a 0 3px, transparent 3.7px); }
.auth-links a { color: rgba(255,255,255,.74); }
.auth-links a:hover { color: #ffffff; }
.auth-demo { color: #0f0f0f !important; background: #16a34a; border-color: #16a34a; }
.auth-scene { min-height: 650px; }
.auth-form { border-color: #292929; color: #ffffff; background: linear-gradient(145deg, rgba(24,24,24,.98), rgba(9,9,9,.98)); box-shadow: 0 30px 90px rgba(22,163,74,.12); }
.auth-form .eyebrow { color: #16a34a; }
.auth-form h1 { color: #ffffff; font-size: 31px; }
.auth-form p { color: rgba(255,255,255,.7); }
.auth-form label { color: #ffffff; }
.auth-form input { color: #ffffff; border-color: #333333; background: #050505; }
.auth-form input:focus { border-color: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.18); }
.auth-help { color: #16a34a; }
.auth-submit { color: #0f0f0f; background: #16a34a; border-color: #16a34a; }
.auth-divider { color: rgba(255,255,255,.62); }
.auth-divider span { background: #2b2b2b; }
.auth-access span { color: #ffffff; border-color: #333333; background: #101010; }
.auth-hint { color: rgba(255,255,255,.64); }
.auth-note { color: rgba(255,255,255,.62); }
.auth-note strong { color: #16a34a; }
.auth-footer { color: rgba(255,255,255,.6); }
.auth-footer span { background: rgba(22,163,74,.44); }
.auth-cardlet, .auth-device-card { border-color: rgba(22,163,74,.7); background: rgba(16,16,16,.72); }
.auth-cardlet span, .auth-device-card span { background: #16a34a; box-shadow: 0 12px 0 #16a34a; }
.auth-cardlet.graph span { border-color: #16a34a; background: transparent; box-shadow: none; }
.auth-dots { background-color: #16a34a; background-image: radial-gradient(#050505 0 3px, transparent 3.5px); }
.auth-squiggle, .auth-squiggle::after { border-color: #16a34a; }
.auth-operator .head, .auth-operator .body { background: #16a34a; }
.auth-operator .screen { border-color: #16a34a; background: #101010; }
.auth-operator::before { border-color: rgba(22,163,74,.7); background: rgba(16,16,16,.72); }
.auth-operator::after { border-left-color: #16a34a; border-bottom-color: #16a34a; }

@media (max-width: 980px) {
  .auth-scene { min-height: auto; }
}

@media (max-width: 560px) {
  .auth-stage { width: 100%; padding-left: 18px; padding-right: 18px; }
  .auth-scene { display: block; width: 100%; max-width: 100%; }
  .auth-panel { width: 100%; max-width: 100%; margin: 0; justify-items: stretch; }
  .auth-form { width: 100%; max-width: 100%; padding-left: 18px; padding-right: 18px; }
  .auth-form input, .auth-submit { width: 100%; max-width: 100%; }
}

/* Solid landing and login pass. */
.landing-body *, .landing-body *::before, .landing-body *::after,
.auth-body *, .auth-body *::before, .auth-body *::after {
  background-image: none !important;
  box-shadow: none !important;
  filter: none !important;
}
.landing-body,
.landing-body .saas-landing,
.saas-hero,
.landing-body .landing-section,
.landing-body .how-section,
.landing-body .final-cta,
.landing-body > .landing-footer,
.auth-body,
.auth-stage {
  background: #050505;
}
.saas-hero { min-height: 680px; color: #ffffff; }
.saas-hero::before,
.saas-hero::after,
.hero-stars,
.hero-orbit,
.auth-stage::before {
  display: none !important;
}
.landing-body .landing-nav {
  min-height: 82px;
  background: #050505;
  border-bottom: 1px solid #242424;
}
.landing-body .landing-logo,
.auth-brand {
  color: #ffffff;
}
.logo-symbol,
.auth-mark {
  border: 1px solid #16a34a;
  border-radius: 7px;
  background: #16a34a !important;
}
.landing-body .landing-menu a,
.auth-links a {
  color: #d6d6d6;
}
.landing-body .landing-menu a:hover,
.auth-links a:hover {
  color: #ffffff;
}
.hero-content { margin-top: 66px; }
.saas-hero h1,
.saas-hero h1 span,
.landing-body .section-copy h2,
.landing-body .how-section h2,
.landing-body .final-cta h2 {
  color: #ffffff;
}
.saas-hero .eyebrow,
.landing-body .eyebrow,
#platform .section-copy h2,
.footer-columns strong,
.auth-form .eyebrow,
.auth-note strong {
  color: #16a34a;
}
.saas-hero .landing-copy,
.landing-body .section-copy p,
.landing-body .how-section p,
.landing-body .solution-grid p,
.platform-flow p,
.landing-body > .landing-footer p,
.footer-columns a,
.footer-columns span,
.auth-form p,
.auth-note {
  color: #cfcfcf;
}
.landing-body .btn,
.landing-body .landing-link,
.footer-cta,
.auth-demo,
.auth-submit {
  color: #0f0f0f !important;
  border-color: #16a34a;
  border-radius: 8px;
  background: #16a34a !important;
}
.landing-body .btn.secondary {
  color: #ffffff !important;
  border-color: #4a4a4a;
  background: #050505 !important;
}
.partner-strip {
  margin-top: 138px;
}
.partner-strip p,
.partner-strip span {
  color: #ffffff;
}
.platform-flow article,
.landing-body .solution-grid article,
.landing-body .how-steps article,
.footer-columns div {
  border-color: #292929;
  border-radius: 8px;
  background: #101010;
}
.platform-flow article::after {
  display: none;
}
.platform-flow span,
.landing-body .how-steps span {
  color: #0f0f0f;
  border-color: #16a34a;
  background: #16a34a;
}
.platform-flow h3,
.landing-body .solution-grid h3,
.landing-body .how-steps strong {
  color: #ffffff;
}
.landing-body .solution-grid article img {
  border-bottom-color: #292929;
}
.landing-body .setup-section {
  grid-template-columns: minmax(260px, .72fr) minmax(0, 1.28fr);
  gap: clamp(22px, 4vw, 44px);
  padding-top: 62px;
  padding-bottom: 62px;
}
.setup-copy p {
  max-width: 520px;
}
.landing-body .setup-list {
  gap: 10px;
}
.landing-body .setup-list article {
  min-height: auto;
  padding: 18px;
}
.landing-body .setup-list strong {
  margin-bottom: 6px;
  font-size: 18px;
}
.landing-body .setup-list p {
  max-width: 720px;
  font-size: 14px;
}
.faq-highlight {
  display: none;
}
.landing-body > .landing-footer {
  border-top-color: #242424;
}
.footer-bottom {
  border-top-color: #242424;
  color: #a8a8a8;
}
.footer-bottom span {
  border-color: #292929;
  background: #101010;
}
.auth-stage {
  padding: clamp(20px, 4vw, 52px) clamp(18px, 5vw, 68px);
}
.auth-scene {
  grid-template-columns: minmax(320px, 460px);
  justify-content: center;
  min-height: 620px;
}
.auth-side {
  display: none;
}
.auth-panel {
  max-width: 460px;
}
.auth-form {
  border-color: #292929;
  border-radius: 8px;
  color: #ffffff;
  background: #101010;
}
.auth-form h1,
.auth-form label {
  color: #ffffff;
}
.auth-form input {
  color: #ffffff;
  border-color: #333333;
  background: #050505;
}
.auth-form input:focus {
  border-color: #16a34a;
}
.auth-access span {
  color: #ffffff;
  border-color: #333333;
  background: #050505;
}
.auth-divider span {
  background: #333333;
}
.auth-help {
  color: #16a34a;
}

@media (max-width: 980px) {
  .landing-body .setup-section {
    grid-template-columns: 1fr;
  }
  .auth-scene {
    grid-template-columns: minmax(0, 460px);
  }
}

@media (max-width: 760px) {
  .saas-hero {
    min-height: 620px;
  }
  .hero-content {
    margin-top: 44px;
  }
  .partner-strip {
    margin-top: 96px;
  }
  .landing-body .setup-section {
    padding-top: 48px;
    padding-bottom: 48px;
  }
}

/* Follow-up polish: original marks, simpler nav, white login. */
.landing-body .landing-menu {
  gap: clamp(22px, 4vw, 56px);
}
.logo-symbol {
  border: 0;
  border-radius: 8px;
  background:
    radial-gradient(circle at 6px 6px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 6px, #ffffff 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 6px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 6px 14px, #ffffff 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 14px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 14px, #ffffff 0 3px, transparent 3.8px),
    radial-gradient(circle at 6px 22px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 22px, #ffffff 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 22px, #16a34a 0 3px, transparent 3.8px) !important;
}
.auth-body,
.auth-stage {
  color: #111111;
  background: #ffffff;
}
.auth-brand {
  color: #111111;
}
.auth-mark {
  border: 0;
  border-radius: 0;
  background:
    radial-gradient(circle at 5px 5px, #16a34a 0 3px, transparent 3.7px),
    radial-gradient(circle at 13px 5px, #111111 0 3px, transparent 3.7px),
    radial-gradient(circle at 21px 5px, #16a34a 0 3px, transparent 3.7px),
    radial-gradient(circle at 5px 13px, #111111 0 3px, transparent 3.7px),
    radial-gradient(circle at 13px 13px, #16a34a 0 3px, transparent 3.7px),
    radial-gradient(circle at 21px 13px, #111111 0 3px, transparent 3.7px),
    radial-gradient(circle at 5px 21px, #16a34a 0 3px, transparent 3.7px),
    radial-gradient(circle at 13px 21px, #111111 0 3px, transparent 3.7px),
    radial-gradient(circle at 21px 21px, #16a34a 0 3px, transparent 3.7px) !important;
}
.auth-links a {
  color: #222222;
}
.auth-links a:hover {
  color: #000000;
}
.auth-form {
  color: #111111;
  border-color: #dfe7df;
  background: #ffffff;
}
.auth-form h1,
.auth-form label {
  color: #111111;
}
.auth-form p,
.auth-note,
.auth-hint,
.auth-divider {
  color: #555555;
}
.auth-form input {
  color: #111111;
  border-color: #cbd8cd;
  background: #ffffff;
}
.auth-access span {
  color: #111111;
  border-color: #dfe7df;
  background: #ffffff;
}
.auth-divider span {
  background: #dfe7df;
}
.auth-help,
.auth-note strong {
  color: #166534;
}

/* White landing pass. */
.landing-body,
.landing-body .saas-landing,
.saas-hero,
.landing-body .landing-nav,
.landing-body .landing-section,
.landing-body .how-section,
.landing-body .final-cta,
.landing-body > .landing-footer {
  color: #111111;
  background: #ffffff;
}
.landing-body .landing-nav,
.saas-hero,
.landing-body .landing-section,
.landing-body .how-section,
.landing-body .final-cta,
.landing-body > .landing-footer {
  border-color: #dfe7df;
}
.landing-body .landing-logo,
.landing-body .landing-menu a,
.partner-strip p,
.partner-strip span,
.saas-hero h1,
.saas-hero h1 span,
.landing-body .section-copy h2,
#platform .section-copy h2,
.landing-body .how-section h2,
.landing-body .final-cta h2,
.platform-flow h3,
.landing-body .solution-grid h3,
.landing-body .how-steps strong,
.footer-logo {
  color: #111111;
}
.landing-body .landing-menu a:hover {
  color: #166534;
}
.logo-symbol {
  background:
    radial-gradient(circle at 6px 6px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 6px, #111111 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 6px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 6px 14px, #111111 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 14px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 14px, #111111 0 3px, transparent 3.8px),
    radial-gradient(circle at 6px 22px, #16a34a 0 3px, transparent 3.8px),
    radial-gradient(circle at 14px 22px, #111111 0 3px, transparent 3.8px),
    radial-gradient(circle at 22px 22px, #16a34a 0 3px, transparent 3.8px) !important;
}
.saas-hero .landing-copy,
.landing-body .section-copy p,
.landing-body .how-section p,
.landing-body .solution-grid p,
.platform-flow p,
.landing-body > .landing-footer p,
.footer-columns a,
.footer-columns span {
  color: #555555;
}
.landing-body .btn.secondary {
  color: #111111 !important;
  border-color: #cbd8cd;
  background: #ffffff !important;
}
.platform-flow article,
.landing-body .solution-grid article,
.landing-body .how-steps article,
.footer-columns div,
.footer-bottom span {
  border-color: #dfe7df;
  background: #ffffff;
}
.landing-body .solution-grid article img {
  border-bottom-color: #dfe7df;
}
.footer-bottom {
  border-top-color: #dfe7df;
  color: #666666;
}



/* ─── KISMART professional brand system ─── */
.ks-site, .ks-auth, .ks-dash {
  margin: 0;
  color: #14201a;
  background: #f4f7f5;
  font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.ks-wrap { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
.ks-kicker {
  margin: 0 0 10px;
  color: #0d6b45;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.ks-kicker.light { color: #9fd4b8; }
.ks-logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #14201a;
  font-size: 18px;
  font-weight: 750;
  text-decoration: none;
}
.ks-logo.light { color: #ffffff; }
.ks-mark {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: #0d6b45;
  box-shadow: inset 0 0 0 2px #0d6b45;
  position: relative;
}
.ks-mark::after {
  content: "";
  position: absolute;
  inset: 7px;
  border: 2px solid #ffffff;
  border-radius: 2px;
}
.ks-mark.light { background: #159a5f; }
.ks-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  padding: 0 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
}
.ks-btn-primary { color: #ffffff; background: #0d6b45; border-color: #0d6b45; }
.ks-btn-primary:hover { background: #0b5a3a; }
.ks-btn-ghost { color: #14201a; background: #ffffff; border-color: #c9d6ce; }
.ks-btn-ghost:hover { border-color: #0d6b45; }
.ks-btn-on-dark { color: #0d1f17; background: #ffffff; border-color: #ffffff; }
.ks-btn-outline-light { color: #ffffff; background: transparent; border-color: rgba(255,255,255,.45); }
.ks-btn-block { width: 100%; }
.ks-link { color: #2f4038; font-size: 14px; font-weight: 600; text-decoration: none; }
.ks-link:hover { color: #0d6b45; }

/* Top bar */
.ks-topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  background: #ffffff;
  border-bottom: 1px solid #d5e0d9;
}
.ks-topbar-inner {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 20px;
  min-height: 68px;
}
.ks-nav { display: flex; justify-content: center; gap: 22px; }
.ks-nav a { color: #42574c; font-size: 14px; font-weight: 600; text-decoration: none; }
.ks-nav a:hover { color: #0d6b45; }
.ks-top-actions { display: flex; align-items: center; gap: 12px; }

/* Hero */
.ks-hero {
  background: #ffffff;
  border-bottom: 1px solid #d5e0d9;
}
.ks-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr);
  gap: 40px;
  align-items: center;
  padding: 56px 0 52px;
}
.ks-hero h1 {
  margin: 0;
  max-width: 560px;
  color: #14201a;
  font-size: clamp(32px, 4.2vw, 44px);
  line-height: 1.15;
  font-weight: 750;
  letter-spacing: -.02em;
}
.ks-lead {
  margin: 16px 0 0;
  max-width: 520px;
  color: #5a6b62;
  font-size: 16px;
  line-height: 1.6;
}
.ks-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.ks-hero-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 28px 0 0;
}
.ks-hero-facts div {
  padding: 12px 14px;
  border: 1px solid #d5e0d9;
  border-radius: 10px;
  background: #f4f7f5;
}
.ks-hero-facts dt {
  color: #5a6b62;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.ks-hero-facts dd {
  margin: 6px 0 0;
  color: #14201a;
  font-size: 13px;
  font-weight: 650;
}
.ks-hero-card {
  padding: 18px;
  border: 1px solid #d5e0d9;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgba(13, 31, 23, .06);
}
.ks-card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e4ece7;
}
.ks-card-head span { color: #0d6b45; font-size: 11px; font-weight: 700; text-transform: uppercase; }
.ks-card-head strong { color: #14201a; font-size: 14px; }
.ks-stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 14px 0;
}
.ks-stat {
  padding: 12px;
  border: 1px solid #e4ece7;
  border-radius: 10px;
  background: #f8fbf9;
}
.ks-stat span { display: block; color: #5a6b62; font-size: 11px; font-weight: 600; }
.ks-stat strong { display: block; margin-top: 8px; color: #14201a; font-size: 18px; }
.ks-task-list { list-style: none; margin: 0; padding: 0; border: 1px solid #e4ece7; border-radius: 10px; overflow: hidden; }
.ks-task-list li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border-top: 1px solid #eef3f0;
}
.ks-task-list li:first-child { border-top: 0; }
.ks-task-list strong { color: #14201a; font-size: 13px; }
.ks-task-list span { color: #5a6b62; font-size: 12px; }
.ks-task-list em {
  min-width: 54px;
  padding: 4px 8px;
  border-radius: 999px;
  background: #e7f3ed;
  color: #0d6b45;
  font-size: 11px;
  font-style: normal;
  font-weight: 700;
  text-align: center;
}

/* Band */
.ks-band { background: #eef3f0; border-bottom: 1px solid #d5e0d9; }
.ks-band-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 18px;
  padding: 18px 0;
}
.ks-band-inner > p {
  margin: 0;
  color: #5a6b62;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.ks-band-inner ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ks-band-inner li {
  padding: 7px 12px;
  border: 1px solid #d5e0d9;
  border-radius: 999px;
  background: #ffffff;
  color: #2f4038;
  font-size: 13px;
  font-weight: 600;
}

/* Sections */
.ks-section { padding: 64px 0; background: #ffffff; }
.ks-section-alt { background: #f4f7f5; border-top: 1px solid #d5e0d9; border-bottom: 1px solid #d5e0d9; }
.ks-section-head { max-width: 640px; margin-bottom: 28px; }
.ks-section-head.tight { margin-bottom: 0; }
.ks-section-head h2 {
  margin: 0 0 10px;
  color: #14201a;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.2;
  font-weight: 750;
  letter-spacing: -.015em;
}
.ks-section-head p:not(.ks-kicker) { margin: 0; color: #5a6b62; font-size: 15px; line-height: 1.55; }
.ks-quad, .ks-features, .ks-security {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.ks-features, .ks-security { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ks-quad article, .ks-features article, .ks-security article {
  padding: 20px;
  border: 1px solid #d5e0d9;
  border-radius: 12px;
  background: #ffffff;
}
.ks-features article {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ks-features article img {
  display: block;
  width: 100%;
  height: 168px;
  object-fit: cover;
  border-bottom: 1px solid #d5e0d9;
  background: #eef3f0;
}
.ks-feature-body { padding: 18px 20px 20px; }
.ks-section-alt .ks-quad article,
.ks-section-alt .ks-features article,
.ks-section-alt .ks-security article { background: #ffffff; }
.ks-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: #e7f3ed;
  color: #0d6b45;
  font-size: 12px;
  font-weight: 750;
}
.ks-quad h3, .ks-features h3, .ks-security h3 {
  margin: 14px 0 8px;
  color: #14201a;
  font-size: 16px;
  font-weight: 700;
}
.ks-quad p, .ks-features p, .ks-security p {
  margin: 0;
  color: #5a6b62;
  font-size: 14px;
  line-height: 1.5;
}
.ks-tag {
  margin: 0 0 8px !important;
  color: #0d6b45 !important;
  font-size: 11px !important;
  font-weight: 750 !important;
  letter-spacing: .05em;
  text-transform: uppercase;
}
.ks-split {
  display: grid;
  grid-template-columns: minmax(240px, .85fr) minmax(0, 1.15fr);
  gap: 36px;
  align-items: start;
}
.ks-steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; counter-reset: step; }
.ks-steps li {
  position: relative;
  padding: 18px 18px 18px 62px;
  border: 1px solid #d5e0d9;
  border-radius: 12px;
  background: #ffffff;
  counter-increment: step;
}
.ks-steps li::before {
  content: counter(step);
  position: absolute;
  left: 16px;
  top: 18px;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: #0d6b45;
  color: #ffffff;
  font-size: 13px;
  font-weight: 750;
}
.ks-steps strong { display: block; color: #14201a; font-size: 15px; }
.ks-steps p { margin: 6px 0 0; color: #5a6b62; font-size: 14px; line-height: 1.5; }

/* CTA + footer */
.ks-cta {
  background: #0d1f17;
  color: #ffffff;
  padding: 56px 0;
}
.ks-cta-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}
.ks-cta h2 {
  margin: 0 0 8px;
  max-width: 520px;
  color: #ffffff;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.2;
}
.ks-cta p:not(.ks-kicker) { margin: 0; max-width: 520px; color: #b7c9be; font-size: 15px; line-height: 1.5; }
.ks-footer {
  background: #ffffff;
  border-top: 1px solid #d5e0d9;
  padding: 36px 0 24px;
}
.ks-footer-grid {
  display: grid;
  grid-template-columns: 1.4fr .8fr .8fr;
  gap: 28px;
}
.ks-footer p { margin: 12px 0 0; max-width: 340px; color: #5a6b62; font-size: 14px; line-height: 1.5; }
.ks-footer strong {
  display: block;
  margin-bottom: 10px;
  color: #14201a;
  font-size: 12px;
  font-weight: 750;
  letter-spacing: .05em;
  text-transform: uppercase;
}
.ks-footer a, .ks-footer span {
  display: block;
  margin-top: 8px;
  color: #5a6b62;
  font-size: 14px;
  text-decoration: none;
}
.ks-footer a:hover { color: #0d6b45; }
.ks-footer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #e4ece7;
  color: #6b7c73;
  font-size: 12px;
}

/* Auth */
.ks-auth { min-height: 100vh; background: #f4f7f5; }
.ks-auth-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, .95fr) minmax(340px, 1.05fr);
}
.ks-auth-brand {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 48px clamp(28px, 5vw, 64px);
  background: #0d1f17;
  color: #ffffff;
}
.ks-auth-brand h1 {
  margin: 18px 0 0;
  max-width: 380px;
  font-size: clamp(28px, 3.5vw, 36px);
  line-height: 1.15;
  font-weight: 750;
}
.ks-auth-brand > p { margin: 0; max-width: 360px; color: #b7c9be; font-size: 15px; line-height: 1.55; }
.ks-auth-brand ul { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.ks-auth-brand li {
  position: relative;
  padding-left: 18px;
  color: #d7e6dd;
  font-size: 14px;
}
.ks-auth-brand li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #159a5f;
}
.ks-auth-main {
  display: grid;
  place-items: center;
  padding: 40px 20px;
}
.ks-auth-card {
  width: min(420px, 100%);
  padding: 28px;
  border: 1px solid #d5e0d9;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 10px 28px rgba(13, 31, 23, .05);
}
.ks-auth-card h2 { margin: 0 0 6px; font-size: 24px; color: #14201a; }
.ks-auth-sub { margin: 0 0 18px; color: #5a6b62; font-size: 14px; line-height: 1.5; }
.ks-form { display: grid; gap: 12px; }
.ks-form label { display: grid; gap: 6px; color: #2f4038; font-size: 12px; font-weight: 700; }
.ks-form input, .ks-form select, .ks-form textarea {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid #c9d6ce;
  border-radius: 8px;
  background: #ffffff;
  color: #14201a;
  font: inherit;
  outline: none;
}
.ks-form textarea { min-height: 96px; resize: vertical; }
.ks-form input:focus, .ks-form select:focus, .ks-form textarea:focus {
  border-color: #0d6b45;
  box-shadow: 0 0 0 3px rgba(13, 107, 69, .12);
}
.ks-alert {
  padding: 11px 12px;
  border: 1px solid #9b2c2c;
  border-radius: 8px;
  background: #fdecec;
  color: #7a1f1f;
  font-size: 13px;
}
.ks-alert.ok {
  border-color: #0d6b45;
  background: #e7f3ed;
  color: #0b5a3a;
}
.ks-auth-demo, .ks-auth-meta { margin: 14px 0 0; color: #6b7c73; font-size: 12px; line-height: 1.45; }
.ks-auth-foot { margin: 16px 0 0; text-align: center; }
.ks-auth-foot a { color: #5a6b62; font-size: 13px; text-decoration: none; }
.ks-auth-foot a:hover { color: #0d6b45; }

/* Intake */
.ks-intake { padding: 48px 0 64px; }
.ks-intake-grid {
  display: grid;
  grid-template-columns: minmax(240px, .9fr) minmax(320px, 440px);
  gap: 40px;
  align-items: start;
}
.ks-intake-copy h1 {
  margin: 0 0 12px;
  color: #14201a;
  font-size: clamp(28px, 4vw, 40px);
  line-height: 1.15;
}
.ks-intake-copy p:not(.ks-kicker) { margin: 0; color: #5a6b62; font-size: 15px; line-height: 1.55; max-width: 420px; }
.ks-intake-form {
  padding: 22px;
  border: 1px solid #d5e0d9;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 10px 28px rgba(13, 31, 23, .05);
}
.ks-full { grid-column: 1 / -1; }

/* Dashboard overrides (shell still uses existing class names from app.js) */
.ks-dash { background: #f4f7f5; color: #14201a; font-family: "Segoe UI", system-ui, Arial, sans-serif; }
.ks-dash .shell { min-height: 100vh; }
.ks-dash aside {
  background: #0d1f17 !important;
  color: #ffffff !important;
  border-right: 1px solid #0a1711 !important;
}
.ks-dash .brand { border-bottom-color: rgba(255,255,255,.1) !important; }
.ks-dash .brand-word { color: #ffffff !important; font-weight: 750 !important; }
.ks-dash .brand span { color: #a8c0b3 !important; }
.ks-dash .brand-logo {
  border: 0 !important;
  border-radius: 7px !important;
  background: #0d6b45 !important;
}
.ks-dash .brand-logo::before {
  background: #ffffff !important;
  box-shadow: 8px 0 rgba(255,255,255,.55), 16px 0 #ffffff, 0 8px rgba(255,255,255,.55), 8px 8px #ffffff, 16px 8px rgba(255,255,255,.55), 0 16px #ffffff, 8px 16px rgba(255,255,255,.55), 16px 16px #ffffff !important;
}
.ks-dash nav button {
  color: #c5d6cc !important;
  border-radius: 8px !important;
  font-weight: 550 !important;
}
.ks-dash nav button.active,
.ks-dash nav button:hover {
  color: #ffffff !important;
  background: rgba(13, 107, 69, .28) !important;
}
.ks-dash nav button.active::before,
.ks-dash nav button:hover::before { background: #159a5f !important; }
.ks-dash nav button.active .nav-icon,
.ks-dash nav button:hover .nav-icon { color: #7dcea6 !important; }
.ks-dash .side-status { border-top-color: rgba(255,255,255,.1) !important; }
.ks-dash .side-status strong { color: #ffffff !important; }
.ks-dash .side-status small { color: #a8c0b3 !important; }
.ks-dash .pulse { background: #159a5f !important; box-shadow: 0 0 0 4px rgba(21, 154, 95, .2) !important; }
.ks-dash main { background: #f4f7f5 !important; padding: 22px 26px 36px !important; }
.ks-dash .dash-header {
  border-bottom: 1px solid #d5e0d9 !important;
  margin-bottom: 18px !important;
  padding-bottom: 14px !important;
}
.ks-dash h1 { color: #14201a !important; font-weight: 750 !important; }
.ks-dash .eyebrow { color: #0d6b45 !important; font-weight: 700 !important; letter-spacing: .05em !important; }
.ks-dash .controls input,
.ks-dash .controls select {
  border: 1px solid #c9d6ce !important;
  border-radius: 8px !important;
  background: #ffffff !important;
  color: #14201a !important;
  box-shadow: none !important;
}
.ks-dash .controls input:focus,
.ks-dash .controls select:focus {
  border-color: #0d6b45 !important;
  box-shadow: 0 0 0 3px rgba(13, 107, 69, .12) !important;
}
.ks-dash .btn {
  border-radius: 8px !important;
  border: 1px solid #0d6b45 !important;
  background: #0d6b45 !important;
  color: #ffffff !important;
  font-weight: 650 !important;
  box-shadow: none !important;
}
.ks-dash .btn.secondary {
  background: #ffffff !important;
  color: #14201a !important;
  border-color: #c9d6ce !important;
}
.ks-dash .btn.signout-btn {
  background: #ffffff !important;
  color: #9b2c2c !important;
  border-color: #e8b4b4 !important;
}
.ks-dash .panel,
.ks-dash .metric,
.ks-dash .chart-panel {
  border: 1px solid #d5e0d9 !important;
  border-radius: 12px !important;
  background: #ffffff !important;
  box-shadow: 0 6px 18px rgba(13, 31, 23, .04) !important;
}
.ks-dash .health-panel {
  background: #0d1f17 !important;
  border-color: #0d1f17 !important;
  color: #ffffff !important;
  border-radius: 12px !important;
  box-shadow: none !important;
}
.ks-dash .health-copy .eyebrow,
.ks-dash .health-copy p,
.ks-dash .health-strip span { color: #a8c0b3 !important; }
.ks-dash .health-copy strong,
.ks-dash .health-strip strong { color: #ffffff !important; }
.ks-dash .health-score {
  border: 1px solid rgba(21, 154, 95, .45) !important;
  color: #7dcea6 !important;
  border-radius: 10px !important;
}
.ks-dash .health-strip { border-top-color: rgba(255,255,255,.1) !important; }
.ks-dash tbody tr:hover td { background: #f0f8f4 !important; }
.ks-dash th { background: #eef3f0 !important; color: #5a6b62 !important; }
.ks-dash .badge {
  border-radius: 999px !important;
  font-weight: 650 !important;
}
.ks-dash .badge.Active,
.ks-dash .badge.Pending,
.ks-dash .badge.Live {
  color: #14201a !important;
  background: #eef3f0 !important;
  border: 1px solid #d5e0d9 !important;
}
.ks-dash .badge.Completed,
.ks-dash .badge.Synced,
.ks-dash .badge.Ready,
.ks-dash .badge.Online {
  color: #0b5a3a !important;
  background: #e7f3ed !important;
  border: 1px solid #b7dfc9 !important;
}
.ks-dash .badge.Overdue,
.ks-dash .badge.Attention {
  color: #0b5a3a !important;
  background: #e7f3ed !important;
  border: 1px solid #0d6b45 !important;
}
.ks-dash .badge.Restricted,
.ks-dash .badge.Failed,
.ks-dash .badge.Blocked,
.ks-dash .badge.Offline {
  color: #ffffff !important;
  background: #14201a !important;
  border: 1px solid #14201a !important;
}
.ks-dash .tiny {
  border-radius: 7px !important;
  border-color: #c9d6ce !important;
  background: #ffffff !important;
  color: #14201a !important;
}
.ks-dash .tiny.success,
.ks-dash .tiny[data-action="remind"],
.ks-dash .tiny[data-action="warn"] {
  background: #0d6b45 !important;
  border-color: #0d6b45 !important;
  color: #ffffff !important;
}
.ks-dash .tiny.danger,
.ks-dash .tiny[data-action="restrict"] {
  background: #14201a !important;
  border-color: #14201a !important;
  color: #ffffff !important;
}
.ks-dash .tiny.delete {
  background: #ffffff !important;
  border-color: #e8b4b4 !important;
  color: #9b2c2c !important;
}
.ks-dash .metric.green strong,
.ks-dash .metric.accent strong,
.ks-dash .metric.blue strong { color: #0d6b45 !important; }
.ks-dash .metric.red strong { color: #9b2c2c !important; }
.ks-dash .metric::after { background: #0d6b45 !important; opacity: .55 !important; }
.ks-dash .bar-fill,
.ks-dash .pipeline-fill { background: #0d6b45 !important; }
.ks-dash .chart-blue,
.ks-dash .chart-teal,
.ks-dash .chart-accent,
.ks-dash .chart-green { fill: #0d6b45 !important; stroke: #0d6b45 !important; }
.ks-dash .chart-red { fill: #9b2c2c !important; stroke: #9b2c2c !important; }
.ks-dash .toast { border-radius: 10px !important; background: #0d1f17 !important; }

@media (max-width: 960px) {
  .ks-hero-grid,
  .ks-split,
  .ks-auth-shell,
  .ks-intake-grid,
  .ks-cta-inner,
  .ks-footer-grid { grid-template-columns: 1fr !important; }
  .ks-quad { grid-template-columns: 1fr 1fr !important; }
  .ks-auth-brand { min-height: auto; padding-top: 36px; padding-bottom: 36px; }
}
@media (max-width: 720px) {
  .ks-nav { display: none !important; }
  .ks-topbar-inner { grid-template-columns: auto auto !important; }
  .ks-hero-facts,
  .ks-stat-row,
  .ks-quad,
  .ks-features,
  .ks-security { grid-template-columns: 1fr !important; }
  .ks-task-list li { grid-template-columns: 1fr auto !important; }
  .ks-task-list span { display: none; }
  .ks-wrap { width: min(100% - 28px, 1120px); }
}

`;
}

function renderClientScript() {
  return String.raw`
const money = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 0 });
const app = document.getElementById("app");
const title = document.getElementById("title");
const eyebrow = document.getElementById("eyebrow");
const role = document.getElementById("role");
const search = document.getElementById("search");
const toast = document.getElementById("toast");
let state = null;
let view = "overview";
let liveEvents = null;
let liveReloadTimer = 0;

const baseDeviceCatalog = [
  { id: "samsung-a15", label: "Samsung Galaxy A15", model: "Samsung Galaxy A15", platform: "Android", controlProfile: "Android device owner", price: 28000 },
  { id: "tecno-spark-20", label: "Tecno Spark 20", model: "Tecno Spark 20", platform: "Android", controlProfile: "Android work profile", price: 18500 },
  { id: "infinix-note-40", label: "Infinix Note 40", model: "Infinix Note 40", platform: "Android", controlProfile: "Android device owner", price: 33000 },
  { id: "iphone-12", label: "iPhone 12", model: "iPhone 12", platform: "iOS", controlProfile: "Apple supervised MDM", price: 64000 },
  { id: "iphone-13", label: "iPhone 13", model: "iPhone 13", platform: "iOS", controlProfile: "Apple supervised MDM", price: 78000 },
  { id: "iphone-14", label: "iPhone 14", model: "iPhone 14", platform: "iOS", controlProfile: "Apple supervised MDM", price: 92000 }
];

function deviceOptions() {
  const manual = { id: "custom", label: "Manual entry", model: "", imei: "", serial: "", platform: "Android", controlProfile: "Android device owner", price: "", inventoryDeviceId: "" };
  const saved = ((state && state.inventoryDevices) || []).map(function (device) {
    const identity = [device.imei, device.serial].filter(Boolean).join(" / ");
    return {
      id: "inventory:" + device.id,
      label: device.model + (identity ? " - " + identity : "") + (device.status === "Assigned" ? " (assigned)" : ""),
      model: device.model,
      imei: device.imei,
      serial: device.serial,
      platform: device.platform,
      controlProfile: device.controlProfile,
      price: device.price,
      inventoryDeviceId: device.id
    };
  });
  return [manual].concat(saved, baseDeviceCatalog.map(function (device) {
    return Object.assign({ imei: "", serial: "", inventoryDeviceId: "" }, device);
  }));
}

const planTemplates = [
  { id: "custom", label: "Custom terms", frequency: "Weekly", periodCount: 4, graceDays: 2, depositRate: null },
  { id: "daily-30", label: "Daily - 30 payments", frequency: "Daily", periodCount: 30, graceDays: 1, depositRate: 0.2 },
  { id: "weekly-8", label: "Weekly - 8 payments", frequency: "Weekly", periodCount: 8, graceDays: 2, depositRate: 0.2 },
  { id: "monthly-4", label: "Monthly - 4 payments", frequency: "Monthly", periodCount: 4, graceDays: 3, depositRate: 0.25 }
];

const titles = {
  overview: ["Portfolio command", "Command Center"],
  contracts: ["Repayment ledger", "Portfolio"],
  register: ["Customer onboarding", "Onboarding"],
  inventory: ["Admin device stock", "Device Stock"],
  payments: ["Collections desk", "Collections"],
  devices: ["Device command queue", "Device Operations"],
  operations: ["Ecosystem control", "Ecosystem"],
  audit: ["Governance", "Audit Trail"]
};

document.querySelectorAll("[data-view]").forEach(function (button) {
  button.addEventListener("click", function () {
    view = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach(function (item) {
      item.classList.toggle("active", item === button);
    });
    render();
  });
});

document.getElementById("refresh").addEventListener("click", load);
search.addEventListener("input", render);

document.addEventListener("click", async function (event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.disabled) return;
  const id = target.dataset.id;
  if (target.dataset.confirm && !window.confirm(target.dataset.confirm)) return;
  target.disabled = true;
  target.classList.add("busy");
  try {
    if (target.dataset.action === "warn") await api("/api/contracts/" + id + "/warnings", { method: "POST", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "remind") await api("/api/contracts/" + id + "/reminders", { method: "POST", body: JSON.stringify({ role: role.value, type: "Payment reminder" }) });
    if (target.dataset.action === "restrict") await api("/api/contracts/" + id + "/restrictions", { method: "POST", body: JSON.stringify({ role: role.value, level: target.dataset.level }) });
    if (target.dataset.action === "restore") await api("/api/contracts/" + id + "/restrictions?role=" + encodeURIComponent(role.value), { method: "DELETE" });
    if (target.dataset.action === "reset-binding") await api("/api/contracts/" + encodeURIComponent(id) + "/device-binding", { method: "DELETE", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "delete-contract") await api("/api/contracts/" + encodeURIComponent(id), { method: "DELETE", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "delete-intake") await api("/api/intakes/" + encodeURIComponent(id), { method: "DELETE", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "delete-inventory-device") await api("/api/inventory-devices/" + encodeURIComponent(id), { method: "DELETE", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "run-automation") await api("/api/automation/run", { method: "POST", body: JSON.stringify({ role: role.value }) });
    if (target.dataset.action === "dispatch-notices") await api("/api/notifications/dispatch", { method: "POST", body: JSON.stringify({ role: role.value, limit: 50 }) });
    if (target.dataset.action === "dispatch-mdm") await api("/api/device-commands/dispatch", { method: "POST", body: JSON.stringify({ role: role.value, limit: 50 }) });
    await load();
    showToast(actionToast(target.dataset.action, target.dataset.level));
  } catch (error) {
    showToast(error.message);
  } finally {
    target.disabled = false;
    target.classList.remove("busy");
  }
});

async function api(path, options) {
  const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Admin session expired");
  }
  if (!response.ok) throw new Error(body.detail || body.error || "Request failed");
  return body;
}

function actionToast(action, level) {
  if (action === "restrict" && level === "Full lock") return "Lock command queued";
  if (action === "restrict" && level === "Limited access") return "Limit command queued";
  if (action === "restore") return "Restore command queued";
  if (action === "warn") return "Warning queued";
  if (action === "remind") return "Reminder queued";
  if (action === "reset-binding") return "Device identity reset queued";
  if (action === "run-automation") return "Automation completed";
  if (action === "dispatch-notices") return "Notices dispatched";
  if (action === "dispatch-mdm") return "MDM dispatch completed";
  return "Action completed";
}

async function load(options) {
  const previousPending = state ? pendingIntakeCount(state) : 0;
  state = await api("/api/state");
  render();
  if (options && options.live && pendingIntakeCount(state) > previousPending) {
    showToast("New customer details received");
  }
}

function startLiveUpdates() {
  if (liveEvents || !window.EventSource) return;
  liveEvents = new EventSource("/api/events");
  liveEvents.addEventListener("state", function () {
    scheduleLiveReload();
  });
  liveEvents.onerror = function () {
    liveEvents.close();
    liveEvents = null;
    window.setTimeout(startLiveUpdates, 3000);
  };
}

function scheduleLiveReload() {
  window.clearTimeout(liveReloadTimer);
  liveReloadTimer = window.setTimeout(function () {
    load({ live: true }).catch(function (error) { showToast(error.message); });
  }, 120);
}

function pendingIntakeCount(source) {
  return ((source && source.intakes) || []).filter(function (intake) { return intake.status === "Pending"; }).length;
}

function render() {
  if (!state) return;
  const pair = titles[view] || titles.overview;
  eyebrow.textContent = pair[0];
  title.textContent = pair[1];
  if (view === "overview") renderOverview();
  if (view === "contracts") renderContracts();
  if (view === "register") renderRegister();
  if (view === "inventory") renderInventory();
  if (view === "payments") renderPayments();
  if (view === "devices") renderDevices();
  if (view === "operations") renderOperations();
  if (view === "audit") renderAudit();
}

function filteredContracts() {
  const q = search.value.toLowerCase().trim();
  return state.contracts.filter(function (contract) {
    const haystack = [contract.id, contract.customer.name, contract.customer.phone, contract.customer.branch, contract.device.imei, contract.device.serial, contract.device.model, contract.payments.map(function (p) { return p.reference; }).join(" ")].join(" ").toLowerCase();
    return !q || haystack.includes(q);
  });
}

function filteredInventoryDevices() {
  const q = search.value.toLowerCase().trim();
  return ((state && state.inventoryDevices) || []).filter(function (device) {
    const haystack = [device.id, device.model, device.imei, device.serial, device.platform, device.controlProfile, device.status, device.notes].join(" ").toLowerCase();
    return !q || haystack.includes(q);
  });
}

function renderOverview() {
  const s = state.summary;
  const score = portfolioScore();
  const deviceLabel = s.total === 1 ? "1 financed device" : s.total + " financed devices";
  const actionLabel = s.overdue === 1 ? "1 account needs action" : s.overdue + " accounts need action";
  app.innerHTML = [
    '<section class="command-surface">',
    '<div class="command-lead"><div><span class="eyebrow">Operating snapshot</span><h2>' + healthLabel(score) + '</h2><p>Financing, collections, balances, arrears, and customer follow-up on one clean operating surface.</p></div><div class="command-score"><span>Health score</span><strong>' + score + '</strong><small>' + s.collectionRate + '% collection rate</small></div></div>',
    '<div class="command-metrics">',
    commandMetric("Portfolio value", money.format(s.value), deviceLabel, "ink"),
    commandMetric("Collected", money.format(s.collected), "Payments received", "green-accent"),
    commandMetric("Outstanding", money.format(s.balance), "Customer balances still open", "neutral"),
    commandMetric("Arrears exposure", money.format(s.arrears), actionLabel, "dark"),
    '</div>',
    '<div class="command-insights">',
    portfolioStatusChart("command-chart"),
    portfolioStatusLine(),
    '</div>',
    '</section>',
    '<section class="command-ledger"><div class="section-head"><div><h2>Priority Ledger</h2><p>Contracts sorted for repayment follow-up and visibility.</p></div><button class="btn secondary" type="button" onclick="location.href=\'/api/export/contracts.csv\'">Export CSV</button></div>' + contractsTable(filteredContracts(), false) + '</section>'
  ].join("");
}

function renderContracts() {
  app.innerHTML = '<section class="panel"><div class="panel-head"><div><h2>Financing Book</h2><p>Search by customer, phone, device, IMEI, branch, or payment reference.</p></div><button class="btn secondary" type="button" onclick="location.href=\'/api/export/contracts.csv\'">Export CSV</button></div>' + contractsTable(filteredContracts(), false) + '</section>';
}

function renderRegister() {
  const pendingIntakes = (state.intakes || []).filter(function (intake) { return intake.status === "Pending"; });
  const intakeOptions = ['<option value="">New walk-in customer</option>'].concat(pendingIntakes.map(function (intake) {
    return '<option value="' + e(intake.id) + '">' + e(intake.customerName + " - " + intake.phone) + '</option>';
  })).join("");
  app.innerHTML = [
    '<div class="layout">',
    '<section class="panel"><div class="panel-head"><div><h2>Quick Registration</h2><p>Use customer intake, product presets, and payment templates to create the contract with fewer manual fields.</p></div><button class="btn" form="contractForm" type="submit">Save Contract</button></div>',
    '<form id="contractForm">',
    '<input name="intakeId" type="hidden">',
    '<input name="inventoryDeviceId" type="hidden">',
    '<div class="form-section form-wide"><strong>Customer</strong><span>Start from a customer intake or enter walk-in details.</span></div>',
    '<label>Customer intake<select name="intakeSelect">' + intakeOptions + '</select></label>',
    field("Customer name", "customerName", "text", true),
    field("Phone number", "customerPhone", "text", true),
    field("National ID", "nationalId", "text", false),
    field("Customer address", "address", "text", false),
    selectField("Branch", "branch", ["Kisumu", "Nairobi", "Mobile sales"]),
    field("ID document", "documentName", "text", false),
    '<div class="form-section form-wide"><strong>Device</strong><span>Select a saved stock phone or type the device details manually.</span></div>',
    '<label>Device preset<select name="devicePreset">' + deviceOptions().map(function (item) { return '<option value="' + e(item.id) + '">' + e(item.label) + '</option>'; }).join("") + '</select></label>',
    field("Device model", "deviceModel", "text", true),
    field("IMEI", "imei", "text", true, "", "numeric"),
    field("Serial number", "serial", "text", true),
    selectField("Platform", "platform", ["Android", "iOS"]),
    selectField("Control profile", "controlProfile", ["Android device owner", "Android work profile", "Apple supervised MDM", "Apple MDM", "Reminder only"]),
    '<div class="form-section form-wide"><strong>Terms</strong><span>Choose a repayment template, then adjust if needed.</span></div>',
    '<label>Plan template<select name="planTemplate">' + planTemplates.map(function (item) { return '<option value="' + e(item.id) + '">' + e(item.label) + '</option>'; }).join("") + '</select></label>',
    field("Device price", "devicePrice", "number", true),
    field("Deposit", "deposit", "number", true),
    field("Installment", "installment", "number", true),
    selectField("Frequency", "frequency", ["Daily", "Weekly", "Monthly", "Custom"]),
    field("Repayment period", "periodCount", "number", true, "4"),
    field("Grace days", "graceDays", "number", false, "2"),
    '<div class="form-summary form-wide" id="planSummary"></div>',
    '</form></section>',
    '<section class="panel"><div class="panel-head"><div><h2>Customer Intake</h2><p>Share the intake link with buyers and pull their submitted details into onboarding.</p></div><a class="btn secondary" href="/intake" target="_blank" rel="noreferrer">Open Link</a></div>' + intakeQueue(pendingIntakes) + '</section>',
    '</div>'
  ].join("");
  bindRegistrationHelpers();
}

function renderInventory() {
  app.innerHTML = [
    '<section class="panel"><div class="panel-head"><div><h2>Add Device</h2><p>Add phones the shop already has, then choose them quickly during onboarding.</p></div><button class="btn" form="inventoryForm" type="submit">Add Device</button></div>',
    '<form id="inventoryForm">',
    field("Device model", "model", "text", true),
    field("IMEI", "imei", "text", false, "", "numeric"),
    field("Serial number", "serial", "text", false),
    selectField("Platform", "platform", ["Android", "iOS"]),
    selectField("Control profile", "controlProfile", ["Android device owner", "Android work profile", "Apple supervised MDM", "Apple MDM", "Reminder only"]),
    field("Device price", "price", "number", false),
    field("Notes", "notes", "text", false),
    '</form></section>',
    '<section class="panel"><div class="panel-head"><div><h2>Stock Ledger</h2><p>Saved phones appear in onboarding but can still be overwritten when needed.</p></div></div>' + inventoryDevicesTable(filteredInventoryDevices()) + '</section>'
  ].join("");
  document.getElementById("inventoryForm").addEventListener("submit", submitInventoryDevice);
  const form = document.getElementById("inventoryForm");
  form.elements.imei.addEventListener("input", function () { form.elements.imei.value = onlyDigits(form.elements.imei.value); });
  form.elements.serial.addEventListener("input", function () { form.elements.serial.value = cleanSerialText(form.elements.serial.value); });
}

function renderPayments() {
  const options = state.contracts.map(function (contract) { return '<option value="' + e(contract.id) + '">' + e(contract.id + " - " + contract.customer.name) + '</option>'; }).join("");
  app.innerHTML = [
    '<div class="layout">',
    '<section class="panel"><div class="panel-head"><div><h2>Record Collection</h2><p>Post a payment, reconcile the account, and queue restoration when arrears clear.</p></div><button class="btn" form="paymentForm" type="submit">Record Payment</button></div>',
    '<form id="paymentForm">',
    '<label>Contract<select name="contractId">' + options + '</select></label>',
    selectField("Channel", "method", ["M-Pesa", "Airtel Money", "Bank", "Cash"]),
    field("Amount", "amount", "number", true),
    field("Reference", "reference", "text", true),
    field("Date", "date", "date", false, todayIso()),
    '</form></section>',
    '<section class="panel"><div class="panel-head"><div><h2>Rails Status</h2><p>Callback and reconciliation readiness.</p></div></div>' + paymentRails() + '</section>',
    '</div>',
    '<section class="panel"><div class="panel-head"><div><h2>Collections Ledger</h2><p>Latest reconciled customer payments.</p></div></div>' + paymentsTable() + '</section>'
  ].join("");
  document.getElementById("paymentForm").addEventListener("submit", submitPayment);
}

function renderDevices() {
  app.innerHTML = '<div class="layout-even"><section class="panel"><div class="panel-head"><div><h2>Control Coverage</h2><p>Platform policy position for financed devices.</p></div></div>' + compatibilityList() + '</section><section class="panel"><div class="panel-head"><div><h2>Restriction Queue</h2><p>Commands are audited before device sync.</p></div></div>' + devicePipeline() + '</section></div><section class="panel"><div class="panel-head"><div><h2>Device Command Ledger</h2><p>Use Lock Phone to close the phone, and Restore Phone to reopen it on the next device sync.</p></div></div>' + contractsTable(filteredContracts(), true) + '</section>';
}

function renderOperations() {
  app.innerHTML = [
    '<section class="panel"><div class="panel-head"><div><h2>Ecosystem Controls</h2><p>Run reminders, warnings, restrictions, restoration, SMS notices, and Apple MDM dispatch.</p></div><div class="actions"><button class="btn" data-action="run-automation" type="button">Run Automation</button><button class="btn secondary" data-action="dispatch-notices" type="button">Dispatch Notices</button><button class="btn secondary" data-action="dispatch-mdm" type="button">Dispatch MDM</button></div></div>' + ecosystemSummary() + '</section>',
    '<div class="layout-even">',
    '<section class="panel"><div class="panel-head"><div><h2>Device Agent</h2><p>Phones pull policy, acknowledge commands, and report tamper attempts through these endpoints.</p></div></div>' + deviceAgentGuide() + '</section>',
    '<section class="panel"><div class="panel-head"><div><h2>Notice Outbox</h2><p>Queued SMS, in-app, and system notices for the pilot workflow.</p></div></div>' + notificationOutbox() + '</section>',
    '</div>',
    '<div class="layout-even">',
    '<section class="panel"><div class="panel-head"><div><h2>Launch Readiness</h2><p>Operational checks before pilot deployment.</p></div></div>' + readinessList() + '</section>',
    '<section class="panel"><div class="panel-head"><div><h2>Device Sync Log</h2><p>Latest phone-side policy sync, command acknowledgement, and tamper events.</p></div></div>' + deviceEventsTable() + '</section>',
    '</div>',
    '<section class="panel"><div class="panel-head"><div><h2>Backend Surface</h2><p>Routes available for dashboard, payments, device commands, and reports.</p></div></div>' + apiSurface() + '</section>'
  ].join("");
}

function renderAudit() {
  app.innerHTML = '<section class="panel"><div class="panel-head"><div><h2>Administrator Audit Trail</h2><p>Every sensitive action is logged with role and record.</p></div></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Role</th><th>Action</th><th>Record</th></tr></thead><tbody>' + state.audit.map(function (a) {
    return '<tr><td>' + e(formatTime(a.time)) + '</td><td>' + e(a.role) + '</td><td>' + e(a.action) + '</td><td>' + e(a.record) + '</td></tr>';
  }).join("") + '</tbody></table></div></section>';
}

function intakeQueue(intakes) {
  if (!intakes.length) return '<div class="empty">No pending customer intakes.</div>';
  return '<div class="queue">' + intakes.slice(0, 8).map(function (intake) {
    return '<div class="queue-row"><div><strong>' + e(intake.customerName) + '</strong><p>' + e(intake.phone + " - " + intake.branch) + '</p></div><div class="actions"><button class="tiny" data-intake-id="' + e(intake.id) + '" type="button">Use</button><button class="tiny delete" data-action="delete-intake" data-id="' + e(intake.id) + '" data-confirm="' + e("Delete intake for " + intake.customerName + "? This cannot be undone.") + '" type="button">Delete</button></div></div>';
  }).join("") + '</div>';
}

function bindRegistrationHelpers() {
  const form = document.getElementById("contractForm");
  form.addEventListener("submit", submitContract);
  form.elements.intakeSelect.addEventListener("change", function () { applyIntake(form.elements.intakeSelect.value); });
  form.elements.devicePreset.addEventListener("change", function () { applyDevicePreset(form); });
  form.elements.planTemplate.addEventListener("change", function () { applyPlanTemplate(form, true); });
  ["devicePrice", "deposit", "periodCount"].forEach(function (name) {
    form.elements[name].addEventListener("input", function () { applyPlanTemplate(form, false); });
  });
  form.elements.imei.addEventListener("input", function () { form.elements.imei.value = onlyDigits(form.elements.imei.value); });
  form.elements.customerPhone.addEventListener("input", function () { form.elements.customerPhone.value = cleanPhoneText(form.elements.customerPhone.value); });
  form.elements.serial.addEventListener("input", function () { form.elements.serial.value = cleanSerialText(form.elements.serial.value); });
  ["deviceModel", "imei", "serial"].forEach(function (name) {
    form.elements[name].addEventListener("input", function () { clearInventoryDeviceSelection(form); });
  });
  document.querySelectorAll("[data-intake-id]").forEach(function (button) {
    button.addEventListener("click", function () {
      form.elements.intakeSelect.value = button.dataset.intakeId;
      applyIntake(button.dataset.intakeId);
    });
  });
  applyPlanTemplate(form, true);
}

function applyIntake(id) {
  const form = document.getElementById("contractForm");
  const intake = (state.intakes || []).find(function (item) { return item.id === id; });
  form.elements.intakeId.value = intake ? intake.id : "";
  if (!intake) return;
  setFormValue(form, "customerName", intake.customerName);
  setFormValue(form, "customerPhone", intake.phone);
  setFormValue(form, "nationalId", intake.nationalId);
  setFormValue(form, "address", intake.address);
  setFormValue(form, "branch", intake.branch || "Kisumu");
}

function applyDevicePreset(form) {
  const preset = deviceOptions().find(function (item) { return item.id === form.elements.devicePreset.value; });
  setFormValue(form, "inventoryDeviceId", "");
  if (!preset || preset.id === "custom") return;
  setFormValue(form, "inventoryDeviceId", preset.inventoryDeviceId || "");
  setFormValue(form, "deviceModel", preset.model);
  setFormValue(form, "imei", preset.imei || "");
  setFormValue(form, "serial", preset.serial || "");
  setFormValue(form, "platform", preset.platform);
  setFormValue(form, "controlProfile", preset.controlProfile);
  if (preset.price !== "") setFormValue(form, "devicePrice", preset.price);
  applyPlanTemplate(form, true);
}

function clearInventoryDeviceSelection(form) {
  if (!form.elements.inventoryDeviceId.value) return;
  setFormValue(form, "inventoryDeviceId", "");
  setFormValue(form, "devicePreset", "custom");
}

function applyPlanTemplate(form, updateDeposit) {
  const template = planTemplates.find(function (item) { return item.id === form.elements.planTemplate.value; }) || planTemplates[0];
  if (template.id !== "custom") {
    setFormValue(form, "frequency", template.frequency);
    setFormValue(form, "periodCount", template.periodCount);
    setFormValue(form, "graceDays", template.graceDays);
    if (updateDeposit && template.depositRate != null) {
      const price = numberValue(form.elements.devicePrice.value);
      setFormValue(form, "deposit", roundMoney(price * template.depositRate));
    }
  }
  const price = numberValue(form.elements.devicePrice.value);
  const deposit = numberValue(form.elements.deposit.value);
  const periods = Math.max(1, Math.floor(numberValue(form.elements.periodCount.value) || 1));
  const balance = Math.max(price - deposit, 0);
  if (template.id !== "custom" || !numberValue(form.elements.installment.value)) {
    setFormValue(form, "installment", Math.ceil(balance / periods));
  }
  updatePlanSummary(price, deposit, periods, form.elements.installment.value, form.elements.frequency.value);
}

function updatePlanSummary(price, deposit, periods, installment, frequency) {
  const summary = document.getElementById("planSummary");
  const balance = Math.max(price - deposit, 0);
  summary.innerHTML = '<span>Financed balance</span><strong>' + money.format(balance) + '</strong><small>' + periods + ' ' + e(frequency).toLowerCase() + ' payment(s) at ' + money.format(numberValue(installment)) + '</small>';
}

function setFormValue(form, name, value) {
  if (form.elements[name]) form.elements[name].value = value == null ? "" : String(value);
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  if (!value) return 0;
  return Math.ceil(value / 100) * 100;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function cleanSerialText(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function cleanPhoneText(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

async function submitContract(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.target).entries());
    body.role = role.value;
    await api("/api/contracts", { method: "POST", body: JSON.stringify(body) });
    showToast("Contract saved");
    view = "overview";
    await load();
  } catch (error) {
    showToast(error.message);
  }
}

async function submitInventoryDevice(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.target).entries());
    body.role = role.value;
    await api("/api/inventory-devices", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    showToast("Device added to stock");
    await load();
  } catch (error) {
    showToast(error.message);
  }
}

async function submitPayment(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.target).entries());
    body.role = role.value;
    await api("/api/contracts/" + encodeURIComponent(body.contractId) + "/payments", { method: "POST", body: JSON.stringify(body) });
    showToast("Payment recorded");
    await load();
  } catch (error) {
    showToast(error.message);
  }
}

function contractsTable(contracts, controls) {
  if (!contracts.length) return '<div class="empty">No matching contracts.</div>';
  return '<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Device</th><th>Plan</th><th>Paid</th><th>Balance</th><th>Arrears</th><th>Next due</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + contracts.map(function (c) {
    const deleteButton = '<button class="tiny delete" data-action="delete-contract" data-id="' + e(c.id) + '" data-confirm="' + e("Delete contract " + c.id + " for " + c.customer.name + "? This cannot be undone.") + '" type="button">Delete</button>';
    const bindingStatus = c.device.binding ? "Identity locked (same phone auto-recovers)" : "Identity not enrolled";
    const bindingButton = '<button class="tiny" data-action="reset-binding" data-id="' + e(c.id) + '" data-confirm="' + e("Reset device identity for " + c.customer.name + "? Only needed for a different physical handset, not for reinstall on the same phone.") + '" type="button">Reset ID</button>';
    const controlButtons = controls
      ? '<button class="tiny" data-action="restrict" data-level="Limited access" data-id="' + e(c.id) + '" type="button">Limit Use</button><button class="tiny danger" data-action="restrict" data-level="Full lock" data-id="' + e(c.id) + '" data-confirm="' + e("Lock " + c.customer.name + "'s phone?") + '" type="button">Lock Phone</button><button class="tiny success" data-action="restore" data-id="' + e(c.id) + '" data-confirm="' + e("Restore phone access for " + c.customer.name + "?") + '" type="button">Restore Phone</button>' + bindingButton
      : '<button class="tiny" data-action="remind" data-id="' + e(c.id) + '" type="button">Remind</button><button class="tiny" data-action="warn" data-id="' + e(c.id) + '" type="button">Warn</button>' + deleteButton;
    return '<tr><td><div class="cell-main"><strong>' + e(c.customer.name) + '</strong><span>' + e(c.customer.phone + " - " + c.customer.branch) + '</span></div></td><td><div class="cell-main"><strong>' + e(c.device.model) + '</strong><span>IMEI ' + e(c.device.imei) + '</span><span>' + e(bindingStatus) + '</span></div></td><td><div class="cell-main"><strong>' + e(c.plan.frequency) + '</strong><span><span class="money-value">' + money.format(c.plan.installment) + '</span> installment</span></div></td><td class="money-cell">' + money.format(c.progress.paid) + '</td><td class="money-cell">' + money.format(c.progress.balance) + '</td><td class="money-cell">' + money.format(c.progress.arrears) + '</td><td>' + e(c.progress.nextDue || "Fully paid") + '</td><td>' + badge(c.status) + '</td><td><div class="actions">' + controlButtons + '</div></td></tr>';
  }).join("") + '</tbody></table></div>';
}

function inventoryDevicesTable(devices) {
  if (!devices.length) return '<div class="empty">No saved devices yet.</div>';
  return '<div class="table-wrap"><table><thead><tr><th>Device</th><th>Identity</th><th>Control</th><th>Price</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody>' + devices.map(function (device) {
    const deleteButton = device.status === "Assigned"
      ? '<button class="tiny" disabled type="button">Assigned</button>'
      : '<button class="tiny delete" data-action="delete-inventory-device" data-id="' + e(device.id) + '" data-confirm="' + e("Delete " + device.model + " from device stock? This cannot be undone.") + '" type="button">Delete</button>';
    const identity = [device.imei ? "IMEI " + device.imei : "", device.serial ? "SN " + device.serial : ""].filter(Boolean).join("<br>");
    return '<tr><td><div class="cell-main"><strong>' + e(device.model) + '</strong><span>' + e(device.id) + '</span></div></td><td>' + identity + '</td><td><div class="cell-main"><strong>' + e(device.platform) + '</strong><span>' + e(device.controlProfile) + '</span></div></td><td class="money-cell">' + money.format(numberValue(device.price)) + '</td><td>' + badge(device.status) + '</td><td>' + e(device.notes || "") + '</td><td><div class="actions">' + deleteButton + '</div></td></tr>';
  }).join("") + '</tbody></table></div>';
}

function paymentsTable() {
  if (!state.payments.length) return '<div class="empty">No payments recorded.</div>';
  return '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>Channel</th><th>Reference</th><th>Amount</th><th>Status</th></tr></thead><tbody>' + state.payments.slice().reverse().map(function (p) {
    return '<tr><td>' + e(p.date) + '</td><td>' + e(p.customerName) + '</td><td>' + e(p.method) + '</td><td>' + e(p.reference) + '</td><td class="money-cell">' + money.format(p.amount) + '</td><td>' + badge(p.status) + '</td></tr>';
  }).join("") + '</tbody></table></div>';
}

function riskQueue() {
  const risky = state.contracts.filter(function (c) { return c.progress.arrears > 0 || c.status === "Restricted"; }).sort(function (a, b) { return b.progress.arrears - a.progress.arrears; });
  if (!risky.length) return '<div class="empty">No accounts are in arrears.</div>';
  return '<div class="queue">' + risky.slice(0, 8).map(function (c) {
    return '<div class="queue-row"><div><strong>' + e(c.customer.name) + '</strong><p>' + money.format(c.progress.arrears) + ' overdue. ' + e(c.warning) + '. ' + e(c.device.model) + '.</p></div><div class="actions">' + badge(c.status) + '<button class="tiny" data-action="warn" data-id="' + e(c.id) + '" type="button">Warn</button></div></div>';
  }).join("") + '</div>';
}

function branchBars() {
  const rows = state.branchPerformance || [];
  const max = Math.max.apply(null, rows.map(function (row) { return row.collected; }).concat([1]));
  return '<div class="bar-list">' + rows.map(function (row) {
    const width = Math.max(8, Math.round((row.collected / max) * 100));
    return '<div class="bar-row"><strong>' + e(row.branch) + '</strong><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><span class="money-value">' + money.format(row.collected) + '</span></div>';
  }).join("") + '</div>';
}

function investorSnapshot() {
  return '<div class="queue"><div class="queue-row"><div><strong>Unit economics signal</strong><p>' + state.summary.collectionRate + '% recovered in the sample book with ' + money.format(state.summary.balance) + ' still collectible.</p></div>' + badge("Ready") + '</div><div class="queue-row"><div><strong>Default controls</strong><p>' + state.summary.overdue + ' overdue accounts and ' + state.summary.restricted + ' device-control case.</p></div>' + badge(state.summary.overdue ? "Attention" : "Ready") + '</div><div class="queue-row"><div><strong>Expansion path</strong><p>Branch analytics, payment callbacks, warning workflow, and audited device commands are already modeled.</p></div>' + badge("Ready") + '</div></div>';
}

function portfolioStatusChart(extraClass) {
  const rows = [
    { label: "Active", value: state.summary.active, className: "chart-blue" },
    { label: "Overdue", value: state.summary.overdue, className: "chart-accent" },
    { label: "Restricted", value: state.summary.restricted, className: "chart-red" },
    { label: "Completed", value: state.summary.completed, className: "chart-green" }
  ];
  const total = rows.reduce(function (sum, row) { return sum + row.value; }, 0);
  const nonZero = rows.filter(function (row) { return row.value > 0; });
  let start = 0;
  let slices = "";
  if (total <= 0) {
    slices = '<circle cx="95" cy="88" r="66" fill="none" stroke="#dfe5ee" stroke-width="18"></circle>';
  } else if (nonZero.length === 1) {
    slices = '<circle class="' + nonZero[0].className + '" cx="95" cy="88" r="68"></circle>';
  } else {
    slices = rows.map(function (row) {
      if (row.value <= 0) return "";
      const end = start + (row.value / total) * 360;
      const path = piePath(95, 88, 68, start, end);
      start = end;
      return '<path class="' + row.className + '" d="' + path + '"></path>';
    }).join("");
  }
  const legend = rows.map(function (row) {
    return '<div class="legend-item"><span class="legend-dot ' + row.className + '"></span><span>' + e(row.label) + '</span><strong>' + row.value + '</strong></div>';
  }).join("");
  const panelClass = "chart-panel" + (extraClass ? " " + extraClass : "");
  return '<section class="' + panelClass + '"><div class="chart-head"><div><h2>Portfolio Status</h2><p>Share of contracts by repayment condition.</p></div>' + badge("Live") + '</div><div class="pie-layout"><svg class="chart-svg" viewBox="0 0 190 176" role="img" aria-label="Portfolio status pie chart">' + slices + '<circle cx="95" cy="88" r="38" fill="#ffffff"></circle><text class="chart-title" x="95" y="84" text-anchor="middle">' + total + '</text><text class="chart-label" x="95" y="102" text-anchor="middle">contracts</text></svg><div class="pie-legend">' + legend + '</div></div></section>';
}

function piePath(cx, cy, radius, startAngle, endAngle) {
  const start = polarPoint(cx, cy, radius, endAngle);
  const end = polarPoint(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return ["M", cx, cy, "L", start.x, start.y, "A", radius, radius, 0, largeArc, 0, end.x, end.y, "Z"].join(" ");
}

function polarPoint(cx, cy, radius, angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians)
  };
}

function paymentRails() {
  return '<div class="pipeline"><div class="pipeline-row"><strong>M-Pesa</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 94%"></div></div>' + badge("Ready") + '</div><div class="pipeline-row"><strong>Airtel Money</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 90%"></div></div>' + badge("Ready") + '</div><div class="pipeline-row"><strong>Idempotency</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 100%"></div></div>' + badge("Ready") + '</div><div class="queue-row"><div><strong>Callback routes</strong><p>/api/payments/mpesa-callback and /api/payments/airtel-callback</p></div>' + badge("Ready") + '</div></div>';
}

function readinessList() {
  return '<div class="queue">' + state.readiness.map(function (item) {
    return '<div class="readiness-row"><div><strong>' + e(item.title) + '</strong><p>' + e(item.detail) + '</p></div>' + badge(item.status) + '</div>';
  }).join("") + '</div>';
}

function compatibilityList() {
  return '<div class="queue"><div class="readiness-row"><strong>Android control path</strong><p>Best restriction support through device-owner or managed-profile enrollment.</p>' + badge("Ready") + '</div><div class="readiness-row"><strong>iOS control path</strong><p>Restriction depth depends on Apple MDM enrollment and supported policy controls.</p>' + badge("Attention") + '</div><div class="readiness-row"><strong>Emergency access</strong><p>Emergency calling remains subject to law, platform rules, and device policy limitations.</p>' + badge("Ready") + '</div></div>';
}

function signalGrid() {
  return '<div class="signal-grid"><div class="signal"><span>Payment rails</span><strong>M-Pesa + Airtel</strong><small>Callback reconciliation ready</small></div><div class="signal"><span>Warning policy</span><strong>' + state.settings.warningStages.length + ' stages</strong><small>Notice before restriction</small></div><div class="signal"><span>Data model</span><strong>' + state.branchPerformance.length + ' branches</strong><small>Multi-shop ready</small></div></div>';
}

function devicePipeline() {
  const restricted = state.contracts.filter(function (contract) { return contract.status === "Restricted"; }).length;
  const overdue = state.contracts.filter(function (contract) { return contract.progress.arrears > 0; }).length;
  return '<div class="pipeline"><div class="pipeline-row"><strong>Screen notice</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 70%"></div></div>' + badge("Ready") + '</div><div class="pipeline-row"><strong>Limit</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 62%"></div></div>' + badge("Ready") + '</div><div class="pipeline-row"><strong>Full lock</strong><div class="pipeline-line"><div class="pipeline-fill" style="width: 54%"></div></div>' + badge(restricted ? "Attention" : "Ready") + '</div><div class="queue-row"><div><strong>Current queue</strong><p>' + overdue + ' overdue accounts and ' + restricted + ' restricted device.</p></div>' + badge(overdue ? "Attention" : "Ready") + '</div></div>';
}

function ecosystemSummary() {
  const item = state.ecosystem || {};
  return '<div class="metric-grid ecosystem-grid">' +
    metric("Pending notices", String(item.pendingNotifications || 0), "accent", "Ready for dispatch") +
    metric("Phone SMS", item.smsReady ? "Connected" : "Simulated", item.smsReady ? "green" : "accent", item.smsProvider || "Pilot simulation") +
    metric("Apple MDM", item.iosMdmReady ? "Connected" : "Simulated", item.iosMdmReady ? "green" : "accent", item.iosMdmProvider || "MDM simulation") +
    metric("Device commands", String(item.pendingDeviceCommands || 0), "blue", "Android sync or MDM dispatch") +
    metric("Device events", String(item.deviceEvents || 0), "green", "Agent activity received") +
    metric("Security secrets", item.secured ? "Configured" : "Pending", item.secured ? "green" : "red", "Callback and device sync protection") +
    '</div>';
}

function deviceAgentGuide() {
  return '<div class="queue">' +
    '<div class="readiness-row"><strong>Android policy pull</strong><p>GET /api/devices/:imei/policy returns balance, arrears, next due date, and the current restriction level for the Android agent.</p>' + badge("Ready") + '</div>' +
    '<div class="readiness-row"><strong>Android identity binding</strong><p>First trusted sync locks the contract to that handset Android ID and issues a binding token. Reinstalls and app-data wipes on the same phone are re-accepted automatically using Android ID; only a different physical handset needs Reset ID.</p>' + badge("Ready") + '</div>' +
    '<div class="readiness-row"><strong>Remote device control</strong><p>Phones sync to the public control URL (' + e(PUBLIC_BASE_URL) + ') from any network. Host this backend on that URL (or set KISMART_PUBLIC_BASE_URL) and use Firestore so laptop and cloud share the same contracts.</p>' + badge("Ready") + '</div>' +
    '<div class="readiness-row"><strong>Apple MDM bridge</strong><p>iOS contracts queue Apple MDM commands for supervised iPhones. Use Dispatch MDM or configure KISMART_IOS_MDM_PROVIDER=webhook for a real MDM connector.</p>' + badge("Ready") + '</div>' +
    '<div class="readiness-row"><strong>Tamper reporting</strong><p>Android posts tamper events through the agent; iOS tamper and restriction depth come from the MDM provider.</p>' + badge("Ready") + '</div>' +
    '</div>';
}

function notificationOutbox() {
  const rows = (state.notifications || []).slice(0, 8);
  if (!rows.length) return '<div class="empty">No notices have been queued yet.</div>';
  return '<div class="table-wrap compact"><table><thead><tr><th>Time</th><th>Type</th><th>Channel</th><th>Status</th></tr></thead><tbody>' + rows.map(function (notice) {
    return '<tr><td>' + e(formatTime(notice.time)) + '</td><td>' + e(notice.type) + '</td><td>' + e(notice.channel) + '</td><td>' + badge(notice.status) + '</td></tr>';
  }).join("") + '</tbody></table></div>';
}

function deviceEventsTable() {
  const rows = (state.deviceEvents || []).slice(0, 8);
  if (!rows.length) return '<div class="empty">No device-side events received yet.</div>';
  return '<div class="table-wrap compact"><table><thead><tr><th>Time</th><th>IMEI</th><th>Event</th><th>Message</th><th>Status</th></tr></thead><tbody>' + rows.map(function (event) {
    return '<tr><td>' + e(formatTime(event.time)) + '</td><td>' + e(event.imei) + '</td><td>' + e(event.type) + '</td><td>' + e(event.message || "") + '</td><td>' + badge(event.status) + '</td></tr>';
  }).join("") + '</tbody></table></div>';
}

function scalePlan() {
  const sms = state.ecosystem || {};
  return '<div class="queue"><div class="readiness-row"><strong>Data layer</strong><p>Firestore top-level collections are ready for multi-shop deployment.</p>' + badge("Ready") + '</div><div class="readiness-row"><strong>Messaging</strong><p>' + e(sms.smsReady ? "Phone SMS is connected for reminders and warning escalation." : "Phone SMS is wired, but still needs provider credentials before live delivery.") + '</p>' + badge(sms.smsReady ? "Ready" : "Attention") + '</div><div class="readiness-row"><strong>Device control</strong><p>Android uses the device-owner agent. iOS uses supervised Apple MDM enrollment and the Apple MDM bridge.</p>' + badge("Attention") + '</div></div>';
}

function portfolioScore() {
  const raw = 58 + state.summary.collectionRate * 0.35 - state.summary.overdue * 6 - state.summary.restricted * 7;
  return Math.max(32, Math.min(94, Math.round(raw)));
}

function healthLabel(score) {
  if (score >= 80) return "Strong operating position";
  if (score >= 60) return "Pilot ready with collection watch";
  return "Needs tighter collections before scale";
}

function apiSurface() {
  const routes = ["/api/events", "/api/state", "/api/contracts", "/api/contracts/:id", "/api/inventory-devices", "/api/inventory-devices/:id", "/api/intakes/:id", "/api/contracts/:id/payments", "/api/contracts/:id/warnings", "/api/contracts/:id/restrictions", "/api/automation/run", "/api/notifications/dispatch", "/api/device-commands/dispatch", "/api/devices/:imei/policy", "/api/devices/:imei/sync", "/api/devices/:imei/tamper", "/api/payments/mpesa-callback", "/api/payments/airtel-callback", "/api/reports/summary", "/api/readiness"];
  return '<div class="table-wrap"><table><thead><tr><th>Route</th><th>Purpose</th></tr></thead><tbody>' + routes.map(function (route) {
    return '<tr><td>' + e(route) + '</td><td>' + e(routePurpose(route)) + '</td></tr>';
  }).join("") + '</tbody></table></div>';
}

function routePurpose(route) {
  if (route.includes("events")) return "Live admin refresh when customers submit intake details or records change";
  if (route.includes("automation")) return "Run daily reminders, warning escalation, restrictions, and restoration";
  if (route.includes("notifications")) return "Dispatch queued SMS notices through the configured phone provider";
  if (route.includes("device-commands")) return "Dispatch Apple MDM commands for supervised iOS devices";
  if (route.includes("inventory-devices/:id")) return "Delete an unassigned stock device after admin confirmation";
  if (route.includes("inventory-devices")) return "Admin-managed device stock for onboarding dropdowns";
  if (route.includes("devices")) return "Device-agent policy sync, command acknowledgement, and tamper reporting";
  if (route.includes("intakes/:id")) return "Delete a pending customer intake after admin confirmation";
  if (route.includes("payments/")) return "Mobile-money reconciliation";
  if (route.includes("restrictions")) return "Apply or remove device controls";
  if (route.includes("warnings")) return "Queue warning notices";
  if (route.includes("reports")) return "Portfolio analytics";
  if (route.includes("readiness")) return "Production rollout checks";
  if (route.includes("contracts/:id/payments")) return "Record customer payment";
  if (route === "/api/contracts/:id") return "Delete an incorrect financing contract after admin confirmation";
  if (route.includes("contracts")) return "Customer and device financing contracts";
  return "Dashboard state";
}

function metric(label, value, tone, note) {
  return '<div class="metric ' + tone + '"><span>' + e(label) + '</span><strong>' + e(value) + '</strong><small>' + e(note) + '</small></div>';
}

function commandMetric(label, value, note, tone) {
  return '<div class="command-metric ' + tone + '"><span>' + e(label) + '</span><strong>' + e(value) + '</strong><small>' + e(note) + '</small></div>';
}

function portfolioStatusLine() {
  const rows = [
    { label: "Active", value: state.summary.active, tone: "ink" },
    { label: "Overdue", value: state.summary.overdue, tone: "green-accent" },
    { label: "Restricted", value: state.summary.restricted, tone: "dark" },
    { label: "Completed", value: state.summary.completed, tone: "neutral" }
  ];
  return '<div class="portfolio-status-line"><span>Status mix</span><div class="status-strip">' + rows.map(function (row) {
    return '<div class="status-pill ' + row.tone + '"><span>' + e(row.label) + '</span><strong>' + row.value + '</strong></div>';
  }).join("") + '</div></div>';
}

function field(label, name, type, required, value, inputMode) {
  return '<label>' + e(label) + '<input name="' + e(name) + '" type="' + e(type) + '"' + (inputMode ? ' inputmode="' + e(inputMode) + '"' : "") + (required ? " required" : "") + (value ? ' value="' + e(value) + '"' : "") + '></label>';
}

function selectField(label, name, options) {
  return '<label>' + e(label) + '<select name="' + e(name) + '">' + options.map(function (option) { return '<option>' + e(option) + '</option>'; }).join("") + '</select></label>';
}

function badge(status) {
  return '<span class="badge ' + e(String(status).replace(/\s+/g, "")) + '">' + e(status) + '</span>';
}

function e(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(function () { toast.classList.remove("show"); }, 2600);
}

load().then(startLiveUpdates).catch(function (error) { showToast(error.message); });
`;
}

async function loadState(): Promise<AppState> {
  if (cachedState) {
    if (isFirestoreStorage() || !(await jsonStateFileChanged())) {
      return cachedState;
    }
  }
  if (isFirestoreStorage()) {
    try {
      cachedState = await withTimeout(loadFirestoreState(), FIRESTORE_OPERATION_TIMEOUT_MS, "Firestore load timed out");
      return cachedState;
    } catch (error) {
      markFirestoreUnavailable(error);
    }
  }
  cachedState = await loadJsonState();
  return cachedState;
}

async function loadJsonState(): Promise<AppState> {
  if (!existsSync(DATA_FILE)) {
    const state = seedJsonState();
    await saveJsonState(state);
    return state;
  }
  const raw = await readFile(DATA_FILE, "utf8");
  const state = normalizeState(JSON.parse(raw) as AppState);
  const bootstrapContracts = bootstrapContractsFromEnv();
  if (!state.contracts.length && bootstrapContracts.length) {
    state.contracts = bootstrapContracts;
    await saveJsonState(state);
  }
  cachedJsonMtimeMs = await jsonStateMtimeMs();
  return state;
}

async function saveState(state: AppState) {
  if (isFirestoreStorage()) {
    try {
      await withTimeout(saveFirestoreState(state), FIRESTORE_OPERATION_TIMEOUT_MS, "Firestore save timed out");
    } catch (error) {
      markFirestoreUnavailable(error);
      await saveJsonState(state);
    }
  } else {
    await saveJsonState(state);
  }
  cachedState = state;
  broadcastStateChange();
}

function queueDeviceRuntimeSave(
  state: AppState,
  changes: RuntimeSaveChanges
) {
  cachedState = state;
  broadcastStateChange();
  void saveDeviceRuntimeChanges(state, changes).catch((error) => {
    console.error(`Device sync persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function saveDeviceRuntimeChanges(
  state: AppState,
  changes: RuntimeSaveChanges
) {
  if (!isFirestoreStorage()) {
    await saveJsonState(state);
    return;
  }

  try {
    const firestore = getFirestoreDb();
    const contractsById = new Map(state.contracts.map((contract) => [contract.id, contract]));
    const notificationsById = new Map(state.notifications.map((notice) => [notice.id, notice]));
    const syncEventsById = new Map(state.syncEvents.map((event) => [event.id, event]));
    const deviceEventsById = new Map(state.deviceEvents.map((event) => [event.id, event]));
    const auditById = new Map(state.audit.map((event) => [event.id, event]));
    const operations: ((batch: any) => void)[] = [];

    uniqueIds(changes.contractIds || []).forEach((id) => {
      const contract = contractsById.get(id);
      if (contract) {
        operations.push((batch) => batch.set(
          firestore.collection(FIRESTORE_RECORD_COLLECTIONS.contracts).doc(id),
          toFirestoreRecord(contract)
        ));
      }
    });

    uniqueIds(changes.notificationIds || []).forEach((id) => {
      const notice = notificationsById.get(id);
      if (notice) {
        operations.push((batch) => batch.set(
          firestore.collection(FIRESTORE_RECORD_COLLECTIONS.notifications).doc(id),
          toFirestoreRecord(notice)
        ));
      }
    });

    uniqueIds(changes.syncEventIds || []).forEach((id) => {
      const event = syncEventsById.get(id);
      if (event) {
        operations.push((batch) => batch.set(
          firestore.collection(FIRESTORE_RECORD_COLLECTIONS.syncEvents).doc(id),
          toFirestoreRecord(event)
        ));
      }
    });

    uniqueIds(changes.deviceEventIds || []).forEach((id) => {
      const event = deviceEventsById.get(id);
      if (event) {
        operations.push((batch) => batch.set(
          firestore.collection(FIRESTORE_RECORD_COLLECTIONS.deviceEvents).doc(id),
          toFirestoreRecord(event)
        ));
      }
    });

    uniqueIds(changes.auditIds || []).forEach((id) => {
      const event = auditById.get(id);
      if (event) {
        operations.push((batch) => batch.set(
          firestore.collection(FIRESTORE_RECORD_COLLECTIONS.audit).doc(id),
          toFirestoreRecord(event)
        ));
      }
    });

    if (operations.length) {
      await withTimeout(commitFirestoreOperations(firestore, operations), FIRESTORE_OPERATION_TIMEOUT_MS, "Firestore runtime save timed out");
    }
  } catch (error) {
    markFirestoreUnavailable(error);
    await saveJsonState(state);
  }
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

async function saveJsonState(state: AppState) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(state, null, 2));
  await rename(tempFile, DATA_FILE);
  cachedJsonMtimeMs = await jsonStateMtimeMs();
}

async function jsonStateFileChanged() {
  const currentMtimeMs = await jsonStateMtimeMs();
  return currentMtimeMs > 0 && currentMtimeMs !== cachedJsonMtimeMs;
}

async function jsonStateMtimeMs() {
  try {
    return (await stat(DATA_FILE)).mtimeMs;
  } catch {
    return 0;
  }
}

async function loadFirestoreState(): Promise<AppState> {
  const firestore = getFirestoreDb();
  const topLevelState = await loadFirestoreCollectionState(firestore);
  const jsonState = existsSync(DATA_FILE) ? await loadJsonState() : seedState();

  if (hasFirestoreCollectionData(topLevelState)) {
    const fireState = normalizeState(topLevelState.state);
    const mergedState = mergeState(fireState, jsonState);
    if (mergedState.changed) {
      await saveFirestoreState(mergedState.state);
    }
    return mergedState.state;
  }

  const doc = getFirestoreStateDoc();
  const nestedState = await loadFirestoreCollectionState(doc);
  if (hasFirestoreCollectionData(nestedState)) {
    const state = mergeState(normalizeState(nestedState.state), jsonState).state;
    await saveFirestoreState(state);
    await deleteLegacyFirestoreState();
    return state;
  }

  const snapshot = await doc.get();
  if (snapshot.exists) {
    const data = snapshot.data() || {};
    const legacyState = data.state || (looksLikeAppState(data) ? data : null);
    if (legacyState) {
      const state = mergeState(normalizeState(legacyState as AppState), jsonState).state;
      await saveFirestoreState(state);
      await deleteLegacyFirestoreState();
      return state;
    }
  }

  await saveFirestoreState(jsonState);
  return jsonState;
}

function mergeState(firestoreState: AppState, jsonState: AppState): { state: AppState; changed: boolean } {
  let changed = false;
  const state = { ...firestoreState };

  const mergeCollections = <T extends { id: string }>(fireItems: T[], jsonItems: T[]) => {
    const items = [...fireItems];
    const fireIds = new Set(items.map((i) => i.id));
    jsonItems.forEach((jsonItem) => {
      if (!fireIds.has(jsonItem.id)) {
        items.unshift(jsonItem);
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
  state.audit = mergeCollections(state.audit, jsonState.audit);

  return { state, changed };
}

async function saveFirestoreState(state: AppState) {
  const firestore = getFirestoreDb();
  await firestore.collection(FIRESTORE_SETTINGS_COLLECTION).doc(FIRESTORE_SETTINGS_DOCUMENT).set({
    ...toFirestoreRecord(state.settings),
    updatedAt: nowIso(),
    version: VERSION,
  });
  await Promise.all([
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.contracts, state.contracts, (item: Contract) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.intakes, state.intakes, (item: IntakeRecord) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.notifications, state.notifications, (item: NotificationRecord) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.syncEvents, state.syncEvents, (item: AppState["syncEvents"][number]) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.deviceEvents, state.deviceEvents, (item: DeviceEvent) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.inventoryDevices, state.inventoryDevices, (item: InventoryDevice) => item.id),
    syncFirestoreCollection(firestore, FIRESTORE_RECORD_COLLECTIONS.audit, state.audit, (item: AuditRecord) => item.id),
  ]);
}

function isFirestoreStorage() {
  return STORAGE_MODE === "firestore" && !firestoreUnavailable;
}

function normalizeFirestoreDatabase(value: string) {
  const cleaned = clean(value);
  if (!cleaned || cleaned === "(default)") return "";
  return cleaned;
}

function markFirestoreUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!firestoreUnavailable) {
    console.error(`Firestore unavailable; falling back to JSON storage: ${message}`);
  }
  firestoreLastError = message;
  firestoreUnavailable = true;
  firestoreDb = null;
  firestoreStateDoc = null;
}

function getFirestoreStateDoc() {
  if (firestoreStateDoc) return firestoreStateDoc;
  firestoreStateDoc = getFirestoreDb().collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
  return firestoreStateDoc;
}

function getFirestoreDb() {
  if (firestoreDb) return firestoreDb;
  const app = getApps()[0] || initializeApp({
    credential: firebaseCredential(),
    projectId: FIREBASE_PROJECT_ID,
  });
  firestoreDb = FIRESTORE_DATABASE ? getFirestore(app, FIRESTORE_DATABASE) : getFirestore(app);
  return firestoreDb;
}

async function loadFirestoreCollectionState(doc: any) {
  const [
    settingsSnapshot,
    contracts,
    intakes,
    notifications,
    syncEvents,
    deviceEvents,
    inventoryDevices,
    audit,
  ] = await Promise.all([
    doc.collection(FIRESTORE_SETTINGS_COLLECTION).doc(FIRESTORE_SETTINGS_DOCUMENT).get(),
    readFirestoreCollection<Contract>(doc, FIRESTORE_RECORD_COLLECTIONS.contracts),
    readFirestoreCollection<IntakeRecord>(doc, FIRESTORE_RECORD_COLLECTIONS.intakes),
    readFirestoreCollection<NotificationRecord>(doc, FIRESTORE_RECORD_COLLECTIONS.notifications),
    readFirestoreCollection<AppState["syncEvents"][number]>(doc, FIRESTORE_RECORD_COLLECTIONS.syncEvents),
    readFirestoreCollection<DeviceEvent>(doc, FIRESTORE_RECORD_COLLECTIONS.deviceEvents),
    readFirestoreCollection<InventoryDevice>(doc, FIRESTORE_RECORD_COLLECTIONS.inventoryDevices),
    readFirestoreCollection<AuditRecord>(doc, FIRESTORE_RECORD_COLLECTIONS.audit),
  ]);

  const settings = settingsSnapshot.exists ? cleanFirestoreSettings(settingsSnapshot.data() || {}) : seedSettings();
  return {
    hasSettings: settingsSnapshot.exists,
    contracts: sortByDateDesc(contracts, (item) => item.createdAt),
    intakes: sortByDateDesc(intakes, (item) => item.time),
    notifications: sortByDateDesc(notifications, (item) => item.time),
    syncEvents: sortByDateDesc(syncEvents, (item) => item.time),
    deviceEvents: sortByDateDesc(deviceEvents, (item) => item.time),
    inventoryDevices: sortByDateDesc(inventoryDevices, (item) => item.createdAt),
    audit: sortByDateDesc(audit, (item) => item.time),
    state: {
      settings,
      contracts: sortByDateDesc(contracts, (item) => item.createdAt),
      intakes: sortByDateDesc(intakes, (item) => item.time),
      notifications: sortByDateDesc(notifications, (item) => item.time),
      syncEvents: sortByDateDesc(syncEvents, (item) => item.time),
      deviceEvents: sortByDateDesc(deviceEvents, (item) => item.time),
      inventoryDevices: sortByDateDesc(inventoryDevices, (item) => item.createdAt),
      audit: sortByDateDesc(audit, (item) => item.time),
    } as AppState,
  };
}

async function readFirestoreCollection<T extends { id?: string }>(doc: any, collectionName: string): Promise<T[]> {
  const snapshot = await doc.collection(collectionName).get();
  return snapshot.docs.map((record: any) => ({ id: record.id, ...(record.data() || {}) }) as T);
}

async function syncFirestoreCollection<T>(doc: any, collectionName: string, items: T[], idForItem: (item: T) => string) {
  const collection = doc.collection(collectionName);
  const snapshot = await collection.get();
  const wantedIds = new Set(items.map(idForItem).filter(Boolean));
  const operations: ((batch: any) => void)[] = [];

  snapshot.docs.forEach((record: any) => {
    if (!wantedIds.has(record.id)) {
      operations.push((batch) => batch.delete(record.ref));
    }
  });

  items.forEach((item) => {
    const id = idForItem(item);
    if (!id) return;
    operations.push((batch) => batch.set(collection.doc(id), toFirestoreRecord(item)));
  });

  await commitFirestoreOperations(doc, operations);
}

async function deleteLegacyFirestoreState() {
  const doc = getFirestoreStateDoc();
  await Promise.all([
    clearFirestoreCollection(doc, FIRESTORE_SETTINGS_COLLECTION),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.contracts),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.intakes),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.notifications),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.syncEvents),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.deviceEvents),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.inventoryDevices),
    clearFirestoreCollection(doc, FIRESTORE_RECORD_COLLECTIONS.audit),
  ]);
  await doc.delete();
}

async function clearFirestoreCollection(parent: any, collectionName: string) {
  const snapshot = await parent.collection(collectionName).get();
  const operations = snapshot.docs.map((record: any) => (batch: any) => batch.delete(record.ref));
  await commitFirestoreOperations(parent, operations);
}

async function commitFirestoreOperations(doc: any, operations: ((batch: any) => void)[]) {
  for (let index = 0; index < operations.length; index += 450) {
    const batch = doc.firestore ? doc.firestore.batch() : doc.batch();
    operations.slice(index, index + 450).forEach((operation) => operation(batch));
    await batch.commit();
  }
}

function sortByDateDesc<T>(items: T[], dateForItem: (item: T) => string | null | undefined) {
  return items.slice().sort((left, right) => Date.parse(dateForItem(right) || "") - Date.parse(dateForItem(left) || ""));
}

function hasFirestoreCollectionData(collectionState: Awaited<ReturnType<typeof loadFirestoreCollectionState>>) {
  return (
    collectionState.contracts.length > 0 ||
    collectionState.intakes.length > 0 ||
    collectionState.notifications.length > 0 ||
    collectionState.syncEvents.length > 0 ||
    collectionState.deviceEvents.length > 0 ||
    collectionState.inventoryDevices.length > 0 ||
    collectionState.audit.length > 0 ||
    collectionState.hasSettings
  );
}

function toFirestoreRecord(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function cleanFirestoreSettings(value: any) {
  const settings = { ...value };
  delete settings.updatedAt;
  delete settings.version;
  return settings;
}

function looksLikeAppState(value: any) {
  return Boolean(value && Array.isArray(value.contracts) && Array.isArray(value.intakes) && value.settings);
}

function firebaseCredential() {
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (error) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", error);
    }
  }
  if (FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = isAbsolute(FIREBASE_SERVICE_ACCOUNT_PATH)
      ? FIREBASE_SERVICE_ACCOUNT_PATH
      : join(__dirname, FIREBASE_SERVICE_ACCOUNT_PATH);
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
    return cert(serviceAccount);
  }
  return applicationDefault();
}

function normalizeState(state: AppState): AppState {
  const seededSettings = seedSettings();
  state.settings = {
    ...seededSettings,
    ...(state.settings || {}),
    warningStages: state.settings?.warningStages?.length ? state.settings.warningStages : seededSettings.warningStages,
    roles: state.settings?.roles?.length ? state.settings.roles : seededSettings.roles,
    security: state.settings?.security?.length ? state.settings.security : seededSettings.security,
  };
  state.deviceEvents = Array.isArray(state.deviceEvents) ? state.deviceEvents : [];
  state.syncEvents = Array.isArray(state.syncEvents) ? state.syncEvents : [];
  state.notifications = Array.isArray(state.notifications) ? state.notifications : [];
  state.intakes = Array.isArray(state.intakes) ? state.intakes : [];
  state.inventoryDevices = Array.isArray(state.inventoryDevices) ? state.inventoryDevices : [];
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  state.contracts = Array.isArray(state.contracts) ? state.contracts : [];
  state.inventoryDevices = state.inventoryDevices.map(normalizeInventoryDevice);
  state.contracts.forEach((contract) => {
    contract.device = {
      model: clean(contract.device?.model),
      imei: cleanDigits(contract.device?.imei),
      serial: cleanSerial(contract.device?.serial),
      platform: normalizePlatform(contract.device?.platform),
      controlProfile: clean(contract.device?.controlProfile || "Android device owner"),
      binding: normalizeDeviceBinding(contract.device?.binding),
    };
  });
  return state;
}

function normalizeInventoryDevice(device: any): InventoryDevice {
  return {
    id: clean(device?.id || uid("DEV")),
    createdAt: clean(device?.createdAt || nowIso()),
    model: clean(device?.model || device?.deviceModel),
    imei: cleanDigits(device?.imei),
    serial: cleanSerial(device?.serial),
    platform: normalizePlatform(device?.platform),
    controlProfile: clean(device?.controlProfile || "Android device owner"),
    price: numberFrom(device?.price || device?.devicePrice),
    notes: clean(device?.notes),
    status: device?.status === "Assigned" ? "Assigned" : "Available",
    assignedContractId: clean(device?.assignedContractId) || null,
    assignedAt: clean(device?.assignedAt) || null,
  };
}

function buildPublicState(state: AppState) {
  const contracts = state.contracts.map(enrichContract);
  const smsProvider = getSmsProviderStatus();
  return {
    service: {
      shop: SHOP_NAME,
      version: VERSION,
      generatedAt: nowIso(),
      smsProvider: smsProvider.label,
      smsReady: smsProvider.ready,
    },
    summary: getSummary(state),
    contracts,
    payments: getAllPayments(state),
    branchPerformance: getBranchPerformance(state),
    readiness: getReadiness(state),
    ecosystem: getEcosystemSummary(state),
    reminderQueue: getReminderQueue(state),
    syncEvents: state.syncEvents,
    deviceEvents: state.deviceEvents,
    notifications: state.notifications,
    intakes: state.intakes,
    inventoryDevices: state.inventoryDevices.map((device) => enrichInventoryDevice(state, device)),
    audit: state.audit,
    settings: state.settings,
  };
}

function enrichContract(contract: Contract) {
  return {
    ...contract,
    progress: getProgress(contract),
    status: getStatus(contract),
    warning: getWarningLabel(contract),
  };
}

function enrichInventoryDevice(state: AppState, device: InventoryDevice) {
  const financedContract = state.contracts.find((contract) => {
    return (device.imei && contract.device.imei === device.imei) || (device.serial && contract.device.serial === device.serial);
  });
  return {
    ...device,
    status: financedContract ? "Assigned" : device.status,
    assignedContractId: financedContract?.id || device.assignedContractId || null,
  };
}

function createIntakeFromForm(body: URLSearchParams): IntakeRecord {
  return {
    id: uid("INT"),
    time: nowIso(),
    status: "Pending",
    customerName: clean(body.get("customerName")),
    phone: cleanPhone(body.get("phone")),
    nationalId: clean(body.get("nationalId")),
    address: clean(body.get("address")),
    branch: clean(body.get("branch") || "Kisumu"),
    notes: clean(body.get("notes")),
    convertedContractId: null,
  };
}

function validateIntakePayload(intake: IntakeRecord) {
  const missing = [
    ["customerName", intake.customerName],
    ["phone", intake.phone],
  ]
    .filter(([, value]) => !clean(value))
    .map(([name]) => name);
  if (missing.length) throw new HttpError(400, `Missing required fields: ${missing.join(", ")}`);
}

function markIntakeConverted(state: AppState, intakeId: unknown, contractId: string) {
  const id = clean(intakeId);
  if (!id) return;
  const intake = state.intakes.find((item) => item.id === id);
  if (!intake) return;
  intake.status = "Converted";
  intake.convertedContractId = contractId;
}

function createInventoryDeviceFromPayload(body: any): InventoryDevice {
  return {
    id: clean(body.id || uid("DEV")),
    createdAt: clean(body.createdAt || nowIso()),
    model: clean(body.model || body.deviceModel),
    imei: cleanDigits(body.imei),
    serial: cleanSerial(body.serial),
    platform: normalizePlatform(body.platform || "Android"),
    controlProfile: clean(body.controlProfile || "Android device owner"),
    price: numberFrom(body.price || body.devicePrice),
    notes: clean(body.notes),
    status: "Available",
    assignedContractId: null,
    assignedAt: null,
  };
}

function validateInventoryDevicePayload(state: AppState, body: any) {
  const model = clean(body.model || body.deviceModel);
  const imei = cleanDigits(body.imei);
  const serial = cleanSerial(body.serial);
  if (!model) throw new HttpError(400, "Device model is required");
  if (!imei && !serial) throw new HttpError(400, "Add either IMEI or serial number");
  if (imei && state.contracts.some((contract) => contract.device.imei === imei)) {
    throw new HttpError(409, `Device IMEI ${imei} is already financed`);
  }
  if (serial && state.contracts.some((contract) => contract.device.serial === serial)) {
    throw new HttpError(409, `Device serial ${serial} is already financed`);
  }
  if (imei && state.inventoryDevices.some((device) => device.imei === imei)) {
    throw new HttpError(409, `Device IMEI ${imei} is already in inventory`);
  }
  if (serial && state.inventoryDevices.some((device) => device.serial === serial)) {
    throw new HttpError(409, `Device serial ${serial} is already in inventory`);
  }
}

function markInventoryDeviceAssigned(state: AppState, inventoryDeviceId: unknown, contract: Contract) {
  const id = clean(inventoryDeviceId);
  if (!id) return;
  const device = state.inventoryDevices.find((item) => item.id === id);
  if (!device) return;
  device.status = "Assigned";
  device.assignedContractId = contract.id;
  device.assignedAt = nowIso();
}

function releaseInventoryDevice(state: AppState, contractId: string) {
  state.inventoryDevices.forEach((device) => {
    if (device.assignedContractId !== contractId) return;
    device.status = "Available";
    device.assignedContractId = null;
    device.assignedAt = null;
  });
}

function createContractFromPayload(body: any): Contract {
  const id = clean(body.id || `KIS-${Math.floor(1000 + Math.random() * 9000)}`);
  const deposit = numberFrom(body.deposit);
  return {
    id,
    createdAt: clean(body.createdAt || todayIso()),
    customer: {
      name: clean(body.customerName || body.customer?.name),
      phone: cleanPhone(body.customerPhone || body.customer?.phone),
      nationalId: clean(body.nationalId || body.customer?.nationalId),
      address: clean(body.address || body.customer?.address),
      branch: clean(body.branch || body.customer?.branch || "Kisumu"),
      documentName: clean(body.documentName || body.customer?.documentName),
    },
    device: {
      model: clean(body.deviceModel || body.device?.model),
      imei: cleanDigits(body.imei || body.device?.imei),
      serial: cleanSerial(body.serial || body.device?.serial),
      platform: normalizePlatform(body.platform || body.device?.platform),
      controlProfile: clean(body.controlProfile || body.device?.controlProfile || "Android device owner"),
      binding: normalizeDeviceBinding(body.device?.binding),
    },
    plan: {
      devicePrice: numberFrom(body.devicePrice || body.plan?.devicePrice),
      deposit,
      installment: numberFrom(body.installment || body.plan?.installment),
      frequency: normalizeFrequency(body.frequency || body.plan?.frequency),
      periodCount: numberFrom(body.periodCount || body.plan?.periodCount, 1),
      graceDays: numberFrom(body.graceDays || body.plan?.graceDays, 2),
      customDates: Array.isArray(body.customDates) ? body.customDates.map(clean) : [],
    },
    payments: deposit
      ? [
          {
            id: uid("PAY"),
            date: todayIso(),
            method: "Deposit",
            reference: `DEP-${id}`,
            amount: deposit,
            status: "Synced",
          },
        ]
      : [],
    warningsSent: [],
    restriction: {
      active: false,
      level: "None",
      appliedAt: null,
    },
  };
}

function validateContractPayload(state: AppState, body: any) {
  const required = [
    ["customerName", body.customerName || body.customer?.name],
    ["customerPhone", cleanPhone(body.customerPhone || body.customer?.phone)],
    ["deviceModel", body.deviceModel || body.device?.model],
    ["imei", cleanDigits(body.imei || body.device?.imei)],
    ["serial", cleanSerial(body.serial || body.device?.serial)],
  ];
  const missing = required.filter(([, value]) => !clean(value)).map(([name]) => name);
  if (missing.length) throw new HttpError(400, `Missing required fields: ${missing.join(", ")}`);

  const devicePrice = numberFrom(body.devicePrice || body.plan?.devicePrice);
  const deposit = numberFrom(body.deposit || body.plan?.deposit);
  const installment = numberFrom(body.installment || body.plan?.installment);
  const periodCount = numberFrom(body.periodCount || body.plan?.periodCount, 1);
  if (devicePrice <= 0) throw new HttpError(400, "Device price must be greater than zero");
  if (deposit < 0 || deposit >= devicePrice) throw new HttpError(400, "Deposit must be less than the device price");
  if (installment <= 0) throw new HttpError(400, "Installment amount must be greater than zero");
  if (periodCount <= 0) throw new HttpError(400, "Repayment period must be greater than zero");

  const imei = cleanDigits(body.imei || body.device?.imei);
  const serial = cleanSerial(body.serial || body.device?.serial);
  if (state.contracts.some((contract) => contract.device.imei === imei)) {
    throw new HttpError(409, `Device IMEI ${imei} is already financed`);
  }
  if (state.contracts.some((contract) => contract.device.serial === serial)) {
    throw new HttpError(409, `Device serial ${serial} is already financed`);
  }
}

function validatePaymentPayload(body: any) {
  const amount = numberFrom(body.amount);
  if (amount <= 0) throw new HttpError(400, "Payment amount must be greater than zero");
}

function findPaymentByReference(state: AppState, reference: string, method: PaymentMethod) {
  for (const contract of state.contracts) {
    const payment = contract.payments.find((item) => item.reference === reference && item.method === method);
    if (payment) return { contract, payment };
  }
  return null;
}

function addPayment(contract: Contract, input: Omit<Payment, "id">): Payment {
  const payment = { id: uid("PAY"), ...input };
  contract.payments.push(payment);
  return payment;
}

function resolveContractForCallback(state: AppState, body: any) {
  const contractId = clean(body.contractId);
  if (contractId) return state.contracts.find((contract) => contract.id === contractId);
  const phone = clean(body.phone || body.msisdn);
  if (phone) return state.contracts.find((contract) => contract.customer.phone === phone);
  const imei = clean(body.imei);
  if (imei) return state.contracts.find((contract) => contract.device.imei === imei);
  return null;
}

function resolveContractByMpesaReference(state: AppState, reference: string) {
  if (!reference) return null;
  const event = state.syncEvents.find((e) => e.reference === reference);
  if (event) {
    return state.contracts.find((c) => c.id === event.contractId);
  }
  return null;
}

function parseMpesaStkCallback(body: any) {
  if (!body?.Body?.stkCallback) return null;
  const cb = body.Body.stkCallback;
  const metadata = cb.CallbackMetadata?.Item || [];
  const getVal = (name: string) => metadata.find((i: any) => i.Name === name)?.Value;
  return {
    merchantRequestId: String(cb.MerchantRequestID || ""),
    checkoutRequestId: String(cb.CheckoutRequestID || ""),
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc || ""),
    amount: numberFrom(getVal("Amount")),
    receiptNumber: String(getVal("MpesaReceiptNumber") || ""),
    transactionDate: String(getVal("TransactionDate") || ""),
    phoneNumber: String(getVal("PhoneNumber") || ""),
  };
}

function queueReminder(state: AppState, contract: Contract, type: string): NotificationRecord {
  const progress = getProgress(contract);
  const message =
    progress.arrears > 0
      ? `${type}: ${contract.customer.name} has ${formatKes(progress.arrears)} overdue. Payment plan must be adhered to.`
      : `${type}: next payment of ${formatKes(progress.nextAmount || contract.plan.installment)} is due on ${progress.nextDue || "the next schedule date"}.`;
  const notice: NotificationRecord = {
    id: uid("NTC"),
    time: nowIso(),
    contractId: contract.id,
    type,
    channel: "SMS",
    status: "Pending",
    message,
  };
  state.notifications.unshift(notice);
  return notice;
}

function issueWarning(state: AppState, contract: Contract, stageOverride?: WarningStage): WarningNotice {
  const progress = getProgress(contract);
  const sentNames = new Set(contract.warningsSent.map((warning) => warning.stage));
  const nextStage =
    stageOverride ||
    state.settings.warningStages.find((stage) => !sentNames.has(stage.name)) ||
    state.settings.warningStages[state.settings.warningStages.length - 1];
  const amount = progress.arrears || progress.balance;
  const message = `${nextStage.name}: ${contract.customer.name} owes ${formatKes(amount)}. Payment plan must be adhered to. Consequence: ${nextStage.consequence}.`;
  const warning = {
    id: uid("WARN"),
    stage: nextStage.name,
    date: todayIso(),
    amount,
    message,
  };
  contract.warningsSent.push(warning);
  state.notifications.unshift({
    id: uid("NTC"),
    time: nowIso(),
    contractId: contract.id,
    type: nextStage.name,
    channel: "SMS",
    status: "Pending",
    message,
  });
  return warning;
}

function applyRestriction(state: AppState, contract: Contract, level: RestrictionLevel) {
  contract.restriction = {
    active: level !== "None",
    level,
    appliedAt: level === "None" ? null : todayIso(),
  };
  supersedePendingDeviceCommands(state, contract, level);
  const provider = deviceCommandProvider(contract);
  const event: AppState["syncEvents"][number] = {
    id: uid("SYNC"),
    time: nowIso(),
    contractId: contract.id,
    provider,
    reference: level,
    status: "Pending",
    message: `${provider} restriction command queued for ${contract.device.imei}`,
  };
  state.syncEvents.unshift(event);
  return event;
}

function restoreDevice(state: AppState, contract: Contract, action: string) {
  contract.restriction = {
    active: false,
    level: "None",
    appliedAt: null,
  };
  supersedePendingDeviceCommands(state, contract, "Restore");
  const provider = deviceCommandProvider(contract);
  const event: AppState["syncEvents"][number] = {
    id: uid("SYNC"),
    time: nowIso(),
    contractId: contract.id,
    provider,
    reference: "Restore",
    status: "Pending",
    message: `${provider} restore command queued for ${contract.device.imei}`,
  };
  state.syncEvents.unshift(event);
  const audit = addAudit(state, "System", action, contract.id);
  return { event, audit };
}

function applyAutomaticPaymentControls(state: AppState, contracts = state.contracts): AutomaticPaymentControlResult {
  const actions: AutomaticPaymentControlResult["actions"] = [];
  const changes: RuntimeSaveChanges = {
    syncEventIds: [],
    contractIds: [],
    auditIds: [],
  };

  contracts.forEach((contract) => {
    const progress = getProgress(contract);
    if (progress.arrears <= 0) {
      if (!contract.restriction.active) return;
      const { event, audit } = restoreDevice(state, contract, "Automatic restoration after arrears cleared");
      changes.contractIds?.push(contract.id);
      changes.syncEventIds?.push(event.id);
      changes.auditIds?.push(audit.id);
      actions.push({
        contractId: contract.id,
        type: "Restore",
        message: "Arrears cleared; restore command queued automatically.",
      });
      return;
    }

    if (contract.restriction.active) return;
    const event = applyRestriction(state, contract, "Limited access");
    const audit = addAudit(state, "System", "Automatic payment limit applied", `${contract.id} - ${formatKes(progress.arrears)} arrears`);
    changes.contractIds?.push(contract.id);
    changes.syncEventIds?.push(event.id);
    changes.auditIds?.push(audit.id);
    actions.push({
      contractId: contract.id,
      type: "Restriction",
      message: `Limited access queued automatically for ${formatKes(progress.arrears)} arrears.`,
    });
  });

  return {
    changed: actions.length > 0,
    actions,
    changes,
  };
}

function startAutomaticPaymentControlLoop() {
  if (automaticPaymentControlLoopStarted) return;
  automaticPaymentControlLoopStarted = true;
  const timer = setInterval(() => {
    void runAutomaticPaymentControlPass().catch((error) => {
      console.error(`Automatic payment control failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

async function runAutomaticPaymentControlPass() {
  if (automaticPaymentControlRunning) return;
  automaticPaymentControlRunning = true;
  try {
    const state = await loadState();
    const result = applyAutomaticPaymentControls(state);
    if (!result.changed) return;
    await dispatchPendingDeviceCommands(state, 25);
    await saveState(state);
  } finally {
    automaticPaymentControlRunning = false;
  }
}

function supersedePendingDeviceCommands(state: AppState, contract: Contract, nextReference: string) {
  state.syncEvents.forEach((event) => {
    if (event.contractId === contract.id && isDeviceCommandProvider(event.provider) && event.status === "Pending") {
      event.status = "Failed";
      event.message = `Superseded by ${nextReference} command for ${contract.device.imei}`;
    }
  });
}

function deviceCommandProvider(contract: Contract) {
  return contract.device.platform === "iOS" ? "Apple MDM" : "Device command";
}

function isDeviceCommandProvider(provider: string) {
  return provider === "Device command" || provider === "Apple MDM";
}

function runAutomation(state: AppState) {
  const actions: { contractId: string; type: string; message: string }[] = [];
  const counts = { reminders: 0, warnings: 0, restrictions: 0, restorations: 0 };

  state.contracts.forEach((contract) => {
    const automaticControls = applyAutomaticPaymentControls(state, [contract]);
    if (automaticControls.changed) {
      automaticControls.actions.forEach((action) => {
        if (action.type === "Restore") counts.restorations += 1;
        if (action.type === "Restriction") counts.restrictions += 1;
        actions.push(action);
      });
      return;
    }

    const progress = getProgress(contract);
    const finalStage = state.settings.warningStages[state.settings.warningStages.length - 1];
    const finalWarningSentBefore = Boolean(finalStage && contract.warningsSent.some((warning) => warning.stage === finalStage.name));

    if (progress.balance <= 0 && contract.restriction.active) {
      restoreDevice(state, contract, "Automation restored paid account");
      counts.restorations += 1;
      actions.push({ contractId: contract.id, type: "Restore", message: "Account is paid up; restore command queued." });
      return;
    }

    if (progress.arrears > 0) {
      const dueStage = getDueWarningStage(state, contract, progress.overdueDays);
      if (dueStage) {
        const warning = issueWarning(state, contract, dueStage);
        counts.warnings += 1;
        actions.push({ contractId: contract.id, type: warning.stage, message: warning.message });
        return;
      }

      const restrictionGraceDays = Math.max(0, numberFrom(state.settings.restrictionGraceDays, 2));
      if (
        finalStage &&
        finalWarningSentBefore &&
        !contract.restriction.active &&
        progress.overdueDays >= finalStage.daysAfterDue + restrictionGraceDays
      ) {
        const level = normalizeRestrictionLevel(state.settings.defaultRestrictionLevel || "Full lock");
        applyRestriction(state, contract, level);
        counts.restrictions += 1;
        actions.push({ contractId: contract.id, type: "Restriction", message: `${level} command queued after final warning grace period.` });
      }
      return;
    }

    if (shouldQueueUpcomingReminder(state, contract, progress)) {
      const notice = queueReminder(state, contract, "Upcoming payment");
      counts.reminders += 1;
      actions.push({ contractId: contract.id, type: notice.type, message: notice.message });
    }
  });

  return {
    time: nowIso(),
    counts,
    actions,
    pendingNotifications: state.notifications.filter((notice) => notice.status === "Pending").length,
    pendingDeviceCommands: state.syncEvents.filter((event) => isDeviceCommandProvider(event.provider) && event.status === "Pending").length,
  };
}

function getDueWarningStage(state: AppState, contract: Contract, overdueDays: number) {
  const sentNames = new Set(contract.warningsSent.map((warning) => warning.stage));
  return state.settings.warningStages.find((stage) => overdueDays >= stage.daysAfterDue && !sentNames.has(stage.name)) || null;
}

function shouldQueueUpcomingReminder(state: AppState, contract: Contract, progress: Progress) {
  if (!progress.nextDue || progress.balance <= 0) return false;
  const daysUntil = daysBetween(today(), parseDate(progress.nextDue));
  return daysUntil >= 0 && daysUntil <= state.settings.reminderLeadDays && !hasNoticeToday(state, contract.id, "Upcoming payment");
}

function hasNoticeToday(state: AppState, contractId: string, type: string) {
  const todayValue = todayIso();
  return state.notifications.some((notice) => notice.contractId === contractId && notice.type === type && notice.time.slice(0, 10) === todayValue);
}

async function dispatchPendingNotifications(state: AppState, limit: number) {
  const max = Math.max(1, Math.min(250, Math.floor(limit || 50)));
  const pending = state.notifications.filter((notice) => notice.status === "Pending");
  const selected = pending.slice(0, max);
  let sent = 0;
  let failed = 0;

  for (const notice of selected) {
    const contract = state.contracts.find((item) => item.id === notice.contractId);
    const result = contract
      ? await dispatchNotificationToPhone(contract, notice)
      : {
          ok: false,
          provider: notice.channel,
          reference: notice.id,
          detail: `${notice.type} could not be sent because contract ${notice.contractId} was not found.`,
        };

    notice.status = result.ok ? "Sent" : "Failed";
    if (result.ok) sent += 1;
    else failed += 1;

    state.syncEvents.unshift({
      id: uid("SYNC"),
      time: nowIso(),
      contractId: notice.contractId,
      provider: result.provider,
      reference: result.reference || notice.id,
      status: result.ok ? "Synced" : "Failed",
      message: result.detail,
    });
  }

  const smsProvider = getSmsProviderStatus();
  return {
    attempted: selected.length,
    sent,
    failed,
    pending: state.notifications.filter((notice) => notice.status === "Pending").length,
    providerMode: smsProvider.label,
    providerReady: smsProvider.ready,
  };
}

async function dispatchPendingDeviceCommands(state: AppState, limit: number) {
  const max = Math.max(1, Math.min(250, Math.floor(limit || 50)));
  const pending = state.syncEvents.filter((event) => event.provider === "Apple MDM" && event.status === "Pending");
  const selected = pending.slice(0, max);
  let synced = 0;
  let failed = 0;

  for (const event of selected) {
    const contract = state.contracts.find((item) => item.id === event.contractId);
    const result = contract
      ? await dispatchIosMdmCommand(contract, event)
      : {
          ok: false,
          provider: "Apple MDM",
          reference: event.reference,
          detail: `Apple MDM command could not be sent because contract ${event.contractId} was not found.`,
        };

    event.provider = result.provider;
    event.status = result.ok ? "Synced" : "Failed";
    event.message = result.detail;
    if (result.ok) synced += 1;
    else failed += 1;
  }

  const mdm = getIosMdmProviderStatus();
  return {
    attempted: selected.length,
    synced,
    failed,
    pending: state.syncEvents.filter((event) => event.provider === "Apple MDM" && event.status === "Pending").length,
    providerMode: mdm.label,
    providerReady: mdm.ready,
  };
}

async function dispatchIosMdmCommand(contract: Contract, event: AppState["syncEvents"][number]): Promise<SmsSendResult> {
  if (contract.device.platform !== "iOS") {
    return {
      ok: false,
      provider: "Apple MDM",
      reference: event.reference,
      detail: `Apple MDM command skipped because ${contract.device.imei} is registered as ${contract.device.platform}.`,
    };
  }

  const payload = buildIosMdmPayload(contract, event);
  if (IOS_MDM_PROVIDER === "webhook") return await sendIosMdmViaWebhook(payload, event);

  return {
    ok: true,
    provider: "Apple MDM simulation",
    reference: `SIM-${event.id}`,
    detail: `${payload.command} simulated for ${contract.device.imei}. Configure KISMART_IOS_MDM_PROVIDER=webhook to send it to an Apple MDM service.`,
  };
}

async function sendIosMdmViaWebhook(payload: Record<string, unknown>, event: AppState["syncEvents"][number]): Promise<SmsSendResult> {
  if (!IOS_MDM_WEBHOOK_URL) {
    return {
      ok: false,
      provider: "Apple MDM webhook",
      reference: event.reference,
      detail: "Apple MDM webhook is selected, but KISMART_IOS_MDM_WEBHOOK_URL is not configured.",
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (IOS_MDM_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${IOS_MDM_WEBHOOK_TOKEN}`;
  const response = await fetch(IOS_MDM_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const body = parseJsonMaybe(raw) || {};
  const reference = clean(body.reference || body.id || body.commandId || event.reference);
  return {
    ok: response.ok,
    provider: "Apple MDM webhook",
    reference,
    detail: response.ok
      ? `${payload.command} sent to Apple MDM webhook for ${payload.imei}.`
      : `Apple MDM webhook failed for ${payload.imei}: ${body.error || body.message || raw || response.statusText}`,
  };
}

function buildIosMdmPayload(contract: Contract, event: AppState["syncEvents"][number]) {
  return {
    platform: "iOS",
    command: iosMdmCommandName(event.reference),
    reference: event.reference,
    queuedAt: event.time,
    contractId: contract.id,
    customerName: contract.customer.name,
    customerPhone: contract.customer.phone,
    imei: contract.device.imei,
    serial: contract.device.serial,
    model: contract.device.model,
    controlProfile: contract.device.controlProfile,
    restriction: contract.restriction,
    message: iosMdmLockMessage(contract, event.reference),
    note: "Requires supervised iPhone enrolled in Apple MDM. Ordinary iOS apps cannot enforce full-device lock.",
  };
}

function iosMdmCommandName(reference: string) {
  if (reference === "Restore") return "DisableLostModeAndClearRestrictions";
  if (reference === "Full lock") return "EnableLostMode";
  if (reference === "Limited access") return "ApplySupervisedRestrictions";
  return "ApplyLockScreenMessage";
}

function iosMdmLockMessage(contract: Contract, reference: string) {
  if (reference === "Restore") return "KISMART account restored. Device access may be returned by MDM.";
  const progress = getProgress(contract);
  return `${SHOP_NAME}: ${contract.customer.name}, your financed device has ${formatKes(progress.arrears)} overdue. Please contact the shop to restore access.`;
}

async function dispatchNotificationToPhone(contract: Contract, notice: NotificationRecord): Promise<SmsSendResult> {
  if (notice.channel !== "SMS") {
    return {
      ok: true,
      provider: notice.channel,
      reference: notice.id,
      detail: `${notice.type} marked delivered through ${notice.channel}.`,
    };
  }

  const to = normalizeSmsPhone(contract.customer.phone);
  if (!to) {
    return {
      ok: false,
      provider: getSmsProviderStatus().label,
      reference: notice.id,
      detail: `${notice.type} could not be sent because ${contract.customer.name} has no valid phone number.`,
    };
  }

  const message = buildSmsMessage(contract, notice);
  try {
    if (SMS_PROVIDER === "webhook") return await sendSmsViaWebhook(to, message, contract, notice);
    if (SMS_PROVIDER === "africas-talking") return await sendSmsViaAfricasTalking(to, message, contract, notice);
  } catch (error) {
    return {
      ok: false,
      provider: getSmsProviderStatus().label,
      reference: notice.id,
      detail: `${notice.type} failed for ${to}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    provider: "SMS simulation",
    reference: `SIM-${notice.id}`,
    detail: `${notice.type} simulated for ${to}. Set KISMART_SMS_PROVIDER to send a real phone SMS.`,
  };
}

async function sendSmsViaWebhook(to: string, message: string, contract: Contract, notice: NotificationRecord): Promise<SmsSendResult> {
  if (!SMS_WEBHOOK_URL) {
    return {
      ok: false,
      provider: "SMS webhook",
      reference: notice.id,
      detail: "SMS webhook is selected, but KISMART_SMS_WEBHOOK_URL is not configured.",
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SMS_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${SMS_WEBHOOK_TOKEN}`;
  const response = await fetch(SMS_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to,
      message,
      sender: SMS_SENDER || SHOP_NAME,
      contractId: contract.id,
      customerName: contract.customer.name,
      noticeId: notice.id,
      noticeType: notice.type,
    }),
  });
  const raw = await response.text();
  const payload = parseJsonMaybe(raw) || {};
  const reference = clean(payload.reference || payload.id || payload.messageId || payload.sid || notice.id);
  return {
    ok: response.ok,
    provider: "SMS webhook",
    reference,
    detail: response.ok
      ? `${notice.type} sent to ${to} through SMS webhook.`
      : `SMS webhook failed for ${to}: ${payload.error || payload.message || raw || response.statusText}`,
  };
}

async function sendSmsViaAfricasTalking(to: string, message: string, contract: Contract, notice: NotificationRecord): Promise<SmsSendResult> {
  if (!AFRICAS_TALKING_USERNAME || !AFRICAS_TALKING_API_KEY) {
    return {
      ok: false,
      provider: "Africa's Talking SMS",
      reference: notice.id,
      detail: "Africa's Talking SMS is selected, but AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY are not configured.",
    };
  }

  const body = new URLSearchParams({
    username: AFRICAS_TALKING_USERNAME,
    to,
    message,
  });
  if (SMS_SENDER) body.set("from", SMS_SENDER);

  const response = await fetch(getAfricasTalkingSmsEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      apiKey: AFRICAS_TALKING_API_KEY,
    },
    body,
  });
  const raw = await response.text();
  const payload = parseJsonMaybe(raw) || {};
  const recipient = payload.SMSMessageData?.Recipients?.[0] || {};
  const recipientStatus = clean(recipient.status || payload.status);
  const accepted =
    response.ok &&
    (!recipientStatus || ["success", "sent", "queued"].some((status) => recipientStatus.toLowerCase().includes(status)));
  const reference = clean(recipient.messageId || payload.messageId || notice.id);
  const providerMessage = clean(payload.SMSMessageData?.Message || payload.message || recipientStatus || response.statusText);

  return {
    ok: accepted,
    provider: "Africa's Talking SMS",
    reference,
    detail: accepted
      ? `${notice.type} sent to ${to} through Africa's Talking.`
      : `Africa's Talking failed for ${to}: ${providerMessage || raw || "unknown provider response"}`,
  };
}

function buildSmsMessage(contract: Contract, notice: NotificationRecord) {
  const message = `${SHOP_NAME}: ${notice.message}`;
  const account = ` Account ${contract.id}.`;
  const full = message.includes(contract.id) ? message : `${message}${account}`;
  return full.length > 320 ? `${full.slice(0, 317)}...` : full;
}

function normalizeSmsPhone(value: string) {
  const raw = clean(value).replace(/\s+/g, "");
  if (!raw) return "";
  const digits = cleanDigits(raw);
  if (!digits) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (SMS_DEFAULT_COUNTRY_CODE && digits.startsWith(SMS_DEFAULT_COUNTRY_CODE)) return `+${digits}`;
  if (SMS_DEFAULT_COUNTRY_CODE && digits.startsWith("0")) return `+${SMS_DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  return `+${digits}`;
}

function getSmsProviderStatus() {
  if (SMS_PROVIDER === "webhook") {
    return {
      mode: SMS_PROVIDER,
      label: "SMS webhook",
      ready: Boolean(SMS_WEBHOOK_URL),
    };
  }
  if (SMS_PROVIDER === "africas-talking") {
    return {
      mode: SMS_PROVIDER,
      label: "Africa's Talking SMS",
      ready: Boolean(AFRICAS_TALKING_USERNAME && AFRICAS_TALKING_API_KEY),
    };
  }
  return {
    mode: SMS_PROVIDER,
    label: "SMS simulation",
    ready: false,
  };
}

function getIosMdmProviderStatus() {
  if (IOS_MDM_PROVIDER === "webhook") {
    return {
      mode: IOS_MDM_PROVIDER,
      label: "Apple MDM webhook",
      ready: Boolean(IOS_MDM_WEBHOOK_URL),
    };
  }
  return {
    mode: IOS_MDM_PROVIDER,
    label: "Apple MDM simulation",
    ready: false,
  };
}

function getAfricasTalkingSmsEndpoint() {
  return AFRICAS_TALKING_ENV === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
}

function normalizeSmsProviderName(value: string): SmsProviderMode {
  const normalized = clean(value).toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  if (normalized === "webhook") return "webhook";
  if (normalized === "africas-talking" || normalized === "africastalking" || normalized === "at") return "africas-talking";
  return "simulate";
}

function normalizeIosMdmProviderName(value: string): IosMdmProviderMode {
  const normalized = clean(value).toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  if (normalized === "webhook") return "webhook";
  return "simulate";
}

function parseJsonMaybe(value: string) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function buildDevicePolicy(state: AppState, contract: Contract, bindingToken = "") {
  const progress = getProgress(contract);
  const pendingCommands = currentPendingDeviceCommands(state, contract)
    .map(deviceCommandPayload);
  const restrictionMessage =
    progress.arrears > 0
      ? `${contract.customer.name}, your account has ${formatKes(progress.arrears)} overdue. Payment plan must be adhered to.`
      : "Account is currently in good standing.";
  const paymentOnlyActive = contract.restriction.active && contract.restriction.level === "Limited access";
  return {
    service: SHOP_NAME,
    serverTime: nowIso(),
    // Canonical public URL so phones keep syncing after they leave the shop LAN.
    controlEndpoint: PUBLIC_BASE_URL,
    contractId: contract.id,
    customer: contract.customer.name,
    imei: contract.device.imei,
    serial: contract.device.serial,
    model: contract.device.model,
    platform: contract.device.platform,
    controlProfile: contract.device.controlProfile,
    identity: {
      bound: Boolean(contract.device.binding),
      firstSeenAt: contract.device.binding?.firstSeenAt || null,
      lastSeenAt: contract.device.binding?.lastSeenAt || null,
      mismatchCount: contract.device.binding?.mismatchCount || 0,
      bindingToken,
    },
    status: getStatus(contract),
    paid: progress.paid,
    balance: progress.balance,
    arrears: progress.arrears,
    nextDue: progress.nextDue,
    restriction: contract.restriction,
    pendingCommands,
    customerMessage: restrictionMessage,
    allowedPaymentPackages: paymentOnlyActive ? [ANDROID_AGENT_PACKAGE] : PAYMENT_APP_PACKAGES,
    paymentOnly: {
      active: paymentOnlyActive,
      label: "KISMART-only mode",
      allowedPackages: [ANDROID_AGENT_PACKAGE],
      emergencyDial: "112",
      allowedSystemActions: [],
    },
    emergencyAccessRequired: true,
  };
}

function acknowledgeDeviceCommands(state: AppState, contract: Contract, appliedCommandIds?: string[]) {
  const currentCommands = currentPendingDeviceCommands(state, contract);
  const currentIds = new Set(currentCommands.map((event) => event.id));
  const explicitAck = Array.isArray(appliedCommandIds);
  const acknowledgedIds = explicitAck
    ? new Set((appliedCommandIds || []).map((id) => clean(id)).filter(Boolean))
    : currentIds;
  const acknowledgedEvents: AppState["syncEvents"] = [];

  state.syncEvents.forEach((event) => {
    if (event.contractId === contract.id && event.provider === "Device command" && event.status === "Pending") {
      if (acknowledgedIds.has(event.id)) {
        event.status = "Synced";
        event.message = `Device acknowledged ${event.reference} command for ${contract.device.imei}`;
        acknowledgedEvents.push(event);
      } else if (!explicitAck) {
        event.status = "Failed";
        event.message = `Superseded by newer device command for ${contract.device.imei}`;
      }
    }
  });

  const commands = acknowledgedEvents.map(deviceCommandPayload);
  if (commands.length) {
    recordDeviceEvent(state, contract, "Command acknowledged", "Online", `${commands.length} command(s) acknowledged by device`, {
      commandsReceived: commands.length,
    });
  }
  return commands;
}

function deviceCommandPayload(event: AppState["syncEvents"][number]) {
  return {
    id: event.id,
    reference: event.reference,
    message: event.message,
    queuedAt: event.time,
  };
}

function readAppliedDeviceCommandIds(body: any) {
  const values = Array.isArray(body?.appliedCommandIds)
    ? body.appliedCommandIds
    : Array.isArray(body?.appliedCommands)
      ? body.appliedCommands
      : [];
  return values
    .map((value: any) => typeof value === "string" ? value : clean(value?.id))
    .map((value: string) => clean(value))
    .filter(Boolean);
}

function currentPendingDeviceCommands(state: AppState, contract: Contract) {
  const pending = state.syncEvents
    .filter((event) => event.contractId === contract.id && event.provider === "Device command" && event.status === "Pending")
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  return pending.slice(0, 1);
}

function readDeviceIdentity(request: any, body: any = {}): DeviceIdentityInput {
  const identity = body && typeof body.identity === "object" ? body.identity : {};
  const valueFrom = (header: string, field: string) => clean(request.headers[header] || identity[field] || body[field]);
  const result = {
    installId: valueFrom("x-kismart-install-id", "installId"),
    androidId: valueFrom("x-kismart-android-id", "androidId"),
    fingerprint: valueFrom("x-kismart-device-fingerprint", "fingerprint"),
    bindingToken: valueFrom("x-kismart-binding-token", "bindingToken"),
    manufacturer: valueFrom("x-kismart-device-manufacturer", "manufacturer"),
    brand: valueFrom("x-kismart-device-brand", "brand"),
    model: valueFrom("x-kismart-device-model", "model"),
    sdk: valueFrom("x-kismart-android-sdk", "sdk"),
  };
  if (!result.installId || !result.androidId || !result.fingerprint) {
    throw new HttpError(428, "Device identity is missing. Install the latest KISMART Device Agent, then save and sync again.");
  }
  return result;
}

function verifyDeviceIdentity(
  state: AppState,
  contract: Contract,
  identity: DeviceIdentityInput,
  source: string
): { allowed: boolean; detail?: string; changes: RuntimeSaveChanges; bindingToken: string } {
  const now = nowIso();
  const changes: RuntimeSaveChanges = { contractIds: [contract.id] };

  if (!contract.device.binding) {
    const bindingToken = createDeviceBindingToken();
    contract.device.binding = {
      installId: identity.installId,
      androidId: identity.androidId,
      fingerprint: identity.fingerprint,
      tokenHash: deviceBindingTokenHash(bindingToken),
      tokenIssuedAt: now,
      manufacturer: identity.manufacturer,
      brand: identity.brand,
      model: identity.model,
      sdk: identity.sdk,
      firstSeenAt: now,
      lastSeenAt: now,
      lastMismatchAt: null,
      mismatchCount: 0,
    };
    const event = recordDeviceEvent(state, contract, "Identity enrolled", "Online", "Device identity enrolled and bound to this contract", {
      source,
      installId: shortIdentity(identity.installId),
      androidId: shortIdentity(identity.androidId),
      fingerprint: shortIdentity(identity.fingerprint),
      model: identity.model,
    });
    const audit = addAudit(state, "Device Agent", "Device identity enrolled", `${contract.id} - ${contract.device.imei}`);
    changes.deviceEventIds = [event.id];
    changes.auditIds = [audit.id];
    return { allowed: true, changes, bindingToken };
  }

  const match = evaluateDeviceIdentityMatch(contract.device.binding, identity);
  if (!match.matched) {
    contract.device.binding.lastMismatchAt = now;
    contract.device.binding.mismatchCount = numberFrom(contract.device.binding.mismatchCount) + 1;
    const detail = "This IMEI is already bound to another phone identity. Admin must verify the handset and reset the device binding before this phone can sync.";
    const event = recordDeviceEvent(state, contract, "Tamper alert", "Attention", "Device identity mismatch blocked", {
      source,
      matchReason: match.reason,
      expectedInstallId: shortIdentity(contract.device.binding.installId),
      incomingInstallId: shortIdentity(identity.installId),
      expectedAndroidId: shortIdentity(contract.device.binding.androidId),
      incomingAndroidId: shortIdentity(identity.androidId),
      expectedFingerprint: shortIdentity(contract.device.binding.fingerprint),
      incomingFingerprint: shortIdentity(identity.fingerprint),
      model: identity.model,
    });
    const notice: NotificationRecord = {
      id: uid("NTC"),
      time: now,
      contractId: contract.id,
      type: "Device identity mismatch",
      channel: "System",
      status: "Pending",
      message: `${contract.customer.name} device ${contract.device.imei}: IMEI sync attempt blocked because the phone identity did not match the enrolled handset.`,
    };
    state.notifications.unshift(notice);
    const audit = addAudit(state, "Device Agent", "Device identity mismatch blocked", `${contract.id} - ${contract.device.imei}`);
    changes.deviceEventIds = [event.id];
    changes.notificationIds = [notice.id];
    changes.auditIds = [audit.id];
    return { allowed: false, detail, changes, bindingToken: "" };
  }

  // Same physical handset: refresh mutable fields and re-issue token after reinstall/data wipe.
  let bindingToken = "";
  if (match.needsTokenReissue || !contract.device.binding.tokenHash) {
    bindingToken = createDeviceBindingToken();
    contract.device.binding.tokenHash = deviceBindingTokenHash(bindingToken);
    contract.device.binding.tokenIssuedAt = now;
  }
  contract.device.binding.installId = identity.installId || contract.device.binding.installId;
  contract.device.binding.androidId = identity.androidId || contract.device.binding.androidId;
  contract.device.binding.fingerprint = identity.fingerprint || contract.device.binding.fingerprint;
  contract.device.binding.lastSeenAt = now;
  contract.device.binding.manufacturer = identity.manufacturer || contract.device.binding.manufacturer;
  contract.device.binding.brand = identity.brand || contract.device.binding.brand;
  contract.device.binding.model = identity.model || contract.device.binding.model;
  contract.device.binding.sdk = identity.sdk || contract.device.binding.sdk;

  if (match.reason === "android-id-recovery" || match.reason === "legacy-unbound-token") {
    const event = recordDeviceEvent(state, contract, "Identity verified", "Online", "Device identity recovered on the same handset without admin reset", {
      source,
      matchReason: match.reason,
      androidId: shortIdentity(identity.androidId),
      model: identity.model,
    });
    changes.deviceEventIds = [event.id];
  }

  return { allowed: true, changes, bindingToken };
}

/**
 * Durable same-phone matching:
 * - Valid binding token always wins (agent reconnected with stored secret).
 * - Same Android ID wins even if app data / binding token was wiped (reinstall).
 * - Fingerprint/installId alone are not enough (they can be shared or IMEI-derived).
 * Reset ID is only required when a different physical handset uses the same IMEI.
 */
function evaluateDeviceIdentityMatch(binding: DeviceBinding, identity: DeviceIdentityInput): {
  matched: boolean;
  reason: string;
  needsTokenReissue: boolean;
} {
  const tokenOk = deviceBindingTokenMatches(binding, identity.bindingToken);
  if (tokenOk) {
    return { matched: true, reason: "binding-token", needsTokenReissue: false };
  }

  const androidIdMatch = Boolean(binding.androidId && identity.androidId && binding.androidId === identity.androidId);
  if (androidIdMatch) {
    // Token missing/wrong after reinstall or SharedPreferences wipe — same handset.
    return { matched: true, reason: "android-id-recovery", needsTokenReissue: true };
  }

  // Backward-compatible path for older agents that had no token yet but still present both signals.
  if (!binding.tokenHash) {
    const installMatch = Boolean(binding.installId && identity.installId && binding.installId === identity.installId);
    const fingerprintMatch = Boolean(binding.fingerprint && identity.fingerprint && binding.fingerprint === identity.fingerprint);
    if (installMatch || fingerprintMatch) {
      return { matched: true, reason: "legacy-unbound-token", needsTokenReissue: true };
    }
  }

  return { matched: false, reason: "mismatch", needsTokenReissue: false };
}

function createDeviceBindingToken() {
  return randomBytes(32).toString("base64url");
}

function deviceBindingTokenHash(token: string, secret = BINDING_TOKEN_SECRET) {
  return createHmac("sha256", secret).update(clean(token)).digest("base64url");
}

function deviceBindingTokenMatches(binding: DeviceBinding, token: string) {
  if (!binding.tokenHash || !token) return false;
  if (safeEqual(binding.tokenHash, deviceBindingTokenHash(token, BINDING_TOKEN_SECRET))) return true;
  // Accept legacy hashes signed with the admin session secret so existing phones keep working.
  if (BINDING_TOKEN_SECRET !== SESSION_SECRET) {
    if (safeEqual(binding.tokenHash, deviceBindingTokenHash(token, SESSION_SECRET))) return true;
  }
  return false;
}

function resolvePublicBaseUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "https://kismartsystem.vercel.app";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/$/, "");
}

function mergeRuntimeSaveChanges(...items: RuntimeSaveChanges[]): RuntimeSaveChanges {
  return {
    syncEventIds: uniqueIds(items.flatMap((item) => item.syncEventIds || [])),
    deviceEventIds: uniqueIds(items.flatMap((item) => item.deviceEventIds || [])),
    contractIds: uniqueIds(items.flatMap((item) => item.contractIds || [])),
    notificationIds: uniqueIds(items.flatMap((item) => item.notificationIds || [])),
    auditIds: uniqueIds(items.flatMap((item) => item.auditIds || [])),
  };
}

function normalizeDeviceBinding(value: any): DeviceBinding | null {
  if (!value) return null;
  const installId = clean(value.installId);
  const androidId = clean(value.androidId);
  const fingerprint = clean(value.fingerprint);
  if (!installId || !androidId || !fingerprint) return null;
  return {
    installId,
    androidId,
    fingerprint,
    tokenHash: clean(value.tokenHash || value.bindingTokenHash),
    tokenIssuedAt: clean(value.tokenIssuedAt),
    manufacturer: clean(value.manufacturer),
    brand: clean(value.brand),
    model: clean(value.model),
    sdk: clean(value.sdk),
    firstSeenAt: clean(value.firstSeenAt || nowIso()),
    lastSeenAt: clean(value.lastSeenAt || value.firstSeenAt || nowIso()),
    lastMismatchAt: clean(value.lastMismatchAt) || null,
    mismatchCount: numberFrom(value.mismatchCount),
  };
}

function shortIdentity(value: string) {
  const cleaned = clean(value);
  if (cleaned.length <= 8) return cleaned;
  return `${cleaned.slice(0, 4)}...${cleaned.slice(-4)}`;
}

function recordDeviceEvent(
  state: AppState,
  contract: Contract,
  type: DeviceEvent["type"],
  status: DeviceEvent["status"],
  message: string,
  metadata: Record<string, string | number | boolean | null> = {}
) {
  const event: DeviceEvent = {
    id: uid("DEV"),
    time: nowIso(),
    contractId: contract.id,
    imei: contract.device.imei,
    type,
    status,
    message,
    metadata,
  };
  state.deviceEvents.unshift(event);
  if (state.deviceEvents.length > 250) state.deviceEvents.length = 250;
  return event;
}

function getSummary(state: AppState) {
  const value = state.contracts.reduce((sum, contract) => sum + contract.plan.devicePrice, 0);
  const collected = state.contracts.reduce((sum, contract) => sum + getProgress(contract).paid, 0);
  const balance = state.contracts.reduce((sum, contract) => sum + getProgress(contract).balance, 0);
  const arrears = state.contracts.reduce((sum, contract) => sum + getProgress(contract).arrears, 0);
  const active = state.contracts.filter((contract) => getStatus(contract) === "Active").length;
  const overdue = state.contracts.filter((contract) => getStatus(contract) === "Overdue").length;
  const restricted = state.contracts.filter((contract) => getStatus(contract) === "Restricted").length;
  const completed = state.contracts.filter((contract) => getStatus(contract) === "Completed").length;
  return {
    total: state.contracts.length,
    value,
    collected,
    balance,
    arrears,
    active,
    overdue,
    restricted,
    completed,
    collectionRate: value ? Math.round((collected / value) * 100) : 0,
  };
}

function getAllPayments(state: AppState) {
  return state.contracts.flatMap((contract) =>
    contract.payments.map((payment) => ({
      ...payment,
      contractId: contract.id,
      customerName: contract.customer.name,
    }))
  );
}

function getEcosystemSummary(state: AppState) {
  const pendingNotifications = state.notifications.filter((notice) => notice.status === "Pending").length;
  const pendingDeviceCommands = state.syncEvents.filter((event) => isDeviceCommandProvider(event.provider) && event.status === "Pending").length;
  const onlineToday = state.deviceEvents.filter((event) => event.time.slice(0, 10) === todayIso() && event.status === "Online").length;
  const smsProvider = getSmsProviderStatus();
  const iosMdmProvider = getIosMdmProviderStatus();
  return {
    pendingNotifications,
    pendingDeviceCommands,
    deviceEvents: state.deviceEvents.length,
    onlineToday,
    smsProvider: smsProvider.label,
    smsReady: smsProvider.ready,
    smsMode: smsProvider.mode,
    iosMdmProvider: iosMdmProvider.label,
    iosMdmReady: iosMdmProvider.ready,
    iosMdmMode: iosMdmProvider.mode,
    callbackSecretConfigured: Boolean(CALLBACK_SECRET),
    deviceSyncSecretConfigured: Boolean(DEVICE_SYNC_SECRET),
    secured: Boolean(CALLBACK_SECRET && DEVICE_SYNC_SECRET),
  };
}

function buildContractsCsv(state: AppState) {
  const rows = state.contracts.map((contract) => {
    const progress = getProgress(contract);
    return {
      contract_id: contract.id,
      customer: contract.customer.name,
      phone: contract.customer.phone,
      branch: contract.customer.branch,
      device: contract.device.model,
      imei: contract.device.imei,
      platform: contract.device.platform,
      control_profile: contract.device.controlProfile,
      frequency: contract.plan.frequency,
      device_price: contract.plan.devicePrice,
      paid: progress.paid,
      balance: progress.balance,
      arrears: progress.arrears,
      next_due: progress.nextDue || "",
      status: getStatus(contract),
      restriction: contract.restriction.level,
    };
  });
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(","))].join("\n");
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function getBranchPerformance(state: AppState) {
  const branches = new Map<string, { branch: string; contracts: number; collected: number; balance: number; arrears: number }>();
  state.contracts.forEach((contract) => {
    const progress = getProgress(contract);
    const branch = contract.customer.branch || "Unassigned";
    const row = branches.get(branch) || { branch, contracts: 0, collected: 0, balance: 0, arrears: 0 };
    row.contracts += 1;
    row.collected += progress.paid;
    row.balance += progress.balance;
    row.arrears += progress.arrears;
    branches.set(branch, row);
  });
  return Array.from(branches.values()).sort((a, b) => b.collected - a.collected);
}

function getReadiness(state: AppState) {
  const summary = getSummary(state);
  const hasAndroidControl = state.contracts.some((contract) => contract.device.platform === "Android" && contract.device.controlProfile.includes("Android"));
  const hasIosPolicy = state.contracts.some((contract) => contract.device.platform === "iOS" && contract.device.controlProfile.includes("MDM"));
  const hasPaymentRails = state.contracts.some((contract) => contract.payments.some((payment) => payment.method === "M-Pesa" || payment.method === "Airtel Money"));
  const smsProvider = getSmsProviderStatus();
  const iosMdmProvider = getIosMdmProviderStatus();
  return [
    {
      title: "Portfolio engine",
      status: summary.total > 0 ? "Ready" : "Attention",
      detail: `${summary.total} contracts with automated balance, arrears, and status calculations.`,
    },
    {
      title: "Payment reconciliation",
      status: hasPaymentRails ? "Ready" : "Attention",
      detail: "M-Pesa and Airtel Money callbacks support idempotent allocation by transaction reference.",
    },
    {
      title: "Callback signing",
      status: CALLBACK_SECRET ? "Ready" : "Attention",
      detail: CALLBACK_SECRET ? "Provider callbacks require the configured shared secret." : "Set KISMART_CALLBACK_SECRET before exposing callbacks publicly.",
    },
    {
      title: "Warning workflow",
      status: state.settings.warningStages.length >= 3 ? "Ready" : "Attention",
      detail: `${state.settings.warningStages.length} warning stages configured before restriction.`,
    },
    {
      title: "Phone messaging",
      status: smsProvider.ready ? "Ready" : "Attention",
      detail: smsProvider.ready
        ? `${smsProvider.label} is configured for SMS reminders and warnings.`
        : `${smsProvider.label} is active, so notices are not leaving the server as real SMS yet.`,
    },
    {
      title: "Device command queue",
      status: hasAndroidControl || hasIosPolicy ? "Ready" : "Attention",
      detail: "Restriction and restoration commands are queued with audit records for Android sync or Apple MDM dispatch.",
    },
    {
      title: "Device agent sync",
      status: state.deviceEvents.length > 0 || state.syncEvents.some((event) => isDeviceCommandProvider(event.provider)) ? "Ready" : "Attention",
      detail: "Android devices can pull policy, acknowledge commands, and report tamper events through the sync API.",
    },
    {
      title: "iOS control path",
      status: hasIosPolicy && iosMdmProvider.ready ? "Ready" : hasIosPolicy ? "Attention" : "Blocked",
      detail: hasIosPolicy
        ? `${iosMdmProvider.label} is ${iosMdmProvider.ready ? "configured" : "available in simulation mode"} for supervised Apple devices.`
        : "iOS restrictions require supervised Apple MDM enrollment and policy support.",
    },
    {
      title: "Governance",
      status: state.audit.length > 0 ? "Ready" : "Attention",
      detail: `${state.audit.length} audit events captured across contracts, payments, warnings, and restrictions.`,
    },
  ];
}

function getProgress(contract: Contract): Progress {
  const total = contract.plan.devicePrice;
  const schedule = getSchedule(contract);
  const paidRaw = contract.payments.reduce((sum, payment) => sum + numberFrom(payment.amount), 0);
  const paid = Math.min(paidRaw, total);
  const balance = Math.max(total - paidRaw, 0);
  const dueNow = schedule
    .filter((item) => parseDate(item.dueDate) <= today())
    .reduce((sum, item) => sum + item.amount, 0);
  const arrears = Math.max(dueNow - paidRaw, 0);

  let cumulative = 0;
  let next: { dueDate: string; amount: number } | null = null;
  for (const item of schedule) {
    cumulative += item.amount;
    if (cumulative > paidRaw) {
      next = item;
      break;
    }
  }

  const graceDate = next ? addDays(parseDate(next.dueDate), contract.plan.graceDays || 0) : null;
  const overdueDays = arrears > 0 && graceDate ? Math.max(0, daysBetween(graceDate, today())) : 0;
  return {
    paid,
    balance,
    arrears,
    nextDue: next ? next.dueDate : null,
    nextAmount: next ? next.amount : 0,
    overdueDays,
  };
}

function getStatus(contract: Contract): Status {
  const progress = getProgress(contract);
  if (progress.balance <= 0) return "Completed";
  if (contract.restriction.active) return "Restricted";
  if (progress.arrears > 0) return "Overdue";
  return "Active";
}

function getWarningLabel(contract: Contract) {
  const progress = getProgress(contract);
  if (progress.arrears <= 0) return "No warning";
  let label = "Payment due";
  seedSettings().warningStages.forEach((stage) => {
    if (progress.overdueDays >= stage.daysAfterDue) label = stage.name;
  });
  return label;
}

function getReminderQueue(state: AppState) {
  return state.contracts
    .filter((contract) => getStatus(contract) !== "Completed")
    .flatMap((contract) => {
      const progress = getProgress(contract);
      if (progress.arrears > 0) {
        return [
          {
            contractId: contract.id,
            type: getWarningLabel(contract),
            status: "Pending",
            message: `${formatKes(progress.arrears)} overdue. ${contract.customer.name} is ${progress.overdueDays} days beyond the grace window.`,
          },
        ];
      }
      if (!progress.nextDue) return [];
      const daysUntil = daysBetween(today(), parseDate(progress.nextDue));
      if (daysUntil <= state.settings.reminderLeadDays && daysUntil >= 0) {
        return [
          {
            contractId: contract.id,
            type: "Upcoming payment",
            status: "Pending",
            message: `${formatKes(progress.nextAmount)} due on ${progress.nextDue} via ${contract.plan.frequency} plan.`,
          },
        ];
      }
      return [];
    });
}

function getSchedule(contract: Contract) {
  const plan = contract.plan;
  const deposit = Math.min(plan.deposit || 0, plan.devicePrice);
  const remaining = Math.max(plan.devicePrice - deposit, 0);
  const count = Math.max(1, plan.periodCount || Math.ceil(remaining / plan.installment));
  const schedule = [{ label: "Deposit", dueDate: contract.createdAt, amount: deposit }];
  if (remaining <= 0) return schedule;

  for (let index = 1; index <= count; index += 1) {
    const paidBefore = plan.installment * (index - 1);
    const amount =
      index === count
        ? Math.max(remaining - paidBefore, 0)
        : Math.min(plan.installment, Math.max(remaining - paidBefore, 0));
    if (amount <= 0) continue;
    const dueDate =
      plan.frequency === "Custom" && plan.customDates[index - 1]
        ? plan.customDates[index - 1]
        : dateToIso(addByFrequency(parseDate(contract.createdAt), plan.frequency, index));
    schedule.push({ label: `${plan.frequency} installment ${index}`, dueDate, amount });
  }
  return schedule;
}

function seedState(): AppState {
  return {
    settings: seedSettings(),
    deviceEvents: [],
    syncEvents: [],
    notifications: [],
    intakes: [],
    inventoryDevices: [],
    audit: [],
    contracts: [],
  };
}

function seedJsonState(): AppState {
  const state = seedState();
  const bootstrapContracts = bootstrapContractsFromEnv();
  if (bootstrapContracts.length) {
    state.contracts = bootstrapContracts;
  }
  return normalizeState(state);
}

function bootstrapContractsFromEnv(): Contract[] {
  const raw = clean(process.env.KISMART_BOOTSTRAP_CONTRACTS_JSON);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Bootstrap contracts ignored: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function seedSettings() {
  return {
    reminderLeadDays: 2,
    restrictionGraceDays: 2,
    defaultRestrictionLevel: "Full lock" as RestrictionLevel,
    warningStages: [
      { name: "First warning", daysAfterDue: 1, consequence: "formal overdue notice" },
      { name: "Second warning", daysAfterDue: 4, consequence: "lock-screen message or limited access" },
      { name: "Final warning", daysAfterDue: 7, consequence: "device restriction until account is brought up to date" },
    ],
    roles: [
      { name: "Admin", permissions: ["contracts", "payments", "restrictions", "reports", "settings"] },
      { name: "Branch Manager", permissions: ["contracts", "payments", "reports", "reminders"] },
      { name: "Cashier", permissions: ["payments", "customer lookup", "receipts"] },
      { name: "Support Agent", permissions: ["reminders", "warnings", "device restore"] },
    ],
    security: [
      { title: "Unique device binding", detail: "Contracts store IMEI, serial number, platform, and assigned control profile." },
      { title: "Audit trail", detail: "Every reminder, warning, payment, restriction, and role change is logged." },
      { title: "Secure communication", detail: "Production backend should use HTTPS, signed payment callbacks, and server-issued device commands." },
      { title: "Tamper resistance", detail: "Android uses device-owner enrollment where policy allows; iOS requires Apple MDM enrollment." },
      { title: "Offline sync", detail: "Payment and device events are queued locally and reconciled when the network returns." },
    ],
  };
}

function isValidAdminLogin(email: string, password: string) {
  return safeEqual(email.trim().toLowerCase(), ADMIN_EMAIL.trim().toLowerCase()) && safeEqual(password, ADMIN_PASSWORD);
}

function safeEqual(leftValue: string, rightValue: string) {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createAdminSession(email: string) {
  const payload = Buffer.from(JSON.stringify({ email, expiresAt: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sessionSignature(payload)}`;
}

function getAdminSession(request: any) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = parseAdminSession(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) return null;
  return session;
}

function assertAdminSession(request: any) {
  if (!getAdminSession(request)) throw new HttpError(401, "Admin authentication required");
}

function clearAdminSession(request: any) {
  getCookie(request, SESSION_COOKIE);
}

function parseAdminSession(token: string): { email: string; expiresAt: number } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, sessionSignature(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = clean(session?.email);
    const expiresAt = numberFrom(session?.expiresAt);
    if (!email || !expiresAt) return null;
    return { email, expiresAt };
  } catch {
    return null;
  }
}

function sessionSignature(payload: string) {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function getCookie(request: any, name: string) {
  const raw = String(request.headers.cookie || "");
  const cookies = raw.split(";").map((part) => part.trim()).filter(Boolean);
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0) continue;
    const key = cookie.slice(0, index);
    if (key === name) return decodeURIComponent(cookie.slice(index + 1));
  }
  return "";
}

function sessionCookie(token: string) {
  const secure = process.env.KISMART_COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function requiresAdminAuth(pathname: string) {
  if (pathname === "/api/health") return false;
  if (pathname.startsWith("/api/auth/")) return false;
  if (pathname.startsWith("/api/devices/")) return false;
  if (pathname === "/api/payments/mpesa-callback" || pathname === "/api/payments/airtel-callback") return false;
  return true;
}

async function readBody(request: any) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: any) => body += chunk);
    request.on("end", () => resolve(body));
    request.on("error", (err: any) => reject(err));
  });
}

async function getMpesaAccessToken() {
  const credentials = Buffer.from(`${PAYBILL_API_KEY}:${PAYBILL_API_SECRET}`).toString("base64");
  const response = await fetch(`${MPESA_API_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`M-Pesa auth failed: ${error}`);
  }
  const data: any = await response.json();
  return data.access_token;
}

async function initiateMpesaStkPush(phoneNumber: string, amount: number, accountReference: string) {
  const accessToken = await getMpesaAccessToken();
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").split(".")[0];
  const password = Buffer.from(`${PAYBILL_BUSINESS_NUMBER}${PAYBILL_PASSKEY}${timestamp}`).toString("base64");

  const body = {
    BusinessShortCode: PAYBILL_BUSINESS_NUMBER,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: formatMpesaPhone(phoneNumber),
    PartyB: PAYBILL_BUSINESS_NUMBER,
    PhoneNumber: formatMpesaPhone(phoneNumber),
    CallBackURL: CALLBACK_SECRET ? `${PAYBILL_CALLBACK_URL}?secret=${CALLBACK_SECRET}` : PAYBILL_CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: `Payment for ${accountReference}`,
  };

  const response = await fetch(`${MPESA_API_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`STK Push failed: ${error}`);
  }

  return await response.json();
}

function formatMpesaPhone(phone: string) {
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    cleaned = "254" + cleaned;
  }
  return cleaned;
}


async function readJson(request: any) {
  const raw = await readBody(request);
  return raw ? JSON.parse(raw) : {};
}

async function readForm(request: any) {
  return new URLSearchParams(await readBody(request));
}

function sendJson(response: any, statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  response.writeHead(statusCode, { ...responseHeaders("application/json; charset=utf-8"), ...extraHeaders });
  response.end(JSON.stringify(body, null, 2));
}

function sendHtml(response: any, body: string, statusCode = 200, extraHeaders: Record<string, string> = {}) {
  response.writeHead(statusCode, { ...responseHeaders("text/html; charset=utf-8", true), ...extraHeaders });
  response.end(body);
}

function sendRedirect(response: any, location: string, extraHeaders: Record<string, string> = {}) {
  response.writeHead(303, { ...responseHeaders("text/plain; charset=utf-8"), ...extraHeaders, Location: location });
  response.end(`Redirecting to ${location}`);
}

function sendText(response: any, statusCode: number, contentType: string, body: string) {
  response.writeHead(statusCode, responseHeaders(contentType));
  response.end(body);
}

function sendBinary(response: any, statusCode: number, contentType: string, body: Buffer) {
  response.writeHead(statusCode, responseHeaders(contentType));
  response.end(body);
}

function sendEmpty(response: any, statusCode: number) {
  response.writeHead(statusCode, responseHeaders("text/plain; charset=utf-8"));
  response.end();
}

function openEventStream(request: any, response: any) {
  response.writeHead(200, {
    ...responseHeaders("text/event-stream; charset=utf-8"),
    "Connection": "keep-alive",
  });
  eventClients.add(response);
  writeEvent(response, "connected", { time: nowIso() });
  const heartbeat = setInterval(() => {
    writeEvent(response, "heartbeat", { time: nowIso() });
  }, 25000);
  request.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

function broadcastStateChange() {
  const payload = { time: nowIso() };
  for (const client of Array.from(eventClients)) {
    try {
      writeEvent(client, "state", payload);
    } catch {
      eventClients.delete(client);
    }
  }
}

function writeEvent(response: any, event: string, payload: unknown) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function responseHeaders(contentType: string, html = false) {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-KISMART-Role, X-KISMART-Callback-Secret, X-KISMART-Device-Secret, X-KISMART-Install-Id, X-KISMART-Android-Id, X-KISMART-Device-Fingerprint, X-KISMART-Binding-Token, X-KISMART-Device-Manufacturer, X-KISMART-Device-Brand, X-KISMART-Device-Model, X-KISMART-Android-SDK",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  };
  if (html) {
    headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";
  }
  return headers;
}

function findContractOrThrow(state: AppState, id: string) {
  const contract = state.contracts.find((item) => item.id === id);
  if (!contract) throw new HttpError(404, `Contract ${id} not found`);
  return contract;
}

function findContractByImeiOrThrow(state: AppState, imei: string) {
  const normalizedImei = clean(imei);
  const contract = state.contracts.find((item) => item.device.imei === normalizedImei);
  if (!contract) throw new HttpError(404, `Device IMEI ${normalizedImei} is not registered`);
  return contract;
}

function addAudit(state: AppState, role: string, action: string, record: string) {
  const audit: AuditRecord = {
    id: uid("AUD"),
    time: nowIso(),
    role,
    action,
    record,
  };
  state.audit.unshift(audit);
  return audit;
}

function assertRole(role: string, permission: string) {
  const permissions = ROLE_PERMISSIONS[role] || [];
  if (!permissions.includes(permission)) {
    throw new HttpError(403, `${role} is not allowed to perform ${permission}`);
  }
}

function assertCallbackSecret(request: any) {
  if (!CALLBACK_SECRET) return;
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const incoming = String(request.headers["x-kismart-callback-secret"] || url.searchParams.get("secret") || "");
  if (incoming !== CALLBACK_SECRET) {
    // For M-Pesa STK Push, we might not have the header, so we allow it if the request is valid
    // but ideally the user should add ?secret=... to their callback URL
    throw new HttpError(401, "Invalid payment callback signature");
  }
}

function assertDeviceSecret(request: any) {
  if (!DEVICE_SYNC_SECRET) return;
  const incoming = String(request.headers["x-kismart-device-secret"] || "");
  if (incoming !== DEVICE_SYNC_SECRET) {
    throw new HttpError(401, "Invalid device sync signature");
  }
}

function normalizePaymentMethod(value: string): PaymentMethod {
  if (["Deposit", "M-Pesa", "Airtel Money", "Bank", "Cash"].includes(value)) return value as PaymentMethod;
  return "M-Pesa";
}

function normalizeFrequency(value: string): Frequency {
  if (["Daily", "Weekly", "Monthly", "Custom"].includes(value)) return value as Frequency;
  return "Weekly";
}

function normalizePlatform(value: string): Platform {
  return value === "iOS" ? "iOS" : "Android";
}

function normalizeRestrictionLevel(value: string): RestrictionLevel {
  if (["None", "Lock screen message", "Limited access", "Full lock"].includes(value)) {
    return value as RestrictionLevel;
  }
  return "Full lock";
}

function clean(value: unknown) {
  return String(value || "").trim();
}

function cleanDigits(value: unknown) {
  return clean(value).replace(/\D/g, "");
}

function cleanSerial(value: unknown) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function cleanPhone(value: unknown) {
  return clean(value).replace(/[^\d+]/g, "");
}

function paymentAppPackagesFromEnv(value: unknown) {
  const configured = clean(value)
    .split(",")
    .map((item) => clean(item))
    .filter(Boolean);
  return configured.length ? Array.from(new Set(configured)) : DEFAULT_PAYMENT_APP_PACKAGES;
}

function numberFrom(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function today() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function todayIso() {
  return dateToIso(today());
}

function nowIso() {
  return new Date().toISOString();
}

function parseDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addByFrequency(start: Date, frequency: Frequency, index: number) {
  const date = new Date(start);
  if (frequency === "Daily") date.setDate(date.getDate() + index);
  else if (frequency === "Weekly") date.setDate(date.getDate() + index * 7);
  else date.setMonth(date.getMonth() + index);
  return date;
}

function daysBetween(start: Date, end: Date) {
  const ms = 1000 * 60 * 60 * 24;
  return Math.floor((stripTime(end).getTime() - stripTime(start).getTime()) / ms);
}

function stripTime(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateToIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatKes(amount: number) {
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    maximumFractionDigits: 0,
  }).format(amount);
}

async function runSelfTest() {
  const state = buildSelfTestState();
  const summary = getSummary(state);
  const first = enrichContract(state.contracts[0]);
  const automation = runAutomation(state);
  const policy = buildDevicePolicy(state, state.contracts[0]);
  applyRestriction(state, state.contracts[0], "Lock screen message");
  const deliveredCommands = currentPendingDeviceCommands(state, state.contracts[0]).map(deviceCommandPayload);
  const prematureAck = acknowledgeDeviceCommands(state, state.contracts[0], []);
  const commands = acknowledgeDeviceCommands(state, state.contracts[0], deliveredCommands.map((command) => command.id));
  const iosContract: Contract = {
    ...state.contracts[0],
    id: "KIS-IOS-TEST",
    customer: { ...state.contracts[0].customer, name: "Test iPhone Customer" },
    device: {
      ...state.contracts[0].device,
      model: "Test iPhone",
      imei: "350000000000002",
      serial: "TEST-IOS-001",
      platform: "iOS",
      controlProfile: "Apple supervised MDM",
      binding: null,
    },
    restriction: { active: false, level: "None", appliedAt: null },
    payments: [...state.contracts[0].payments],
    warningsSent: [],
  };
  state.contracts.push(iosContract);
  applyRestriction(state, iosContract, "Full lock");
  const mdmDispatch = await dispatchPendingDeviceCommands(state, 5);
  const dispatch = await dispatchPendingNotifications(state, 5);
  const ecosystem = getEcosystemSummary(state);
  const dashboard = renderDashboard();
  const clientScript = renderClientScript();
  const sessionToken = createAdminSession(ADMIN_EMAIL);
  const session = getAdminSession({ headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` } });
  if (!summary.total) throw new Error("Expected self-test contract");
  if (!first.progress) throw new Error("Expected enriched contract progress");
  if (!Array.isArray(automation.actions)) throw new Error("Expected automation action list");
  if (session?.email !== ADMIN_EMAIL) throw new Error("Expected signed admin session to verify");
  if (getAdminSession({ headers: { cookie: `${SESSION_COOKIE}=invalid-token` } })) throw new Error("Expected invalid admin session to fail");
  if (policy.contractId !== state.contracts[0].id) throw new Error("Expected device policy for first contract");
  if (!policy.allowedPaymentPackages.length) throw new Error("Expected device policy payment app allowlist");
  if (prematureAck.length) throw new Error("Expected device command to wait for applied command ids");
  if (!commands.length) throw new Error("Expected device command acknowledgement");
  if (mdmDispatch.synced < 1) throw new Error("Expected Apple MDM command simulation to sync");
  if (dispatch.sent < 1) throw new Error("Expected notification dispatch to process queued notices");
  if (!ecosystem.deviceEvents) throw new Error("Expected device event summary");
  if (!dashboard.includes("/assets/app.js")) throw new Error("Expected dashboard to load generated client script");
  if (!clientScript.includes("/api/automation/run")) throw new Error("Expected client script to run automation API");
  if (!clientScript.includes("Device Sync Log")) throw new Error("Expected ecosystem UI in client script");
  if (!clientScript.includes("/api/state")) throw new Error("Expected client script to use backend API");
  console.log(
    JSON.stringify(
      {
        ok: true,
        contracts: summary.total,
        active: summary.active,
        overdue: summary.overdue,
        restricted: summary.restricted,
        automationActions: automation.actions.length,
        mdmCommands: mdmDispatch.synced,
        dispatchedNotices: dispatch.sent,
        deviceEvents: ecosystem.deviceEvents,
        dashboardBytes: dashboard.length,
      },
      null,
      2
    )
  );
}

function buildSelfTestState(): AppState {
  const state = seedState();
  const contract: Contract = {
    id: "KIS-TEST",
    createdAt: dateToIso(addDays(today(), -15)),
    customer: {
      name: "Test Customer",
      phone: "0700000000",
      nationalId: "TEST-ID",
      address: "Test address",
      branch: "Test branch",
      documentName: "test-id.pdf",
    },
    device: {
      model: "Test Android Phone",
      imei: "350000000000001",
      serial: "TEST-SERIAL-001",
      platform: "Android",
      controlProfile: "Android device owner",
      binding: null,
    },
    plan: {
      devicePrice: 12000,
      deposit: 2000,
      installment: 1000,
      frequency: "Weekly",
      periodCount: 10,
      graceDays: 2,
      customDates: [],
    },
    payments: [
      {
        id: uid("PAY"),
        date: dateToIso(addDays(today(), -15)),
        method: "Deposit",
        reference: "DEP-KIS-TEST",
        amount: 2000,
        status: "Synced",
      },
    ],
    warningsSent: [],
    restriction: { active: false, level: "None", appliedAt: null },
  };
  state.contracts.push(contract);
  state.notifications.push({
    id: uid("NTC"),
    time: nowIso(),
    contractId: contract.id,
    type: "Payment reminder",
    channel: "SMS",
    status: "Pending",
    message: "Self-test payment reminder.",
  });
  state.syncEvents.push({
    id: uid("SYNC"),
    time: nowIso(),
    contractId: contract.id,
    provider: "Device command",
    reference: "Full lock",
    status: "Pending",
    message: `Restriction command queued for ${contract.device.imei}`,
  });
  return state;
}
