import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useState} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const src = orderId
    ? `/print/order?orderId=${encodeURIComponent(orderId)}&timeline=${includeTimeline ? '1' : '0'}`
    : undefined;

  return (
    <s-admin-print-action src={src}>
      <s-stack direction="block" gap="base">
        <s-text type="strong">Stampa ordine di produzione</s-text>
        <s-text color="subdued">
          Il documento include il riepilogo semplificato degli articoli e i dati dell’ordine Shopify.
        </s-text>
        <s-checkbox
          name="include-timeline"
          checked={includeTimeline}
          onChange={(event) => {
            setIncludeTimeline(event.target.checked);
          }}
          label="Includi timeline"
        />
        {!orderId ? <s-banner tone="critical">Ordine non disponibile.</s-banner> : null}
      </s-stack>
    </s-admin-print-action>
  );
}
