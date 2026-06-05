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
  buildProductAdvancedConfigFromForm,
  createEmptyOption,
  createEmptyOptionGroup,
  EMPTY_PRODUCT_CONFIG,
  formatPriceModifierLabel,
  normalizeProductConfig,
  normalizeId,
  parseProductAdvancedConfig,
  stringifyProductConfig,
  validateOptionGroup,
  validateProductConfig,
  type OptionGroupType,
  type PriceModifierType,
  type SqmOption,
  type SqmOptionGroup,
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

type ConfigTab = "promo" | "options" | "calculation";

const EMPTY_RANGE: DiscountRange = {
  min_m2: 0,
  max_m2: null,
  discount_percent: 0,
  label: "",
};

const OPTION_TYPE_OPTIONS: Array<{
  label: string;
  value: OptionGroupType;
  description: string;
}> = [
  {
    label: "Bottoni",
    value: "button",
    description: "Ideale per poche opzioni visibili",
  },
  {
    label: "Radio",
    value: "radio",
    description: "Ideale per una scelta singola ordinata",
  },
  {
    label: "Dropdown",
    value: "dropdown",
    description: "Ideale per tante opzioni",
  },
  {
    label: "Checkbox",
    value: "checkbox",
    description: "Utile per attivare opzioni aggiuntive",
  },
  {
    label: "Toggle",
    value: "toggle",
    description: "Perfetto per una scelta on/off rapida",
  },
];

const ICON_OPTIONS = [
  { label: "Nessuna", value: "" },
  { label: "Sparkles", value: "sparkles" },
  { label: "Layers", value: "layers" },
  { label: "Droplets", value: "droplets" },
  { label: "Image", value: "image" },
  { label: "Ruler", value: "ruler" },
  { label: "Print", value: "print" },
];

const PRICE_TYPE_OPTIONS: Array<{ label: string; value: PriceModifierType }> = [
  { label: "Nessuna modifica", value: "none" },
  { label: "Extra per mq", value: "per_sqm" },
  { label: "Extra fisso ordine", value: "fixed_order" },
  { label: "Extra per pezzo", value: "fixed_piece" },
  { label: "Percentuale", value: "percentage" },
  { label: "Moltiplicatore", value: "multiplier" },
];

function cloneOptionGroup(group: SqmOptionGroup, index: number) {
  const nextIdBase = normalizeId(`${group.id || group.label || "option"}_${index + 1}`);
  return normalizeProductConfig({
    enableSqmCalculator: true,
    optionGroups: [
      {
        ...group,
        id: nextIdBase || `option_group_${index + 1}`,
        label: group.label ? `${group.label} copia` : "",
      },
    ],
    conditionalFees: [],
  }).optionGroups[0];
}

function sanitizeOptionGroup(group: SqmOptionGroup, index: number) {
  const normalized = normalizeProductConfig({
    enableSqmCalculator: true,
    optionGroups: [group],
    conditionalFees: [],
  }).optionGroups[0];

  return (
    normalized ?? {
      ...createEmptyOptionGroup(group.type, index),
      ...group,
    }
  );
}

