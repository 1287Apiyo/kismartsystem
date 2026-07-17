/**
 * Printable document generators for KISMART (HTML → browser print / share).
 * Supports English and Chinese for sales & supply reports.
 */

export type DocLang = "en" | "zh";

export interface SoldPhoneRow {
  id: string;
  date: string;
  phoneType: string;
  price: number;
  details: string;
  createdAt?: string;
}

export interface SupplyRow {
  id: string;
  date: string;
  suppliedTo: string;
  phoneNumber: string;
  phoneTaken: string;
  priceGiven: number;
  details?: string;
  createdAt?: string;
}

export interface PaymentPlanDocInput {
  shopName: string;
  logoUrl: string;
  agreementNo: string;
  agreementDate: string;
  customer: {
    name: string;
    nationalId: string;
    phone: string;
    address: string;
    house?: string;
    altContactName?: string;
    altContactPhone?: string;
    relationship?: string;
  };
  device: {
    model: string;
    storageColour?: string;
    imei1: string;
    imei2?: string;
    accessories?: string;
    condition?: string;
  };
  plan: {
    phoneValue: number;
    deposit: number;
    balance: number;
    interestFreeMonths: number;
    lateInterest: number;
    schedule: { stage: string; date: string; amount: number }[];
    finalDeadline: string;
  };
  termsExtra?: string[];
}

function money(n: number, lang: DocLang = "en") {
  const v = Number(n) || 0;
  const formatted = v.toLocaleString(lang === "zh" ? "zh-CN" : "en-KE");
  return lang === "zh" ? `KES ${formatted}` : `KES ${formatted}`;
}

