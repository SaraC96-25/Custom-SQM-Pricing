import { useEffect, useMemo, useState } from "react";
import {
  Form,
  useFetcher,
  useLocation,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";

import type {
  PreviewProduct,
  PreviewProductsActionData,
  ProductCollectionOption,
} from "../features/preview-products.server";

type PreviewProductsPageProps = {
  products: PreviewProduct[];
  collectionOptions: ProductCollectionOption[];
  filters: {
    search: string;
    collectionId: string;
  };
  pagination: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
    pageSize: number;
  };
  isIndexRoute: boolean;
  setup: {
    definitionExists: boolean;
    missingMetafieldCount: number;
    missingProductIds: string[];
  };
};

type SummaryCardProps = {
  label: string;
  value: string;
  tone?: "success" | "subdued";
};

type ProductRowProps = {
  product: PreviewProduct;
  toggleAction: string;
  onOptimisticToggle: (id: string, nextEnabled: boolean) => void;
  onConfirmToggle: (id: string, enabled: boolean) => void;
  onRevertToggle: (id: string, previousEnabled: boolean) => void;
};

function SummaryCard({ label, value, tone = "subdued" }: SummaryCardProps) {
  return (
    <Card padding="400">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text
          as="p"
          variant="headingLg"
          tone={tone === "success" ? "success" : undefined}
        >
          {value}
        </Text>
      </BlockStack>
    </Card>
  );
}
function statusTone(status: string): "success" | "attention" | "critical" | "info" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "DRAFT":
      return "attention";
    case "ARCHIVED":
      return "critical";
    default:
      return "info";
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "ACTIVE":
      return "Prodotto attivo";
    case "DRAFT":
      return "Bozza";
    case "ARCHIVED":
      return "Archiviato";
    default:
      return status;
  }
}

function ProductRow({
  product,
  toggleAction,
  onOptimisticToggle,
  onConfirmToggle,
  onRevertToggle,
}: ProductRowProps) {
  const fetcher = useFetcher<PreviewProductsActionData>();
  const shopify = useAppBridge();
  const nextEnabled = !product.enabled;
  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    const actionResult = fetcher.data;

    if (!actionResult) return;

    if (actionResult.ok && actionResult.productId && typeof actionResult.enabled === "boolean") {
      onConfirmToggle(actionResult.productId, actionResult.enabled);
      shopify.toast.show("Stato prodotto salvato");
      return;
    }

    if (actionResult.productId && typeof actionResult.enabled === "boolean") {
      onRevertToggle(actionResult.productId, !actionResult.enabled);
    }

    shopify.toast.show(actionResult.error ?? "Errore durante il salvataggio", {
      isError: true,
    });
  }, [fetcher.data, onConfirmToggle, onRevertToggle, shopify]);

  return (
    <Card key={product.id} padding="400">
      <InlineStack align="space-between" blockAlign="center" gap="400">
        <InlineStack gap="400" blockAlign="center">
          <Thumbnail
            source={
              product.imageUrl ??
              "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            }
            alt={product.imageAlt ?? product.title}
            size="large"
          />

          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h4" variant="headingSm">
                {product.title}
              </Text>
              <Badge tone={statusTone(product.status)}>
                {statusLabel(product.status)}
              </Badge>
              <Badge tone={product.enabled ? "success" : "critical"}>
                {product.enabled ? "Anteprima attiva" : "Anteprima disattiva"}
              </Badge>
            </InlineStack>

            <Text as="p" variant="bodySm" tone="subdued">
              Handle Shopify: {product.handle}
            </Text>

            <Text as="p" variant="bodySm" tone="subdued">
              {product.enabled
                ? "Questo prodotto e gia pronto per mostrare l'anteprima di stampa."
                : "Attiva il pulsante per rendere disponibile l'anteprima su questo prodotto."}
            </Text>

            {isSaving ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Salvataggio in corso...
              </Text>
            ) : null}
          </BlockStack>
        </InlineStack>

        <div style={{ flexShrink: 0 }}>
          <fetcher.Form
            method="post"
            action={toggleAction}
            onSubmit={() => onOptimisticToggle(product.id, nextEnabled)}
          >
            <input type="hidden" name="productId" value={product.id} />
            <input type="hidden" name="enabled" value={String(nextEnabled)} />
            <Button
              submit
              variant={product.enabled ? "secondary" : "primary"}
              loading={isSaving}
              size="slim"
            >
              {product.enabled ? "Disattiva anteprima" : "Attiva anteprima"}
            </Button>
          </fetcher.Form>
        </div>
      </InlineStack>
    </Card>
  );
}

