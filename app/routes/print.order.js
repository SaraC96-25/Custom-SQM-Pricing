import {authenticate} from "../shopify.server";
import prisma from "../db.server";
import {buildOrderSummary} from "../../extensions/order-print-summary/src/order-summary.js";

const ORDER_QUERY = `#graphql
  query PrintableOrder($id: ID!) {
    order(id: $id) {
      id name createdAt processedAt email phone note tags currencyCode
      displayFinancialStatus displayFulfillmentStatus paymentGatewayNames
      customAttributes { key value }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      netPaymentSet { shopMoney { amount currencyCode } }
      billingAddress { firstName lastName company address1 address2 city province zip country phone }
      shippingAddress { firstName lastName company address1 address2 city province zip country phone }
      customer { displayName email phone }
      shippingLines(first: 20) { nodes { title code originalPriceSet { shopMoney { amount currencyCode } } } }
      events(first: 40, reverse: true) { nodes { id createdAt message } }
      lineItems(first: 250) {
        nodes {
          id title name quantity variantTitle sku
          image { url altText }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          originalTotalSet { shopMoney { amount currencyCode } }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          discountedTotalSet { shopMoney { amount currencyCode } }
          customAttributes { key value }
          lineItemGroup { id customAttributes { key value } }
        }
      }
    }
  }
`;

export async function loader({request}) {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("document");
  if (documentId) {
    const document = await prisma.printDocument.findUnique({where: {id: documentId}});
    if (!document || document.expiresAt < new Date()) {
      return new Response("Documento scaduto. Riapri la stampa dall’ordine.", {status: 410});
    }
    try {
      return htmlResponse(renderOrderHtml(
        document.payload,
        url.searchParams.get("timeline") !== "0",
        url.searchParams.get("print") === "1",
      ));
    } catch (error) {
      console.error("Unable to render print document", error);
      return htmlResponse(renderPrintError(document.payload?.name), 500);
    }
  }

  const {admin, cors} = await authenticate.admin(request);
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return cors(new Response("Ordine non specificato.", {status: 400}));

  const response = await admin.graphql(ORDER_QUERY, {variables: {id: orderId}});
  const payload = await response.json();
  if (payload.errors?.length || !payload.data?.order) {
    return cors(new Response("Impossibile caricare l’ordine.", {status: 404}));
  }

  return cors(new Response(renderOrderHtml(
    payload.data.order,
    url.searchParams.get("timeline") !== "0",
    url.searchParams.get("print") === "1",
  ), {
    headers: {"Content-Type": "text/html; charset=utf-8"},
  }));
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, no-store",
    },
  });
}

