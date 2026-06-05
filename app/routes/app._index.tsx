import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  EMPTY_PROMO_CONFIG,
  normalizePromoConfig,
  parsePromoConfig,
  validatePromoConfig,
  type PromoFormatConfig,
  type PromoFormatEntry,
} from "./sqm-promo-config";
import {
  EMPTY_PRODUCT_CONFIG,
  normalizeProductConfig,
  stringifyProductConfig,
  validateProductConfig,
  type SqmProductConfig,
} from "./sqm-product-config";

type DiscountRange = {
  min_m2: number;
  max_m2: number | null;
  discount_percent: number;
  label?: string;
};

type VariantSummary = {
  id: string;
  title: string;
  price: string;
  quantityOption: string | null;
};

type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enabled: boolean;
  minimumAreaM2: number;
  ranges: DiscountRange[];
  promoConfig: PromoFormatConfig;
  productConfig: SqmProductConfig;
  productConfigJson: string;
  variants: VariantSummary[];
};

type LoaderData = {
  products: ProductSummary[];
  selectedProduct: ProductSummary | null;
  search: string;
  cartTransformStatus: CartTransformStatus;
};

type ActionData = {
  ok: boolean;
  errors?: string[];
  savedProductId?: string;
};

type CartTransformStatus = {
  active: boolean;
  eligibleForPriceUpdates: boolean;
  message?: string;
};

const EMPTY_RANGE: DiscountRange = {
  min_m2: 0,
  max_m2: null,
  discount_percent: 0,
  label: "",
};

const PRODUCTS_QUERY = `#graphql
  query CustomSqmPricingProducts($query: String) {
    products(first: 50, query: $query, sortKey: TITLE) {
      edges {
        node {
          id
          title
          handle
          status
          enabledMetafield: metafield(namespace: "custom", key: "sqm_pricing_enabled") {
            value
          }
          minimumAreaMetafield: metafield(namespace: "custom", key: "sqm_minimum_area_m2") {
            value
          }
          rangesMetafield: metafield(namespace: "custom", key: "sqm_discount_ranges") {
            value
          }
          promoFormatsMetafield: metafield(namespace: "custom", key: "sqm_promo_formats") {
            value
          }
          productConfigMetafield: metafield(namespace: "custom", key: "sqm_product_config") {
            value
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation CustomSqmPricingSaveProduct($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const CART_TRANSFORM_STATUS_QUERY = `#graphql
  query CustomSqmPricingCartTransformStatus {
    shop {
      features {
        cartTransform {
          eligibleOperations {
            updateOperation
          }
        }
      }
    }
    shopifyFunctions(first: 25) {
      nodes {
        id
        title
        apiType
      }
    }
    cartTransforms(first: 25) {
      nodes {
        id
        functionId
      }
    }
  }
