/**
 * Server-side PDF generation for KISMART documents (payment plan, sales, supply).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { DocLang, PaymentPlanDocInput, SoldPhoneRow, SupplyRow } from "./documents.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GREEN = "#0d6b45";
const INK = "#14201a";
const MUTED = "#5a6b62";
const LINE = "#c9d6ce";

function money(n: number) {
  const v = Number(n) || 0;
  return `KES ${v.toLocaleString("en-KE")}`;
}

function collectBuffers(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function isUsableFontFile(path: string) {
  // pdfkit cannot open .ttc collections — only .ttf / .otf.
  return /\.(ttf|otf)$/i.test(path) && existsSync(path);
}

function resolveFontPaths(lang: DocLang) {
  const candidates =
    lang === "zh"
      ? [
          "C:\\Windows\\Fonts\\simsunb.ttf",
          "C:\\Windows\\Fonts\\NotoSansSC-Regular.otf",
          "C:\\Windows\\Fonts\\NotoSansCJKsc-Regular.otf",
          join(__dirname, "assets", "NotoSansSC-Regular.otf"),
          // Latin fallbacks (unicode=false path for CJK)
          "C:\\Windows\\Fonts\\arial.ttf",
          "C:\\Windows\\Fonts\\segoeui.ttf",
        ]
      : [
          "C:\\Windows\\Fonts\\arial.ttf",
          "C:\\Windows\\Fonts\\segoeui.ttf",
          "C:\\Windows\\Fonts\\calibri.ttf",
          join(__dirname, "assets", "arial.ttf"),
        ];
  const boldCandidates =
    lang === "zh"
      ? ["C:\\Windows\\Fonts\\simsunb.ttf", ...candidates]
      : [
          "C:\\Windows\\Fonts\\arialbd.ttf",
          "C:\\Windows\\Fonts\\segoeuib.ttf",
          "C:\\Windows\\Fonts\\calibrib.ttf",
          ...candidates,
        ];
  const regular = candidates.find(isUsableFontFile) || null;
  const bold = boldCandidates.find(isUsableFontFile) || regular;
  return { regular, bold };
}

function registerFonts(doc: PDFKit.PDFDocument, lang: DocLang) {
  const { regular, bold } = resolveFontPaths(lang);
  let body = "Helvetica";
  let heading = "Helvetica-Bold";
  let unicode = false;

  const tryRegister = (name: string, path: string | null) => {
    if (!path) return false;
    try {
      doc.registerFont(name, path);
      return true;
    } catch {
      return false;
    }
  };

  if (tryRegister("Body", regular)) {
    body = "Body";
    // CJK-capable file names only. Arial/Segoe on Windows cannot encode Chinese.
    unicode = /simsun|noto|cjk|sourcehan|droid|wqy|uming|hei/i.test(regular || "");
  }
  if (tryRegister("Heading", bold)) {
    heading = "Heading";
  } else if (body === "Body") {
    heading = body;
  }
  return { body, heading, unicode };
}

/** Helvetica cannot encode CJK — strip/replace so Vercel Linux never crashes mid-draw. */
function safeText(value: unknown, unicode: boolean) {
  const text = String(value ?? "");
  if (unicode) return text;
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

function logoPath() {
  const p = join(__dirname, "assets", "logo.jpeg");
  return existsSync(p) ? p : null;
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  fonts: { body: string; heading: string; unicode: boolean },
  title: string,
  metaLines: string[]
) {
  const logo = logoPath();
  const top = doc.y;
  if (logo) {
    try {
      doc.image(logo, doc.page.margins.left, top, { width: 64, height: 64, fit: [64, 64] });
    } catch {
      // ignore image errors (missing/corrupt logo must not crash the function)
    }
  }
  const textX = doc.page.margins.left + (logo ? 78 : 0);
  const rightWidth = doc.page.width - doc.page.margins.right - textX;
  doc
    .font(fonts.heading)
    .fontSize(14)
    .fillColor(INK)
    .text(safeText(title, fonts.unicode), textX, top, {
      width: rightWidth,
      align: "right",
    });
  doc.font(fonts.body).fontSize(9).fillColor(MUTED);
  metaLines.forEach((line) => {
    doc.text(safeText(line, fonts.unicode), textX, doc.y, { width: rightWidth, align: "right" });
  });
  const after = Math.max(doc.y, top + 68);
  doc.y = after + 8;
  doc.rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, 8).fill(GREEN);
  doc.y += 18;
  doc.fillColor(INK);
}

function ensureSpace(doc: PDFKit.PDFDocument, need: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) {
    doc.addPage();
  }
}

