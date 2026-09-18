const FILE_URL_PATTERN = /^https?:\/\//i;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function visibleAttributes(attributes) {
  return (attributes || []).filter((attribute) => {
    return attribute && attribute.key && attribute.value && attribute.key.charAt(0) !== '_';
  });
}

function cleanPropertyLabel(key, productTitle) {
  let label = String(key || '').trim();
  const title = String(productTitle || '').trim();
  const normalizedLabel = normalize(label);
  const normalizedTitle = normalize(title);
  const isFile = /^file\b/i.test(label);

  if (isFile) label = label.replace(/^file\s*/i, '');

  if (normalizedTitle && normalize(label).includes(normalizedTitle)) {
    const words = title.split(/\s+/).filter(Boolean);
    const titlePattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    label = label.replace(new RegExp(titlePattern, 'i'), '');
  }

  label = label
    .replace(/^[\s·:()\-–—]+/, '')
    .replace(/[\s·:()\-–—]+$/, '')
    .replace(/_(\d+)$/, ' $1')
    .replace(/\s+/g, ' ')
    .trim();

  if (isFile) return label ? `File ${label}` : 'File';
  return label || (normalizedLabel ? key : 'Dettaglio');
}

function findOwner(key, products) {
  const normalizedKey = normalize(key);
  return products
    .filter((product) => normalizedKey.includes(normalize(product.title)))
    .sort((a, b) => normalize(b.title).length - normalize(a.title).length)[0] || null;
}

function appendProperty(target, attribute, productTitle) {
  if (!target || !attribute) return;
  const signature = `${attribute.key}::${attribute.value}`;
  if (target.signatures.has(signature)) return;
  target.signatures.add(signature);
  target.properties.push({
    key: attribute.key,
    label: cleanPropertyLabel(attribute.key, productTitle),
    value: attribute.value,
    isFile: FILE_URL_PATTERN.test(String(attribute.value).trim()),
  });
}