export function PreviewProductsPage({
  products,
  collectionOptions,
  filters,
  pagination,
  isIndexRoute,
  setup,
}: PreviewProductsPageProps) {
  const location = useLocation();
  const navigation = useNavigation();
  const setupFetcher = useFetcher<PreviewProductsActionData>();
  const shopify = useAppBridge();
  const [items, setItems] = useState(products);
  const [searchValue, setSearchValue] = useState(filters.search);
  const [collectionValue, setCollectionValue] = useState(filters.collectionId);

  useEffect(() => {
    setItems(products);
  }, [products]);

  useEffect(() => {
    setSearchValue(filters.search);
    setCollectionValue(filters.collectionId);
  }, [filters.collectionId, filters.search]);

  const isFiltering = navigation.state !== "idle";
  const enabledCount = items.filter((product) => product.enabled).length;
  const disabledCount = items.length - enabledCount;
  const isPreparingMetafields = setupFetcher.state !== "idle";

  const embeddedSearchParams = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("collectionId");
    params.delete("after");
    params.delete("before");
    params.delete("index");
    return params;
  }, [location.search]);

  const filterAction = useMemo(() => {
    const search = embeddedSearchParams.toString();
    return search ? `${location.pathname}?${search}` : location.pathname;
  }, [embeddedSearchParams, location.pathname]);

  const toggleAction = useMemo(() => {
    const params = new URLSearchParams(embeddedSearchParams);

    if (isIndexRoute) {
      params.set("index", "");
    }

    const search = params.toString();
    return search ? `${location.pathname}?${search}` : location.pathname;
  }, [embeddedSearchParams, isIndexRoute, location.pathname]);

  const paginationBaseParams = useMemo(() => {
    const params = new URLSearchParams(embeddedSearchParams);

    if (filters.search) {
      params.set("search", filters.search);
    }

    if (filters.collectionId && filters.collectionId !== "all") {
      params.set("collectionId", filters.collectionId);
    }

    return params;
  }, [embeddedSearchParams, filters.collectionId, filters.search]);

  const previousPageUrl = useMemo(() => {
    if (!pagination.hasPreviousPage || !pagination.startCursor) {
      return null;
    }

    const params = new URLSearchParams(paginationBaseParams);
    params.set("before", pagination.startCursor);

    const search = params.toString();
    return search ? `${location.pathname}?${search}` : location.pathname;
  }, [
    location.pathname,
    pagination.hasPreviousPage,
    pagination.startCursor,
    paginationBaseParams,
  ]);

  const nextPageUrl = useMemo(() => {
    if (!pagination.hasNextPage || !pagination.endCursor) {
      return null;
    }

    const params = new URLSearchParams(paginationBaseParams);
    params.set("after", pagination.endCursor);

    const search = params.toString();
    return search ? `${location.pathname}?${search}` : location.pathname;
  }, [
    location.pathname,
    pagination.endCursor,
    pagination.hasNextPage,
    paginationBaseParams,
  ]);

  const updateProductEnabled = (id: string, enabled: boolean) => {
    setItems((currentItems) =>
      currentItems.map((product) =>
        product.id === id
          ? { ...product, enabled, hasMetafield: true }
          : product,
      ),
    );
  };

  useEffect(() => {
    const actionResult = setupFetcher.data;

    if (!actionResult || actionResult.mode !== "setup") return;

    if (actionResult.ok) {
      shopify.toast.show(
        actionResult.initializedCount && actionResult.initializedCount > 0
          ? `Metafield inizializzati: ${actionResult.initializedCount}`
          : "Definizione metafield verificata",
      );
      return;
    }

    shopify.toast.show(
      actionResult.error ?? "Errore durante la preparazione del metafield",
      { isError: true },
    );
  }, [setupFetcher.data, shopify]);

  return (
    <Page
      title="Anteprima di stampa"
      subtitle="Trova rapidamente i prodotti giusti, controlla il loro stato Shopify e attiva l'anteprima solo dove serve."
    >
      <Layout>
        <Layout.Section>
          <Card padding="500">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="start">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">
                    Preparazione metafield
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Se vuoi, puoi inizializzare in un colpo solo il metafield
                    corretto sui prodotti visibili e verificare che la definizione
                    Shopify sia pronta.
                  </Text>
                </BlockStack>

                <Badge tone={setup.definitionExists ? "success" : "attention"}>
                  {setup.definitionExists
                    ? "Definizione pronta"
                    : "Definizione da creare"}
                </Badge>
              </InlineStack>

              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd">
                    Prodotti visibili senza metafield inizializzato:{" "}
                    <strong>{setup.missingMetafieldCount}</strong>
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Il pulsante crea la definizione se manca e imposta i metafield
                    mancanti a <code>false</code>, cosi poi puoi attivarli o
                    disattivarli liberamente.
                  </Text>
                </BlockStack>

                <setupFetcher.Form method="post" action={toggleAction}>
                  <input type="hidden" name="mode" value="setup" />
                  {setup.missingProductIds.map((productId) => (
                    <input
                      key={productId}
                      type="hidden"
                      name="productIds"
                      value={productId}
                    />
                  ))}
                  <Button submit loading={isPreparingMetafields} variant="primary">
                    Prepara metafield catalogo
                  </Button>
                </setupFetcher.Form>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box
              padding="600"
              background="bg-fill-secondary"
              borderBlockEndWidth="025"
              borderColor="border"
            >
              <BlockStack gap="300">
                <Badge tone="info">Gestione catalogo</Badge>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingLg">
                    Configura l&apos;anteprima prodotto con piu contesto
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Ogni riga mostra immagine, stato Shopify e stato della tua
                    funzione di anteprima. Puoi cercare per nome o limitare la
                    vista a una collezione specifica.
                  </Text>
                </BlockStack>
              </BlockStack>
            </Box>

            <Box padding="500">
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                <SummaryCard label="Prodotti visibili" value={String(items.length)} />
                <SummaryCard
                  label="Anteprima attiva"
                  value={String(enabledCount)}
                  tone="success"
                />
                <SummaryCard
                  label="Anteprima disattiva"
                  value={String(disabledCount)}
                />
              </InlineGrid>
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="500">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">
                    Cerca e filtra i prodotti
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Usa la ricerca per nome oppure filtra il catalogo per
                    collezione, cosi la configurazione resta veloce anche con
                    molti prodotti.
                  </Text>
                </BlockStack>

                <Badge tone="attention">
                  {`${enabledCount} attivi su ${items.length}`}
                </Badge>
              </InlineStack>

              <Form method="get" action={filterAction}>
                <InlineGrid columns={{ xs: 1, md: "2fr 1fr auto" }} gap="300">
                  <TextField
                    label="Cerca prodotto"
                    name="search"
                    autoComplete="off"
                    value={searchValue}
                    onChange={setSearchValue}
                    placeholder="Es. T-shirt personalizzata"
                    clearButton
                    onClearButtonClick={() => setSearchValue("")}
                  />

                  <Select
                    label="Collezione"
                    name="collectionId"
                    options={collectionOptions}
                    value={collectionValue}
                    onChange={setCollectionValue}
                  />

                  <Box paddingBlockStart="600">
                    <Button submit loading={isFiltering} variant="primary">
                      Applica filtri
                    </Button>
                  </Box>
                </InlineGrid>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="500">
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  Prodotti configurabili
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Ogni modifica viene salvata subito. Lo stato Shopify ti aiuta a
                  capire se il prodotto e attivo, in bozza o archiviato.
                </Text>
              </BlockStack>

              <Divider />

              {items.length === 0 ? (
                <EmptyState
                  heading="Nessun prodotto corrisponde ai filtri"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Prova a cambiare ricerca o collezione per trovare i prodotti
                    che vuoi configurare.
                  </p>
                </EmptyState>
              ) : (
                <BlockStack gap="300">
                  {items.map((product) => (
                    <ProductRow
                      key={product.id}
                      product={product}
                      toggleAction={toggleAction}
                      onOptimisticToggle={updateProductEnabled}
                      onConfirmToggle={updateProductEnabled}
                      onRevertToggle={updateProductEnabled}
                    />
                  ))}

                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`Pagina alleggerita: ${pagination.pageSize} prodotti massimi per richiesta Shopify.`}
                    </Text>

                    <InlineStack gap="200">
                      <Button url={previousPageUrl ?? undefined} disabled={!previousPageUrl}>
                        Pagina precedente
                      </Button>
                      <Button
                        url={nextPageUrl ?? undefined}
                        disabled={!nextPageUrl}
                        variant="primary"
                      >
                        Pagina successiva
                      </Button>
                    </InlineStack>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