function summarizeOptionGroup(group: SqmOptionGroup) {
  const labels = group.options
    .map((option) => option.label.trim())
    .filter(Boolean)
    .slice(0, 4);
  const pricedCount = group.options.filter(
    (option) => option.priceModifier.type !== "none",
  ).length;

  return {
    valuesLabel: labels.length ? labels.join(", ") : "Nessun valore",
    pricedLabel:
      pricedCount > 0
        ? `${pricedCount} ${pricedCount === 1 ? "valore con extra" : "valori con extra"}`
        : "Nessun extra prezzo",
  };
}

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
  const [productConfig, setProductConfig] = useState<SqmProductConfig>(
    selectedProduct?.productConfig ?? { ...EMPTY_PRODUCT_CONFIG },
  );
  const [productConfigJson, setProductConfigJson] = useState(
    selectedProduct?.productConfigJson ??
      stringifyProductConfig(selectedProduct?.productConfig ?? EMPTY_PRODUCT_CONFIG),
  );
  const [isVariantMenuOpen, setIsVariantMenuOpen] = useState(false);
  const [draftOptionGroup, setDraftOptionGroup] = useState<SqmOptionGroup | null>(null);
  const [editingOptionGroupIndex, setEditingOptionGroupIndex] = useState<number | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<ConfigTab>("promo");

  const isSaving = fetcher.state !== "idle";
  const totalConfigured = products.filter((product) => product.enabled).length;
  const rangeErrors = useMemo(() => validateRanges(normalizeRanges(ranges)), [ranges]);
  const promoErrors = useMemo(
    () => validatePromoConfig(normalizePromoConfig(promoConfig)),
    [promoConfig],
  );
  const productConfigErrors = useMemo(
    () => validateProductConfig(productConfig),
    [productConfig],
  );
  const productConfigJsonErrors = useMemo(
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
    setProductConfig(selectedProduct?.productConfig ?? { ...EMPTY_PRODUCT_CONFIG });
    setProductConfigJson(
      selectedProduct?.productConfigJson ??
        stringifyProductConfig(selectedProduct?.productConfig ?? EMPTY_PRODUCT_CONFIG),
    );
    setIsVariantMenuOpen(false);
    setDraftOptionGroup(null);
    setEditingOptionGroupIndex(null);
    setActiveTab("promo");
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

  const updateProductConfig = (
    updater: SqmProductConfig | ((current: SqmProductConfig) => SqmProductConfig),
  ) => {
    setProductConfig((current) => {
      const next =
        typeof updater === "function"
          ? (updater as (value: SqmProductConfig) => SqmProductConfig)(current)
          : updater;
      const normalized = normalizeProductConfig(next);
      setProductConfigJson(stringifyProductConfig(normalized));
      return normalized;
    });
  };

  const addOptionGroup = (type: OptionGroupType) => {
    setDraftOptionGroup(
      sanitizeOptionGroup(createEmptyOptionGroup(type, productConfig.optionGroups.length), productConfig.optionGroups.length),
    );
    setEditingOptionGroupIndex(null);
    setIsVariantMenuOpen(false);
  };

  const duplicateOptionGroup = (index: number) => {
    updateProductConfig((current) => {
      const source = current.optionGroups[index];
      if (!source) return current;
      const duplicate = cloneOptionGroup(source, current.optionGroups.length);
      const next = [...current.optionGroups];
      next.splice(index + 1, 0, duplicate);
      return { ...current, optionGroups: next };
    });
  };

  const editOptionGroup = (index: number) => {
    const source = productConfig.optionGroups[index];
    if (!source) return;
    setDraftOptionGroup(sanitizeOptionGroup(source, index));
    setEditingOptionGroupIndex(index);
    setIsVariantMenuOpen(false);
  };

  const removeOptionGroup = (index: number) => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Vuoi eliminare questa variante?");
      if (!confirmed) return;
    }
    updateProductConfig((current) => ({
      ...current,
      optionGroups: current.optionGroups.filter((_, groupIndex) => groupIndex !== index),
    }));
  };

  const updateDraftOptionGroup = (
    updater:
      | SqmOptionGroup
      | ((current: SqmOptionGroup) => SqmOptionGroup),
  ) => {
    setDraftOptionGroup((current) => {
      if (!current) return current;
      const next = typeof updater === "function" ? updater(current) : updater;
      return sanitizeOptionGroup(next, editingOptionGroupIndex ?? productConfig.optionGroups.length);
    });
  };

  const cancelDraftOptionGroup = () => {
    setDraftOptionGroup(null);
    setEditingOptionGroupIndex(null);
    setIsVariantMenuOpen(false);
  };

  const saveDraftOptionGroup = () => {
    if (!draftOptionGroup) return;

    updateProductConfig((current) => {
      const nextGroups = [...current.optionGroups];
      if (editingOptionGroupIndex === null) {
        nextGroups.push(draftOptionGroup);
      } else {
        nextGroups[editingOptionGroupIndex] = draftOptionGroup;
      }
      return {
        ...current,
        optionGroups: nextGroups,
      };
    });

    setDraftOptionGroup(null);
    setEditingOptionGroupIndex(null);
    setIsVariantMenuOpen(false);
  };

  const addOptionValue = () => {
    updateDraftOptionGroup((group) => {
      const nextOption = createEmptyOption(group.options.length);
      const options = [...group.options, nextOption];
      return {
        ...group,
        defaultValue:
          group.defaultValue || (group.type === "checkbox" ? "" : nextOption.value),
        options,
      };
    });
  };

  const updateOptionGroup = (
    field: keyof SqmOptionGroup,
    value: string | boolean,
  ) => {
    updateDraftOptionGroup((group) => {
      const nextGroup: SqmOptionGroup = {
        ...group,
        [field]: value,
      } as SqmOptionGroup;

      if (field === "label") {
        nextGroup.id =
          normalizeId(String(value)) ||
          group.id ||
          `option_group_${(editingOptionGroupIndex ?? productConfig.optionGroups.length) + 1}`;
      }

      if (field === "type" && value === "checkbox") {
        nextGroup.required = false;
      }

      return nextGroup;
    });
  };

  const updateOptionValue = (
    optionIndex: number,
    field: keyof SqmOption,
    value: string,
  ) => {
    updateDraftOptionGroup((group) => {
      const options = group.options.map((option, currentOptionIndex) => {
        if (currentOptionIndex !== optionIndex) return option;

        const nextOption: SqmOption = {
          ...option,
          [field]: value,
        } as SqmOption;

        if (
          field === "label" &&
          (!option.value || option.value === createEmptyOption(optionIndex).value)
        ) {
          nextOption.value =
            normalizeId(value).replace(/_/g, "-") || `option-${optionIndex + 1}`;
        }

        return nextOption;
      });

      const nextDefaultValue = options.some((option) => option.value === group.defaultValue)
        ? group.defaultValue
        : options[0]?.value ?? "";

      return {
        ...group,
        defaultValue: nextDefaultValue,
        options,
      };
    });
  };

  const updateOptionPriceModifier = (
    optionIndex: number,
    field: "type" | "amount" | "target" | "frontendLabel",
    value: string,
  ) => {
    updateDraftOptionGroup((group) => {
      const options = group.options.map((option, currentOptionIndex) => {
        if (currentOptionIndex !== optionIndex) return option;
        const currentModifier = option.priceModifier ?? { type: "none", amount: 0 };
        return {
          ...option,
          priceModifier: {
            ...currentModifier,
            [field]:
              field === "amount" ? Number(value.replace(",", ".")) || 0 : value,
          },
        };
      });

      return { ...group, options };
    });
  };

  const setOptionDefault = (value: string) => {
    updateDraftOptionGroup((group) => ({
      ...group,
      defaultValue: value,
    }));
  };

  const duplicateOptionValue = (optionIndex: number) => {
    updateDraftOptionGroup((group) => {
      const source = group.options[optionIndex];
      if (!source) return group;
      const duplicate: SqmOption = {
        ...source,
        value: `${source.value}-copy-${group.options.length + 1}`,
        label: source.label ? `${source.label} copia` : "",
      };
      const options = [...group.options];
      options.splice(optionIndex + 1, 0, duplicate);
      return { ...group, options };
    });
  };

  const removeOptionValue = (optionIndex: number) => {
    updateDraftOptionGroup((group) => {
      const options = group.options.filter(
        (_, currentOptionIndex) => currentOptionIndex !== optionIndex,
      );
      if (!options.length) {
        options.push(createEmptyOption(0));
      }
      const defaultValue = options.some((option) => option.value === group.defaultValue)
        ? group.defaultValue
        : options[0].value;
      return { ...group, options, defaultValue };
    });
  };

  const applyAdvancedJson = () => {
    const parsed = parseProductAdvancedConfig(productConfigJson);
    setProductConfig(parsed);
    setProductConfigJson(stringifyProductConfig(parsed));
  };

  const updatePackagingField = (
    field: "enabled" | "costPerSqm" | "maxPanelSizeCm" | "minimumCost",
    value: string | boolean,
  ) => {
    updateProductConfig((current) => ({
      ...current,
      packaging: {
        ...current.packaging,
        [field]:
          typeof value === "boolean"
            ? value
            : Math.max(0, toNumber(value) ?? 0),
      },
    }));
  };

  const sanitizedRanges = normalizeRanges(ranges);
  const sanitizedPromoConfig = normalizePromoConfig(promoConfig);
  const sanitizedProductConfigJson = buildProductAdvancedConfigFromForm(productConfig);

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
                  </div>
                  <div className="sqm-product-status">
                    <span className="sqm-product-status__label">Stato:</span>
                    <label className="sqm-toggle">
                      <span>Attivato</span>
                      <input
                        checked={enabled}
                        onChange={(event) => setEnabled(event.currentTarget.checked)}
                        type="checkbox"
                      />
                    </label>
                  </div>
                </div>

                <div className="sqm-tabs" role="tablist" aria-label="Configurazione prodotto">
                  <button
                    aria-selected={activeTab === "promo"}
                    className={`sqm-tab ${activeTab === "promo" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("promo")}
                    role="tab"
                    type="button"
                  >
                    Formati promo
                  </button>
                  <button
                    aria-selected={activeTab === "options"}
                    className={`sqm-tab ${activeTab === "options" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("options")}
                    role="tab"
                    type="button"
                  >
                    Opzioni prodotto
                  </button>
                  <button
                    aria-selected={activeTab === "calculation"}
                    className={`sqm-tab ${activeTab === "calculation" ? "is-active" : ""}`}
                    onClick={() => setActiveTab("calculation")}
                    role="tab"
                    type="button"
                  >
                    Calcolo Mq
                  </button>
                </div>

                <div className="sqm-tab-panels">
                  <section
                    className={`sqm-tab-panel ${activeTab === "promo" ? "is-active" : ""}`}
                    hidden={activeTab !== "promo"}
                  >
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
                  </section>

                  <section
                    className={`sqm-tab-panel ${activeTab === "options" ? "is-active" : ""}`}
                    hidden={activeTab !== "options"}
                  >
                    <div className="sqm-section-heading">
                      <div>
                        <h2>Opzioni prodotto</h2>
                        <p>
                          Configura visivamente le opzioni del calcolatore. Il JSON
                          resta disponibile solo come editor avanzato e debug.
                        </p>
                      </div>
                      <div className="sqm-variant-menu">
                        <button
                          aria-expanded={isVariantMenuOpen}
                          className="sqm-button"
                          onClick={() => setIsVariantMenuOpen((current) => !current)}
                          type="button"
                        >
                          + Aggiungi variante ▼
                        </button>

                        {isVariantMenuOpen ? (
                          <div className="sqm-variant-menu__popover">
                            {OPTION_TYPE_OPTIONS.map((optionType) => (
                              <button
                                className="sqm-variant-menu__item"
                                key={optionType.value}
                                onClick={() => addOptionGroup(optionType.value)}
                                type="button"
                              >
                                <strong>{optionType.label}</strong>
                                <span>{optionType.description}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="sqm-option-groups">
                      {productConfig.optionGroups.map((group, groupIndex) => {
                        const summary = summarizeOptionGroup(group);

                        return (
                          <article className="sqm-option-card" key={`${group.id}-${groupIndex}`}>
                            <div className="sqm-option-card__header">
                              <div>
                                <h3>{group.label || `Variante ${groupIndex + 1}`}</h3>
                                <p>Tipo: {OPTION_TYPE_OPTIONS.find((optionType) => optionType.value === group.type)?.label ?? group.type}</p>
                                <p>Valori: {summary.valuesLabel}</p>
                                <p>Prezzo: {summary.pricedLabel}</p>
                              </div>
                              <div className="sqm-option-card__actions">
                                <button
                                  className="sqm-button sqm-button--small"
                                  onClick={() => editOptionGroup(groupIndex)}
                                  type="button"
                                >
                                  Modifica
                                </button>
                                <button
                                  className="sqm-button sqm-button--small"
                                  onClick={() => duplicateOptionGroup(groupIndex)}
                                  type="button"
                                >
                                  Duplica
                                </button>
                                <button
                                  className="sqm-button sqm-button--small sqm-button--danger"
                                  onClick={() => removeOptionGroup(groupIndex)}
                                  type="button"
                                >
                                  Elimina
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>

                    {draftOptionGroup ? (
                      <article className="sqm-option-card sqm-option-card--draft">
                        <div className="sqm-option-card__header">
                          <div>
                            <h3>
                              {editingOptionGroupIndex === null
                                ? "Nuova variante"
                                : "Modifica variante"}
                            </h3>
                            <p>
                              Configura la variante e salvala solo quando hai finito.
                            </p>
                          </div>
                        </div>

                        <div className="sqm-option-card__grid">
                          <label className="sqm-field">
                            <span>Titolo variante</span>
                            <input
                              onChange={(event) =>
                                updateOptionGroup("label", event.target.value)
                              }
                              placeholder="Es. Plastificazione"
                              type="text"
                              value={draftOptionGroup.label}
                            />
                          </label>

                          <label className="sqm-field">
                            <span>Icona titolo</span>
                            <select
                              onChange={(event) =>
                                updateOptionGroup("icon", event.target.value)
                              }
                              value={draftOptionGroup.icon ?? ""}
                            >
                              {ICON_OPTIONS.map((icon) => (
                                <option key={icon.value || "none"} value={icon.value}>
                                  {icon.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="sqm-field">
                            <span>Tipo variante</span>
                            <select
                              onChange={(event) =>
                                updateOptionGroup("type", event.target.value)
                              }
                              value={draftOptionGroup.type}
                            >
                              {OPTION_TYPE_OPTIONS.map((optionType) => (
                                <option key={optionType.value} value={optionType.value}>
                                  {optionType.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="sqm-field sqm-field--wide">
                            <span>Descrizione / help text</span>
                            <input
                              onChange={(event) =>
                                updateOptionGroup("helpText", event.target.value)
                              }
                              placeholder="Testo opzionale sotto il titolo"
                              type="text"
                              value={draftOptionGroup.helpText ?? ""}
                            />
                          </label>
                        </div>

                        <div className="sqm-option-card__toggles">
                          <label className="sqm-toggle sqm-toggle--block">
                            <input
                              checked={draftOptionGroup.required}
                              onChange={(event) =>
                                updateOptionGroup(
                                  "required",
                                  event.currentTarget.checked,
                                )
                              }
                              type="checkbox"
                            />
                            <span>Obbligatoria</span>
                          </label>

                          <label className="sqm-toggle sqm-toggle--block">
                            <input
                              checked={draftOptionGroup.showInSummary}
                              onChange={(event) =>
                                updateOptionGroup(
                                  "showInSummary",
                                  event.currentTarget.checked,
                                )
                              }
                              type="checkbox"
                            />
                            <span>Mostra nel riepilogo ordine</span>
                          </label>

                          <label className="sqm-toggle sqm-toggle--block">
                            <input
                              checked={draftOptionGroup.saveToProperties}
                              onChange={(event) =>
                                updateOptionGroup(
                                  "saveToProperties",
                                  event.currentTarget.checked,
                                )
                              }
                              type="checkbox"
                            />
                            <span>Salva nelle line item properties</span>
                          </label>
                        </div>

                        <div className="sqm-section-heading sqm-section-heading--tight">
                          <div>
                            <h2>Valori variante</h2>
                            <p>Aggiungi i valori visibili nel configuratore frontend.</p>
                          </div>
                          <button
                            className="sqm-button"
                            onClick={addOptionValue}
                            type="button"
                          >
                            + Aggiungi valore
                          </button>
                        </div>

                        <div className="sqm-option-values">
                          {draftOptionGroup.options.map((option, optionIndex) => (
                            <div className="sqm-option-value" key={`draft-option-${optionIndex}`}>
                              <div className="sqm-option-value__header">
                                <strong>{option.label || `Valore ${optionIndex + 1}`}</strong>
                                <div className="sqm-option-card__actions">
                                  <button
                                    className="sqm-icon-button"
                                    onClick={() => duplicateOptionValue(optionIndex)}
                                    type="button"
                                  >
                                    ⧉
                                  </button>
                                  <button
                                    className="sqm-icon-button"
                                    onClick={() => removeOptionValue(optionIndex)}
                                    type="button"
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>

                              <div className="sqm-option-card__grid sqm-option-card__grid--value">
                                <label className="sqm-field">
                                  <span>Etichetta visibile</span>
                                  <input
                                    onChange={(event) =>
                                      updateOptionValue(
                                        optionIndex,
                                        "label",
                                        event.target.value,
                                      )
                                    }
                                    placeholder="Es. Opaca"
                                    type="text"
                                    value={option.label}
                                  />
                                </label>

                                <label className="sqm-field">
                                  <span>Valore interno</span>
                                  <input
                                    onChange={(event) =>
                                      updateOptionValue(
                                        optionIndex,
                                        "value",
                                        event.target.value,
                                      )
                                    }
                                    placeholder="Es. opaca"
                                    type="text"
                                    value={option.value}
                                  />
                                </label>

                                <label className="sqm-field">
                                  <span>Badge</span>
                                  <input
                                    onChange={(event) =>
                                      updateOptionValue(
                                        optionIndex,
                                        "badge",
                                        event.target.value,
                                      )
                                    }
                                    placeholder="Es. Premium"
                                    type="text"
                                    value={option.badge ?? ""}
                                  />
                                </label>

                                <label className="sqm-field">
                                  <span>Valore default</span>
                                  <select
                                    onChange={(event) =>
                                      setOptionDefault(event.target.value)
                                    }
                                    value={draftOptionGroup.defaultValue}
                                  >
                                    {draftOptionGroup.options.map((groupOption) => (
                                      <option key={groupOption.value} value={groupOption.value}>
                                        {groupOption.label || groupOption.value}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label className="sqm-field">
                                  <span>Tipo modifica prezzo</span>
                                  <select
                                    onChange={(event) =>
                                      updateOptionPriceModifier(
                                        optionIndex,
                                        "type",
                                        event.target.value,
                                      )
                                    }
                                    value={option.priceModifier.type}
                                  >
                                    {PRICE_TYPE_OPTIONS.map((priceType) => (
                                      <option key={priceType.value} value={priceType.value}>
                                        {priceType.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                <label className="sqm-field">
                                  <span>Importo modifica prezzo</span>
                                  <input
                                    disabled={option.priceModifier.type === "none"}
                                    onChange={(event) =>
                                      updateOptionPriceModifier(
                                        optionIndex,
                                        "amount",
                                        event.target.value,
                                      )
                                    }
                                    step="0.01"
                                    type="number"
                                    value={option.priceModifier.amount || ""}
                                  />
                                </label>

                                <label className="sqm-field">
                                  <span>Applica su</span>
                                  <select
                                    onChange={(event) =>
                                      updateOptionPriceModifier(
                                        optionIndex,
                                        "target",
                                        event.target.value,
                                      )
                                    }
                                    value={option.priceModifier.target ?? "subtotal"}
                                  >
                                    <option value="subtotal">Subtotale</option>
                                    <option value="base">Prezzo base</option>
                                  </select>
                                </label>

                                <label className="sqm-field sqm-field--wide">
                                  <span>Etichetta prezzo frontend</span>
                                  <input
                                    onChange={(event) =>
                                      updateOptionPriceModifier(
                                        optionIndex,
                                        "frontendLabel",
                                        event.target.value,
                                      )
                                    }
                                    placeholder="Es. +2,50 €/mq"
                                    type="text"
                                    value={option.priceModifier.frontendLabel ?? ""}
                                  />
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="sqm-option-preview">
                          <div className="sqm-option-preview__title">
                            Preview configuratore
                          </div>
                          <div className="sqm-option-preview__label">
                            {draftOptionGroup.icon ? <span>{draftOptionGroup.icon}</span> : null}
                            <strong>{draftOptionGroup.label || "Titolo variante"}</strong>
                          </div>
                          {draftOptionGroup.helpText ? (
                            <p className="sqm-option-preview__help">
                              {draftOptionGroup.helpText}
                            </p>
                          ) : null}
                          {draftOptionGroup.type === "dropdown" ? (
                            <select disabled value={draftOptionGroup.defaultValue}>
                              {draftOptionGroup.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                  {formatPriceModifierLabel(option.priceModifier)
                                    ? ` ${formatPriceModifierLabel(option.priceModifier)}`
                                    : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div className="sqm-option-preview__chips">
                              {draftOptionGroup.options.map((option) => (
                                <span
                                  className={`sqm-option-preview__chip ${
                                    draftOptionGroup.defaultValue === option.value
                                      ? "is-active"
                                      : ""
                                  }`}
                                  key={option.value}
                                >
                                  {option.label || option.value}
                                  {option.badge ? ` · ${option.badge}` : ""}
                                  {formatPriceModifierLabel(option.priceModifier)
                                    ? ` ${formatPriceModifierLabel(option.priceModifier)}`
                                    : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="sqm-actions sqm-actions--inline">
                          <button
                            className="sqm-button sqm-button--primary"
                            disabled={Boolean(validateOptionGroup(draftOptionGroup).length)}
                            onClick={saveDraftOptionGroup}
                            type="button"
                          >
                            Salva variante
                          </button>
                          <button
                            className="sqm-button"
                            onClick={cancelDraftOptionGroup}
                            type="button"
                          >
                            Annulla
                          </button>
                        </div>

                        {validateOptionGroup(draftOptionGroup).length ? (
                          <div className="sqm-errors">
                            {validateOptionGroup(draftOptionGroup).map((error) => (
                              <p key={error}>{error}</p>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ) : null}

                    {!productConfig.optionGroups.length && !draftOptionGroup ? (
                      <p className="sqm-empty">
                        Nessuna variante extra configurata. Il frontend continuera a
                        usare il calcolatore standard.
                      </p>
                    ) : null}

                    <details className="sqm-advanced-json">
                      <summary>Editor JSON avanzato</summary>
                      <label className="sqm-field sqm-json-editor">
                        <span>JSON configurazione</span>
                        <textarea
                          onBlur={() => {
                            if (!productConfigJsonErrors.length) {
                              applyAdvancedJson();
                            }
                          }}
                          onChange={(event) => setProductConfigJson(event.target.value)}
                          rows={14}
                          spellCheck={false}
                          value={productConfigJson}
                        />
                      </label>
                    </details>

                    {productConfigErrors.length ? (
                      <div className="sqm-errors">
                        {productConfigErrors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}

                    {productConfigJsonErrors.length ? (
                      <div className="sqm-errors">
                        {productConfigJsonErrors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  <section
                    className={`sqm-tab-panel ${activeTab === "calculation" ? "is-active" : ""}`}
                    hidden={activeTab !== "calculation"}
                  >
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

                    <div className="sqm-section-heading sqm-section-heading--spaced">
                      <div>
                        <h2>Imballaggio</h2>
                        <p>
                          Aggiunge automaticamente un costo di imballaggio in base
                          alle misure inserite, alla quantità e al costo al mq
                          configurato per questo prodotto.
                        </p>
                      </div>
                    </div>

                    <div className="sqm-promo-box sqm-packaging-box">
                      <label className="sqm-toggle sqm-toggle--block">
                        <input
                          checked={productConfig.packaging.enabled}
                          onChange={(event) =>
                            updatePackagingField(
                              "enabled",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        <span>Abilita costo imballaggio</span>
                      </label>

                      <div className="sqm-promo-meta sqm-promo-meta--triple">
                        <label className="sqm-field">
                          <span>Costo imballaggio al mq</span>
                          <input
                            min="0"
                            onChange={(event) =>
                              updatePackagingField("costPerSqm", event.target.value)
                            }
                            placeholder="Es. 2,50"
                            step="0.01"
                            type="number"
                            value={productConfig.packaging.costPerSqm || ""}
                          />
                        </label>

                        <label className="sqm-field">
                          <span>Dimensione massima pannello per spedizione</span>
                          <input
                            min="1"
                            onChange={(event) =>
                              updatePackagingField("maxPanelSizeCm", event.target.value)
                            }
                            placeholder="150"
                            step="0.1"
                            type="number"
                            value={productConfig.packaging.maxPanelSizeCm || ""}
                          />
                        </label>

                        <label className="sqm-field">
                          <span>Costo minimo imballaggio</span>
                          <input
                            min="0"
                            onChange={(event) =>
                              updatePackagingField("minimumCost", event.target.value)
                            }
                            placeholder="Es. 5,00"
                            step="0.01"
                            type="number"
                            value={productConfig.packaging.minimumCost || ""}
                          />
                        </label>
                      </div>
                    </div>

                    {actionData?.errors?.length ? (
                      <div className="sqm-errors">
                        {actionData.errors.map((error) => (
                          <p key={error}>{error}</p>
                        ))}
                      </div>
                    ) : null}
                  </section>
                </div>

                <div className="sqm-actions">
                  <button
                    className="sqm-button sqm-button--primary"
                    disabled={
                      isSaving ||
                      Boolean(rangeErrors.length) ||
                      Boolean(promoErrors.length) ||
                      Boolean(productConfigErrors.length) ||
                      Boolean(productConfigJsonErrors.length)
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
  :root {
    --sqm-green: #089225;
    --sqm-green-dark: #066e1c;
    --sqm-green-soft: #eff9f1;
    --sqm-green-soft-2: #f8fcf9;
    --sqm-green-soft-3: #f4fbf6;
    --sqm-ink: #212529;
    --sqm-muted: #5f6b76;
    --sqm-line: #dfe8e2;
    --sqm-shadow: 0 18px 40px rgba(33, 37, 41, 0.08);
    --sqm-shadow-soft: 0 12px 28px rgba(33, 37, 41, 0.05);
  }

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
    background: linear-gradient(180deg, #ffffff 0%, #fbfdfb 100%);
    border: 1px solid var(--sqm-line);
    border-radius: 22px;
    box-shadow: var(--sqm-shadow);
    min-width: 0;
    overflow: visible;
    padding: 22px;
  }

  .sqm-panel--compact {
    padding: 20px;
  }

  .sqm-panel__header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 20px;
  }

  .sqm-panel__header h1,
  .sqm-panel__header h2,
  .sqm-section-heading h2,
  .sqm-variants h2 {
    margin: 0;
    color: var(--sqm-ink);
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

  .sqm-product-status {
    display: grid;
    gap: 8px;
    justify-items: end;
    padding: 10px 12px;
    border: 1px solid var(--sqm-line);
    border-radius: 14px;
    background: linear-gradient(180deg, #ffffff 0%, var(--sqm-green-soft-3) 100%);
  }

  .sqm-product-status__label {
    color: var(--sqm-muted);
    font-size: 12px;
    font-weight: 700;
  }

  .sqm-kicker {
    margin: 0 0 4px;
    color: var(--sqm-muted);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .sqm-muted,
  .sqm-section-heading p,
  .sqm-empty {
    color: var(--sqm-muted);
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.45;
  }

  .sqm-counter {
    align-items: center;
    background: var(--sqm-green-soft);
    border-radius: 999px;
    color: var(--sqm-green-dark);
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
  .sqm-field select,
  .sqm-field textarea {
    border: 1px solid #ced8d2;
    border-radius: 10px;
    box-sizing: border-box;
    font: inherit;
    min-height: 44px;
    padding: 9px 12px;
    width: 100%;
    background: #fcfefd;
    color: var(--sqm-ink);
    transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
  }

  .sqm-field input:focus,
  .sqm-field select:focus,
  .sqm-field textarea:focus,
  .sqm-search input:focus {
    border-color: var(--sqm-green);
    box-shadow: 0 0 0 3px rgba(8, 146, 37, 0.12);
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

  .sqm-advanced-json {
    margin-bottom: 18px;
  }

  .sqm-advanced-json summary {
    color: #202223;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 10px;
  }

  .sqm-search button,
  .sqm-button {
    background: #ffffff;
    border: 1px solid #b9c8bf;
    border-radius: 10px;
    color: var(--sqm-ink);
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    min-height: 42px;
    padding: 8px 14px;
    transition: border-color .18s ease, background-color .18s ease, box-shadow .18s ease, color .18s ease;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8);
  }

  .sqm-button--primary {
    background: linear-gradient(180deg, var(--sqm-green) 0%, var(--sqm-green-dark) 100%);
    border-color: var(--sqm-green);
    color: #ffffff;
    box-shadow: 0 12px 24px rgba(8, 146, 37, 0.16);
  }

  .sqm-button:hover,
  .sqm-search button:hover {
    border-color: var(--sqm-green);
    background: var(--sqm-green-soft-3);
    box-shadow: var(--sqm-shadow-soft);
  }

  .sqm-button--primary:hover {
    background: linear-gradient(180deg, #0aa32a 0%, var(--sqm-green) 100%);
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
    border: 1px solid var(--sqm-line);
    border-radius: 16px;
    color: var(--sqm-ink);
    display: flex;
    gap: 10px;
    justify-content: space-between;
    padding: 14px;
    text-decoration: none;
    background: #ffffff;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.9);
    transition: border-color .18s ease, background-color .18s ease, transform .18s ease, box-shadow .18s ease;
  }

  .sqm-product strong,
  .sqm-product small {
    display: block;
  }

  .sqm-product small {
    color: var(--sqm-muted);
    margin-top: 2px;
  }

  .sqm-product em {
    color: var(--sqm-green);
    font-size: 12px;
    font-style: normal;
    font-weight: 700;
  }

  .sqm-product.is-selected {
    background: var(--sqm-green-soft);
    border-color: var(--sqm-green);
    transform: translateY(-1px);
    box-shadow: 0 14px 28px rgba(8, 146, 37, 0.1);
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

  .sqm-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 20px;
    padding: 6px;
    border: 1px solid var(--sqm-line);
    border-radius: 18px;
    background: linear-gradient(180deg, #fcfefd 0%, #f6fbf7 100%);
  }

  .sqm-tab {
    min-height: 48px;
    border: 1px solid transparent;
    border-radius: 14px;
    background: transparent;
    color: var(--sqm-ink);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 10px 14px;
    text-align: center;
    transition: border-color .18s ease, background-color .18s ease, color .18s ease, box-shadow .18s ease;
  }

  .sqm-tab.is-active {
    border-color: var(--sqm-green);
    background: linear-gradient(180deg, #ffffff 0%, var(--sqm-green-soft) 100%);
    color: var(--sqm-green-dark);
    box-shadow: 0 10px 22px rgba(8, 146, 37, 0.12);
  }

  .sqm-tab-panels {
    display: grid;
    gap: 16px;
  }

  .sqm-tab-panel {
    background: linear-gradient(180deg, #ffffff 0%, var(--sqm-green-soft-2) 100%);
    border: 1px solid var(--sqm-line);
    border-radius: 18px;
    overflow: visible;
    padding: 20px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95);
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

  .sqm-section-heading--spaced {
    margin-top: 22px;
  }

  .sqm-variant-menu {
    position: relative;
  }

  .sqm-variant-menu__popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    z-index: 5;
    width: 280px;
    display: grid;
    gap: 6px;
    max-height: min(360px, calc(100vh - 180px));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px;
    border: 1px solid var(--sqm-line);
    border-radius: 14px;
    background: #ffffff;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);
  }

  .sqm-variant-menu__item {
    width: 100%;
    text-align: left;
    background: #ffffff;
    border: 1px solid #d9e2dd;
    border-radius: 10px;
    padding: 10px 12px;
    cursor: pointer;
    display: grid;
    gap: 4px;
  }

  .sqm-variant-menu__item strong {
    color: var(--sqm-ink);
    font-size: 13px;
  }

  .sqm-variant-menu__item span {
    color: var(--sqm-muted);
    font-size: 12px;
    line-height: 1.35;
  }

  .sqm-variant-menu__item:hover {
    border-color: var(--sqm-green);
    background: var(--sqm-green-soft);
  }

  .sqm-promo-box {
    background: #ffffff;
    border: 1px solid var(--sqm-line);
    border-radius: 16px;
    padding: 16px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), var(--sqm-shadow-soft);
  }

  .sqm-packaging-box {
    background: linear-gradient(180deg, #ffffff 0%, var(--sqm-green-soft-2) 100%);
    border-color: #cfe5d5;
  }

  .sqm-promo-meta {
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(120px, 0.6fr) minmax(0, 1.4fr);
  }

  .sqm-promo-meta--triple {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .sqm-range-list {
    display: grid;
    gap: 10px;
  }

  .sqm-range-row {
    align-items: end;
    background: linear-gradient(180deg, #ffffff 0%, #fbfdfb 100%);
    border: 1px solid var(--sqm-line);
    border-radius: 14px;
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(82px, 1fr) minmax(82px, 1fr) minmax(82px, 0.8fr) minmax(140px, 1.45fr) 38px;
    padding: 14px;
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

  .sqm-option-groups {
    display: grid;
    gap: 14px;
    margin-bottom: 18px;
  }

  .sqm-option-card {
    background: linear-gradient(180deg, #ffffff 0%, #fbfdfb 100%);
    border: 1px solid var(--sqm-line);
    border-radius: 16px;
    padding: 16px;
    box-shadow: var(--sqm-shadow-soft);
  }

  .sqm-option-card--draft {
    border-color: var(--sqm-green);
    box-shadow: 0 0 0 1px rgba(8, 146, 37, 0.12), 0 16px 34px rgba(8, 146, 37, 0.08);
  }

  .sqm-option-card__header,
  .sqm-option-value__header {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .sqm-option-card__header h3,
  .sqm-option-value__header strong {
    color: var(--sqm-ink);
    margin: 0;
  }

  .sqm-option-card__header p {
    color: var(--sqm-muted);
    margin: 4px 0 0;
  }

  .sqm-option-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .sqm-button--small {
    min-height: 32px;
    padding: 6px 10px;
    font-size: 13px;
  }

  .sqm-button--danger {
    border-color: #d82c0d;
    color: #d82c0d;
  }

  .sqm-button--danger:hover {
    background: #fff4f4;
  }

  .sqm-option-card__grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 12px;
  }

  .sqm-option-card__grid--value {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .sqm-option-card__toggles {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 14px;
  }

  .sqm-option-values {
    display: grid;
    gap: 10px;
  }

  .sqm-option-value {
    background: #ffffff;
    border: 1px solid #e1eae4;
    border-radius: 14px;
    padding: 14px;
  }

  .sqm-option-preview {
    background: linear-gradient(180deg, #ffffff 0%, var(--sqm-green-soft-3) 100%);
    border: 1px dashed #c9d8cf;
    border-radius: 14px;
    margin-top: 14px;
    padding: 14px;
  }

  .sqm-option-preview__title {
    color: var(--sqm-muted);
    font-size: 11px;
    font-weight: 700;
    margin-bottom: 8px;
    text-transform: uppercase;
  }

  .sqm-option-preview__label {
    align-items: center;
    color: var(--sqm-ink);
    display: flex;
    gap: 8px;
  }

  .sqm-option-preview__help {
    color: #6d7175;
    margin: 6px 0 10px;
  }

  .sqm-option-preview__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .sqm-option-preview__chip {
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 999px;
    color: #202223;
    display: inline-flex;
    font-size: 13px;
    font-weight: 650;
    padding: 8px 12px;
  }

  .sqm-option-preview__chip.is-active {
    background: #edf8f1;
    border-color: var(--sqm-green);
    color: var(--sqm-green);
  }

  .sqm-variants {
    margin-top: 18px;
  }

  .sqm-variants h2 {
    margin-bottom: 0;
  }

  .sqm-variants .sqm-muted {
    margin-bottom: 12px;
  }

  .sqm-field span {
    color: var(--sqm-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .sqm-icon-button {
    background: #ffffff;
    border: 1px solid #d3ddd7;
    border-radius: 10px;
    cursor: pointer;
    font-size: 18px;
    height: 38px;
    line-height: 1;
    width: 38px;
    transition: border-color .18s ease, background-color .18s ease, color .18s ease;
  }

  .sqm-icon-button:hover {
    background: #fff4f4;
    border-color: #fed3d1;
    color: #8e1f0b;
  }

  .sqm-errors {
    background: #fff4f4;
    border: 1px solid #fed3d1;
    border-radius: 12px;
    color: #8e1f0b;
    margin-top: 12px;
    padding: 12px 14px;
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
    border: 1px solid var(--sqm-line);
    border-radius: 12px;
    padding: 12px 14px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfdfb 100%);
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
    border-top: 1px solid var(--sqm-line);
    display: flex;
    justify-content: flex-end;
    margin-top: 20px;
    padding-top: 16px;
  }

  .sqm-actions--inline {
    border-top: 0;
    justify-content: flex-start;
    margin-top: 16px;
    padding-top: 0;
    gap: 10px;
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

    .sqm-promo-meta--triple {
      grid-template-columns: 1fr;
    }

    .sqm-option-card__grid,
    .sqm-option-card__grid--value,
    .sqm-option-card__toggles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
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

    .sqm-product-status {
      justify-items: start;
    }

    .sqm-variant-menu__popover {
      left: 0;
      right: auto;
      width: min(100%, 320px);
    }

    .sqm-tabs {
      grid-template-columns: 1fr;
    }

    .sqm-option-card__header,
    .sqm-option-value__header {
      align-items: stretch;
      flex-direction: column;
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

    .sqm-option-card__grid,
    .sqm-option-card__grid--value,
    .sqm-option-card__toggles {
      grid-template-columns: 1fr;
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
