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

function isFileAttribute(attribute) {
  return FILE_URL_PATTERN.test(String(attribute?.value || '').trim());
}

const FILE_MATCH_STOP_WORDS = new Set([
  'file', 'grafica', 'stampa', 'posizione', 'taglia', 'taglie', 'colore',
  'pezzi', 'quantita', 'fronte', 'retro', 'lato', 'cuore', 'toppa',
]);

function meaningfulTokens(value) {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length > 2 && !/^\d+$/.test(token) && !FILE_MATCH_STOP_WORDS.has(token));
}

function findFileOwner(attribute, products) {
  const titleOwner = findOwner(attribute.key, products);
  if (titleOwner) return titleOwner;

  const normalizedKey = normalize(attribute.key);
  const keyTokens = new Set(meaningfulTokens(attribute.key));
  const ranked = products.map((product) => {
    let score = 0;

    meaningfulTokens(product.title).forEach((token) => {
      if (keyTokens.has(token)) score += 4;
    });

    product.properties.forEach((property) => {
      const label = normalize(property.label);
      const value = normalize(property.value);
      if (label.startsWith('grafica') && normalizedKey.includes(label)) score += 8;
      if (label === 'posizione stampa' && value && normalizedKey.includes(value)) score += 5;
    });

    return {product, score};
  }).sort((a, b) => b.score - a.score);

  if (!ranked[0]?.score || ranked[0].score === ranked[1]?.score) return null;
  return ranked[0].product;
}

function addFileReferences(products) {
  products.forEach((product) => {
    product.properties.forEach((property) => {
      if (!property.isFile) return;
      const normalizedKey = normalize(property.key);
      const explicitGraphic = normalizedKey.match(/\bgrafica\s+(\d+)\b/);
      const fileSequence = String(property.key || '').match(/(?:_|\s)(\d+)$/);
      const graphicNumber = explicitGraphic?.[1] || fileSequence?.[1] || '';
      const graphic = product.properties.find((candidate) => {
        const label = normalize(candidate.label);
        return !candidate.isFile && label === `grafica ${graphicNumber}`;
      });
      const pieces = product.properties.find((candidate) => {
        return !candidate.isFile && normalize(candidate.label) === 'pezzi';
      });

      if (graphic) {
        property.reference = `${graphic.label}: ${graphic.value}`;
        return;
      }
      if (pieces) {
        property.reference = `${pieces.label}: ${pieces.value}`;
        return;
      }

      const context = product.properties
        .filter((candidate) => {
          const label = normalize(candidate.label);
          return !candidate.isFile && ['quantita', 'taglia', 'taglie', 'colore'].includes(label);
        })
        .map((candidate) => `${candidate.label}: ${candidate.value}`);
      if (context.length) property.reference = context.join(' · ');
    });

    const hasGraphicBreakdown = product.properties.some((property) => {
      return !property.isFile && /^grafica\s+\d+$/.test(normalize(property.label));
    });
    if (hasGraphicBreakdown) {
      product.properties = product.properties.filter((property) => {
        return property.isFile || !/^pezzi(?:\s+\d+)?$/.test(normalize(property.label));
      });
    }
  });
}

function hasProductScopedPrefix(key) {
  const prefix = String(key || '').split('·')[0]?.trim() || '';
  return Boolean(prefix && prefix !== String(key || '').trim());
}

function isPrintPreviewLine(line) {
  return normalize(line?.title || line?.name) === 'anteprima di stampa';
}

function isPreviewProductAttribute(attribute) {
  const key = normalize(attribute?.key);
  return key === 'prodotto' || key === 'product' || key === 'prodotto collegato';
}

function findPreviewOwner(productReference, products) {
  const reference = normalize(productReference);
  if (!reference) return null;

  return products
    .filter((product) => {
      const title = normalize(product.title);
      return title === reference || title.includes(reference) || reference.includes(title);
    })
    .sort((a, b) => {
      const exactA = normalize(a.title) === reference ? 1 : 0;
      const exactB = normalize(b.title) === reference ? 1 : 0;
      return exactB - exactA || normalize(b.title).length - normalize(a.title).length;
    })[0] || null;
}

