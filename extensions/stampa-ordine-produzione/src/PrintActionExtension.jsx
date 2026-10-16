import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

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
          id title name quantity variantTitle sku image { url altText }
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

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const [documentUrl, setDocumentUrl] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!orderId) return;
    let active = true;
    setDocumentUrl(null);
    setError('');

    (async () => {
      const orderResponse = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query: ORDER_QUERY, variables: {id: orderId}}),
      });
      const orderPayload = await orderResponse.json();
      if (orderPayload.errors?.length || !orderPayload.data?.order) {
        throw new Error(orderPayload.errors?.[0]?.message || 'Ordine non disponibile.');
      }

      const documentResponse = await fetch('/api/print-document', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(orderPayload.data.order),
      });
      const documentPayload = await documentResponse.json();
      if (!documentResponse.ok || !documentPayload.url) {
        throw new Error(documentPayload.error || 'Impossibile preparare il documento.');
      }
      if (active) setDocumentUrl(documentPayload.url);
    })().catch((loadError) => {
      if (active) setError(loadError?.message || 'Impossibile preparare la stampa.');
    });

    return () => { active = false; };
  }, [orderId]);

  const src = documentUrl
    ? `${documentUrl}&timeline=${includeTimeline ? '1' : '0'}`
    : null;

  return (
    <s-admin-print-action src={src}>
      <s-stack direction="block" gap="base">
        <s-text type="strong">Stampa ordine di produzione</s-text>
        <s-text color="subdued">
          Il documento include il riepilogo semplificato degli articoli e i dati dell’ordine Shopify.
        </s-text>
        {!documentUrl && !error ? <s-spinner accessibilityLabel="Preparazione documento" /> : null}
        <s-checkbox
          name="include-timeline"
          checked={includeTimeline}
          onChange={(event) => {
            setIncludeTimeline(event.target.checked);
          }}
          label="Includi timeline"
        />
        {!orderId || error ? <s-banner tone="critical">{error || 'Ordine non disponibile.'}</s-banner> : null}
      </s-stack>
    </s-admin-print-action>
  );
}
