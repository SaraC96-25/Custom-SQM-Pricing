/** @jsxImportSource preact */
import {render} from 'preact';
import {buildOrderSummary} from './order-summary.js';

const ORDER_QUERY = `#graphql
  query OrderPrintSummary($id: ID!) {
    order(id: $id) {
      name
      lineItems(first: 250) {
        nodes {
          id
          title
          name
          quantity
          sku
          customAttributes {
            key
            value
          }
          lineItemGroup {
            id
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  }
`;

export default async () => {
  try {
    const orderId = shopify.data.selected?.[0]?.id;
    if (!orderId) throw new Error('Ordine non disponibile.');

    const response = await fetch('shopify:admin/api/graphql.json', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: ORDER_QUERY, variables: {id: orderId}}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Errore Shopify (${response.status}).`);
    if (result.errors?.length) throw new Error(result.errors[0].message);
    if (!result.data?.order) throw new Error('Ordine non trovato.');

    render(<Extension summary={buildOrderSummary(result.data.order)} />, document.body);
  } catch (loadError) {
    render(
      <s-admin-block heading="Riepilogo produzione e file">
        <s-banner tone="critical">
          {loadError?.message || 'Impossibile leggere i dettagli dell’ordine.'}
        </s-banner>
      </s-admin-block>,
      document.body,
    );
  }
};

function PropertyRow({property}) {
  return (
    <s-stack direction="inline" gap="small" alignItems="center" wrap>
      <s-text type="strong">{property.label}:</s-text>
      {property.isFile ? (
        <s-link href={property.value} target="_blank">Apri file</s-link>
      ) : (
        <s-text>{property.value}</s-text>
      )}
    </s-stack>
  );
}

function ProductCard({product}) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center" wrap>
          <s-heading>{product.title}</s-heading>
          <s-badge tone="info">Quantità {product.quantity}</s-badge>
        </s-stack>
        {product.sku ? <s-text color="subdued">SKU: {product.sku}</s-text> : null}
        {product.properties.map((property) => (
          <PropertyRow key={`${property.key}-${property.value}`} property={property} />
        ))}
      </s-stack>
    </s-box>
  );
}

function Extension({summary}) {
  const fileCount = summary.products.reduce(
    (total, product) => total + product.properties.filter((property) => property.isFile).length,
    0,
  );

  return (
    <s-admin-block
      heading="Riepilogo produzione e file"
      collapsedSummary={`${summary.products.length} prodotti · ${fileCount} file`}
    >
      <s-stack direction="block" gap="base">
        {summary.products.length ? summary.products.map((product) => (
          <ProductCard key={product.id} product={product} />
        )) : (
          <s-text color="subdued">Nessuna proprietà personalizzata trovata in questo ordine.</s-text>
        )}
        {summary.general.length ? (
          <>
            <s-divider />
            <s-stack direction="block" gap="small">
              <s-heading>Informazioni generali del bundle</s-heading>
              {summary.general.map((property) => (
                <PropertyRow key={`${property.key}-${property.value}`} property={property} />
              ))}
            </s-stack>
          </>
        ) : null}
      </s-stack>
    </s-admin-block>
  );
}
