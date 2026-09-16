import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOrderSummary} from '../src/order-summary.js';

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