function appendProperty(target, attribute, productTitle) {
  if (!target || !attribute) return;
  const value = String(attribute.value || '').trim();
  const isFile = FILE_URL_PATTERN.test(value);
  const property = {
    key: attribute.key,
    label: cleanPropertyLabel(attribute.key, productTitle),
    value: attribute.value,
    isFile,
  };

  if (isFile) {
    const duplicateIndex = target.properties.findIndex((existing) => {
      return existing.isFile && String(existing.value).trim() === value;
    });

    if (duplicateIndex >= 0) {
      const existing = target.properties[duplicateIndex];
      const newLabelHasFilePrefix = /^file\b/i.test(String(attribute.key).trim());
      const existingLabelHasFilePrefix = /^file\b/i.test(String(existing.key).trim());
      if (newLabelHasFilePrefix && !existingLabelHasFilePrefix) {
        target.properties[duplicateIndex] = property;
      }
      return;
    }
  }

  const signature = `${attribute.key}::${attribute.value}`;
  if (target.signatures.has(signature)) return;
  target.signatures.add(signature);
  target.properties.push(property);
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

// SKU that depend on a product option rather than on the Shopify variant.
// Add a row here for other products with the same need.
const OPTION_SKU_RULES = [
  {
    product: 'berretti invernali',
    option: 'forma toppa',
    skus: {circolare: 'B446', rettangolare: 'B445'},
  },
];

function applyOptionSku(product) {
  const title = normalize(product.title);
  OPTION_SKU_RULES.forEach((rule) => {
    if (!title.includes(rule.product)) return;
    const option = product.properties.find((property) => {
      return !property.isFile && normalize(property.label) === rule.option;
    });
    const sku = option && rule.skus[normalize(option.value)];
    if (sku) product.sku = sku;
  });
}

export function buildOrderSummary(order) {
  const lines = order?.lineItems?.nodes || [];
  const previewLineIndexes = new Set(
    lines.map((line, index) => isPrintPreviewLine(line) ? index : -1).filter((index) => index >= 0),
  );
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
    if (previewLineIndexes.has(index)) return;
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
    const groupProducts = products.filter((product, index) => {
      return product.groupId === group.id && !previewLineIndexes.has(index);
    });

    const groupAttributes = visibleAttributes(group.customAttributes);
    const orderedAttributes = [
      ...groupAttributes.filter((attribute) => !isFileAttribute(attribute)),
      ...groupAttributes.filter(isFileAttribute),
    ];

    orderedAttributes.forEach((attribute) => {
      const owner = isFileAttribute(attribute)
        ? findFileOwner(attribute, groupProducts)
        : findOwner(attribute.key, groupProducts);
      if (owner) appendProperty(owner, attribute, owner.title);
      else if (hasProductScopedPrefix(attribute.key)) return;
      else appendProperty(general, attribute, '');
    });
  });

  products.forEach((product) => {
    const variantQuantity = product.properties.find((property) => {
      return normalize(property.label) === 'quantita';
    });
    if (variantQuantity) product.quantity = variantQuantity.value;
  });

  products.forEach(applyOptionSku);

  previewLineIndexes.forEach((index) => {
    const line = lines[index];
    const attributes = visibleAttributes(line.customAttributes);
    const productAttribute = attributes.find(isPreviewProductAttribute);
    const regularProducts = products.filter((product, productIndex) => !previewLineIndexes.has(productIndex));
    let owner = findPreviewOwner(productAttribute?.value, regularProducts);

    if (!owner && line.lineItemGroup?.id) {
      const groupProducts = regularProducts.filter((product) => product.groupId === line.lineItemGroup.id);
      if (groupProducts.length === 1) owner = groupProducts[0];
    }

    if (!owner) {
      owner = products[index];
      owner.title = productAttribute?.value || 'Prodotto con anteprima di stampa';
    }

    appendProperty(owner, {key: 'Anteprima di Stampa', value: 'Sì, grazie'}, owner.title);
    attributes
      .filter((attribute) => !isPreviewProductAttribute(attribute))
      .forEach((attribute) => appendProperty(owner, attribute, owner.title));
  });

  addFileReferences(products);

  return {
    orderName: order?.name || 'Ordine',
    products: products.filter((product, index) => {
      const line = lines[index];
      if (previewLineIndexes.has(index) && normalize(product.title) === 'anteprima di stampa') return false;
      return product.properties.length > 0 || Boolean(parseManualProductTitle(line?.title || line?.name));
    }),
    general: general.properties,
  };
}

function exportProperty(property) {
  const exported = {
    key: property.key,
    label: property.label,
    value: property.value,
    type: property.isFile ? 'file' : 'text',
  };
  if (property.reference) exported.reference = property.reference;
  return exported;
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
