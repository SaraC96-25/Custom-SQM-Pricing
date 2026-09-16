import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOrderSummary} from '../src/order-summary.js';

test('separates bundle properties and keeps file URLs clickable', () => {
  const sharedAttributes = [
    {key: 'T-shirt Economy UNISEX · Posizione stampa', value: 'Lato Cuore + Retro'},
    {key: 'T-shirt Economy UNISEX · Colore', value: 'Royal'},
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
        {id: 'line-1', title: 'T-shirt Economy UNISEX', quantity: 5, sku: 'GL3000', customAttributes: [], lineItemGroup: group},
        {id: 'line-2', title: 'Gilet UNISEX', quantity: 5, sku: 'GILET', customAttributes: [], lineItemGroup: group},
      ],
    },
  };

  const summary = buildOrderSummary(order);
  const tshirt = summary.products.find((product) => product.title === 'T-shirt Economy UNISEX');
  const gilet = summary.products.find((product) => product.title === 'Gilet UNISEX');

  assert.deepEqual(tshirt.properties.map((property) => property.label), [
    'Posizione stampa',
    'Colore',
    'Taglia',
    'File Lato Cuore 1',
  ]);
  assert.equal(tshirt.properties.at(-1).isFile, true);
  assert.deepEqual(gilet.properties.map((property) => property.label), [
    'Posizione stampa',
    'Colore',
    'File Lato Cuore 1',
  ]);
  assert.deepEqual(summary.general.map((property) => property.label), ['Modalità invio file']);
});