function sectionTitle(doc: PDFKit.PDFDocument, fonts: { heading: string; unicode: boolean }, title: string) {
  ensureSpace(doc, 28);
  doc.moveDown(0.4);
  doc.font(fonts.heading).fontSize(11).fillColor(GREEN).text(safeText(title, fonts.unicode));
  doc.moveDown(0.25);
  doc.fillColor(INK);
}

function kvTable(
  doc: PDFKit.PDFDocument,
  fonts: { body: string; heading: string; unicode: boolean },
  rows: [string, string][]
) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelW = width * 0.36;
  const valueW = width - labelW;
  const pad = 6;

  rows.forEach(([label, value]) => {
    const labelText = safeText(label || "", fonts.unicode);
    const valueText = safeText(value || "—", fonts.unicode);
    doc.font(fonts.heading).fontSize(9);
    const hLabel = doc.heightOfString(labelText, { width: labelW - pad * 2 });
    doc.font(fonts.body).fontSize(9);
    const hValue = doc.heightOfString(valueText, { width: valueW - pad * 2 });
    const h = Math.max(hLabel, hValue) + pad * 2;
    ensureSpace(doc, h + 2);
    const y = doc.y;
    doc.rect(left, y, labelW, h).stroke(LINE);
    doc.rect(left + labelW, y, valueW, h).stroke(LINE);
    doc.font(fonts.heading).fontSize(9).fillColor(INK).text(labelText, left + pad, y + pad, {
      width: labelW - pad * 2,
    });
    doc.font(fonts.body).fontSize(9).fillColor(INK).text(valueText, left + labelW + pad, y + pad, {
      width: valueW - pad * 2,
    });
    doc.y = y + h;
  });
}

function simpleTable(
  doc: PDFKit.PDFDocument,
  fonts: { body: string; heading: string; unicode: boolean },
  headers: string[],
  rows: string[][],
  colWeights?: number[]
) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const weights = colWeights || headers.map(() => 1);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const cols = weights.map((w) => (w / totalW) * width);
  const pad = 5;

  const drawRow = (cells: string[], header: boolean) => {
    const safeCells = cells.map((c) => safeText(c || "", fonts.unicode));
    doc.font(header ? fonts.heading : fonts.body).fontSize(8.5);
    const heights = safeCells.map((c, i) => doc.heightOfString(c, { width: cols[i] - pad * 2 }));
    const h = Math.max(...heights, 12) + pad * 2;
    ensureSpace(doc, h + 2);
    const y = doc.y;
    let x = left;
    safeCells.forEach((cell, i) => {
      if (header) {
        doc.rect(x, y, cols[i], h).fillAndStroke("#e8f5ee", LINE);
      } else {
        doc.rect(x, y, cols[i], h).stroke(LINE);
      }
      doc
        .fillColor(INK)
        .font(header ? fonts.heading : fonts.body)
        .fontSize(8.5)
        .text(cell, x + pad, y + pad, { width: cols[i] - pad * 2 });
      x += cols[i];
    });
    doc.y = y + h;
  };

  drawRow(headers, true);
  rows.forEach((r) => drawRow(r, false));
}

export async function buildSoldPhonesPdf(opts: {
  shopName: string;
  lang: DocLang;
  from: string;
  to: string;
  rows: SoldPhoneRow[];
}): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: "A4", info: { Title: "Sold Phones Report", Author: opts.shopName } });
  const done = collectBuffers(doc);
  const fonts = registerFonts(doc, opts.lang);
  const isZh = opts.lang === "zh";
  const title = isZh ? "售出手机记录" : "Sold Phones Report";
  drawHeader(doc, fonts, title, [
    opts.shopName,
    `${isZh ? "期间" : "Period"}: ${opts.from || "—"} → ${opts.to || "—"}`,
  ]);
  doc
    .font(fonts.body)
    .fontSize(10)
    .fillColor(INK)
    .text(
      safeText(
        isZh
          ? "以下为售出手机记录，可用于对账、分享与打印。"
          : "Sold phones log — generated for print, share, and records.",
        fonts.unicode
      )
    );
  doc.moveDown(0.6);

  const headers = isZh
    ? ["#", "日期", "手机型号", "价格", "其他详情"]
    : ["#", "Date", "Phone type", "Price", "Details"];
  const tableRows = opts.rows.map((r, i) => [
    String(i + 1),
    r.date,
    r.phoneType,
    money(r.price),
    r.details || "—",
  ]);
  if (!tableRows.length) {
    tableRows.push(["—", "—", isZh ? "无记录" : "No records", "—", "—"]);
  }
  simpleTable(doc, fonts, headers, tableRows, [0.6, 1.2, 2, 1.2, 2.5]);
  const total = opts.rows.reduce((s, r) => s + (Number(r.price) || 0), 0);
  doc.moveDown(0.6);
  doc
    .font(fonts.heading)
    .fontSize(10)
    .text(
      safeText(
        `${isZh ? "合计" : "Total"}: ${money(total)} · ${opts.rows.length} ${isZh ? "台" : "phone(s)"}`,
        fonts.unicode
      )
    );
  doc.end();
  return done;
}