function esc(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function docShell(title: string, body: string, lang: DocLang) {
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      color: #14201a;
      background: #eef2ef;
      line-height: 1.45;
    }
    .toolbar {
      position: sticky; top: 0; z-index: 5;
      display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #0d1f17; color: #fff;
    }
    .toolbar strong { font-weight: 650; }
    .toolbar .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .toolbar button, .toolbar a {
      appearance: none; border: 0; border-radius: 8px;
      padding: 9px 14px; font: inherit; font-weight: 650; cursor: pointer;
      text-decoration: none; color: #0d1f17; background: #fff;
    }
    .toolbar button.secondary, .toolbar a.secondary {
      background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.35);
    }
    .sheet {
      max-width: 900px; margin: 18px auto 40px;
      background: #fff; border: 1px solid #d5e0d9;
      border-radius: 12px; padding: 28px 30px 36px;
      box-shadow: 0 10px 30px rgba(13,31,23,.06);
    }
    .doc-head {
      display: flex; justify-content: space-between; gap: 18px; align-items: flex-start;
      margin-bottom: 14px;
    }
    .doc-head img { width: 92px; height: 92px; object-fit: contain; }
    .doc-head h1 {
      margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: .02em; text-align: right;
    }
    .meta { color: #5a6b62; font-size: 13px; text-align: right; margin-top: 6px; }
    .bar { height: 10px; background: #0d6b45; border-radius: 2px; margin: 14px 0 18px; }
    h2 {
      margin: 22px 0 10px; color: #0d6b45; font-size: 15px; letter-spacing: .04em;
      text-transform: none;
    }
    p.lead { margin: 0 0 14px; color: #2b3a33; font-size: 13.5px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid #c9d6ce; padding: 8px 10px; vertical-align: top; }
    th { background: #f4f7f5; text-align: left; font-weight: 650; color: #24342c; }
    td.label { width: 34%; background: #f8faf9; font-weight: 600; color: #24342c; }
    .summary th { background: #14201a; color: #fff; text-align: center; }
    .summary td { text-align: center; font-weight: 700; color: #0d6b45; font-size: 15px; }
    .schedule th { background: #e8f5ee; }
    .muted { color: #5a6b62; }
    .terms { margin: 0; padding-left: 18px; }
    .terms li { margin: 0 0 7px; font-size: 13px; }
    .sign {
      display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px;
    }
    .sign > div { border: 1px solid #c9d6ce; border-radius: 8px; padding: 12px 14px; min-height: 120px; }
    .sign h3 { margin: 0 0 12px; color: #0d6b45; font-size: 13px; letter-spacing: .04em; }
    .sign p { margin: 0 0 14px; font-size: 13px; }
    .footer {
      margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2eae5;
      text-align: center; color: #6b7c73; font-size: 11px;
    }
    .totals { margin-top: 12px; font-weight: 700; }
    @media print {
      body { background: #fff; }
      .toolbar { display: none !important; }
      .sheet {
        margin: 0; border: 0; border-radius: 0; box-shadow: none;
        max-width: none; padding: 12mm 14mm;
      }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>${esc(title)}</strong>
    <div class="actions">
      <button type="button" onclick="window.print()">Print / Save PDF</button>
      <button type="button" class="secondary" onclick="shareDoc()">Share</button>
      <a class="secondary" href="/admin">Back to admin</a>
    </div>
  </div>
  <div class="sheet" id="sheet">
    ${body}
  </div>
  <script>
    async function shareDoc() {
      const title = ${JSON.stringify(title)};
      const url = location.href;
      try {
        if (navigator.share) {
          await navigator.share({ title: title, url: url, text: title });
          return;
        }
      } catch (e) {}
      try {
        await navigator.clipboard.writeText(url);
        alert("Link copied. Open it on another device to print or share.");
      } catch (e) {
        prompt("Copy this link:", url);
      }
    }
  </script>
</body>
</html>`;
}

function logoBlock(logoUrl: string, shopName: string) {
  return `<img src="${esc(logoUrl)}" alt="${esc(shopName)}" width="92" height="92">`;
}

/** Daily / filtered sold phones report */
export function renderSoldPhonesDocument(opts: {
  shopName: string;
  logoUrl: string;
  lang: DocLang;
  from: string;
  to: string;
  rows: SoldPhoneRow[];
}) {
  const { shopName, logoUrl, lang, from, to, rows } = opts;
  const t =
    lang === "zh"
      ? {
          title: "售出手机记录",
          subtitle: "每日 / 筛选销售报表",
          period: "期间",
          date: "日期",
          type: "手机型号",
          price: "价格",
          details: "其他详情",
          total: "合计",
          empty: "此期间没有售出记录。",
          intro: "以下为 Kismart Global 售出手机记录，可用于对账、分享与打印。",
        }
      : {
          title: "Sold Phones Report",
          subtitle: "Daily / filtered sales log",
          period: "Period",
          date: "Date",
          type: "Phone type",
          price: "Price",
          details: "Other details",
          total: "Total",
          empty: "No sold phones in this period.",
          intro: "Sold phones log for Kismart Global — ready to print, save as PDF, or share.",
        };

  const total = rows.reduce((sum, r) => sum + (Number(r.price) || 0), 0);
  const tableRows = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.phoneType)}</td><td>${esc(money(r.price, lang))}</td><td>${esc(r.details || "—")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">${esc(t.empty)}</td></tr>`;

  const body = `
    <div class="doc-head">
      ${logoBlock(logoUrl, shopName)}
      <div>
        <h1>${esc(t.title)}</h1>
        <div class="meta">${esc(t.subtitle)}<br>${esc(shopName)}<br>${esc(t.period)}: ${esc(from || "—")} → ${esc(to || "—")}</div>
      </div>
    </div>
    <div class="bar"></div>
    <p class="lead">${esc(t.intro)}</p>
    <table>
      <thead>
        <tr><th>#</th><th>${esc(t.date)}</th><th>${esc(t.type)}</th><th>${esc(t.price)}</th><th>${esc(t.details)}</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p class="totals">${esc(t.total)}: ${esc(money(total, lang))} · ${rows.length} ${lang === "zh" ? "台" : "phone(s)"}</p>
    <div class="footer">${esc(shopName)} · ${esc(t.title)}</div>
  `;
  return docShell(`${t.title} · ${shopName}`, body, lang);
}

/** Supply / wholesale handoff report */
export function renderSupplyDocument(opts: {
  shopName: string;
  logoUrl: string;
  lang: DocLang;
  from: string;
  to: string;
  rows: SupplyRow[];
}) {
  const { shopName, logoUrl, lang, from, to, rows } = opts;
  const t =
    lang === "zh"
      ? {
          title: "供货记录",
          subtitle: "供货客户与手机交接",
          period: "期间",
          date: "日期",
          to: "供货对象",
          phone: "电话",
          device: "取走的手机",
          price: "成交价格",
          details: "备注",
          total: "合计",
          empty: "此期间没有供货记录。",
          intro: "以下为供货交接记录，可打印、导出 PDF 或分享。",
        }
      : {
          title: "Supply Report",
          subtitle: "Phones supplied to partners / resellers",
          period: "Period",
          date: "Date",
          to: "Supplied to",
          phone: "Phone number",
          device: "Phone taken",
          price: "Price given",
          details: "Notes",
          total: "Total",
          empty: "No supply records in this period.",
          intro: "Supply handoff log — ready to print, save as PDF, or share.",
        };

  const total = rows.reduce((sum, r) => sum + (Number(r.priceGiven) || 0), 0);
  const tableRows = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.suppliedTo)}</td><td>${esc(r.phoneNumber)}</td><td>${esc(r.phoneTaken)}</td><td>${esc(money(r.priceGiven, lang))}</td><td>${esc(r.details || "—")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="muted">${esc(t.empty)}</td></tr>`;

  const body = `
    <div class="doc-head">
      ${logoBlock(logoUrl, shopName)}
      <div>
        <h1>${esc(t.title)}</h1>
        <div class="meta">${esc(t.subtitle)}<br>${esc(shopName)}<br>${esc(t.period)}: ${esc(from || "—")} → ${esc(to || "—")}</div>
      </div>
    </div>
    <div class="bar"></div>
    <p class="lead">${esc(t.intro)}</p>
    <table>
      <thead>
        <tr><th>#</th><th>${esc(t.date)}</th><th>${esc(t.to)}</th><th>${esc(t.phone)}</th><th>${esc(t.device)}</th><th>${esc(t.price)}</th><th>${esc(t.details)}</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p class="totals">${esc(t.total)}: ${esc(money(total, lang))} · ${rows.length} ${lang === "zh" ? "笔" : "record(s)"}</p>
    <div class="footer">${esc(shopName)} · ${esc(t.title)}</div>
  `;
  return docShell(`${t.title} · ${shopName}`, body, lang);
}

/** Customer payment plan agreement — mirrors sample PDF structure */
export function renderPaymentPlanAgreement(input: PaymentPlanDocInput, lang: DocLang = "en") {
  const shop = input.shopName;
  const isZh = lang === "zh";
  const t = isZh
    ? {
        title: "客户分期付款协议",
        agreementNo: "协议编号",
        agreementDate: "协议日期",
        intro: `本《客户分期付款协议》（“协议”）记录 ${shop}（“商家”）向下方客户（“客户”）出售手机并按约定分期计划收款的内容。客户确认在领取设备前已理解并接受下列详情与条款。`,
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
        months: "个月",
        stage: "付款阶段",
        due: "约定付款日",
        amount: "应付 / 已付金额",
        receipt: "签字 / 收据号",
        depositStage: "签约时定金",
        monthN: (n: number) => `第 ${n} 期`,
        finalStage: "最后一期 / 结清",
        finalDeadline: "最终结清截止日期",
        finalNote: "免息期自约定开始/定金日起计算，除非双方另行约定。",
        declare: "双方签字确认以上信息正确，并同意本协议所述付款条款、付款日期及逾期利息约定。",
        customer: "客户",
        rep: `${shop} 代表`,
        name: "姓名",
        signature: "签字",
        stamp: "签字 / 盖章",
        date: "日期",
      }
    : {
        title: "CUSTOMER PAYMENT PLAN AGREEMENT",
        agreementNo: "Agreement No.",
        agreementDate: "Agreement Date",
        intro: `This Customer Payment Plan Agreement (the "Agreement") records the sale of a mobile phone by ${shop} (the "Shop") to the customer named below (the "Customer") under an agreed payment plan. The Customer confirms that the details and terms below are understood and accepted before taking possession of the device.`,
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
        months: "months",
        stage: "Payment Stage",
        due: "Agreed Payment Date",
        amount: "Amount Due / Paid",
        receipt: "Initials / Receipt No.",
        depositStage: "Deposit Paid on Signing",
        monthN: (n: number) => `Month ${n} Payment`,
        finalStage: "Final Clearance",
        finalDeadline: "Final balance clearance deadline",
        finalNote: "The interest-free period is counted from the agreed start/deposit date unless the parties write a different start date.",
        declare: "By signing below, both parties confirm that the information above is correct and that they agree to the payment terms, payment dates, and late-interest condition stated in this Agreement.",
        customer: "CUSTOMER",
        rep: `${shop.toUpperCase()} REPRESENTATIVE`,
        name: "Name",
        signature: "Signature",
        stamp: "Signature / Stamp",
        date: "Date",
      };

  const c = input.customer;
  const d = input.device;
  const p = input.plan;
  const depositPct = p.phoneValue > 0 ? Math.round((p.deposit / p.phoneValue) * 100) : 0;

  const row = (label: string, value: string) =>
    `<tr><td class="label">${esc(label)}</td><td>${esc(value || "—")}</td></tr>`;

  const scheduleRows = p.schedule
    .map(
      (s) =>
        `<tr><td>${esc(s.stage)}</td><td>${esc(s.date || "—")}</td><td>${esc(money(s.amount, lang))}</td><td></td></tr>`
    )
    .join("");

  const lateInterest = p.lateInterest || 3000;
  const terms = isZh
    ? [
        `客户同意按本协议分期计划购买价值 ${money(p.phoneValue, lang)} 的设备。`,
        `客户须在领取设备前或领取时支付定金 ${money(p.deposit, lang)}${depositPct ? `（约手机价值的 ${depositPct}%）` : ""}。`,
        `剩余余额 ${money(p.balance, lang)} 须在 ${p.interestFreeMonths} 个月内结清。`,
        `在约定免息期内结清余额的，不收取利息。`,
        `超过免息期后，每月未结清余额将加收逾期利息 ${money(lateInterest, lang)}，直至余额及利息全部付清。`,
        `客户须提供准确住址及可联系的备用联系人。`,
        `如预计无法按时付款，客户应尽早与商家沟通。`,
        `所有付款须以收据、书面确认、移动支付短信或商家认可的其他凭证记录。`,
        `客户确认交接时设备详情、状况及配件与本协议所列一致。`,
        `本协议经客户与商家代表双方签字后生效。`,
      ]
    : [
        `The Customer agrees to purchase the device valued at ${money(p.phoneValue)} under the payment plan stated in this Agreement.`,
        `The Customer shall pay a deposit of ${money(p.deposit)}${depositPct ? `, equal to ${depositPct}% of the phone value` : ""}, before or upon receiving the device.`,
        `The remaining balance of ${money(p.balance)} shall be cleared within ${p.interestFreeMonths} month(s) from the agreed payment start date.`,
        `No interest shall be charged during the interest-free period, provided the balance is cleared within the agreed period.`,
        `After the interest-free period, if any amount remains unpaid, a late interest charge of ${money(lateInterest)} shall be added for every uncleared month until the balance and any applicable interest are fully paid.`,
        `The Customer shall provide accurate residence details and an alternative contact who may be reached if the Customer is unavailable.`,
        `The Customer agrees to communicate early with the Shop if there is any expected delay in payment.`,
        `All payments must be recorded by receipt, written confirmation, mobile money message, or any other proof accepted by the Shop.`,
        `The Customer confirms that the device details, condition, and accessories listed above are correct at the time of handover.`,
        `This Agreement becomes valid once signed by both the Customer and the Shop representative.`,
      ];

  const body = `
    <div class="doc-head">
      ${logoBlock(input.logoUrl, shop)}
      <div>
        <h1>${esc(t.title)}</h1>
        <div class="meta">
          ${esc(t.agreementNo)}: ${esc(input.agreementNo)}<br>
          ${esc(t.agreementDate)}: ${esc(input.agreementDate)}
        </div>
      </div>
    </div>
    <div class="bar"></div>
    <p class="lead">${esc(t.intro)}</p>

    <h2>${esc(t.s1)}</h2>
    <table>
      ${row(t.fullName, c.name)}
      ${row(t.nationalId, c.nationalId)}
      ${row(t.phone, c.phone)}
      ${row(t.residence, c.address)}
      ${row(t.house, c.house || "")}
      ${row(t.altName, c.altContactName || "")}
      ${row(t.altPhone, c.altContactPhone || "")}
      ${row(t.relation, c.relationship || "")}
    </table>

    <h2>${esc(t.s2)}</h2>
    <table>
      ${row(t.model, d.model)}
      ${row(t.storage, d.storageColour || "")}
      ${row(t.imei1, d.imei1)}
      ${row(t.imei2, d.imei2 || "")}
      ${row(t.accessories, d.accessories || "")}
      ${row(t.condition, d.condition || "")}
    </table>

    <h2>${esc(t.s3)}</h2>
    <table class="summary">
      <thead>
        <tr>
          <th>${esc(t.phoneValue)}</th>
          <th>${esc(t.deposit)}${depositPct ? ` · ${depositPct}%` : ""}</th>
          <th>${esc(t.balance)}</th>
          <th>${esc(t.interestFree)}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(money(p.phoneValue, lang))}</td>
          <td>${esc(money(p.deposit, lang))}</td>
          <td>${esc(money(p.balance, lang))}</td>
          <td>${esc(String(p.interestFreeMonths))} ${esc(t.months)}</td>
        </tr>
      </tbody>
    </table>

    <h2>${esc(t.s4)}</h2>
    <table class="schedule">
      <thead>
        <tr>
          <th>${esc(t.stage)}</th>
          <th>${esc(t.due)}</th>
          <th>${esc(t.amount)}</th>
          <th>${esc(t.receipt)}</th>
        </tr>
      </thead>
      <tbody>${scheduleRows}</tbody>
    </table>
    <p class="lead" style="margin-top:12px"><strong>${esc(t.finalDeadline)}:</strong> ${esc(p.finalDeadline || "—")} — ${esc(t.finalNote)}</p>

    <h2>${esc(t.s5)}</h2>
    <ol class="terms">
      ${terms.map((line) => `<li>${esc(line)}</li>`).join("")}
    </ol>

    <h2>${esc(t.s6)}</h2>
    <p class="lead">${esc(t.declare)}</p>
    <div class="sign">
      <div>
        <h3>${esc(t.customer)}</h3>
        <p>${esc(t.name)}: ${esc(c.name)}</p>
        <p>${esc(t.signature)}: _______________________</p>
        <p>${esc(t.date)}: ____ / ____ / ________</p>
      </div>
      <div>
        <h3>${esc(t.rep)}</h3>
        <p>${esc(t.name)}: _______________________</p>
        <p>${esc(t.stamp)}: _______________________</p>
        <p>${esc(t.date)}: ____ / ____ / ________</p>
      </div>
    </div>
    <div class="footer">${esc(shop)} · ${esc(t.title)}</div>
  `;

  return docShell(`${t.title} · ${c.name || shop}`, body, lang);
}

export function buildPaymentScheduleLabels(
  lang: DocLang,
  deposit: number,
  installments: { dueDate: string; amount: number }[],
  interestFreeMonths: number
) {
  const isZh = lang === "zh";
  const rows: { stage: string; date: string; amount: number }[] = [
    {
      stage: isZh ? "签约时定金" : "Deposit Paid on Signing",
      date: installments[0]?.dueDate || "",
      amount: deposit,
    },
  ];
  installments.forEach((item, index) => {
    const n = index + 1;
    const isLast = n === installments.length;
    const stage = isLast
      ? isZh
        ? `第 ${n} 期 / 结清`
        : `Month ${n} / Final Clearance`
      : isZh
        ? `第 ${n} 期`
        : `Month ${n} Payment`;
    rows.push({ stage, date: item.dueDate, amount: item.amount });
  });
  // If empty installments, still show placeholder months for interest-free period
  if (!installments.length) {
    for (let n = 1; n <= Math.max(1, interestFreeMonths); n += 1) {
      const isLast = n === interestFreeMonths;
      rows.push({
        stage: isLast
          ? isZh
            ? `第 ${n} 期 / 结清`
            : `Month ${n} / Final Clearance`
          : isZh
            ? `第 ${n} 期`
            : `Month ${n} Payment`,
        date: "",
        amount: 0,
      });
    }
  }
  return rows;
}
