import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useNavigation, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

type VopoMetafield = {
  namespace: string;
  key: string;
  type: string;
  value: string;
};

type VopoProduct = {
  id: string;
  title: string;
  handle: string;
  metafields: {
    nodes: VopoMetafield[];
  };
};

type CleanPatch = {
  productId: string;
  productTitle: string;
  productHandle: string;
  namespace: string;
  key: string;
  type: string;
  nextValue: string;
  removedCount: number;
};

type InsertPatch = Omit<CleanPatch, "removedCount"> & {
  insertedCount: number;
};

type EditPatch = Omit<CleanPatch, "removedCount"> & {
  editedCount: number;
};

type GazeboPatch = Omit<CleanPatch, "removedCount"> & {
  gazeboCount: number;
};

type CleanerOperation = "remove" | "insert" | "edit" | "gazebo";

type CleanerResult = {
  ok: boolean;
  operation?: CleanerOperation;
  mode?: "preview" | "apply";
  scannedProducts?: number;
  matchedProducts?: number;
  matchedMetafields?: number;
  affectedOptions?: number;
  details?: string[];
  errors?: string[];
};

type MatchCriterion = "any" | "title" | "type" | "instructions";

const OPTION_TITLE_KEYS = ["title", "label", "name", "nome", "option_title", "display_name"];
const OPTION_TYPE_KEYS = ["type", "kind", "field_type", "option_type", "input_type", "display_type"];
const OPTION_INSTRUCTION_KEYS = [
  ...OPTION_TITLE_KEYS,
  ...OPTION_TYPE_KEYS,
  "instructions",
  "instruction",
  "content",
  "description",
  "help_text",
  "html",
  "text",
  "body",
];

const PRODUCTS_QUERY = `#graphql
  query VopoCleanerProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        metafields(first: 250) {
          nodes {
            namespace
            key
            type
            value
          }
        }
      }
    }
  }
`;

function normalizeProductSearchQuery(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return "";
  if (/^handle:/i.test(trimmed)) return trimmed;

  const parenthesizedHandle = trimmed.match(/\(([a-z0-9][a-z0-9-]*[a-z0-9])\)\s*$/i);
  if (parenthesizedHandle?.[1]) {
    return `handle:${parenthesizedHandle[1]}`;
  }

  return trimmed;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation VopoCleanerMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

async function adminGraphql(admin: any, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message: string }) => error.message).join(" "));
  }

  return json.data;
}

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function maybeParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function objectStringsByKeys(value: unknown, keys: string[]) {
  if (!isRecord(value)) return [];
  const normalizedKeys = keys.map(normalize);
  const output: string[] = [];

  Object.entries(value).forEach(([key, child]) => {
    if (normalizedKeys.includes(normalize(key)) && typeof child !== "object") {
      output.push(String(child ?? ""));
    }
  });

  return output;
}

