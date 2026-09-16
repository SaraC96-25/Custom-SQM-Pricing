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
    <s-stack direction="inline" gap="small-500" alignItems="center" wrap>
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
    <s-box padding="small" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-stack direction="inline" gap="small-300" alignItems="center" wrap>
          <s-heading>{product.title}</s-heading>
          <s-badge tone="info">Quantità {product.quantity}</s-badge>
        </s-stack>
        <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small-500 small-200">
          {product.sku ? (
            <s-grid-item>
              <PropertyRow property={{label: 'SKU', value: product.sku, isFile: false}} />
            </s-grid-item>
          ) : null}
          {product.properties.map((property) => (
            <s-grid-item key={`${property.key}-${property.value}`}>
              <PropertyRow property={property} />
            </s-grid-item>
          ))}
        </s-grid>
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
      <s-stack direction="block" gap="small-300">
        {summary.products.length ? summary.products.map((product) => (
          <ProductCard key={product.id} product={product} />
        )) : (
          <s-text color="subdued">Nessuna proprietà personalizzata trovata in questo ordine.</s-text>
        )}
        {summary.general.length ? (
          <>
            <s-divider />
            <s-stack direction="block" gap="small-500">
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