function quantityFromVariantTitle(variantTitle) {
  const match = String(variantTitle || '').match(/^\s*(\d+)\s*\//);
  return match ? match[1] : null;
}

function parseManualProductTitle(value) {
  const parts = String(value || '').split(/\s+-\s+/).map((part) => part.trim());
  if (parts.length < 3 || !/^\d+$/.test(parts[2]) || parts.some((part) => !part)) {
    return null;
  }

  const [sku, title, quantity, ...details] = parts;
  let properties = [];

  // Keep supporting the original six-position apparel format.
  if (details.length === 3 && !details[0].includes(':') && !details[1].includes(':')) {
    const [color, printPosition, rawSizes] = details;
    properties = [
      {key: 'Colore', value: color},
      {key: 'Posizione stampa', value: printPosition},
      {key: 'Taglie', value: cleanSizes(rawSizes)},
    ];
  } else {
    properties = details.map((detail) => {
      const separator = detail.indexOf(':');
      if (separator < 1 || separator === detail.length - 1) return null;

      const key = detail.slice(0, separator).trim();
      const rawValue = detail.slice(separator + 1).trim();
      const value = /^tagli[ae]$/i.test(key) ? cleanSizes(rawValue) : rawValue;
      return {key, value};
    });
    if (properties.some((property) => !property)) return null;
  }

  return {sku, title, quantity, properties};
}

function cleanSizes(value) {
  return String(value || '')
    .replace(/;+$/, '')
    .split(';')
    .map((size) => size.trim())
    .filter(Boolean)
    .join('; ');
}

export function buildOrderSummary(order) {
  const lines = order?.lineItems?.nodes || [];
  const products = lines.map((line) => {
    const manualProduct = parseManualProductTitle(line.title || line.name);
    const product = {
      id: line.id,
      title: manualProduct?.title || line.title || line.name || 'Prodotto',
      quantity: manualProduct?.quantity || quantityFromVariantTitle(line.variantTitle) || line.quantity || 1,
      sku: manualProduct?.sku || line.sku || '',
      groupId: line.lineItemGroup?.id || '',
      properties: [],
      signatures: new Set(),
    };

    if (manualProduct) {
      manualProduct.properties.forEach((property) => {
        appendProperty(product, property, product.title);
      });
    }

    return product;
  });
  const general = {properties: [], signatures: new Set()};

  lines.forEach((line, index) => {
    visibleAttributes(line.customAttributes).forEach((attribute) => {
      const owner = findOwner(attribute.key, products) || products[index];
      appendProperty(owner, attribute, owner?.title);
    });
  });

  const processedGroups = new Set();
  lines.forEach((line) => {
    const group = line.lineItemGroup;
    if (!group || processedGroups.has(group.id)) return;
    processedGroups.add(group.id);
    const groupProducts = products.filter((product) => product.groupId === group.id);

    visibleAttributes(group.customAttributes).forEach((attribute) => {
      const owner = findOwner(attribute.key, groupProducts);
      if (owner) appendProperty(owner, attribute, owner.title);
      else appendProperty(general, attribute, '');
    });
  });

  products.forEach((product) => {
    const variantQuantity = product.properties.find((property) => {
      return normalize(property.label) === 'quantita';
    });
    if (variantQuantity) product.quantity = variantQuantity.value;
  });

  return {
    orderName: order?.name || 'Ordine',
    products: products.filter((product, index) => {
      const line = lines[index];
      return product.properties.length > 0 || Boolean(parseManualProductTitle(line?.title || line?.name));
    }),
    general: general.properties,
  };
}

function exportProperty(property) {
  return {
    key: property.key,
    label: property.label,
    value: property.value,
    type: property.isFile ? 'file' : 'text',
  };
}

function exportProduct(product) {
  return {
    id: product.id,
    title: product.title,
    sku: product.sku || null,
    quantity: product.quantity,
    properties: product.properties.map(exportProperty),
  };
}

export function buildOrderExport(order, exportedAt = new Date().toISOString()) {
  const summary = buildOrderSummary(order);

  return {
    schemaVersion: 1,
    exportedAt,
    order: {
      id: order?.id || null,
      name: order?.name || 'Ordine',
      createdAt: order?.createdAt || null,
      updatedAt: order?.updatedAt || null,
      email: order?.email || null,
      phone: order?.phone || null,
      note: order?.note || null,
      tags: order?.tags || [],
      currencyCode: order?.currencyCode || null,
      financialStatus: order?.displayFinancialStatus || null,
      fulfillmentStatus: order?.displayFulfillmentStatus || null,
      totals: {
        subtotal: order?.subtotalPriceSet?.shopMoney || null,
        shipping: order?.totalShippingPriceSet?.shopMoney || null,
        tax: order?.totalTaxSet?.shopMoney || null,
        discounts: order?.totalDiscountsSet?.shopMoney || null,
        total: order?.totalPriceSet?.shopMoney || null,
      },
      customer: order?.customer || null,
      billingAddress: order?.billingAddress || null,
      shippingAddress: order?.shippingAddress || null,
      shippingLines: order?.shippingLines?.nodes || [],
    },
    productionSummary: {
      products: summary.products.map(exportProduct),
      general: summary.general.map(exportProperty),
    },
    shopifyLineItems: order?.lineItems?.nodes || [],
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlTagName(key) {
  const cleaned = String(key || 'item').replace(/[^A-Za-z0-9_.-]/g, '-');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `field-${cleaned}`;
}

function xmlNode(key, value, indentation = '') {
  const tag = xmlTagName(key);

  if (value === null || value === undefined) {
    return `${indentation}<${tag}/>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indentation}<${tag}/>`;
    const children = value.map((item) => xmlNode('item', item, `${indentation}  `)).join('\n');
    return `${indentation}<${tag}>\n${children}\n${indentation}</${tag}>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return `${indentation}<${tag}/>`;
    const children = entries
      .map(([childKey, childValue]) => xmlNode(childKey, childValue, `${indentation}  `))
      .join('\n');
    return `${indentation}<${tag}>\n${children}\n${indentation}</${tag}>`;
  }

  return `${indentation}<${tag}>${escapeXml(value)}</${tag}>`;
}

export function serializeOrderExport(orderExport, format) {
  if (format === 'json') return `${JSON.stringify(orderExport, null, 2)}\n`;
  if (format === 'xml') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlNode('wowstampaOrderExport', orderExport)}\n`;
  }
  throw new Error(`Formato di esportazione non supportato: ${format}`);
}
