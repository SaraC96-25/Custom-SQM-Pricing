import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrderExport,
  buildOrderSummary,
  serializeOrderExport,
} from '../src/order-summary.js';

test('separates bundle properties and keeps file URLs clickable', () => {
  const sharedAttributes = [
    {key: 'T-shirt Economy UNISEX · Posizione stampa', value: 'Lato Cuore + Retro'},
    {key: 'T-shirt Economy UNISEX · Colore', value: 'Royal'},
    {key: 'T-shirt Economy UNISEX · Quantità', value: '4'},
    {key: 'T-shirt Economy UNISEX · Taglia', value: 'S:1, M:1, XL:2'},
    {key: 'Gilet UNISEX · Posizione stampa', value: 'Lato Cuore'},
    {key: 'Gilet UNISEX · Colore', value: 'Nero'},
    {key: 'File T-shirt Economy UNISEX - Lato Cuore_1', value: 'https://upload.cloudlift.app/tshirt.pdf'},
    {key: 'File Gilet UNISEX - Lato Cuore_1', value: 'https://upload.cloudlift.app/gilet.pdf'},
    {key: 'Modalità invio file', value: 'Carico i file adesso'},
    {key: '_ws_line_uid', value: 'hidden'},
  ];
  const group = {id: 'gid://shopify/LineItemGroup/1', customAttributes: sharedAttributes};
  const order = {
    name: '#1001',
    lineItems: {
      nodes: [
        {id: 'line-1', title: 'T-shirt Economy UNISEX', variantTitle: '10 / Lato Cuore + Retro', quantity: 1, sku: 'GL3000', customAttributes: [], lineItemGroup: group},
        {id: 'line-2', title: 'Gilet UNISEX', variantTitle: '10 / Fronte', quantity: 1, sku: 'GILET', customAttributes: [], lineItemGroup: group},
      ],
    },
  };

  const summary = buildOrderSummary(order);
  const tshirt = summary.products.find((product) => product.title === 'T-shirt Economy UNISEX');
  const gilet = summary.products.find((product) => product.title === 'Gilet UNISEX');

  assert.deepEqual(tshirt.properties.map((property) => property.label), [
    'Posizione stampa',
    'Colore',
    'Quantità',
    'Taglia',
    'File Lato Cuore 1',
  ]);
  assert.equal(tshirt.quantity, '4');
  assert.equal(tshirt.properties.at(-1).isFile, true);
  assert.deepEqual(gilet.properties.map((property) => property.label), [
    'Posizione stampa',
    'Colore',
    'File Lato Cuore 1',
  ]);
  assert.equal(gilet.quantity, '10');
  assert.deepEqual(summary.general.map((property) => property.label), ['Modalità invio file']);
});

test('uses Shopify line quantity when the variant title has no quantity prefix', () => {
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [{
        id: 'line-1',
        title: 'Prodotto semplice',
        variantTitle: 'Default Title',
        quantity: 3,
        customAttributes: [{key: 'Colore', value: 'Nero'}],
      }],
    },
  });

  assert.equal(summary.products[0].quantity, 3);
});

test('merges print preview lines into their related products', () => {
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [
        {
          id: 'product-line-1',
          title: 'Striscioni FORMATI PROMO',
          variantTitle: 'Default Title',
          quantity: 1,
          sku: 'STR-PROMO',
          customAttributes: [],
        },
        {
          id: 'preview-line-1',
          title: 'Anteprima di Stampa',
          quantity: 1,
          customAttributes: [
            {key: 'prodotto', value: 'Striscioni FORMATI PROMO'},
            {key: 'File Fronte_1', value: 'https://upload.example/preview.pdf'},
          ],
        },
        {
          id: 'product-line-2',
          title: 'Striscioni Standard',
          variantTitle: 'Default Title',
          quantity: 2,
          sku: 'STR-STD',
          customAttributes: [{key: 'Altezza (cm)', value: '50'}],
        },
      ],
    },
  });

  assert.deepEqual(summary.products.map((product) => product.title), [
    'Striscioni FORMATI PROMO',
    'Striscioni Standard',
  ]);
  assert.deepEqual(summary.products[0].properties.map(({label, value, isFile}) => ({
    label,
    value,
    isFile,
  })), [
    {label: 'Anteprima di Stampa', value: 'Sì, grazie', isFile: false},
    {label: 'File Fronte 1', value: 'https://upload.example/preview.pdf', isFile: true},
  ]);
});