export async function buildSupplyPdf(opts: {
  shopName: string;
  lang: DocLang;
  from: string;
  to: string;
  rows: SupplyRow[];
}): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: "A4", info: { Title: "Supply Report", Author: opts.shopName } });
  const done = collectBuffers(doc);
  const fonts = registerFonts(doc, opts.lang);
  const isZh = opts.lang === "zh";
  const title = isZh ? "供货记录" : "Supply Report";
  drawHeader(doc, fonts, title, [
    opts.shopName,
    `${isZh ? "期间" : "Period"}: ${opts.from || "—"} → ${opts.to || "—"}`,
  ]);
  doc
    .font(fonts.body)
    .fontSize(10)
    .text(
      safeText(
        isZh ? "供货交接记录，可打印或分享。" : "Supply handoff log — ready to print or share.",
        fonts.unicode
      )
    );
  doc.moveDown(0.6);
  const headers = isZh
    ? ["#", "日期", "供货对象", "电话", "取走的手机", "价格"]
    : ["#", "Date", "Supplied to", "Phone", "Phone taken", "Price"];
  const tableRows = opts.rows.map((r, i) => [
    String(i + 1),
    r.date,
    r.suppliedTo,
    r.phoneNumber || "—",
    r.phoneTaken,
    money(r.priceGiven),
  ]);
  if (!tableRows.length) {
    tableRows.push(["—", "—", isZh ? "无记录" : "No records", "—", "—", "—"]);
  }
  simpleTable(doc, fonts, headers, tableRows, [0.5, 1.1, 1.6, 1.3, 1.6, 1.1]);
  const total = opts.rows.reduce((s, r) => s + (Number(r.priceGiven) || 0), 0);
  doc.moveDown(0.6);
  doc
    .font(fonts.heading)
    .fontSize(10)
    .text(
      safeText(
        `${isZh ? "合计" : "Total"}: ${money(total)} · ${opts.rows.length} ${isZh ? "笔" : "record(s)"}`,
        fonts.unicode
      )
    );
  doc.end();
  return done;
}