function renderPrintError(orderName) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Stampa ordine</title></head>
    <body style="font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;color:#202223">
      <h1 style="font-size:20px">${escapeHtml(orderName || "Ordine")}</h1>
      <p>Non è stato possibile formattare questo ordine. Chiudi la finestra e riprova.</p>
    </body></html>`;
}

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

function money(value, currency = "EUR") {
  const amount = Number(value?.amount ?? value ?? 0);
  const code = value?.currencyCode || currency;
  return new Intl.NumberFormat("it-IT", {style: "currency", currency: code}).format(amount);
}

function dateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("it-IT", {dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Rome"}).format(new Date(value));
}

function addressHtml(address) {
  if (!address) return '<p class="muted">Non presente</p>';
  return [
    [address.firstName, address.lastName].filter(Boolean).join(" "), address.company,
    address.address1, address.address2,
    [address.zip, address.city, address.province].filter(Boolean).join(" "),
    address.country, address.phone,
  ].filter(Boolean).map((row) => `<div>${escapeHtml(row)}</div>`).join("");
}

function statusLabel(value, type) {
  const labels = {
    PENDING: "Pagamento in attesa", PAID: "Pagato", PARTIALLY_PAID: "Parzialmente pagato",
    REFUNDED: "Rimborsato", UNFULFILLED: "Inevaso", PARTIALLY_FULFILLED: "Parzialmente evaso",
    FULFILLED: "Evaso", ON_HOLD: "In sospeso",
  };
  return labels[value] || (type === "fulfillment" ? "Inevaso" : value || "Stato non disponibile");
}

function renderOrderHtml(order, includeTimeline = true, autoPrint = false) {
  const summary = buildOrderSummary(order);
  const summaryById = new Map(summary.products.map((product) => [product.id, product]));
  const lines = order.lineItems?.nodes || [];
  const products = lines.filter((line) => String(line.title || line.name).toLowerCase() !== "anteprima di stampa");
  const currency = order.currencyCode || "EUR";
  const shipping = order.shippingLines?.nodes?.[0];
  const customerName = order.customer?.displayName || [order.shippingAddress?.firstName, order.shippingAddress?.lastName].filter(Boolean).join(" ") || "Cliente";

  const productRows = products.map((line) => {
    const converted = summaryById.get(line.id);
    const details = converted?.properties?.filter((property) => !property.isFile) || [];
    const files = converted?.properties?.filter((property) => property.isFile) || [];
    const quantity = converted?.quantity || line.quantity;
    return `<article class="product">
      <div class="product-main">
        <div class="thumb">${line.image?.url ? `<img src="${escapeHtml(line.image.url)}" alt="">` : ""}</div>
        <div class="product-copy"><strong>${escapeHtml(converted?.title || line.title || line.name)}</strong>
          ${line.variantTitle && line.variantTitle !== "Default Title" ? `<div class="muted">${escapeHtml(line.variantTitle)}</div>` : ""}
          ${converted?.sku || line.sku ? `<div class="muted">SKU: ${escapeHtml(converted?.sku || line.sku)}</div>` : ""}
        </div>
        <div class="price">${money(line.discountedUnitPriceSet?.shopMoney || line.originalUnitPriceSet?.shopMoney, currency)} × ${escapeHtml(quantity)}<strong>${money(line.discountedTotalSet?.shopMoney || line.originalTotalSet?.shopMoney, currency)}</strong></div>
      </div>
      ${details.length ? `<div class="properties">${details.map((p) => `<div><b>${escapeHtml(p.label)}:</b> ${escapeHtml(p.value)}</div>`).join("")}</div>` : ""}
      ${files.length ? `<div class="files">${files.map((p) => `<div><b>${escapeHtml(p.label)}:</b> ${p.reference ? `${escapeHtml(p.reference)} · ` : ""}<span>File allegato</span></div>`).join("")}</div>` : ""}
    </article>`;
  }).join("");

  const timeline = includeTimeline ? (order.events?.nodes || []).map((event) => `
    <div class="event"><i></i><div><strong>${escapeHtml(event.message || "Aggiornamento ordine")}</strong><span>${escapeHtml(dateTime(event.createdAt))}</span></div></div>`).join("") : "";
  const extra = (order.customAttributes || []).filter((item) => item.key && item.value).map((item) => `<div><b>${escapeHtml(item.key)}:</b> ${escapeHtml(item.value)}</div>`).join("");

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${escapeHtml(order.name)} · WOWstampa</title><style>${PRINT_CSS}</style></head><body>
    <header><div><h1>${escapeHtml(order.name)}</h1><div class="badges"><span>${escapeHtml(statusLabel(order.displayFinancialStatus, "financial"))}</span><span>${escapeHtml(statusLabel(order.displayFulfillmentStatus, "fulfillment"))}</span></div><p>${escapeHtml(dateTime(order.processedAt || order.createdAt))} · Ordine online</p></div><div class="brand">WOW<span>stampa</span></div></header>
    <main><div class="primary">
      <section><h2>${escapeHtml(statusLabel(order.displayFulfillmentStatus, "fulfillment"))}</h2><div class="card fulfillment-head"><div><b>${escapeHtml(shipping?.title || "Spedizione")}</b><span>${escapeHtml(shipping?.code || "")}</span></div><div>Articoli ${products.length}</div></div><div class="card products">${productRows || '<p class="muted">Nessun articolo</p>'}</div></section>
      <section><h2>${escapeHtml(statusLabel(order.displayFinancialStatus, "financial"))}</h2><div class="card totals"><div><span>Subtotale</span><b>${money(order.subtotalPriceSet?.shopMoney, currency)}</b></div>${Number(order.totalDiscountsSet?.shopMoney?.amount) ? `<div><span>Sconti</span><b>−${money(order.totalDiscountsSet.shopMoney, currency)}</b></div>` : ""}<div><span>Spedizione</span><b>${money(order.totalShippingPriceSet?.shopMoney, currency)}</b></div><div><span>Imposte</span><b>${money(order.totalTaxSet?.shopMoney, currency)}</b></div><div class="total"><span>Totale</span><b>${money(order.totalPriceSet?.shopMoney, currency)}</b></div><div><span>Pagato dal cliente</span><b>${money(order.netPaymentSet?.shopMoney, currency)}</b></div></div></section>
      ${includeTimeline && timeline ? `<section><h2>Timeline</h2><div class="timeline">${timeline}</div></section>` : ""}
    </div><aside>
      <section><h3>Note</h3>${order.note ? `<p>${escapeHtml(order.note)}</p>` : '<p class="muted">Nessuna nota del cliente</p>'}</section>
      ${extra ? `<section><h3>Informazioni aggiuntive</h3><div class="aside-list">${extra}</div></section>` : ""}
      <section><h3>Cliente</h3><b>${escapeHtml(customerName)}</b>${order.email || order.customer?.email ? `<div>${escapeHtml(order.email || order.customer.email)}</div>` : ""}${order.phone || order.customer?.phone ? `<div>${escapeHtml(order.phone || order.customer.phone)}</div>` : ""}</section>
      <section><h3>Indirizzo di spedizione</h3>${addressHtml(order.shippingAddress)}</section>
      <section><h3>Indirizzo di fatturazione</h3>${addressHtml(order.billingAddress)}</section>
    </aside></main>
    ${autoPrint ? `<script>window.addEventListener("load",function(){window.setTimeout(function(){window.print()},250)})</script>` : ""}
  </body></html>`;
}