test('deduplicates file attributes by URL and keeps the File-prefixed label', () => {
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [{
        id: 'line-1',
        title: 'Felpa girocollo UNISEX',
        quantity: 10,
        customAttributes: [
          {key: 'Lato Cuore_1', value: 'https://upload.example/cuore.pdf'},
          {key: 'File Lato Cuore_1', value: 'https://upload.example/cuore.pdf'},
          {key: 'File Retro_1', value: 'https://upload.example/retro.pdf'},
          {key: 'Retro_1', value: 'https://upload.example/retro.pdf'},
        ],
      }],
    },
  });

  assert.deepEqual(summary.products[0].properties.map(({label, value}) => ({label, value})), [
    {label: 'File Lato Cuore 1', value: 'https://upload.example/cuore.pdf'},
    {label: 'File Retro 1', value: 'https://upload.example/retro.pdf'},
  ]);
});

test('ignores stale bundle properties scoped to products not present in the bundle', () => {
  const group = {
    id: 'gid://shopify/LineItemGroup/pack-berretti',
    customAttributes: [
      {key: 'Berretti Invernali · Posizione stampa', value: 'Fronte'},
      {key: 'Berretti Invernali · Taglia', value: 'Unica'},
      {key: 'Berretti Invernali · Quantità', value: '20'},
      {key: '5 Caps + 5 Vests · Posizione stampa', value: 'Fronte'},
      {key: '5 Caps + 5 Vests · Taglia', value: 'Unica'},
      {key: '5 Caps + 5 Vests · Quantità', value: '20'},
      {key: 'Modalità invio file', value: 'Invio i file dopo'},
    ],
  };
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [
        {
          id: 'line-1',
          title: 'Berretti Invernali',
          variantTitle: '20 / Patch Fronte',
          quantity: 1,
          customAttributes: [],
          lineItemGroup: group,
        },
      ],
    },
  });

  assert.deepEqual(summary.products[0].properties.map(({label, value}) => ({label, value})), [
    {label: 'Posizione stampa', value: 'Fronte'},
    {label: 'Taglia', value: 'Unica'},
    {label: 'Quantità', value: '20'},
  ]);
  assert.deepEqual(summary.general.map(({label, value}) => ({label, value})), [
    {label: 'Modalità invio file', value: 'Invio i file dopo'},
  ]);
});

test('assigns generic bundle files using product, print position, and graphic references', () => {
  const group = {
    id: 'gid://shopify/LineItemGroup/wowpack',
    customAttributes: [
      {key: 'Felpa girocollo UNISEX · Posizione stampa', value: 'Lato Cuore'},
      {key: 'Felpa girocollo UNISEX · Pezzi_1', value: '10 x M Black'},
      {key: 'Felpa girocollo UNISEX · Grafica_1', value: '6 x M Black'},
      {key: 'Felpa girocollo UNISEX · Grafica_2', value: '4 x M Black'},
      {key: 'Berretti Invernali · Posizione stampa', value: 'Fronte'},
      {key: 'Berretti Invernali · Pezzi', value: '10 x Taglia Unica Nero'},
      {key: 'File Lato Cuore 1', value: 'https://upload.example/felpa-1.pdf'},
      {key: 'File BERRETTI Toppa Circolare - Fronte_1', value: 'https://upload.example/berretti.pdf'},
      {key: 'File Lato Cuore - Grafica 2_1', value: 'https://upload.example/felpa-2.pdf'},
    ],
  };
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [
        {id: 'felpa', title: 'Felpa girocollo UNISEX', quantity: 10, customAttributes: [], lineItemGroup: group},
        {id: 'berretti', title: 'Berretti Invernali', quantity: 10, customAttributes: [], lineItemGroup: group},
      ],
    },
  });

  const felpa = summary.products.find((product) => product.id === 'felpa');
  const berretti = summary.products.find((product) => product.id === 'berretti');
  assert.deepEqual(felpa.properties.filter((property) => property.isFile).map((property) => ({
    label: property.label,
    reference: property.reference,
  })), [
    {label: 'File Lato Cuore 1', reference: 'Grafica 1: 6 x M Black'},
    {label: 'File Lato Cuore - Grafica 2 1', reference: 'Grafica 2: 4 x M Black'},
  ]);
  assert.equal(felpa.properties.some((property) => property.label === 'Pezzi'), false);
  assert.deepEqual(berretti.properties.filter((property) => property.isFile).map((property) => ({
    label: property.label,
    reference: property.reference,
  })), [
    {label: 'File BERRETTI Toppa Circolare - Fronte 1', reference: 'Pezzi: 10 x Taglia Unica Nero'},
  ]);
  assert.equal(summary.general.length, 0);
});