export async function buildPaymentPlanPdf(input: PaymentPlanDocInput, lang: DocLang = "en"): Promise<Buffer> {
  const doc = new PDFDocument({
    margin: 40,
    size: "A4",
    info: { Title: "Customer Payment Plan Agreement", Author: input.shopName },
  });
  const done = collectBuffers(doc);
  const fonts = registerFonts(doc, lang);
  const isZh = lang === "zh";
  const shop = input.shopName;
  const c = input.customer;
  const d = input.device;
  const p = input.plan;
  const depositPct = p.phoneValue > 0 ? Math.round((p.deposit / p.phoneValue) * 100) : 0;

  const t = isZh
    ? {
        title: "客户分期付款协议",
        intro: `本协议记录 ${shop} 向客户出售手机并按约定分期计划收款的内容。客户确认在领取设备前已理解并接受下列详情与条款。`,
        s1: "1. 客户资料",
        s2: "2. 手机 / 设备资料",
        s3: "3. 付款摘要",
        s4: "4. 约定付款日期",
        s5: "5. 条款与条件",
        s6: "6. 声明与签字",
        fullName: "客户全名",
        nationalId: "身份证 / 护照号",
        phone: "客户电话",
        residence: "现住址 / 位置",
        house: "房屋 / 小区 / 地标",
        altName: "备用联系人姓名",
        altPhone: "备用联系人电话",
        relation: "与客户关系",
        model: "手机型号",
        storage: "存储 / 颜色",
        imei1: "IMEI 1",
        imei2: "IMEI 2 / 序列号",
        accessories: "附带配件",
        condition: "交接时状况",
        phoneValue: "手机价值",
        deposit: "定金",
        balance: "应付余额",
        interestFree: "免息期",
        stage: "付款阶段",
        due: "约定付款日",
        amount: "应付 / 已付金额",
        receipt: "签字 / 收据号",
        finalDeadline: "最终结清截止日期",
        declare: "双方签字确认以上信息正确，并同意本协议所述付款条款。",
        customer: "客户",
        rep: `${shop} 代表`,
        name: "姓名",
        signature: "签字",
        stamp: "签字 / 盖章",
        date: "日期",
        months: "个月",
      }
    : {
        title: "CUSTOMER PAYMENT PLAN AGREEMENT",
        intro: `This Customer Payment Plan Agreement records the sale of a mobile phone by ${shop} to the Customer under an agreed payment plan. The Customer confirms the details and terms below are understood and accepted before taking possession of the device.`,
        s1: "1. CUSTOMER DETAILS",
        s2: "2. PHONE / DEVICE DETAILS",
        s3: "3. PAYMENT SUMMARY",
        s4: "4. AGREED PAYMENT DATES",
        s5: "5. TERMS AND CONDITIONS",
        s6: "6. DECLARATION AND SIGNATURES",
        fullName: "Full Customer Name",
        nationalId: "National ID / Passport No.",
        phone: "Customer Phone Number",
        residence: "Current Residence / Location",
        house: "House / Estate / Landmark",
        altName: "Alternative Contact Name",
        altPhone: "Alternative Contact Phone",
        relation: "Relationship to Customer",
        model: "Phone Model",
        storage: "Storage / Colour",
        imei1: "IMEI 1",
        imei2: "IMEI 2 / Serial No.",
        accessories: "Accessories Issued",
        condition: "Condition at Handover",
        phoneValue: "Phone Value",
        deposit: "Deposit",
        balance: "Balance Payable",
        interestFree: "Interest-Free Period",
        stage: "Payment Stage",
        due: "Agreed Payment Date",
        amount: "Amount Due / Paid",
        receipt: "Initials / Receipt No.",
        finalDeadline: "Final balance clearance deadline",
        declare: "By signing below, both parties confirm the information above is correct and agree to the payment terms.",
        customer: "CUSTOMER",
        rep: `${shop.toUpperCase()} REPRESENTATIVE`,
        name: "Name",
        signature: "Signature",
        stamp: "Signature / Stamp",
        date: "Date",
        months: "months",
      };

  drawHeader(doc, fonts, t.title, [
    `${isZh ? "协议编号" : "Agreement No."}: ${input.agreementNo}`,
    `${isZh ? "协议日期" : "Agreement Date"}: ${input.agreementDate}`,
  ]);

  doc.font(fonts.body).fontSize(9.5).fillColor(INK).text(safeText(t.intro, fonts.unicode), { align: "justify" });
  doc.moveDown(0.4);

  sectionTitle(doc, fonts, t.s1);
  kvTable(doc, fonts, [
    [t.fullName, c.name],
    [t.nationalId, c.nationalId],
    [t.phone, c.phone],
    [t.residence, c.address],
    [t.house, c.house || ""],
    [t.altName, c.altContactName || ""],
    [t.altPhone, c.altContactPhone || ""],
    [t.relation, c.relationship || ""],
  ]);

  sectionTitle(doc, fonts, t.s2);
  kvTable(doc, fonts, [
    [t.model, d.model],
    [t.storage, d.storageColour || ""],
    [t.imei1, d.imei1],
    [t.imei2, d.imei2 || ""],
    [t.accessories, d.accessories || ""],
    [t.condition, d.condition || ""],
  ]);

  sectionTitle(doc, fonts, t.s3);
  simpleTable(
    doc,
    fonts,
    [
      t.phoneValue,
      `${t.deposit}${depositPct ? ` (${depositPct}%)` : ""}`,
      t.balance,
      t.interestFree,
    ],
    [
      [
        money(p.phoneValue),
        money(p.deposit),
        money(p.balance),
        `${p.interestFreeMonths} ${t.months}`,
      ],
    ],
    [1, 1, 1, 1]
  );

  sectionTitle(doc, fonts, t.s4);
  simpleTable(
    doc,
    fonts,
    [t.stage, t.due, t.amount, t.receipt],
    p.schedule.map((s) => [s.stage, s.date || "—", money(s.amount), ""]),
    [1.6, 1.2, 1.2, 1.2]
  );
  doc.moveDown(0.3);
  doc
    .font(fonts.body)
    .fontSize(9)
    .text(safeText(`${t.finalDeadline}: ${p.finalDeadline || "—"}`, fonts.unicode));

  const lateInterest = p.lateInterest || 3000;
  const terms = isZh
    ? [
        `1. 客户同意按本协议分期计划购买价值 ${money(p.phoneValue)} 的设备。`,
        `2. 客户须支付定金 ${money(p.deposit)}${depositPct ? `（约 ${depositPct}%）` : ""}。`,
        `3. 剩余余额 ${money(p.balance)} 须在 ${p.interestFreeMonths} 个月内结清。`,
        `4. 在约定免息期内结清余额的，不收取利息。`,
        `5. 超过免息期后，每月未结清余额加收逾期利息 ${money(lateInterest)}，直至付清。`,
        `6. 客户须提供准确住址及可联系的备用联系人。`,
        `7. 如预计无法按时付款，客户应尽早与商家沟通。`,
        `8. 所有付款须有收据、书面确认或移动支付凭证。`,
        `9. 客户确认交接时设备详情与本协议一致。`,
        `10. 本协议经双方签字后生效。`,
      ]
    : [
        `1. The Customer agrees to purchase the device valued at ${money(p.phoneValue)} under this payment plan.`,
        `2. The Customer shall pay a deposit of ${money(p.deposit)}${depositPct ? ` (${depositPct}% of phone value)` : ""}.`,
        `3. The remaining balance of ${money(p.balance)} shall be cleared within ${p.interestFreeMonths} month(s).`,
        `4. No interest is charged during the interest-free period if the balance is cleared on time.`,
        `5. After the interest-free period, a late interest of ${money(lateInterest)} applies for every uncleared month.`,
        `6. The Customer shall provide accurate residence details and an alternative contact.`,
        `7. The Customer agrees to communicate early if payment may be delayed.`,
        `8. All payments must be recorded by receipt, written confirmation, or mobile-money proof.`,
        `9. The Customer confirms device details listed above are correct at handover.`,
        `10. This Agreement is valid once signed by both parties.`,
      ];

  sectionTitle(doc, fonts, t.s5);
  terms.forEach((line) => {
    ensureSpace(doc, 18);
    doc.font(fonts.body).fontSize(9).fillColor(INK).text(safeText(line, fonts.unicode), { align: "left" });
    doc.moveDown(0.15);
  });

  sectionTitle(doc, fonts, t.s6);
  doc.font(fonts.body).fontSize(9).text(safeText(t.declare, fonts.unicode));
  doc.moveDown(0.5);

  ensureSpace(doc, 110);
  const boxW = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 12) / 2;
  const boxY = doc.y;
  const leftX = doc.page.margins.left;
  const rightX = leftX + boxW + 12;
  const boxH = 100;
  doc.rect(leftX, boxY, boxW, boxH).stroke(LINE);
  doc.rect(rightX, boxY, boxW, boxH).stroke(LINE);
  doc
    .font(fonts.heading)
    .fontSize(10)
    .fillColor(GREEN)
    .text(safeText(t.customer, fonts.unicode), leftX + 10, boxY + 10, { width: boxW - 20 });
  doc.font(fonts.body).fontSize(9).fillColor(INK);
  doc.text(safeText(`${t.name}: ${c.name || "________________"}`, fonts.unicode), leftX + 10, boxY + 32, {
    width: boxW - 20,
  });
  doc.text(safeText(`${t.signature}: ________________`, fonts.unicode), leftX + 10, boxY + 52, {
    width: boxW - 20,
  });
  doc.text(safeText(`${t.date}: ____ / ____ / ________`, fonts.unicode), leftX + 10, boxY + 72, {
    width: boxW - 20,
  });

  doc
    .font(fonts.heading)
    .fontSize(10)
    .fillColor(GREEN)
    .text(safeText(t.rep, fonts.unicode), rightX + 10, boxY + 10, { width: boxW - 20 });
  doc.font(fonts.body).fontSize(9).fillColor(INK);
  doc.text(safeText(`${t.name}: ________________`, fonts.unicode), rightX + 10, boxY + 32, { width: boxW - 20 });
  doc.text(safeText(`${t.stamp}: ________________`, fonts.unicode), rightX + 10, boxY + 52, { width: boxW - 20 });
  doc.text(safeText(`${t.date}: ____ / ____ / ________`, fonts.unicode), rightX + 10, boxY + 72, {
    width: boxW - 20,
  });

  doc.y = boxY + boxH + 16;
  doc
    .font(fonts.body)
    .fontSize(8)
    .fillColor(MUTED)
    .text(safeText(`${shop} · ${t.title}`, fonts.unicode), { align: "center" });

  doc.end();
  return done;
}

export function pdfFilename(kind: string, lang: DocLang, id = "") {
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = id ? `-${id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}` : "";
  return `kismart-${kind}${suffix}-${lang}-${stamp}.pdf`;
}
