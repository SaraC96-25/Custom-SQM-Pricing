import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
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
  render(<Extension />, document.body);
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

function Extension() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function loadOrder() {
      try {
        const orderId = shopify.data.selected?.[0]?.id;
        if (!orderId) throw new Error('Ordine non disponibile.');
        const response = await shopify.query(ORDER_QUERY, {variables: {id: orderId}});
        if (response.errors?.length) throw new Error(response.errors[0].message);
        if (!response.data?.order) throw new Error('Ordine non trovato.');
        if (active) setSummary(buildOrderSummary(response.data.order));
      } catch (loadError) {
        if (active) setError(loadError?.message || 'Impossibile leggere i dettagli dell’ordine.');
      }
    }

    loadOrder();
    return () => { active = false; };
  }, []);

  const fileCount = summary
    ? summary.products.reduce((total, product) => total + product.properties.filter((property) => property.isFile).length, 0)
    : 0;

  return (
    <s-admin-block
      heading="Riepilogo produzione e file"
      collapsedSummary={summary ? `${summary.products.length} prodotti · ${fileCount} file` : 'Caricamento'}
    >
      {error ? <s-banner tone="critical">{error}</s-banner> : null}
      {!summary && !error ? <s-spinner accessibilityLabel="Caricamento ordine" /> : null}
      {summary ? (
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
      ) : null}
    </s-admin-block>
  );
}