test('parses a structured custom product title from a manual order', () => {
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [{
        id: 'custom-line-1',
        title: 'GL3000 - t-shirt unisex - 6 - nero - lato cuore - XL:2;M:1;S:3;',
        quantity: 1,
        customAttributes: [],
      }],
    },
  });

  assert.equal(summary.products.length, 1);
  assert.deepEqual(summary.products[0], {
    id: 'custom-line-1',
    title: 't-shirt unisex',
    quantity: '6',
    sku: 'GL3000',
    groupId: '',
    properties: [
      {key: 'Colore', label: 'Colore', value: 'nero', isFile: false},
      {key: 'Posizione stampa', label: 'Posizione stampa', value: 'lato cuore', isFile: false},
      {key: 'Taglie', label: 'Taglie', value: 'XL:2; M:1; S:3', isFile: false},
    ],
    signatures: new Set([
      'Colore::nero',
      'Posizione stampa::lato cuore',
      'Taglie::XL:2; M:1; S:3',
    ]),
  });
});

test('supports manual products with no details or named optional details', () => {
  const summary = buildOrderSummary({
    lineItems: {
      nodes: [
        {
          id: 'custom-line-1',
          title: 'GEN01 - Prodotto generico - 3',
          quantity: 1,
          customAttributes: [],
        },
        {
          id: 'custom-line-2',
          title: 'GL3000 - T-shirt unisex - 6 - Colore: nero',
          quantity: 1,
          customAttributes: [],
        },
        {
          id: 'custom-line-3',
          title: 'BANNER01 - Banner - 2 - Lavorazioni e rifiniture: Rinforzo ed Occhielli',
          quantity: 1,
          customAttributes: [],
        },
      ],
    },
  });

  assert.deepEqual(summary.products.map((product) => ({
    title: product.title,
    quantity: product.quantity,
    sku: product.sku,
    properties: product.properties.map(({label, value}) => ({label, value})),
  })), [
    {title: 'Prodotto generico', quantity: '3', sku: 'GEN01', properties: []},
    {
      title: 'T-shirt unisex',
      quantity: '6',
      sku: 'GL3000',
      properties: [{label: 'Colore', value: 'nero'}],
    },
    {
      title: 'Banner',
      quantity: '2',
      sku: 'BANNER01',
      properties: [{label: 'Lavorazioni e rifiniture', value: 'Rinforzo ed Occhielli'}],
    },
  ]);
});

test('exports the normalized production summary without internal bookkeeping', () => {
  const order = {
    id: 'gid://shopify/Order/123',
    name: '#WW1001',
    createdAt: '2026-09-18T10:00:00Z',
    currencyCode: 'EUR',
    totalPriceSet: {shopMoney: {amount: '79.00', currencyCode: 'EUR'}},
    lineItems: {
      nodes: [{
        id: 'line-1',
        title: 'T-shirt & Gilet',
        variantTitle: '10 / Fronte',
        quantity: 1,
        sku: 'KIT-01',
        customAttributes: [
          {key: 'Colore', value: 'Nero'},
          {key: 'File Fronte', value: 'https://upload.example/file?a=1&b=2'},
        ],
      }],
    },
  };

  const result = buildOrderExport(order, '2026-09-18T12:00:00Z');

  assert.equal(result.order.name, '#WW1001');
  assert.deepEqual(result.order.totals.total, {amount: '79.00', currencyCode: 'EUR'});
  assert.deepEqual(result.productionSummary.products[0], {
    id: 'line-1',
    title: 'T-shirt & Gilet',
    sku: 'KIT-01',
    quantity: '10',
    properties: [
      {key: 'Colore', label: 'Colore', value: 'Nero', type: 'text'},
      {
        key: 'File Fronte',
        label: 'File Fronte',
        value: 'https://upload.example/file?a=1&b=2',
        type: 'file',
        reference: 'Colore: Nero',
      },
    ],
  });
  assert.equal('signatures' in result.productionSummary.products[0], false);
});

test('serializes valid JSON and escapes reserved XML characters', () => {
  const orderExport = {
    schemaVersion: 1,
    order: {name: '#WW1001', note: 'Stampa <urgente> & controllo'},
    productionSummary: {products: [], general: []},
  };

  const json = serializeOrderExport(orderExport, 'json');
  const xml = serializeOrderExport(orderExport, 'xml');

  assert.deepEqual(JSON.parse(json), orderExport);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /Stampa &lt;urgente&gt; &amp; controllo/);
});
