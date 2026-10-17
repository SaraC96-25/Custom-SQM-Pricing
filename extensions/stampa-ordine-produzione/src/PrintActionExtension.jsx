import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useState} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const printUrl = orderId
    ? `/print/order?orderId=${encodeURIComponent(orderId)}&timeline=${includeTimeline ? '1' : '0'}`
    : undefined;

  return (
    <s-admin-action heading="Stampa ordine di produzione">
      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          Apri il documento formattato in una nuova scheda e stampalo direttamente dal browser.
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
        <s-button
          variant="primary"
          href={printUrl}
          target="_blank"
          disabled={!orderId}
        >
          Apri pagina di stampa
        </s-button>
      </s-stack>
    </s-admin-action>
  );
}
