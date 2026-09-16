import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

const PREVIEW_METAFIELD_NAMESPACE = "$app";
const PREVIEW_METAFIELD_KEY = "preview_enabled";
const PREVIEW_METAFIELD_TYPE = "boolean";
const THEME_PREVIEW_METAFIELD_NAMESPACE = "wowstampa";
const THEME_PREVIEW_METAFIELD_KEY = "preview_enabled";
const THEME_PREVIEW_METAFIELD_TYPE = "boolean";
const ALL_COLLECTIONS_VALUE = "all";
const PRODUCTS_PAGE_SIZE = 24;
const METAFIELDS_SET_BATCH_SIZE = 24;

export type PreviewProduct = {
  id: string;
  title: string;
  enabled: boolean;
  hasMetafield: boolean;
  themeEnabled: boolean;
  hasThemeMetafield: boolean;
  status: string;
  imageUrl: string | null;
  imageAlt: string | null;
  handle: string;
  collections: Array<{
    id: string;
    title: string;
  }>;
};

export type ProductCollectionOption = {
  label: string;
  value: string;
};

export type PreviewProductsLoaderData = {
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
  setup: {
    definitionExists: boolean;
    missingMetafieldCount: number;
    missingProductIds: string[];
  };
};

export type PreviewProductsActionData = {
  ok: boolean;
  mode?: "toggle" | "setup";
  productId?: string;
  enabled?: boolean;
  error?: string;
  initializedCount?: number;
  definitionCreated?: boolean;
};

type ProductsQueryResponse = {
  data?: {
    products: ProductConnection;
  };
  errors?: Array<{
    message: string;
  }>;
};

type CollectionsQueryResponse = {
  data?: {
    collections: {
      edges: Array<{
        node: {
          id: string;
          title: string;
        };
      }>;
    };
  };
  errors?: Array<{
    message: string;
  }>;
};

type CollectionProductsQueryResponse = {
  data?: {
    collection: {
      products: ProductConnection;
    } | null;
  };
  errors?: Array<{
    message: string;
  }>;
};

type ProductConnection = {
  edges: ProductEdge[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
};

type ProductEdge = {
  cursor: string;
  node: {
    id: string;
    title: string;
    handle: string;
    status: string;
    collections: {
      edges: Array<{
        node: {
          id: string;
          title: string;
        };
      }>;
    };
    featuredImage: {
      url: string;
      altText: string | null;
    } | null;
    previewEnabled: {
      value: string;
    } | null;
    themePreviewEnabled: {
      value: string;
    } | null;
  };
};

type CollectionEdge = NonNullable<CollectionsQueryResponse["data"]>["collections"]["edges"][number];

type MetafieldsSetResponse = {
  data?: {
    metafieldsSet?: {
      userErrors: Array<{
        message: string;
      }>;
    };
  };
};

type MetafieldDefinitionQueryResponse = {
  data: {
    metafieldDefinition: {
      id: string;
    } | null;
  };
};

type MetafieldDefinitionCreateResponse = {
  data?: {
    metafieldDefinitionCreate?: {
      createdDefinition?: {
        id: string;
      } | null;
      userErrors: Array<{
        message: string;
      }>;
    };
  };
};

type ProductMetafieldsNodesQueryResponse = {
  data?: {
    nodes: Array<
      | {
          id: string;
          previewEnabled: {
            value: string;
          } | null;
          themePreviewEnabled: {
            value: string;
          } | null;
        }
      | null
    >;
  };
  errors?: Array<{
    message: string;
  }>;
};

type PreviewDefinitionResult =
  | {
      ok: true;
      created: boolean;
    }
  | {
      ok: false;
      error: string;
    };

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

async function setPreviewMetafields(
  admin: AdminGraphqlClient,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
) {
  for (let index = 0; index < metafields.length; index += METAFIELDS_SET_BATCH_SIZE) {
    const response = await admin.graphql(
      `#graphql
        mutation SetPreviewProductMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              message
            }
          }
        }
      `,
      {
        variables: {
          metafields: metafields.slice(index, index + METAFIELDS_SET_BATCH_SIZE),
        },
      },
    );

    const data = (await response.json()) as MetafieldsSetResponse;
    const userErrors = data.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      return userErrors[0]?.message ?? "Shopify non ha salvato i metafield.";
    }
  }

  return null;
}

