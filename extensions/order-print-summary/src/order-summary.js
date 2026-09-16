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

export function buildOrderSummary(order) {
  const lines = order?.lineItems?.nodes || [];
  const products = lines.map((line) => ({
    id: line.id,
    title: line.title || line.name || 'Prodotto',
    quantity: quantityFromVariantTitle(line.variantTitle) || line.quantity || 1,
    sku: line.sku || '',
    groupId: line.lineItemGroup?.id || '',
    properties: [],
    signatures: new Set(),
  }));
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
    products: products.filter((product) => product.properties.length > 0),
    general: general.properties,
  };
}
