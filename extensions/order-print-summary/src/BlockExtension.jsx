/** @jsxImportSource preact */
import {render} from 'preact';
import {useState} from 'preact/hooks';
import {
  buildOrderExport,
  buildOrderSummary,
  displayProperties,
  paginate,
  serializeOrderExport,
  splitPreviewProducts,
} from './order-summary.js';

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

const PAGE_SIZE = 5;

function PropertyItem({property}) {
  if (property.isFile) {
    return (
      <s-link href={property.value} target="_blank">{property.label}</s-link>
    );
  }
  return (
    <s-stack direction="inline" gap="small-500" alignItems="center">
      <s-text type="strong">{property.label}:</s-text>
      <s-text>{property.value}</s-text>
    </s-stack>
  );
}

function PropertyLine({properties}) {
  if (!properties.length) return null;
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
      {properties.map((property, index) => (
        <s-stack
          key={`${property.key}-${property.value}`}
          direction="inline"
          gap="small-200"
          alignItems="center"
        >
          {index > 0 ? <s-text color="subdued">·</s-text> : null}
          <PropertyItem property={property} />
        </s-stack>
      ))}
    </s-stack>
  );
}

function ProductCard({product}) {
  const properties = displayProperties(product);
  const files = properties.filter((property) => property.isFile);
  const details = properties.filter((property) => !property.isFile);

  return (
    <s-box paddingBlock="small-300" paddingInline="small" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-stack direction="inline" gap="small-300" alignItems="center" wrap>
          <s-text type="strong">{product.title}</s-text>
          <s-badge tone="info">×{product.quantity}</s-badge>
          {product.sku ? <s-text color="subdued">SKU {product.sku}</s-text> : null}
        </s-stack>
        <PropertyLine properties={details} />
        <PropertyLine properties={files} />
      </s-stack>
    </s-box>
  );
}

function PreviewsCard({previews}) {
  return (
    <s-box paddingBlock="small-300" paddingInline="small" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">Anteprime di stampa</s-text>
          <s-badge>{previews.length}</s-badge>
        </s-stack>
        {previews.map((preview) => (
          <s-stack key={preview.id} direction="inline" gap="small-200" alignItems="center" wrap>
            <s-text>{preview.target || 'Prodotto non indicato'}</s-text>
            {Number(preview.quantity) > 1 ? <s-text color="subdued">×{preview.quantity}</s-text> : null}
            <s-text color="subdued">—</s-text>
            {preview.files.length ? (
              <PropertyLine properties={[...preview.details, ...preview.files]} />
            ) : (
              <s-text color="subdued">nessun file</s-text>
            )}
          </s-stack>
        ))}
      </s-stack>
    </s-box>
  );
}

function Pager({pagination, onChange}) {
  if (pagination.pageCount < 2) return null;
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
      <s-button
        variant="tertiary"
        disabled={pagination.page === 0}
        onClick={() => onChange(pagination.page - 1)}
      >
        ‹ Precedenti
      </s-button>
      <s-text color="subdued">
        Articoli {pagination.start + 1}–{pagination.end} di {pagination.total}
      </s-text>
      <s-button
        variant="tertiary"
        disabled={pagination.page >= pagination.pageCount - 1}
        onClick={() => onChange(pagination.page + 1)}
      >
        Successivi ›
      </s-button>
    </s-stack>
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
  const {items, previews} = splitPreviewProducts(summary.products);
  const pagination = paginate(items, page, PAGE_SIZE);
  const isLastPage = pagination.page >= pagination.pageCount - 1;
  const fileCount = summary.products.reduce(
    (total, product) => total + product.properties.filter((property) => property.isFile).length,
    0,
  );
  const jsonDownload = downloadData(order, 'json');
  const xmlDownload = downloadData(order, 'xml');
  const collapsedParts = [`${items.length} prodotti`];
  if (previews.length) collapsedParts.push(`${previews.length} anteprime`);
  collapsedParts.push(`${fileCount} file`);

  return (
    <s-admin-block
      heading="Riepilogo produzione e file"
      collapsedSummary={collapsedParts.join(' · ')}
    >
      <s-stack direction="block" gap="small-300">
        {summary.products.length ? null : (
          <s-text color="subdued">Nessuna proprietà personalizzata trovata in questo ordine.</s-text>
        )}
        <Pager pagination={pagination} onChange={setPage} />
        {pagination.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
        {isLastPage && previews.length ? <PreviewsCard previews={previews} /> : null}
        {isLastPage && summary.general.length ? (
          <>
            <s-divider />
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Informazioni generali del bundle</s-text>
              <PropertyLine properties={summary.general} />
            </s-stack>
          </>
        ) : null}
        <s-divider />
        <s-stack direction="inline" gap="small-300" wrap>
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