`;

const CART_TRANSFORM_CREATE_MUTATION = `#graphql
  mutation CustomSqmPricingCartTransformCreate($functionId: String!) {
    cartTransformCreate(functionId: $functionId, blockOnFailure: false) {
      cartTransform {
        id
        functionId
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function parseRanges(value: unknown): DiscountRange[] {
  if (!value) return [];

  let parsed = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((range) => normalizeRange(range))
    .filter((range): range is DiscountRange => Boolean(range));
}

function normalizeRange(range: unknown): DiscountRange | null {
  if (!range || typeof range !== "object") return null;

  const source = range as Record<string, unknown>;
  const min = toNumber(source.min_m2 ?? source.min);
  const maxSource = source.max_m2 ?? source.max;
  const max =
    maxSource === "" || maxSource === null || typeof maxSource === "undefined"
      ? null
      : toNumber(maxSource);
  const discount = toNumber(source.discount_percent ?? source.discount);
  const label = String(source.label ?? "").trim();

  if (min === null || discount === null) return null;

  return {
    min_m2: roundDecimal(Math.max(0, min)),
    max_m2: max === null ? null : roundDecimal(Math.max(0, max)),
    discount_percent: roundDecimal(Math.max(0, discount)),
    ...(label ? { label } : {}),
  };
}

function normalizeRanges(value: unknown): DiscountRange[] {
  return parseRanges(value).sort((first, second) => first.min_m2 - second.min_m2);
}

function validateRanges(ranges: DiscountRange[]) {
  const errors: string[] = [];

  ranges.forEach((range, index) => {
    const row = index + 1;
    if (range.discount_percent < 0 || range.discount_percent > 100) {
      errors.push(`Riga ${row}: la percentuale deve essere tra 0 e 100.`);
    }
    if (range.max_m2 !== null && range.max_m2 < range.min_m2) {
      errors.push(`Riga ${row}: "A mq" non puo essere minore di "Da mq".`);
    }
  });

  const sorted = [...ranges].sort((first, second) => first.min_m2 - second.min_m2);
  sorted.forEach((range, index) => {
    const next = sorted[index + 1];
    if (!next) return;

    if (range.max_m2 === null) {
      errors.push(
        `Il range da ${formatNumber(range.min_m2)} mq senza limite massimo deve essere l'ultimo.`,
      );
      return;
    }

    if (next.min_m2 < range.max_m2) {
      errors.push(
        `I range ${formatNumber(range.min_m2)}-${formatNumber(
          range.max_m2,
        )} mq e ${formatNumber(next.min_m2)}-${formatNumber(
          next.max_m2,
        )} mq si sovrappongono.`,
      );
    }
  });

  return [...new Set(errors)];
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const number = Number(value.replace(",", ".").trim());
  return Number.isFinite(number) ? number : null;
}

function roundDecimal(value: number) {
  return Math.round(value * 1000) / 1000;
}

function formatNumber(value: number | null) {
  if (value === null) return "+";
  return new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: 3,
  }).format(value);
}

function mapProduct(product: any): ProductSummary {
  const variants = product.variants.edges.map(({ node }: any) => {
    const quantityOption =
      node.selectedOptions.find(
        (option: { name: string }) => option.name.toLowerCase() === "quantita",
      ) ??
      node.selectedOptions.find(
        (option: { name: string }) => option.name.toLowerCase() === "quantità",
      );

    return {
      id: node.id,
      title: node.title,
      price: node.price,
      quantityOption: quantityOption?.value ?? null,
    };
  });

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    enabled: product.enabledMetafield?.value === "true",
    minimumAreaM2: Math.max(0, toNumber(product.minimumAreaMetafield?.value) ?? 0),
    ranges: normalizeRanges(product.rangesMetafield?.value),
    promoConfig: parsePromoConfig(product.promoFormatsMetafield?.value),
    productConfig: normalizeProductConfig(product.productConfigMetafield?.value),
    productConfigJson: stringifyProductConfig(product.productConfigMetafield?.value),
    variants,
  };
}

