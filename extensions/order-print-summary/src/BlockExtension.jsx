/** @jsxImportSource preact */
import {render} from 'preact';
import {useState} from 'preact/hooks';
import {
  buildOrderExport,
  buildOrderSummary,
  serializeOrderExport,
} from './order-summary.js';

const PRODUCTS_PER_PAGE = 2;

const ORDER_QUERY = `#graphql
  query OrderPrintSummary($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      updatedAt
      email
      phone
      note
      tags
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      subtotalPriceSet {
        shopMoney { amount currencyCode }
      }
      totalShippingPriceSet {
        shopMoney { amount currencyCode }
      }
      totalTaxSet {
        shopMoney { amount currencyCode }
      }
      totalDiscountsSet {
        shopMoney { amount currencyCode }
      }
      totalPriceSet {
        shopMoney { amount currencyCode }
      }
      billingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      shippingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        phone
      }
      shippingLines(first: 50) {
        nodes {
          title
          code
          source
          originalPriceSet {
            shopMoney { amount currencyCode }
          }
        }
      }
      lineItems(first: 250) {
        nodes {
          id
          title
          name
          quantity
          variantTitle
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

    const order = result.data.order;
    render(
      <Extension
        order={order}
        summary={buildOrderSummary(order)}
      />,
      document.body,
    );
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
    <s-stack direction="block" gap="small-100">
      <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
        <s-text type="strong">{property.label}:</s-text>
        {property.isFile ? (
          <s-link href={property.value} target="_blank">Apri file</s-link>
        ) : (
          <s-text>{property.value}</s-text>
        )}
      </s-stack>
      {property.isFile && property.reference ? (
        <s-text color="subdued">Riferito a: {property.reference}</s-text>
      ) : null}
    </s-stack>
  );
}

function ProductCard({product, itemNumber}) {
  const details = product.properties.filter((property) => !property.isFile);
  const files = product.properties.filter((property) => property.isFile);

  return (
    <s-box padding="small" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline">
          <s-badge tone="success">Articolo {itemNumber}</s-badge>
        </s-stack>
        <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
          <s-text type="strong">{product.title}</s-text>
          <s-badge tone="info">Quantità {product.quantity}</s-badge>
        </s-stack>
        <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small-200 small-100">
          {product.sku ? (
            <s-grid-item>
              <PropertyRow property={{label: 'SKU', value: product.sku, isFile: false}} />
            </s-grid-item>
          ) : null}
          {details.map((property) => (
            <s-grid-item key={`${property.key}-${property.value}`}>
              <PropertyRow property={property} />
            </s-grid-item>
          ))}
        </s-grid>
        {files.length ? (
          <s-grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="small-200 small-100">
            {files.map((property) => (
              <s-grid-item key={`${property.key}-${property.value}`}>
                <PropertyRow property={property} />
              </s-grid-item>
            ))}
          </s-grid>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function downloadData(order, format) {
  const content = serializeOrderExport(buildOrderExport(order), format);
  const mimeType = format === 'xml' ? 'application/xml' : 'application/json';
  const orderName = String(order?.name || 'ordine')
    .replace(/^#/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-');

  return {
    filename: `${orderName}-riepilogo.${format}`,
    href: `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`,
  };
}

function Extension({order, summary}) {
  const [page, setPage] = useState(0);
  const fileCount = summary.products.reduce(
    (total, product) => total + product.properties.filter((property) => property.isFile).length,
    0,
  );
  const jsonDownload = downloadData(order, 'json');
  const xmlDownload = downloadData(order, 'xml');
  const pageCount = Math.max(1, Math.ceil(summary.products.length / PRODUCTS_PER_PAGE));
  const pageStart = page * PRODUCTS_PER_PAGE;
  const visibleProducts = summary.products.slice(pageStart, pageStart + PRODUCTS_PER_PAGE);
  const isLastPage = page === pageCount - 1;

  return (
    <s-admin-block
      heading="Riepilogo produzione e file"
      collapsedSummary={`${summary.products.length} prodotti · ${fileCount} file`}
    >
      <s-stack direction="block" gap="small-200">
        {pageCount > 1 ? (
          <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
            <s-text color="subdued">
              Articoli {pageStart + 1}–{Math.min(pageStart + PRODUCTS_PER_PAGE, summary.products.length)} di {summary.products.length}
            </s-text>
            <s-button
              variant="secondary"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Precedenti
            </s-button>
            <s-button
              variant="secondary"
              disabled={isLastPage}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            >
              Successivi
            </s-button>
          </s-stack>
        ) : null}
        {summary.products.length ? visibleProducts.map((product, index) => (
          <ProductCard
            key={product.id}
            product={product}
            itemNumber={pageStart + index + 1}
          />
        )) : (
          <s-text color="subdued">Nessuna proprietà personalizzata trovata in questo ordine.</s-text>
        )}
        {isLastPage && summary.general.length ? (
          <>
            <s-divider />
            <s-stack direction="block" gap="small-200">
              <s-heading>Informazioni generali del bundle</s-heading>
              {summary.general.map((property) => (
                <PropertyRow key={`${property.key}-${property.value}`} property={property} />
              ))}
            </s-stack>
          </>
        ) : null}
        <s-divider />
        <s-stack direction="inline" gap="small-300" wrap>
          <s-button
            href="extension:stampa-ordine-produzione/admin.order-details.print-action.render"
            variant="primary"
          >
            Stampa ordine
          </s-button>
          <s-button
            href={jsonDownload.href}
            download={jsonDownload.filename}
            variant="secondary"
          >
            Scarica JSON
          </s-button>
          <s-button
            href={xmlDownload.href}
            download={xmlDownload.filename}
            variant="secondary"
          >
            Scarica XML
          </s-button>
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}