function collectStrings(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function matchesOption(value: unknown, criterion: MatchCriterion, searchText: string) {
  const needle = normalize(searchText);
  if (!needle) return false;

  let haystack: string[];
  if (criterion === "title") {
    haystack = objectStringsByKeys(value, OPTION_TITLE_KEYS);
  } else if (criterion === "type") {
    haystack = objectStringsByKeys(value, OPTION_TYPE_KEYS);
  } else if (criterion === "instructions") {
    haystack = objectStringsByKeys(value, OPTION_INSTRUCTION_KEYS);
  } else {
    haystack = collectStrings(value);
  }

  return haystack.some((text) => normalize(text).includes(needle));
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function slugify(value: string) {
  return (
    normalize(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "prodotto"
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SIZE_OPTIONS = [
  { value: "XXS", name: "Double Extra Small" },
  { value: "XS", name: "Extra Small" },
  { value: "S", name: "Small" },
  { value: "M", name: "Medium" },
  { value: "L", name: "Large" },
  { value: "XL", name: "Extra Large" },
  { value: "XXL", name: "Double Extra Large" },
  { value: "3XL", name: "Triple Extra Large" },
  { value: "4XL", name: "Quadruple Extra Large" },
  { value: "5XL", name: "Quintuple Extra Large" },
];

const GAZEBO_POSITIONS = ["Alto", "Destra", "Basso", "Sinistra"];
const GAZEBO_BASE_CENTS = 28000;

function buildGazeboFinishingInstructionHtml() {
  const spicchiControls = GAZEBO_POSITIONS.map(
    (position, index) =>
      `<button type="button" class="ws-gazebo__chip" data-ws-gazebo-toggle="spicchi" data-ws-gazebo-index="${index}" aria-pressed="false">${escapeHtml(position)}</button>`,
  ).join("");
  const fasceControls = GAZEBO_POSITIONS.map(
    (position, index) =>
      `<button type="button" class="ws-gazebo__chip" data-ws-gazebo-toggle="fasce" data-ws-gazebo-index="${index}" aria-pressed="false">${escapeHtml(position)}</button>`,
  ).join("");

  return `<div class="ws-gazebo-finishing" data-ws-gazebo-finishing data-ws-gazebo-base-cents="${GAZEBO_BASE_CENTS}">
  <div class="ws-gazebo__head">
    <span class="ws-bcpo-icon ws-gazebo__head-icon" aria-hidden="true"><img src="https://cdn.shopify.com/s/files/1/0555/0601/0321/files/setting.svg?v=1772452690" alt="" loading="lazy" decoding="async" width="20" height="20" class="ws-bcpo-icon__img"></span>
    <div>
      <div class="ws-gazebo__title">Lavorazioni e Rifiniture</div>
      <div class="ws-gazebo__value" data-ws-gazebo-label>Solo Struttura</div>
    </div>
  </div>

  <div class="ws-gazebo__body">
    <button type="button" class="ws-gazebo__preview" data-ws-gazebo-preset="none" aria-label="Schema lavorazioni gazebo">
      <svg class="ws-gazebo__svg" viewBox="0 0 120 120" aria-hidden="true">
        <defs><linearGradient id="wsGazeboSegGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#22d36a"></stop><stop offset="100%" stop-color="#0f9f43"></stop></linearGradient></defs>
        <polygon data-ws-gazebo-shape="spicchi" data-ws-gazebo-index="0" points="60,14 87,48 33,48"></polygon>
        <polygon data-ws-gazebo-shape="spicchi" data-ws-gazebo-index="1" points="106,60 72,87 72,33"></polygon>
        <polygon data-ws-gazebo-shape="spicchi" data-ws-gazebo-index="2" points="60,106 33,72 87,72"></polygon>
        <polygon data-ws-gazebo-shape="spicchi" data-ws-gazebo-index="3" points="14,60 48,33 48,87"></polygon>
        <rect data-ws-gazebo-shape="fasce" data-ws-gazebo-index="0" x="37" y="5" width="46" height="10" rx="4"></rect>
        <rect data-ws-gazebo-shape="fasce" data-ws-gazebo-index="1" x="105" y="37" width="10" height="46" rx="4"></rect>
        <rect data-ws-gazebo-shape="fasce" data-ws-gazebo-index="2" x="37" y="105" width="46" height="10" rx="4"></rect>
        <rect data-ws-gazebo-shape="fasce" data-ws-gazebo-index="3" x="5" y="37" width="10" height="46" rx="4"></rect>
        <circle cx="60" cy="60" r="8"></circle>
      </svg>
      <span>Vista dall'alto</span>
    </button>

    <div class="ws-gazebo__controls">
      <div class="ws-gazebo__presets">
        <button type="button" class="ws-gazebo__preset" data-ws-gazebo-preset="none" aria-pressed="true">Solo struttura</button>
        <button type="button" class="ws-gazebo__preset" data-ws-gazebo-preset="all" aria-pressed="false">Completo</button>
      </div>
      <div class="ws-gazebo__group">
        <div class="ws-gazebo__group-head"><span>Spicchi tetto</span><button type="button" data-ws-gazebo-all="spicchi">Tutti</button></div>
        <div class="ws-gazebo__chips">${spicchiControls}</div>
      </div>
      <div class="ws-gazebo__group">
        <div class="ws-gazebo__group-head"><span>Fasce laterali</span><button type="button" data-ws-gazebo-all="fasce">Tutte</button></div>
        <div class="ws-gazebo__chips">${fasceControls}</div>
      </div>
    </div>
  </div>

  <div class="ws-gazebo__summary"><span aria-hidden="true"></span><strong>Configurazione selezionata</strong><em data-ws-gazebo-summary>Solo Struttura</em></div>
  <p class="ws-gazebo__hint">La struttura base e telo tetto e sempre inclusa. Tocca lo schema o i pulsanti per personalizzare ogni lato.</p>
  <input type="hidden" name="properties[Lavorazioni e Rifiniture]" data-ws-gazebo-property value="Solo Struttura">
  <input type="hidden" name="properties[_ws_gazebo_final_price_cents]" data-ws-gazebo-final-cents value="${GAZEBO_BASE_CENTS}">
</div>`;
}

function getSizeRange(fromSize: string, toSize: string) {
  const fromIndex = SIZE_OPTIONS.findIndex((size) => size.value === fromSize);
  const toIndex = SIZE_OPTIONS.findIndex((size) => size.value === toSize);
  const safeFrom = fromIndex >= 0 ? fromIndex : 0;
  const safeTo = toIndex >= 0 ? toIndex : SIZE_OPTIONS.length - 1;
  const start = Math.min(safeFrom, safeTo);
  const end = Math.max(safeFrom, safeTo);

  return SIZE_OPTIONS.slice(start, end + 1);
}

function buildSizesInstructionHtml(productType: string, fromSize: string, toSize: string) {
  const displayType = titleCase(productType.trim() || "Prodotto");
  const packKey = `taglie-${slugify(productType)}`;
  const propertyName = `Taglie ${displayType}`;
  const sizes = getSizeRange(fromSize, toSize);

  const items = sizes
    .map(
      (size) => `
  <div class="ws-sizes__item">
    <div class="ws-sizes__left">
      <span class="ws-sizes__badge">${escapeHtml(size.value)}</span>
      <span class="ws-sizes__name">${escapeHtml(size.name)}</span>
    </div>
    <input class="ws-size-qty" type="number" min="0" value="0" inputmode="numeric">
  </div>`,
    )
    .join("\n");

  return `<div class="bcpo-label"><label><span class="ws-bcpo-icon"><img src="https://cdn.shopify.com/s/files/1/0555/0601/0321/files/ruler.svg?v=1772452690" alt="" loading="lazy" decoding="async" width="20" height="20" class="ws-bcpo-icon__img"></span><span class="bcpo-title" data-ws-icon-done="1">Taglia:</span></label></div>

<div class="ws-sizes ws-sizes--cards" data-pack-key="${escapeHtml(packKey)}">
${items}

  <input type="hidden" name="properties[${escapeHtml(propertyName)}]" data-ws-sizes-summary value="">
  <div class="ws-sizes__error" aria-live="polite" hidden></div>
</div>`;
}

function cleanJson(value: unknown, criterion: MatchCriterion, searchText: string): {
  value: unknown;
  removedCount: number;
} {
  if (Array.isArray(value)) {
    let removedCount = 0;
    const nextItems: unknown[] = [];

    value.forEach((item) => {
      if (matchesOption(item, criterion, searchText)) {
        removedCount += 1;
        return;
      }

      const cleaned = cleanJson(item, criterion, searchText);
      removedCount += cleaned.removedCount;
      nextItems.push(cleaned.value);
    });

    return { value: nextItems, removedCount };
  }

  if (isRecord(value)) {
    let removedCount = 0;
    const nextObject: Record<string, unknown> = {};

    Object.entries(value).forEach(([key, child]) => {
      const cleaned = cleanJson(child, criterion, searchText);
      removedCount += cleaned.removedCount;
      nextObject[key] = cleaned.value;
    });

    return { value: nextObject, removedCount };
  }

  return { value, removedCount: 0 };
}

function renameOptionTitle(value: unknown, nextTitle: string): {
  value: unknown;
  changed: boolean;
} {
  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  let foundTitleKey = false;
  const nextValue: Record<string, unknown> = { ...value };

  Object.keys(value).forEach((key) => {
    if (!OPTION_TITLE_KEYS.includes(normalize(key))) return;

    foundTitleKey = true;
    if (nextValue[key] !== nextTitle) {
      nextValue[key] = nextTitle;
      changed = true;
    }
  });

  if (!foundTitleKey) {
    nextValue.title = nextTitle;
    changed = true;
  }

  return { value: nextValue, changed };
}

function editJson(value: unknown, criterion: MatchCriterion, searchText: string, nextTitle: string): {
  value: unknown;
  editedCount: number;
} {
  if (Array.isArray(value)) {
    let editedCount = 0;
    const nextItems = value.map((item) => {
      if (matchesOption(item, criterion, searchText)) {
        const renamed = renameOptionTitle(item, nextTitle);
        if (renamed.changed) editedCount += 1;
        return renamed.value;
      }

      const edited = editJson(item, criterion, searchText, nextTitle);
      editedCount += edited.editedCount;
      return edited.value;
    });

    return { value: nextItems, editedCount };
  }

  if (isRecord(value)) {
    let editedCount = 0;
    const nextObject: Record<string, unknown> = {};

    Object.entries(value).forEach(([key, child]) => {
      const edited = editJson(child, criterion, searchText, nextTitle);
      editedCount += edited.editedCount;
      nextObject[key] = edited.value;
    });

    return { value: nextObject, editedCount };
  }

  return { value, editedCount: 0 };
}

function scoreInsertArray(items: unknown[]): number {
  if (!items.length) return 1;

  return items.reduce<number>((score, item) => {
    if (!isRecord(item)) return score;
    const keys = Object.keys(item).map(normalize).join(" ");
    const values = collectStrings(item).slice(0, 20).map(normalize).join(" ");
    let nextScore = score;
    if (/(title|label|name|nome)/.test(keys)) nextScore += 3;
    if (/(type|option|field|display)/.test(keys)) nextScore += 3;
    if (/(instructions|instruction|html|content|description|help)/.test(keys)) nextScore += 4;
    if (/(instructions|instruction|virtual option|bcpo|vopo)/.test(values)) nextScore += 3;
    return nextScore;
  }, 0);
}

function buildInstructionOptionFromTemplate(_template: unknown, html: string) {
  const unique = `ws-taglie-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    title: "Taglia",
    type: "instructions",
    unique,
    conditional_option: "",
    conditional_value: "",
    values: [{ key: html, price: "" }],
    multiselect_operator: "",
    multiselect_number: "",
  };
}

function buildGazeboInstructionOptionFromTemplate(_template: unknown, html: string) {
  const unique = `ws-gazebo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    title: "Lavorazioni e Rifiniture",
    type: "instructions",
    unique,
    conditional_option: "",
    conditional_value: "",
    values: [{ key: html, price: "" }],
    multiselect_operator: "",
    multiselect_number: "",
  };
}

function isGazeboFinishingOption(value: unknown) {
  return collectStrings(value).some((text) =>
    text.includes("data-ws-gazebo-finishing") ||
    normalize(text).includes("lavorazioni e rifiniture"),
  );
}

function upsertGazeboFinishingJson(value: unknown, html: string): {
  value: unknown;
  gazeboCount: number;
} {
  function upsertInArray(items: unknown[]): { items: unknown[]; count: number } {
    let count = 0;
    let found = false;
    const nextItems = items.map((item) => {
      if (isGazeboFinishingOption(item)) {
        found = true;
        count += 1;
        return buildGazeboInstructionOptionFromTemplate(item, html);
      }

      return item;
    });

    if (!found) {
      nextItems.push(buildGazeboInstructionOptionFromTemplate(items.find(isRecord), html));
      count = 1;
    }

    return { items: nextItems, count };
  }

  if (isRecord(value) && Array.isArray(value.virtual_options)) {
    const upserted = upsertInArray(value.virtual_options);
    return {
      value: {
        ...value,
        virtual_options: upserted.items,
      },
      gazeboCount: upserted.count,
    };
  }

  type Candidate = { path: Array<string | number>; score: number };
  const candidates: Candidate[] = [];

  function visit(node: unknown, path: Array<string | number>) {
    if (Array.isArray(node)) {
      candidates.push({ path, score: scoreInsertArray(node) });
      node.forEach((child, index) => visit(child, [...path, index]));
      return;
    }

    if (isRecord(node)) {
      Object.entries(node).forEach(([key, child]) => visit(child, [...path, key]));
    }
  }

  visit(value, []);
  const best = candidates.sort((first, second) => second.score - first.score)[0];
  if (!best) return { value, gazeboCount: 0 };

  let gazeboCount = 0;

  function cloneAndUpsert(node: unknown, path: Array<string | number>): unknown {
    if (!path.length) {
      if (!Array.isArray(node)) return node;
      const upserted = upsertInArray(node);
      gazeboCount = upserted.count;
      return upserted.items;
    }

    const [head, ...tail] = path;
    if (Array.isArray(node) && typeof head === "number") {
      return node.map((child, index) => (index === head ? cloneAndUpsert(child, tail) : child));
    }
    if (isRecord(node) && typeof head === "string") {
      return { ...node, [head]: cloneAndUpsert(node[head], tail) };
    }
    return node;
  }

  return {
    value: cloneAndUpsert(value, best.path),
    gazeboCount,
  };
}

function insertInstructionJson(value: unknown, html: string): {
  value: unknown;
  insertedCount: number;
} {
  if (isRecord(value) && Array.isArray(value.virtual_options)) {
    const alreadyExists = value.virtual_options.some((item) =>
      collectStrings(item).some((text) => text.includes("data-pack-key=")),
    );

    if (alreadyExists) return { value, insertedCount: 0 };

    return {
      value: {
        ...value,
        virtual_options: [
          ...value.virtual_options,
          buildInstructionOptionFromTemplate(
            value.virtual_options.find(
              (item) => isRecord(item) && matchesOption(item, "type", "instructions"),
            ) ?? value.virtual_options.find(isRecord),
            html,
          ),
        ],
      },
      insertedCount: 1,
    };
  }

  type Candidate = { path: Array<string | number>; score: number; template: unknown };
  const candidates: Candidate[] = [];

  function visit(node: unknown, path: Array<string | number>) {
    if (Array.isArray(node)) {
      candidates.push({
        path,
        score: scoreInsertArray(node),
        template:
          node.find(
            (item) =>
              isRecord(item) &&
              matchesOption(item, "type", "instructions"),
          ) ?? node.find(isRecord),
      });
      node.forEach((child, index) => visit(child, [...path, index]));
      return;
    }

    if (isRecord(node)) {
      Object.entries(node).forEach(([key, child]) => visit(child, [...path, key]));
    }
  }

  visit(value, []);
  const best = candidates.sort((first, second) => second.score - first.score)[0];
  if (!best) return { value, insertedCount: 0 };

  function cloneAndInsert(node: unknown, path: Array<string | number>): unknown {
    if (!path.length) {
      if (!Array.isArray(node)) return node;
      const alreadyExists = node.some((item) => collectStrings(item).some((text) => text.includes("data-pack-key=")));
      if (alreadyExists) return node;
      return [...node, buildInstructionOptionFromTemplate(best.template, html)];
    }

    const [head, ...tail] = path;
    if (Array.isArray(node) && typeof head === "number") {
      return node.map((child, index) => (index === head ? cloneAndInsert(child, tail) : child));
    }
    if (isRecord(node) && typeof head === "string") {
      return { ...node, [head]: cloneAndInsert(node[head], tail) };
    }
    return node;
  }

  const nextValue = cloneAndInsert(value, best.path);
  return {
    value: nextValue,
    insertedCount: nextValue === value ? 0 : 1,
  };
}

function looksLikeVopoMetafield(metafield: VopoMetafield) {
  const descriptor = normalize(`${metafield.namespace} ${metafield.key} ${metafield.type}`);
  if (/(bcpo|vopo|product option|product_option|custom option|custom_option)/.test(descriptor)) {
    return true;
  }

  const parsed = maybeParseJson(metafield.value);
  if (!parsed) return false;

  const sample = normalize(collectStrings(parsed).slice(0, 80).join(" "));
  return /(bcpo|vopo|option|instructions|selector|field_type|option_type)/.test(sample);
}

function getCandidateMetafields(
  product: VopoProduct,
  namespace: string,
  key: string,
) {
  return product.metafields.nodes.filter((metafield) => {
    if (namespace && metafield.namespace !== namespace) return false;
    if (key && metafield.key !== key) return false;
    if (namespace || key) return true;
    return looksLikeVopoMetafield(metafield);
  });
}

async function setMetafields(
  admin: any,
  patches: Array<Pick<CleanPatch, "productId" | "namespace" | "key" | "type" | "nextValue">>,
) {
  for (let index = 0; index < patches.length; index += 25) {
    const batch = patches.slice(index, index + 25);
    const data = await adminGraphql(admin, METAFIELDS_SET_MUTATION, {
      metafields: batch.map((patch) => ({
        ownerId: patch.productId,
        namespace: patch.namespace,
        key: patch.key,
        type: patch.type,
        value: patch.nextValue,
      })),
    });
    const errors = data.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      throw new Error(errors.map((error: { message: string }) => error.message).join(" "));
    }
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const rawOperation = String(formData.get("operation") || "remove");
  const operation: CleanerOperation =
    rawOperation === "insert"
      ? "insert"
      : rawOperation === "edit"
        ? "edit"
        : rawOperation === "gazebo"
          ? "gazebo"
          : "remove";
  const mode = String(formData.get("mode") || "preview") === "apply" ? "apply" : "preview";
  const productQuery = String(formData.get("productQuery") || "").trim();
  const namespace = String(formData.get("namespace") || "").trim();
  const key = String(formData.get("key") || "").trim();
  const criterion = String(formData.get("criterion") || "any") as MatchCriterion;
  const searchText = String(formData.get("searchText") || "").trim();
  const nextTitle = String(formData.get("nextTitle") || "").trim();
  const productType = String(formData.get("productType") || "").trim();
  const fromSize = String(formData.get("fromSize") || "XXS").trim();
  const toSize = String(formData.get("toSize") || "XXL").trim();
  const productLimit = Math.min(
    100,
    Math.max(1, parseInt(String(formData.get("productLimit") || "25"), 10) || 25),
  );

  if (!productQuery) {
    return { ok: false, errors: ["Inserisci una query prodotti."] } satisfies CleanerResult;
  }

  if (operation === "remove" && !searchText) {
    return {
      ok: false,
      errors: ["Inserisci il testo da cercare nella variante/opzione VOPO."],
    } satisfies CleanerResult;
  }

  if (operation === "edit" && (!searchText || !nextTitle)) {
    return {
      ok: false,
      errors: ["Inserisci sia il testo da cercare sia il nuovo titolo della variante/opzione."],
    } satisfies CleanerResult;
  }

  if (operation === "insert" && !productType) {
    return {
      ok: false,
      errors: ["Inserisci il tipo prodotto per generare data-pack-key e property."],
    } satisfies CleanerResult;
  }

  try {
    const shopifyProductQuery = normalizeProductSearchQuery(productQuery);
    const data = await adminGraphql(admin, PRODUCTS_QUERY, {
      query: shopifyProductQuery,
      first: productLimit,
    });
    const products: VopoProduct[] = data.products?.nodes ?? [];
    const patches: Array<CleanPatch | InsertPatch | EditPatch | GazeboPatch> = [];
    const instructionHtml = operation === "insert"
      ? buildSizesInstructionHtml(productType, fromSize, toSize)
      : "";
    const gazeboHtml = operation === "gazebo" ? buildGazeboFinishingInstructionHtml() : "";

    products.forEach((product) => {
      getCandidateMetafields(product, namespace, key).forEach((metafield) => {
        const parsed = maybeParseJson(metafield.value);
        if (!parsed) return;

        if (operation === "insert") {
          const inserted = insertInstructionJson(parsed, instructionHtml);
          if (!inserted.insertedCount) return;

          patches.push({
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            namespace: metafield.namespace,
            key: metafield.key,
            type: metafield.type,
            nextValue: JSON.stringify(inserted.value),
            insertedCount: inserted.insertedCount,
          });
          return;
        }

        if (operation === "gazebo") {
          const gazebo = upsertGazeboFinishingJson(parsed, gazeboHtml);
          if (!gazebo.gazeboCount) return;

          patches.push({
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            namespace: metafield.namespace,
            key: metafield.key,
            type: metafield.type,
            nextValue: JSON.stringify(gazebo.value),
            gazeboCount: gazebo.gazeboCount,
          });
          return;
        }

        if (operation === "edit") {
          const edited = editJson(parsed, criterion, searchText, nextTitle);
          if (!edited.editedCount) return;

          patches.push({
            productId: product.id,
            productTitle: product.title,
            productHandle: product.handle,
            namespace: metafield.namespace,
            key: metafield.key,
            type: metafield.type,
            nextValue: JSON.stringify(edited.value),
            editedCount: edited.editedCount,
          });
          return;
        }

        const cleaned = cleanJson(parsed, criterion, searchText);
        if (!cleaned.removedCount) return;

        patches.push({
          productId: product.id,
          productTitle: product.title,
          productHandle: product.handle,
          namespace: metafield.namespace,
          key: metafield.key,
          type: metafield.type,
          nextValue: JSON.stringify(cleaned.value),
          removedCount: cleaned.removedCount,
        });
      });
    });

    if (mode === "apply" && patches.length) {
      await setMetafields(admin, patches);
    }

    const matchedProducts = new Set(patches.map((patch) => patch.productId)).size;
    const affectedOptions = patches.reduce((total, patch) => {
      if ("removedCount" in patch) return total + patch.removedCount;
      if ("editedCount" in patch) return total + patch.editedCount;
      if ("gazeboCount" in patch) return total + patch.gazeboCount;
      return total + patch.insertedCount;
    }, 0);

    return {
      ok: true,
      operation,
      mode,
      scannedProducts: products.length,
      matchedProducts,
      matchedMetafields: patches.length,
      affectedOptions,
      details: patches.map(
        (patch) => {
          const count =
            "removedCount" in patch
              ? patch.removedCount
              : "editedCount" in patch
                ? patch.editedCount
                : "gazeboCount" in patch
                  ? patch.gazeboCount
                : patch.insertedCount;
          const actionLabel =
            operation === "insert"
              ? mode === "apply" ? "inseriti" : "da inserire"
              : operation === "gazebo"
                ? mode === "apply" ? "configurati" : "da configurare"
              : operation === "edit"
                ? mode === "apply" ? "modificati" : "da modificare"
                : mode === "apply" ? "rimossi" : "da rimuovere";

          return `${patch.productTitle} (${patch.productHandle}) - ${patch.namespace}.${patch.key}: ${count} elementi ${actionLabel}`;
        },
      ),
    } satisfies CleanerResult;
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Errore pulizia VOPO."],
    } satisfies CleanerResult;
  }
};

export default function VopoCleaner() {
  const actionData = useActionData() as CleanerResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state !== "idle";
  const submittingMode = navigation.formData?.get("mode");
  const submittingOperation = navigation.formData?.get("operation");

  useEffect(() => {
    if (actionData?.ok && actionData.mode === "apply") {
      shopify.toast.show("Opzioni VOPO aggiornate");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="VOPO cleaner">
      <style>{styles}</style>
      <div className="vopo-cleaner">
        <section className="vopo-cleaner__card">
          <p className="vopo-cleaner__kicker">Pulizia massiva sicura</p>
          <h1>Gestisci opzioni VOPO/BCPO da più prodotti</h1>
          <p>
            Cerca i prodotti, individua i metafield JSON candidati e rimuove, modifica
            o inserisce opzioni instruction e configuratori dedicati. Prima usa sempre
            <strong> Anteprima</strong>.
          </p>

          <Form method="post" className="vopo-cleaner__form vopo-cleaner__section">
            <input name="operation" type="hidden" value="remove" />
            <h2>Rimuovi variante/opzione</h2>
            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Query prodotti Shopify</span>
              <input
                name="productQuery"
                placeholder="es. Nome prodotto (handle), handle:prodotto, tag:CustomPrice"
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Limite prodotti</span>
                <input name="productLimit" type="number" min="1" max="100" defaultValue="25" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Criterio</span>
                <select name="criterion" defaultValue="instructions">
                  <option value="instructions">Instructions / contenuto</option>
                  <option value="title">Titolo / label / nome</option>
                  <option value="type">Tipo variante</option>
                  <option value="any">Qualsiasi campo</option>
                </select>
              </label>
            </div>

            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Testo da cercare</span>
              <input
                name="searchText"
                placeholder="es. istruzioni file, Solo testo, instructions, Asola..."
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Namespace metafield opzionale</span>
                <input name="namespace" placeholder="lascia vuoto per auto-detect" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Key metafield opzionale</span>
                <input name="key" placeholder="lascia vuoto per auto-detect" />
              </label>
            </div>

            <div className="vopo-cleaner__actions">
              <button
                className="vopo-cleaner__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingOperation === "remove" && submittingMode === "preview"
                  ? "Analisi..."
                  : "Anteprima rimozione"}
              </button>
              <button
                className="vopo-cleaner__button vopo-cleaner__button--danger"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingOperation === "remove" && submittingMode === "apply"
                  ? "Cancello..."
                  : "Applica cancellazione"}
              </button>
            </div>
          </Form>

          <Form method="post" className="vopo-cleaner__form vopo-cleaner__section">
            <input name="operation" type="hidden" value="edit" />
            <h2>Modifica titolo variante/opzione</h2>
            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Query prodotti Shopify</span>
              <input
                name="productQuery"
                placeholder="es. Nome prodotto (handle), handle:prodotto, tag:CustomPrice"
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Limite prodotti</span>
                <input name="productLimit" type="number" min="1" max="100" defaultValue="25" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Criterio</span>
                <select name="criterion" defaultValue="title">
                  <option value="title">Titolo / label / nome</option>
                  <option value="instructions">Instructions / contenuto</option>
                  <option value="type">Tipo variante</option>
                  <option value="any">Qualsiasi campo</option>
                </select>
              </label>
            </div>

            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Titolo/testo da cercare</span>
              <input
                name="searchText"
                placeholder="es. Materiale, Posizione Stampa, IMPORTANTE..."
                required
              />
            </label>

            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Nuovo titolo</span>
              <input
                name="nextTitle"
                placeholder="es. Materiale di stampa, Posizione stampa, Avviso importante"
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Namespace metafield opzionale</span>
                <input name="namespace" placeholder="lascia vuoto per auto-detect" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Key metafield opzionale</span>
                <input name="key" placeholder="lascia vuoto per auto-detect" />
              </label>
            </div>

            <div className="vopo-cleaner__actions">
              <button
                className="vopo-cleaner__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingOperation === "edit" && submittingMode === "preview"
                  ? "Analisi..."
                  : "Anteprima modifica"}
              </button>
              <button
                className="vopo-cleaner__button vopo-cleaner__button--edit"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingOperation === "edit" && submittingMode === "apply"
                  ? "Modifico..."
                  : "Applica modifica"}
              </button>
            </div>
          </Form>

          <Form method="post" className="vopo-cleaner__form vopo-cleaner__section">
            <input name="operation" type="hidden" value="insert" />
            <h2>Inserisci instruction taglie</h2>

            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Query prodotti Shopify</span>
              <input
                name="productQuery"
                placeholder="es. Nome prodotto (handle), handle:prodotto, tag:abbigliamento"
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Limite prodotti</span>
                <input name="productLimit" type="number" min="1" max="100" defaultValue="25" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Tipo prodotto</span>
                <input name="productType" placeholder="es. calzoncini, camicia, t-shirt" required />
              </label>
            </div>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Da taglia</span>
                <select name="fromSize" defaultValue="XXS">
                  {SIZE_OPTIONS.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="vopo-cleaner__field">
                <span>A taglia</span>
                <select name="toSize" defaultValue="XXL">
                  {SIZE_OPTIONS.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Namespace metafield opzionale</span>
                <input name="namespace" placeholder="lascia vuoto per auto-detect" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Key metafield opzionale</span>
                <input name="key" placeholder="lascia vuoto per auto-detect" />
              </label>
            </div>

            <div className="vopo-cleaner__actions">
              <button
                className="vopo-cleaner__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingOperation === "insert" && submittingMode === "preview"
                  ? "Analisi..."
                  : "Anteprima inserimento"}
              </button>
              <button
                className="vopo-cleaner__button vopo-cleaner__button--insert"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingOperation === "insert" && submittingMode === "apply"
                  ? "Inserisco..."
                  : "Applica inserimento"}
              </button>
            </div>
          </Form>

          <Form method="post" className="vopo-cleaner__form vopo-cleaner__section">
            <input name="operation" type="hidden" value="gazebo" />
            <h2>Inserisci configuratore Gazebo</h2>
            <p>
              Aggiunge o aggiorna la variante instruction <strong>Lavorazioni e Rifiniture</strong>
              con spicchi e fasce indipendenti. Prezzo base Shopify: 280 euro solo struttura.
            </p>

            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Query prodotti Shopify</span>
              <input
                name="productQuery"
                placeholder="es. Gazebo Personalizzato (gazebo-personalizzato), handle:gazebo-personalizzato"
                required
              />
            </label>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Limite prodotti</span>
                <input name="productLimit" type="number" min="1" max="100" defaultValue="25" />
              </label>
              <div className="vopo-cleaner__price-note" aria-label="Regole prezzo gazebo">
                <strong>Regole prezzo</strong>
                <span>1 spicchio: 270 euro · prima fascia solo fasce: 210 euro</span>
                <span>Spicchi extra: 50 euro · fasce extra: 30 euro</span>
              </div>
            </div>

            <div className="vopo-cleaner__grid">
              <label className="vopo-cleaner__field">
                <span>Namespace metafield opzionale</span>
                <input name="namespace" placeholder="lascia vuoto per auto-detect" />
              </label>
              <label className="vopo-cleaner__field">
                <span>Key metafield opzionale</span>
                <input name="key" placeholder="lascia vuoto per auto-detect" />
              </label>
            </div>

            <div className="vopo-cleaner__actions">
              <button
                className="vopo-cleaner__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingOperation === "gazebo" && submittingMode === "preview"
                  ? "Analisi..."
                  : "Anteprima Gazebo"}
              </button>
              <button
                className="vopo-cleaner__button vopo-cleaner__button--gazebo"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingOperation === "gazebo" && submittingMode === "apply"
                  ? "Configuro..."
                  : "Applica Gazebo"}
              </button>
            </div>
          </Form>
        </section>

        <section className="vopo-cleaner__card vopo-cleaner__card--result">
          <h2>Risultato</h2>
          {!actionData ? (
            <p>Fai prima un'anteprima: qui vedrai prodotti e metafield coinvolti.</p>
          ) : null}

          {actionData?.errors?.length ? (
            <div className="vopo-cleaner__errors">
              {actionData.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          ) : null}

          {actionData?.ok ? (
            <div className="vopo-cleaner__success">
              <strong>
                {actionData.mode === "apply"
                  ? actionData.operation === "insert"
                    ? "Inserimento completato"
                    : actionData.operation === "gazebo"
                      ? "Configuratore Gazebo completato"
                    : actionData.operation === "edit"
                      ? "Modifica completata"
                    : "Cancellazione completata"
                  : "Anteprima completata"}
              </strong>
              <p>
                Prodotti analizzati: {actionData.scannedProducts}. Prodotti con match:{" "}
                {actionData.matchedProducts}. Metafield coinvolti:{" "}
                {actionData.matchedMetafields}. Elementi: {actionData.affectedOptions}.
              </p>
              {actionData.details?.length ? (
                <div className="vopo-cleaner__details">
                  {actionData.details.map((detail) => (
                    <p key={detail}>{detail}</p>
                  ))}
                </div>
              ) : (
                <p>Nessun elemento corrispondente trovato.</p>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </s-page>
  );
}

const styles = `
  .vopo-cleaner {
    width: min(1180px, calc(100vw - 48px));
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, .75fr);
    gap: 22px;
  }

  .vopo-cleaner__card {
    border: 1px solid #dce8df;
    border-radius: 22px;
    background: rgba(255, 255, 255, .95);
    box-shadow: 0 18px 48px rgba(18, 38, 29, .08);
    padding: 24px;
  }

  .vopo-cleaner__card--result {
    background: linear-gradient(180deg, #f7fbf8 0%, #ffffff 100%);
  }

  .vopo-cleaner h1,
  .vopo-cleaner h2,
  .vopo-cleaner p {
    margin: 0;
  }

  .vopo-cleaner h1 {
    color: #1f2933;
    font-size: 27px;
    line-height: 1.1;
    margin-bottom: 10px;
  }

  .vopo-cleaner h2 {
    color: #1f2933;
    font-size: 18px;
    line-height: 1.2;
    margin-bottom: 10px;
  }

  .vopo-cleaner p {
    color: #556371;
    font-size: 14px;
    line-height: 1.55;
  }

  .vopo-cleaner__kicker {
    color: #667085 !important;
    font-size: 11px !important;
    font-weight: 900;
    letter-spacing: .12em;
    text-transform: uppercase;
    margin-bottom: 8px !important;
  }

  .vopo-cleaner__form {
    display: grid;
    gap: 16px;
    margin-top: 22px;
  }

  .vopo-cleaner__section {
    padding: 18px;
    border: 1px solid #dce8df;
    border-radius: 18px;
    background: linear-gradient(180deg, #fbfefc 0%, #ffffff 100%);
  }

  .vopo-cleaner__section + .vopo-cleaner__section {
    margin-top: 18px;
  }

  .vopo-cleaner__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .vopo-cleaner__field {
    display: grid;
    gap: 8px;
    color: #344054;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .vopo-cleaner__field input,
  .vopo-cleaner__field select {
    min-height: 48px;
    border: 1px solid #cad8d0;
    border-radius: 14px;
    background: #fff;
    padding: 12px 14px;
    color: #111827;
    font-size: 14px;
    text-transform: none;
    letter-spacing: 0;
  }

  .vopo-cleaner__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .vopo-cleaner__button {
    min-height: 50px;
    border: 0;
    border-radius: 14px;
    background: linear-gradient(135deg, #18b65b 0%, #0c8c3f 100%);
    color: #fff;
    cursor: pointer;
    font-size: 15px;
    font-weight: 900;
    padding: 0 18px;
    box-shadow: 0 12px 24px rgba(12, 140, 63, .2);
  }

  .vopo-cleaner__button--danger {
    background: linear-gradient(135deg, #ef4444 0%, #b42318 100%);
    box-shadow: 0 12px 24px rgba(180, 35, 24, .16);
  }

  .vopo-cleaner__button--insert {
    background: linear-gradient(135deg, #2563eb 0%, #0f766e 100%);
    box-shadow: 0 12px 24px rgba(37, 99, 235, .16);
  }

  .vopo-cleaner__button--edit {
    background: linear-gradient(135deg, #f59e0b 0%, #b45309 100%);
    box-shadow: 0 12px 24px rgba(180, 83, 9, .16);
  }

  .vopo-cleaner__button--gazebo {
    background: linear-gradient(135deg, #00c853 0%, #047857 100%);
    box-shadow: 0 12px 24px rgba(0, 200, 83, .18);
  }

  .vopo-cleaner__button:disabled {
    cursor: wait;
    opacity: .72;
  }

  .vopo-cleaner__price-note {
    border: 1px solid #ccefd7;
    border-radius: 16px;
    background: #f0fbf3;
    color: #176b3a;
    display: grid;
    gap: 4px;
    font-size: 12px;
    line-height: 1.35;
    padding: 12px 14px;
  }

  .vopo-cleaner__price-note strong {
    color: #0f7a39;
    font-size: 13px;
  }

  .vopo-cleaner__errors,
  .vopo-cleaner__success {
    margin-top: 14px;
    padding: 14px 16px;
    border-radius: 16px;
    display: grid;
    gap: 8px;
  }

  .vopo-cleaner__errors {
    border: 1px solid #fecaca;
    background: #fff5f5;
  }

  .vopo-cleaner__errors p {
    color: #b42318;
    font-weight: 800;
  }

  .vopo-cleaner__success {
    border: 1px solid #ccefd7;
    background: #f0fbf3;
  }

  .vopo-cleaner__success strong {
    color: #0f7a39;
  }

  .vopo-cleaner__details {
    display: grid;
    gap: 6px;
    max-height: 420px;
    overflow: auto;
    padding-right: 4px;
  }

  .vopo-cleaner__details p {
    padding: 9px 10px;
    border-radius: 10px;
    background: #fff;
    border: 1px solid #dce8df;
    color: #344054;
    font-size: 12px;
  }

  @media (max-width: 900px) {
    .vopo-cleaner {
      width: min(100%, calc(100vw - 24px));
      grid-template-columns: 1fr;
    }

    .vopo-cleaner__grid {
      grid-template-columns: 1fr;
    }
  }
`;

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