const PRINT_CSS = `
  @page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#202223;background:#fff;font:10px/1.38 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #dfe3e8;padding-bottom:12px;margin-bottom:14px}h1{font-size:21px;margin:0 0 7px}.badges{display:flex;gap:6px}.badges span{background:#e4e5e7;border-radius:12px;padding:3px 8px;font-weight:600}header p{color:#6d7175;margin:6px 0 0}.brand{font-size:20px;font-weight:900;color:#14a44d}.brand span{color:#202223;font-size:11px}main{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(150px,.85fr);gap:18px}section{break-inside:avoid;margin-bottom:15px}h2{font-size:14px;margin:0 0 7px}h3{font-size:12px;margin:0 0 7px}.card{border:1px solid #dfe3e8;border-radius:8px;background:#fff}.fulfillment-head{display:flex;justify-content:space-between;padding:8px 10px;margin-bottom:8px}.fulfillment-head span{display:block;color:#6d7175}.products{padding:0 10px}.product{padding:10px 0;border-bottom:1px solid #edf0f2;break-inside:avoid}.product:last-child{border-bottom:0}.product-main{display:grid;grid-template-columns:42px 1fr 125px;gap:8px;align-items:start}.thumb{width:40px;height:40px;border:1px solid #dfe3e8;border-radius:6px;overflow:hidden;background:#f6f6f7}.thumb img{width:100%;height:100%;object-fit:contain}.product-copy strong{font-size:10.5px}.muted{color:#6d7175}.price{text-align:right;white-space:nowrap}.price strong{display:block;margin-top:3px}.properties,.files{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;margin:7px 0 0 50px}.files{color:#454f5b}.files span{color:#087f5b}.totals{padding:10px 12px}.totals>div{display:flex;justify-content:space-between;padding:3px 0}.totals .total{border-top:1px solid #dfe3e8;margin-top:4px;padding-top:8px;font-size:12px}aside{border-left:1px solid #dfe3e8;padding-left:15px}aside section{padding-bottom:12px;border-bottom:1px solid #edf0f2}aside p{margin:0}.aside-list>div{margin-bottom:4px}.timeline{border-left:2px solid #dfe3e8;margin-left:4px;padding-left:13px}.event{position:relative;margin-bottom:9px}.event i{position:absolute;left:-18px;top:3px;width:8px;height:8px;border-radius:50%;background:#8c9196;border:2px solid #fff}.event strong,.event span{display:block}.event span{color:#6d7175;font-size:9px}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

export {renderOrderHtml};