async function ensureCartTransform(admin: any): Promise<CartTransformStatus> {
  try {
    const statusResponse = await admin.graphql(CART_TRANSFORM_STATUS_QUERY);
    const statusJson: any = await statusResponse.json();

    if (statusJson.errors?.length) {
      return {
        active: false,
        eligibleForPriceUpdates: false,
        message: statusJson.errors.map((error: any) => error.message).join(" "),
      };
    }

    const functions = statusJson.data?.shopifyFunctions?.nodes ?? [];
    const cartTransforms = statusJson.data?.cartTransforms?.nodes ?? [];
    const eligibleForPriceUpdates = Boolean(
      statusJson.data?.shop?.features?.cartTransform?.eligibleOperations
        ?.updateOperation,
    );
    const sqmFunction = functions.find(
      (shopifyFunction: { apiType?: string; title?: string }) =>
        shopifyFunction.apiType === "cart_transform" &&
        shopifyFunction.title === "sqm-cart-transform",
    );

    if (!sqmFunction) {
      return {
        active: false,
        eligibleForPriceUpdates,
        message: "Function sqm-cart-transform non trovata nella versione app attiva.",
      };
    }

    const existing = cartTransforms.find(
      (cartTransform: { functionId?: string }) =>
        cartTransform.functionId === sqmFunction.id,
    );

    if (existing) {
      return { active: true, eligibleForPriceUpdates };
    }

    const createResponse = await admin.graphql(CART_TRANSFORM_CREATE_MUTATION, {
      variables: { functionId: sqmFunction.id },
    });
    const createJson: any = await createResponse.json();
    const userErrors =
      createJson.data?.cartTransformCreate?.userErrors?.map(
        (error: { message: string }) => error.message,
      ) ?? [];

    if (createJson.errors?.length || userErrors.length) {
      return {
        active: false,
        eligibleForPriceUpdates,
        message: [
          ...(createJson.errors?.map((error: any) => error.message) ?? []),
          ...userErrors,
        ].join(" "),
      };
    }

    return { active: true, eligibleForPriceUpdates };
  } catch (error) {
    return {
      active: false,
      eligibleForPriceUpdates: false,
      message: error instanceof Error ? error.message : "Errore cart transform.",
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const selectedProductId = url.searchParams.get("productId");
  const cartTransformStatus = await ensureCartTransform(admin);

  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: {
      query: search ? `title:*${search}* OR handle:*${search}*` : undefined,
    },
  });
  const responseJson: any = await response.json();

  if (responseJson.errors?.length) {
    throw new Error(responseJson.errors.map((error: any) => error.message).join("\n"));
  }

  const products: ProductSummary[] = responseJson.data.products.edges.map(({ node }: any) =>
    mapProduct(node),
  );
  const selectedProduct =
    products.find((product: ProductSummary) => product.id === selectedProductId) ??
    products[0] ??
    null;

  return {
    products,
    selectedProduct,
    search,
    cartTransformStatus,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") ?? "");
  const enabled = String(formData.get("enabled") ?? "false") === "true";
  const minimumAreaM2 = Math.max(
    0,
    toNumber(String(formData.get("minimumAreaM2") ?? "0")) ?? 0,
  );
  const ranges = normalizeRanges(String(formData.get("ranges") ?? "[]"));
  const promoConfig = normalizePromoConfig(
    parsePromoConfig(String(formData.get("promoConfig") ?? "{}")),
  );
  const productConfigRaw = String(formData.get("productConfig") ?? "{}");
  const productConfig = normalizeProductConfig(productConfigRaw);
  const errors = validateRanges(ranges);
  errors.push(...validatePromoConfig(promoConfig));
  errors.push(...validateProductConfig(productConfigRaw));

  if (!productId) {
    errors.push("Seleziona un prodotto prima di salvare.");
  }

  if (errors.length) {
    return { ok: false, errors } satisfies ActionData;
  }

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: productId,
          namespace: "custom",
          key: "sqm_pricing_enabled",
          type: "boolean",
          value: enabled ? "true" : "false",
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "sqm_minimum_area_m2",
          type: "number_decimal",
          value: minimumAreaM2.toFixed(3),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "sqm_discount_ranges",
          type: "json",
          value: JSON.stringify(ranges),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "sqm_promo_formats",
          type: "json",
          value: JSON.stringify(promoConfig),
        },
        {
          ownerId: productId,
          namespace: "custom",
          key: "sqm_product_config",
          type: "json",
          value: JSON.stringify(productConfig),
        },
      ],
    },
  });
  const responseJson: any = await response.json();
  const userErrors =
    responseJson.data?.metafieldsSet?.userErrors?.map(
      (error: { message: string }) => error.message,
    ) ?? [];

  if (responseJson.errors?.length || userErrors.length) {
    return {
      ok: false,
      errors: [
        ...(responseJson.errors?.map((error: any) => error.message) ?? []),
        ...userErrors,
      ],
    } satisfies ActionData;
  }

  return {
    ok: true,
    savedProductId: productId,
  } satisfies ActionData;
};