function normalizeCollectionId(rawValue: string | null) {
  return rawValue && rawValue.length > 0 ? rawValue : ALL_COLLECTIONS_VALUE;
}

function normalizeCursor(rawValue: string | null) {
  return rawValue && rawValue.length > 0 ? rawValue : null;
}

function buildPaginationVariables(after: string | null, before: string | null) {
  if (before) {
    return {
      first: null,
      after: null,
      last: PRODUCTS_PAGE_SIZE,
      before,
    };
  }

  return {
    first: PRODUCTS_PAGE_SIZE,
    after,
    last: null,
    before: null,
  };
}

function buildProductsSearchQuery(rawSearch: string) {
  const normalizedTerms = rawSearch
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => term.replace(/["\\]/g, ""));

  if (normalizedTerms.length === 0) {
    return null;
  }

  return normalizedTerms
    .map((term) => `(title:*${term}* OR handle:*${term}*)`)
    .join(" AND ");
}

async function ensurePreviewMetafieldDefinition(
  admin: AdminGraphqlClient,
): Promise<PreviewDefinitionResult> {
  const currentDefinitionResponse = await admin.graphql(
    `#graphql
      query PreviewMetafieldDefinition {
        metafieldDefinition(
          identifier: {
            ownerType: PRODUCT
            namespace: "$app"
            key: "preview_enabled"
          }
        ) {
          id
        }
      }
    `,
  );

  const currentDefinitionData =
    (await currentDefinitionResponse.json()) as MetafieldDefinitionQueryResponse;

  if (currentDefinitionData.data.metafieldDefinition) {
    return { ok: true, created: false as const };
  }

  const createDefinitionResponse = await admin.graphql(
    `#graphql
      mutation CreatePreviewMetafieldDefinition {
        metafieldDefinitionCreate(
          definition: {
            name: "Anteprima di stampa attiva"
            description: "Indica se il prodotto ha l'anteprima di stampa abilitata dall'app."
            namespace: "$app"
            key: "preview_enabled"
            type: "boolean"
            ownerType: PRODUCT
            access: { admin: MERCHANT_READ_WRITE }
          }
        ) {
          createdDefinition {
            id
          }
          userErrors {
            message
          }
        }
      }
    `,
  );

  const createDefinitionData =
    (await createDefinitionResponse.json()) as MetafieldDefinitionCreateResponse;
  const definitionErrors =
    createDefinitionData.data?.metafieldDefinitionCreate?.userErrors ?? [];

  if (definitionErrors.length > 0) {
    return {
      ok: false as const,
      error:
        definitionErrors[0]?.message ??
        "Shopify non ha creato la definizione del metafield.",
    };
  }

  return { ok: true, created: true as const };
}

async function ensureThemePreviewMetafieldDefinition(
  admin: AdminGraphqlClient,
): Promise<PreviewDefinitionResult> {
  const currentDefinitionResponse = await admin.graphql(
    `#graphql
      query ThemePreviewMetafieldDefinition {
        metafieldDefinition(
          identifier: {
            ownerType: PRODUCT
            namespace: "wowstampa"
            key: "preview_enabled"
          }
        ) {
          id
        }
      }
    `,
  );

  const currentDefinitionData =
    (await currentDefinitionResponse.json()) as MetafieldDefinitionQueryResponse;

  if (currentDefinitionData.data.metafieldDefinition) {
    return { ok: true, created: false };
  }

  const createDefinitionResponse = await admin.graphql(
    `#graphql
      mutation CreateThemePreviewMetafieldDefinition {
        metafieldDefinitionCreate(
          definition: {
            name: "Anteprima di stampa storefront"
            description: "Versione storefront-safe del flag anteprima di stampa."
            namespace: "wowstampa"
            key: "preview_enabled"
            type: "boolean"
            ownerType: PRODUCT
            access: { storefront: PUBLIC_READ }
          }
        ) {
          createdDefinition {
            id
          }
          userErrors {
            message
          }
        }
      }
    `,
  );

  const createDefinitionData =
    (await createDefinitionResponse.json()) as MetafieldDefinitionCreateResponse;
  const definitionErrors =
    createDefinitionData.data?.metafieldDefinitionCreate?.userErrors ?? [];

  if (definitionErrors.length > 0) {
    return {
      ok: false,
      error:
        definitionErrors[0]?.message ??
        "Shopify non ha creato la definizione storefront del metafield.",
    };
  }

  return { ok: true, created: true };
}

async function ensurePreviewMetafieldDefinitions(
  admin: AdminGraphqlClient,
): Promise<PreviewDefinitionResult> {
  const appDefinitionResult = await ensurePreviewMetafieldDefinition(admin);

  if (!appDefinitionResult.ok) {
    return appDefinitionResult;
  }

  const themeDefinitionResult = await ensureThemePreviewMetafieldDefinition(admin);

  if (!themeDefinitionResult.ok) {
    return themeDefinitionResult;
  }

  return {
    ok: true,
    created: appDefinitionResult.created || themeDefinitionResult.created,
  };
}

function buildPreviewMetafieldInputs(productId: string, value: string) {
  return [
    {
      ownerId: productId,
      namespace: PREVIEW_METAFIELD_NAMESPACE,
      key: PREVIEW_METAFIELD_KEY,
      type: PREVIEW_METAFIELD_TYPE,
      value,
    },
    {
      ownerId: productId,
      namespace: THEME_PREVIEW_METAFIELD_NAMESPACE,
      key: THEME_PREVIEW_METAFIELD_KEY,
      type: THEME_PREVIEW_METAFIELD_TYPE,
      value,
    },
  ];
}

export async function previewProductsLoader({
  request,
}: LoaderFunctionArgs): Promise<PreviewProductsLoaderData> {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const collectionId = normalizeCollectionId(url.searchParams.get("collectionId"));
  const after = normalizeCursor(url.searchParams.get("after"));
  const before = normalizeCursor(url.searchParams.get("before"));
  let productEdges: ProductEdge[] = [];
  let collectionEdges: CollectionEdge[] = [];
  let definitionExists = false;
  let productPageInfo: ProductConnection["pageInfo"] = {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };

  try {
    if (collectionId !== ALL_COLLECTIONS_VALUE) {
      const collectionProductsResponse = await admin.graphql(
        `#graphql
          query PreviewCollectionProducts(
            $collectionId: ID!
            $first: Int
            $after: String
            $last: Int
            $before: String
          ) {
            collection(id: $collectionId) {
              products(
                first: $first
                after: $after
                last: $last
                before: $before
                sortKey: TITLE
              ) {
                edges {
                  cursor
                  node {
                    id
                    title
                    handle
                    status
                    collections(first: 20) {
                      edges {
                        node {
                          id
                          title
                        }
                      }
                    }
                    featuredImage {
                      url
                      altText
                    }
                    previewEnabled: metafield(namespace: "$app", key: "preview_enabled") {
                      value
                    }
                    themePreviewEnabled: metafield(namespace: "wowstampa", key: "preview_enabled") {
                      value
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  hasPreviousPage
                  startCursor
                  endCursor
                }
              }
            }
          }
        `,
        {
          variables: {
            collectionId,
            ...buildPaginationVariables(after, before),
          },
        },
      );

      const collectionProductsData =
        (await collectionProductsResponse.json()) as CollectionProductsQueryResponse;

      if (collectionProductsData.errors?.length) {
        console.error(
          "Preview collection products query failed",
          collectionProductsData.errors,
        );
      }

      productEdges = collectionProductsData.data?.collection?.products?.edges ?? [];
      productPageInfo =
        collectionProductsData.data?.collection?.products?.pageInfo ?? productPageInfo;
    } else {
      const productsResponse = await admin.graphql(
        `#graphql
          query PreviewProducts(
            $query: String
            $first: Int
            $after: String
            $last: Int
            $before: String
          ) {
            products(
              first: $first
              after: $after
              last: $last
              before: $before
              sortKey: TITLE
              query: $query
            ) {
              edges {
                cursor
                node {
                  id
                  title
                  handle
                  status
                  collections(first: 20) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                  featuredImage {
                    url
                    altText
                  }
                  previewEnabled: metafield(namespace: "$app", key: "preview_enabled") {
                    value
                  }
                  themePreviewEnabled: metafield(namespace: "wowstampa", key: "preview_enabled") {
                    value
                  }
                }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        `,
        {
          variables: {
            query: buildProductsSearchQuery(search),
            ...buildPaginationVariables(after, before),
          },
        },
      );

      const productsData = (await productsResponse.json()) as ProductsQueryResponse;

      if (productsData.errors?.length) {
        console.error("Preview products query failed", productsData.errors);
      }

      productEdges = productsData.data?.products?.edges ?? [];
      productPageInfo = productsData.data?.products?.pageInfo ?? productPageInfo;
    }
  } catch (error) {
    console.error("Preview products query crashed", error);
  }

  try {
    const collectionsResponse = await admin.graphql(
      `#graphql
        query PreviewCollections {
          collections(first: 100, sortKey: TITLE) {
            edges {
              node {
                id
                title
              }
            }
          }
        }
      `,
    );

    const collectionsData =
      (await collectionsResponse.json()) as CollectionsQueryResponse;

    if (collectionsData.errors?.length) {
      console.error("Preview collections query failed", collectionsData.errors);
    }

    collectionEdges = collectionsData.data?.collections?.edges ?? [];
  } catch (error) {
    console.error("Preview collections query crashed", error);
  }

  try {
    const definitionResult = await ensurePreviewMetafieldDefinitions(admin);
    definitionExists = definitionResult.ok;
  } catch (error) {
    console.error("Preview metafield definition check crashed", error);
  }

  const mappedProducts = productEdges.map((edge: ProductEdge) => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    status: edge.node.status,
    imageUrl: edge.node.featuredImage?.url ?? null,
    imageAlt: edge.node.featuredImage?.altText ?? null,
    enabled:
      edge.node.previewEnabled?.value === "true" ||
      (edge.node.previewEnabled === null &&
        edge.node.themePreviewEnabled?.value === "true"),
    hasMetafield: edge.node.previewEnabled !== null,
    themeEnabled: edge.node.themePreviewEnabled?.value === "true",
    hasThemeMetafield: edge.node.themePreviewEnabled !== null,
    collections: (edge.node.collections?.edges ?? []).map((collectionEdge) => ({
      id: collectionEdge.node.id,
      title: collectionEdge.node.title,
    })),
  }));
  const normalizedSearch = search.toLocaleLowerCase();
  const filteredProducts = mappedProducts.filter((product: PreviewProduct) => {
    const shouldApplyLocalSearch = collectionId !== ALL_COLLECTIONS_VALUE;
    const matchesSearch =
      !shouldApplyLocalSearch ||
      normalizedSearch.length === 0 ||
      product.title.toLocaleLowerCase().includes(normalizedSearch) ||
      product.handle.toLocaleLowerCase().includes(normalizedSearch);

    const matchesCollection =
      collectionId === ALL_COLLECTIONS_VALUE ||
      product.collections.some((collection) => collection.id === collectionId);

    return matchesSearch && matchesCollection;
  });

  const missingProductIds = filteredProducts
    .filter(
      (product: PreviewProduct) =>
        !product.hasMetafield ||
        !product.hasThemeMetafield ||
        product.themeEnabled !== product.enabled,
    )
    .map((product: PreviewProduct) => product.id);

  return {
    products: filteredProducts,
    collectionOptions: [
      { label: "Tutte le collezioni", value: ALL_COLLECTIONS_VALUE },
      ...collectionEdges.map((edge: CollectionEdge) => ({
        label: edge.node.title,
        value: edge.node.id,
      })),
    ],
    filters: {
      search,
      collectionId,
    },
    pagination: {
      hasNextPage: productPageInfo.hasNextPage,
      hasPreviousPage: productPageInfo.hasPreviousPage,
      startCursor: productPageInfo.startCursor,
      endCursor: productPageInfo.endCursor,
      pageSize: PRODUCTS_PAGE_SIZE,
    },
    setup: {
      definitionExists,
      missingMetafieldCount: missingProductIds.length,
      missingProductIds,
    },
  };
}

