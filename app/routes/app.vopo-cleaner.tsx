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

type CleanerResult = {
  ok: boolean;
  mode?: "preview" | "apply";
  scannedProducts?: number;
  matchedProducts?: number;
  matchedMetafields?: number;
  removedOptions?: number;
  details?: string[];
  errors?: string[];
};

type MatchCriterion = "any" | "title" | "type" | "instructions";

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

  const titleKeys = ["title", "label", "name", "nome", "option_title", "display_name"];
  const typeKeys = ["type", "kind", "field_type", "option_type", "input_type", "display_type"];
  const instructionKeys = [
    ...titleKeys,
    ...typeKeys,
    "instructions",
    "instruction",
    "content",
    "description",
    "help_text",
    "html",
    "text",
    "body",
  ];

  let haystack: string[];
  if (criterion === "title") {
    haystack = objectStringsByKeys(value, titleKeys);
  } else if (criterion === "type") {
    haystack = objectStringsByKeys(value, typeKeys);
  } else if (criterion === "instructions") {
    haystack = objectStringsByKeys(value, instructionKeys);
  } else {
    haystack = collectStrings(value);
  }

  return haystack.some((text) => normalize(text).includes(needle));
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

async function setMetafields(admin: any, patches: CleanPatch[]) {
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
  const mode = String(formData.get("mode") || "preview") === "apply" ? "apply" : "preview";
  const productQuery = String(formData.get("productQuery") || "").trim();
  const namespace = String(formData.get("namespace") || "").trim();
  const key = String(formData.get("key") || "").trim();
  const criterion = String(formData.get("criterion") || "any") as MatchCriterion;
  const searchText = String(formData.get("searchText") || "").trim();
  const productLimit = Math.min(
    100,
    Math.max(1, parseInt(String(formData.get("productLimit") || "25"), 10) || 25),
  );

  if (!productQuery) {
    return { ok: false, errors: ["Inserisci una query prodotti."] } satisfies CleanerResult;
  }

  if (!searchText) {
    return {
      ok: false,
      errors: ["Inserisci il testo da cercare nella variante/opzione VOPO."],
    } satisfies CleanerResult;
  }

  try {
    const data = await adminGraphql(admin, PRODUCTS_QUERY, {
      query: productQuery,
      first: productLimit,
    });
    const products: VopoProduct[] = data.products?.nodes ?? [];
    const patches: CleanPatch[] = [];

    products.forEach((product) => {
      getCandidateMetafields(product, namespace, key).forEach((metafield) => {
        const parsed = maybeParseJson(metafield.value);
        if (!parsed) return;

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
    const removedOptions = patches.reduce((total, patch) => total + patch.removedCount, 0);

    return {
      ok: true,
      mode,
      scannedProducts: products.length,
      matchedProducts,
      matchedMetafields: patches.length,
      removedOptions,
      details: patches.map(
        (patch) =>
          `${patch.productTitle} (${patch.productHandle}) - ${patch.namespace}.${patch.key}: ${patch.removedCount} elementi ${mode === "apply" ? "rimossi" : "da rimuovere"}`,
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
          <h1>Cancella opzioni VOPO/BCPO da più prodotti</h1>
          <p>
            Cerca i prodotti, individua i metafield JSON candidati e rimuove dagli array
            le opzioni che corrispondono al criterio scelto. Prima usa sempre
            <strong> Anteprima</strong>.
          </p>

          <Form method="post" className="vopo-cleaner__form">
            <label className="vopo-cleaner__field vopo-cleaner__field--wide">
              <span>Query prodotti Shopify</span>
              <input
                name="productQuery"
                placeholder="es. tag:CustomPrice oppure title:*striscioni* oppure handle:prodotto"
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
                {isSubmitting && submittingMode === "preview" ? "Analisi..." : "Anteprima"}
              </button>
              <button
                className="vopo-cleaner__button vopo-cleaner__button--danger"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingMode === "apply"
                  ? "Cancello..."
                  : "Applica cancellazione"}
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
                {actionData.mode === "apply" ? "Cancellazione completata" : "Anteprima completata"}
              </strong>
              <p>
                Prodotti analizzati: {actionData.scannedProducts}. Prodotti con match:{" "}
                {actionData.matchedProducts}. Metafield coinvolti:{" "}
                {actionData.matchedMetafields}. Elementi: {actionData.removedOptions}.
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

  .vopo-cleaner__button:disabled {
    cursor: wait;
    opacity: .72;
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