export default function Index() {
  const { products, selectedProduct, search, cartTransformStatus } =
    useLoaderData() as LoaderData;
  const fetcher = useFetcher();
  const actionData = fetcher.data as ActionData | undefined;
  const shopify = useAppBridge();
  const [enabled, setEnabled] = useState(selectedProduct?.enabled ?? false);
  const [minimumAreaM2, setMinimumAreaM2] = useState(
    selectedProduct?.minimumAreaM2 ?? 0,
  );
  const [ranges, setRanges] = useState<DiscountRange[]>(
    selectedProduct?.ranges.length ? selectedProduct.ranges : [{ ...EMPTY_RANGE }],
  );
  const [promoConfig, setPromoConfig] = useState<PromoFormatConfig>(
    selectedProduct?.promoConfig ?? { ...EMPTY_PROMO_CONFIG },
  );
  const [productConfigJson, setProductConfigJson] = useState(
    selectedProduct?.productConfigJson ?? stringifyProductConfig(EMPTY_PRODUCT_CONFIG),
  );

  const isSaving = fetcher.state !== "idle";
  const totalConfigured = products.filter((product) => product.enabled).length;
  const rangeErrors = useMemo(() => validateRanges(normalizeRanges(ranges)), [ranges]);
  const promoErrors = useMemo(
    () => validatePromoConfig(normalizePromoConfig(promoConfig)),
    [promoConfig],
  );
  const productConfigErrors = useMemo(
    () => validateProductConfig(productConfigJson),
    [productConfigJson],
  );
  useEffect(() => {
    setEnabled(selectedProduct?.enabled ?? false);
    setMinimumAreaM2(selectedProduct?.minimumAreaM2 ?? 0);
    setRanges(
      selectedProduct?.ranges.length ? selectedProduct.ranges : [{ ...EMPTY_RANGE }],
    );
    setPromoConfig(selectedProduct?.promoConfig ?? { ...EMPTY_PROMO_CONFIG });
    setProductConfigJson(
      selectedProduct?.productConfigJson ?? stringifyProductConfig(EMPTY_PRODUCT_CONFIG),
    );
  }, [selectedProduct]);

  useEffect(() => {
    if (actionData?.ok) {
      shopify.toast.show("Configurazione mq salvata");
    }
  }, [actionData, shopify]);

  const updateRange = (
    index: number,
    field: keyof DiscountRange,
    value: string,
  ) => {
    setRanges((current) =>
      current.map((range, rangeIndex) => {
        if (rangeIndex !== index) return range;

        if (field === "label") {
          return { ...range, label: value };
        }

        if (field === "max_m2" && value.trim() === "") {
          return { ...range, max_m2: null };
        }

        return {
          ...range,
          [field]: Number(value.replace(",", ".")),
        };
      }),
    );
  };

  const addRange = () => {
    setRanges((current) => [
      ...current,
      {
        min_m2: current.at(-1)?.max_m2 ?? current.at(-1)?.min_m2 ?? 0,
        max_m2: null,
        discount_percent: 0,
        label: "",
      },
    ]);
  };

  const removeRange = (index: number) => {
    setRanges((current) => {
      const next = current.filter((_, rangeIndex) => rangeIndex !== index);
      return next.length ? next : [{ ...EMPTY_RANGE }];
    });
  };

  const updatePromoField = (
    field: keyof Pick<
      PromoFormatConfig,
      "enablePromoFormats" | "promoBadge" | "promoMessage"
    >,
    value: boolean | string,
  ) => {
    setPromoConfig((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updatePromoFormat = (
    index: number,
    field: keyof PromoFormatEntry,
    value: string,
  ) => {
    setPromoConfig((current) => ({
      ...current,
      formats: current.formats.map((format, formatIndex) => {
        if (formatIndex !== index) return format;
        if (field === "label") {
          return { ...format, label: value };
        }
        return {
          ...format,
          [field]: Math.max(0, toNumber(value) ?? 0),
        };
      }),
    }));
  };

  const addPromoFormat = () => {
    setPromoConfig((current) => ({
      ...current,
      formats: [
        ...current.formats,
        {
          label: "",
          base: 0,
          height: 0,
        },
      ],
    }));
  };

  const removePromoFormat = (index: number) => {
    setPromoConfig((current) => ({
      ...current,
      formats: current.formats.filter((_, formatIndex) => formatIndex !== index),
    }));
  };

  const sanitizedRanges = normalizeRanges(ranges);
  const sanitizedPromoConfig = normalizePromoConfig(promoConfig);
  const sanitizedProductConfigJson = stringifyProductConfig(productConfigJson);

  return (
    <s-page heading="Custom SQM Pricing">
      <style>{styles}</style>

      <s-section>
        <div className="sqm-layout">
          <aside className="sqm-sidebar">
            <div className="sqm-panel sqm-panel--compact">
              <div className="sqm-panel__header">
                <div>
                  <p className="sqm-kicker">Prodotti</p>
                  <h2>Configurazioni</h2>
                </div>
                <span className="sqm-counter">{totalConfigured}</span>
              </div>

              {!cartTransformStatus.active || !cartTransformStatus.eligibleForPriceUpdates ? (
                <div className="sqm-notice">
                  <strong>Prezzo carrello</strong>
                  <span>
                    {!cartTransformStatus.eligibleForPriceUpdates
                      ? "Questo shop non risulta abilitato agli update prezzo via Cart Transform. Funziona su development store o Shopify Plus."
                      : cartTransformStatus.message ??
                        "Cart Transform non ancora attiva su questo shop."}
                  </span>
                </div>
              ) : null}

              <Form className="sqm-search" method="get">
                <input
                  aria-label="Cerca prodotto"
                  defaultValue={search}
                  name="q"
                  placeholder="Cerca titolo o handle"
                  type="search"
                />
                <button type="submit">Cerca</button>
              </Form>

              <div className="sqm-product-list">
                {products.map((product) => {
                  const href = `/app?productId=${encodeURIComponent(product.id)}${
                    search ? `&q=${encodeURIComponent(search)}` : ""
                  }`;

                  return (
                    <a
                      className={`sqm-product ${
                        product.id === selectedProduct?.id ? "is-selected" : ""
                      }`}
                      href={href}
                      key={product.id}
                    >
                      <span>
                        <strong>{product.title}</strong>
                        <small>{product.handle}</small>
                      </span>
                      {product.enabled ? <em>Attivo</em> : null}
                    </a>
                  );
                })}

                {!products.length ? (
                  <p className="sqm-empty">Nessun prodotto trovato.</p>
                ) : null}
              </div>
            </div>
          </aside>

          <main className="sqm-main">
            {selectedProduct ? (
              <fetcher.Form method="post" className="sqm-panel">
                <input name="productId" type="hidden" value={selectedProduct.id} />
                <input name="enabled" type="hidden" value={String(enabled)} />
                <input
                  name="minimumAreaM2"
                  type="hidden"
                  value={String(minimumAreaM2)}
                />
                <input
                  name="ranges"
                  type="hidden"
                  value={JSON.stringify(sanitizedRanges)}
                />
                <input
                  name="promoConfig"
                  type="hidden"
                  value={JSON.stringify(sanitizedPromoConfig)}
                />
                <input
                  name="productConfig"
                  type="hidden"
                  value={sanitizedProductConfigJson}
                />

                <div className="sqm-panel__header sqm-panel__header--product">
                  <div>
                    <p className="sqm-kicker">Prodotto selezionato</p>
                    <h1>{selectedProduct.title}</h1>
                    <p className="sqm-muted">
                      Base prezzo dalla variante Shopify selezionata; area calcolata
                      con base, altezza e quantity selector.
                    </p>
                  </div>
                  <label className="sqm-toggle">
                    <input
                      checked={enabled}
                      onChange={(event) => setEnabled(event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>{enabled ? "Attivo" : "Disattivo"}</span>
                  </label>
                </div>

                <div className="sqm-section-grid">
                  <section>
                    <div className="sqm-section-heading">
                      <div>
                        <h2>Formati promo</h2>
                        <p>
                          Attiva la scelta iniziale tra promo e personalizzato solo
                          per questo prodotto. Se non ci sono formati validi, il
                          frontend usera automaticamente il calcolatore standard.
                        </p>
                      </div>
                    </div>

                    <div className="sqm-promo-box">
                      <label className="sqm-toggle sqm-toggle--block">
                        <input
                          checked={promoConfig.enablePromoFormats}
                          onChange={(event) =>
                            updatePromoField(
                              "enablePromoFormats",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        <span>Abilita promo / personalizzato</span>
                      </label>

                      <div className="sqm-promo-meta">
                        <label className="sqm-field">
                          <span>Badge promo</span>
                          <input
                            onChange={(event) =>
                              updatePromoField("promoBadge", event.target.value)
                            }
                            placeholder="Es. -20%"
                            type="text"
                            value={promoConfig.promoBadge}
                          />
                        </label>
                        <label className="sqm-field sqm-field--wide">
                          <span>Messaggio promo</span>
                          <input
                            onChange={(event) =>
                              updatePromoField("promoMessage", event.target.value)
                            }
                            placeholder="Es. Prezzi speciali sui formati più richiesti"
                            type="text"
                            value={promoConfig.promoMessage}
                          />
                        </label>
                      </div>

                      <div className="sqm-section-heading sqm-section-heading--tight">
                        <div>
                          <h2>Formati promo disponibili</h2>
                          <p>
                            Ogni formato imposta automaticamente base e altezza nel
                            calcolatore.
                          </p>
                        </div>
                        <button className="sqm-button" onClick={addPromoFormat} type="button">
                          Aggiungi formato
                        </button>
                      </div>

                      <div className="sqm-range-list">
                        {promoConfig.formats.map((format, index) => (
                          <div className="sqm-range-row sqm-range-row--promo" key={index}>
                            <label className="sqm-field sqm-field--label">
                              <span>Etichetta</span>
                              <input
                                onChange={(event) =>
                                  updatePromoFormat(index, "label", event.target.value)
                                }
                                placeholder="Es. 300 x 100 cm"
                                type="text"
                                value={format.label}
                              />
                            </label>
                            <label className="sqm-field">
                              <span>Base cm</span>
                              <input
                                min="0"
                                onChange={(event) =>
                                  updatePromoFormat(index, "base", event.target.value)
                                }
                                step="0.1"
                                type="number"
                                value={format.base || ""}
                              />
                            </label>
                            <label className="sqm-field">
                              <span>Altezza cm</span>
                              <input
                                min="0"
                                onChange={(event) =>
                                  updatePromoFormat(index, "height", event.target.value)
                                }
                                step="0.1"
                                type="number"
                                value={format.height || ""}
                              />
                            </label>
                            <button
                              aria-label="Rimuovi formato promo"
                              className="sqm-icon-button"
                              onClick={() => removePromoFormat(index)}
                              type="button"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>

                      {!promoConfig.formats.length ? (
                        <p className="sqm-empty">Nessun formato promo configurato.</p>
                      ) : null}
                    </div>

                    {promoErrors.length ? (
                      <div className="sqm-errors">
                        {promoErrors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}

                    <div className="sqm-section-heading">
                      <div>
                        <h2>Configurazione avanzata prodotto</h2>
                        <p>
                          Definisci opzioni custom e commissioni automatiche in JSON.
                          Lascia array vuoti per mantenere il comportamento standard.
                        </p>
                      </div>
                    </div>

                    <label className="sqm-field sqm-json-editor">
                      <span>JSON configurazione</span>
                      <textarea
                        onBlur={() => {
                          if (!productConfigErrors.length) {
                            setProductConfigJson(sanitizedProductConfigJson);
                          }
                        }}
                        onChange={(event) => setProductConfigJson(event.target.value)}
                        rows={14}
                        spellCheck={false}
                        value={productConfigJson}
                      />
                    </label>

                    {productConfigErrors.length ? (
                      <div className="sqm-errors">
                        {productConfigErrors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}

                    <div className="sqm-section-heading">
                      <div>
                        <h2>Minimo di stampa</h2>
                        <p>
                          Se l area totale e inferiore a questa soglia, il prezzo
                          resta quello del minimo fatturabile. Esempio: prezzo base
                          12 €/mq e minimo 1 mq = anche 0,5 mq costa 12 €.
                        </p>
                      </div>
                    </div>

                    <div className="sqm-minimum-box">
                      <label className="sqm-field">
                        <span>Mq minimi fatturabili</span>
                        <input
                          min="0"
                          onChange={(event) =>
                            setMinimumAreaM2(
                              Math.max(
                                0,
                                toNumber(event.target.value) ?? 0,
                              ),
                            )
                          }
                          placeholder="0"
                          step="0.001"
                          type="number"
                          value={minimumAreaM2}
                        />
                      </label>
                    </div>

                    <div className="sqm-section-heading">
                      <div>
                        <h2>Range metri quadrati</h2>
                        <p>
                          Imposta le soglie prodotto per prodotto. Lascia “A mq”
                          vuoto per indicare nessun limite massimo.
                        </p>
                      </div>
                      <button className="sqm-button" onClick={addRange} type="button">
                        Aggiungi
                      </button>
                    </div>

                    <div className="sqm-range-list">
                      {ranges.map((range, index) => (
                        <div className="sqm-range-row" key={index}>
                          <label className="sqm-field">
                            <span>Da mq</span>
                            <input
                              min="0"
                              onChange={(event) =>
                                updateRange(index, "min_m2", event.target.value)
                              }
                              step="0.001"
                              type="number"
                              value={Number.isFinite(range.min_m2) ? range.min_m2 : ""}
                            />
                          </label>
                          <label className="sqm-field">
                            <span>A mq</span>
                            <input
                              min="0"
                              onChange={(event) =>
                                updateRange(index, "max_m2", event.target.value)
                              }
                              placeholder="+"
                              step="0.001"
                              type="number"
                              value={range.max_m2 ?? ""}
                            />
                          </label>
                          <label className="sqm-field">
                            <span>Sconto %</span>
                            <input
                              min="0"
                              max="100"
                              onChange={(event) =>
                                updateRange(
                                  index,
                                  "discount_percent",
                                  event.target.value,
                                )
                              }
                              step="0.01"
                              type="number"
                              value={
                                Number.isFinite(range.discount_percent)
                                  ? range.discount_percent
                                  : ""
                              }
                            />
                          </label>
                          <label className="sqm-field sqm-field--label">
                            <span>Etichetta interna</span>
                            <input
                              onChange={(event) =>
                                updateRange(index, "label", event.target.value)
                              }
                              placeholder="Es. Promo grandi formati"
                              type="text"
                              value={range.label ?? ""}
                            />
                          </label>
                          <button
                            aria-label="Rimuovi range"
                            className="sqm-icon-button"
                            onClick={() => removeRange(index)}
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>

                    {rangeErrors.length ? (
                      <div className="sqm-errors">
                        {rangeErrors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}

                    {actionData?.errors?.length ? (
                      <div className="sqm-errors">
                        {actionData.errors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  <section className="sqm-variants">
                    <h2>Prezzo base al mq</h2>
                    <p className="sqm-muted">
                      Il calcolatore usa il prezzo della variante Shopify corrente
                      come €/mq. La quantità viene presa dal quantity selector del
                      tema.
                    </p>
                    <div className="sqm-variant-grid">
                      {selectedProduct.variants.map((variant) => (
                        <div className="sqm-variant" key={variant.id}>
                          <span>{variant.title}</span>
                          <strong>{formatCurrency(variant.price)}</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>

                <div className="sqm-actions">
                  <button
                    className="sqm-button sqm-button--primary"
                    disabled={
                      isSaving ||
                      Boolean(rangeErrors.length) ||
                      Boolean(promoErrors.length) ||
                      Boolean(productConfigErrors.length)
                    }
                    type="submit"
                  >
                    {isSaving ? "Salvataggio..." : "Salva configurazione"}
                  </button>
                </div>
              </fetcher.Form>
            ) : (
              <div className="sqm-panel">
                <h1>Seleziona un prodotto</h1>
                <p className="sqm-muted">
                  Cerca un prodotto per impostare range mq e sconti dedicati.
                </p>
              </div>
            )}
          </main>
        </div>
      </s-section>
    </s-page>
  );
}

function formatCurrency(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;

  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(number);
}

const styles = `
  .sqm-layout {
    display: grid;
    grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    margin: 0 auto;
    max-width: 1180px;
    width: 100%;
  }

  .sqm-sidebar,
  .sqm-main {
    min-width: 0;
  }

  .sqm-panel {
    background: #ffffff;
    border: 1px solid #dfe3e8;
    border-radius: 8px;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
    min-width: 0;
    padding: 18px;
  }

  .sqm-panel--compact {
    padding: 16px;
  }

  .sqm-panel__header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 18px;
  }

  .sqm-panel__header h1,
  .sqm-panel__header h2,
  .sqm-section-heading h2,
  .sqm-variants h2 {
    margin: 0;
    color: #202223;
    line-height: 1.2;
  }

  .sqm-panel__header h1 {
    font-size: 22px;
  }

  .sqm-panel__header h2,
  .sqm-section-heading h2,
  .sqm-variants h2 {
    font-size: 16px;
  }

  .sqm-minimum-box {
    margin-bottom: 18px;
  }

  .sqm-kicker {
    margin: 0 0 4px;
    color: #6d7175;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .sqm-muted,
  .sqm-section-heading p,
  .sqm-empty {
    color: #6d7175;
    margin: 6px 0 0;
  }

  .sqm-counter {
    align-items: center;
    background: #eaf5f2;
    border-radius: 999px;
    color: #006c52;
    display: inline-flex;
    font-size: 12px;
    font-weight: 700;
    justify-content: center;
    min-width: 28px;
    padding: 5px 9px;
  }

  .sqm-notice {
    background: #fff8e5;
    border: 1px solid #e6c56f;
    border-radius: 6px;
    color: #4f4700;
    display: grid;
    gap: 4px;
    font-size: 13px;
    line-height: 1.4;
    margin-bottom: 14px;
    padding: 10px 12px;
  }

  .sqm-notice strong {
    color: #332d00;
  }

  .sqm-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    margin-bottom: 14px;
  }

  .sqm-search input,
  .sqm-field input,
  .sqm-field textarea {
    border: 1px solid #c9cccf;
    border-radius: 6px;
    box-sizing: border-box;
    font: inherit;
    min-height: 36px;
    padding: 7px 10px;
    width: 100%;
  }

  .sqm-field input:focus,
  .sqm-field textarea:focus,
  .sqm-search input:focus {
    border-color: #008060;
    box-shadow: 0 0 0 1px #008060;
    outline: none;
  }

  .sqm-field textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.5;
    min-height: 220px;
    padding: 10px 12px;
    resize: vertical;
  }

  .sqm-json-editor {
    margin-bottom: 18px;
  }

  .sqm-search button,
  .sqm-button {
    background: #ffffff;
    border: 1px solid #8c9196;
    border-radius: 6px;
    color: #202223;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    min-height: 36px;
    padding: 7px 12px;
  }

  .sqm-button--primary {
    background: #008060;
    border-color: #008060;
    color: #ffffff;
  }

  .sqm-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .sqm-product-list {
    display: grid;
    gap: 8px;
    max-height: 640px;
    overflow: auto;
  }

  .sqm-product {
    border: 1px solid #dfe3e8;
    border-radius: 6px;
    color: #202223;
    display: flex;
    gap: 10px;
    justify-content: space-between;
    padding: 10px;
    text-decoration: none;
  }

  .sqm-product strong,
  .sqm-product small {
    display: block;
  }

  .sqm-product small {
    color: #6d7175;
    margin-top: 2px;
  }

  .sqm-product em {
    color: #008060;
    font-size: 12px;
    font-style: normal;
    font-weight: 700;
  }

  .sqm-product.is-selected {
    background: #edf7f4;
    border-color: #008060;
  }

  .sqm-toggle {
    align-items: center;
    display: inline-flex;
    gap: 8px;
    font-weight: 700;
    white-space: nowrap;
  }

  .sqm-toggle--block {
    display: flex;
    margin-bottom: 14px;
    white-space: normal;
  }

  .sqm-toggle input {
    height: 18px;
    width: 18px;
  }

  .sqm-section-grid {
    display: grid;
    gap: 24px;
  }

  .sqm-section-heading {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .sqm-section-heading--tight {
    margin-top: 16px;
  }

  .sqm-promo-box {
    background: #f9fbfb;
    border: 1px solid #dfe3e8;
    border-radius: 8px;
    padding: 14px;
  }

  .sqm-promo-meta {
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(120px, 0.6fr) minmax(0, 1.4fr);
  }

  .sqm-range-list {
    display: grid;
    gap: 10px;
  }

  .sqm-range-row {
    align-items: end;
    background: #fbfbfc;
    border: 1px solid #dfe3e8;
    border-radius: 8px;
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(82px, 1fr) minmax(82px, 1fr) minmax(82px, 0.8fr) minmax(140px, 1.45fr) 38px;
    padding: 12px;
  }

  .sqm-range-row--promo {
    grid-template-columns: minmax(180px, 1.5fr) minmax(90px, 1fr) minmax(90px, 1fr) 38px;
  }

  .sqm-field {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .sqm-field--wide {
    min-width: 0;
  }

  .sqm-field span {
    color: #6d7175;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .sqm-icon-button {
    background: #ffffff;
    border: 1px solid #c9cccf;
    border-radius: 6px;
    cursor: pointer;
    font-size: 18px;
    height: 36px;
    line-height: 1;
    width: 36px;
  }

  .sqm-icon-button:hover {
    background: #fff4f4;
    border-color: #fed3d1;
    color: #8e1f0b;
  }

  .sqm-errors {
    background: #fff4f4;
    border: 1px solid #fed3d1;
    border-radius: 8px;
    color: #8e1f0b;
    margin-top: 12px;
    padding: 10px 12px;
  }

  .sqm-errors p {
    margin: 0;
  }

  .sqm-errors p + p {
    margin-top: 4px;
  }

  .sqm-variant-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    margin-top: 12px;
  }

  .sqm-variant {
    border: 1px solid #dfe3e8;
    border-radius: 6px;
    padding: 10px;
  }

  .sqm-variant span,
  .sqm-variant strong {
    display: block;
  }

  .sqm-variant span {
    color: #6d7175;
    font-size: 12px;
  }

  .sqm-actions {
    border-top: 1px solid #dfe3e8;
    display: flex;
    justify-content: flex-end;
    margin-top: 20px;
    padding-top: 16px;
  }

  @media (max-width: 1120px) {
    .sqm-layout {
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
    }

    .sqm-range-row {
      grid-template-columns: repeat(3, minmax(84px, 1fr)) 38px;
    }

    .sqm-field--label {
      grid-column: 1 / 4;
      grid-row: 2;
    }

    .sqm-range-row .sqm-icon-button {
      grid-column: 4;
      grid-row: 1 / 3;
      justify-self: end;
    }

    .sqm-range-row--promo {
      grid-template-columns: minmax(0, 1fr) minmax(90px, 1fr) minmax(90px, 1fr) 38px;
    }

    .sqm-promo-meta {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 900px) {
    .sqm-layout {
      grid-template-columns: 1fr;
    }

    .sqm-panel__header--product,
    .sqm-section-heading {
      display: grid;
    }
  }

  @media (max-width: 620px) {
    .sqm-range-row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .sqm-field--label {
      grid-column: 1 / -1;
      grid-row: auto;
    }

    .sqm-range-row .sqm-icon-button {
      grid-column: 2;
      grid-row: auto;
      justify-self: end;
    }

    .sqm-range-row--promo {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