export async function previewProductsAction({
  request,
}: ActionFunctionArgs): Promise<PreviewProductsActionData> {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode = formData.get("mode");

  if (mode === "setup") {
    const definitionResult = await ensurePreviewMetafieldDefinitions(admin);

    if (!definitionResult.ok) {
      return {
        ok: false,
        mode: "setup",
        error: definitionResult.error,
      };
    }

    const productIds = formData
      .getAll("productIds")
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    if (productIds.length === 0) {
      return {
        ok: true,
        mode: "setup",
        initializedCount: 0,
        definitionCreated: definitionResult.created,
      };
    }

    const currentMetafieldsResponse = await admin.graphql(
      `#graphql
        query PreviewSetupProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              previewEnabled: metafield(namespace: "$app", key: "preview_enabled") {
                value
              }
              themePreviewEnabled: metafield(namespace: "wowstampa", key: "preview_enabled") {
                value
              }
            }
          }
        }
      `,
      {
        variables: {
          ids: productIds,
        },
      },
    );

    const currentMetafieldsData =
      (await currentMetafieldsResponse.json()) as ProductMetafieldsNodesQueryResponse;

    if (currentMetafieldsData.errors?.length) {
      return {
        ok: false,
        mode: "setup",
        error:
          currentMetafieldsData.errors[0]?.message ??
          "Shopify non ha letto i metafield correnti dei prodotti.",
      };
    }

    const currentValuesByProductId = new Map(
      (currentMetafieldsData.data?.nodes ?? [])
        .filter(
          (
            node,
          ): node is {
            id: string;
            previewEnabled: {
              value: string;
            } | null;
            themePreviewEnabled: {
              value: string;
            } | null;
          } => node !== null,
        )
        .map((node) => [
          node.id,
          node.previewEnabled?.value ?? node.themePreviewEnabled?.value ?? "false",
        ]),
    );

    const setupError = await setPreviewMetafields(
      admin,
      productIds.flatMap((productId) =>
        buildPreviewMetafieldInputs(
          productId,
          currentValuesByProductId.get(productId) ?? "false",
        ),
      ),
    );

    if (setupError) {
      return {
        ok: false,
        mode: "setup",
        error: setupError,
      };
    }

    return {
      ok: true,
      mode: "setup",
      initializedCount: productIds.length,
      definitionCreated: definitionResult.created,
    };
  }

  const productId = formData.get("productId");
  const enabled = formData.get("enabled");

  if (typeof productId !== "string" || (enabled !== "true" && enabled !== "false")) {
    return {
      ok: false,
      mode: "toggle",
      productId: typeof productId === "string" ? productId : undefined,
      enabled: enabled === "true",
      error: "Dati non validi per il salvataggio.",
    };
  }

  const definitionResult = await ensurePreviewMetafieldDefinitions(admin);

  if (!definitionResult.ok) {
    return {
      ok: false,
      mode: "toggle",
      productId,
      enabled: enabled === "true",
      error: definitionResult.error,
    };
  }

  const toggleError = await setPreviewMetafields(
    admin,
    buildPreviewMetafieldInputs(productId, enabled),
  );

  if (toggleError) {
    return {
      ok: false,
      mode: "toggle",
      productId,
      enabled: enabled === "true",
      error: toggleError,
    };
  }

  return {
    ok: true,
    mode: "toggle",
    productId,
    enabled: enabled === "true",
    definitionCreated: definitionResult.created,
  };
}
