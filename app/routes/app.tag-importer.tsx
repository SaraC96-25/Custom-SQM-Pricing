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

type TagImporterMode = "preview" | "apply";
type TagImporterOperation = "add" | "remove";

type ProductMatch = {
  id: string;
  title: string;
  handle: string;
  tags: string[];
};

type ProductTagResult = {
  handle: string;
  status: "changed" | "skipped" | "missing" | "error";
  title?: string;
  message?: string;
};

type TagImporterResult = {
  ok: boolean;
  mode?: TagImporterMode;
  operation?: TagImporterOperation;
  tag?: string;
  totalHandles?: number;
  foundProducts?: number;
  changedProducts?: number;
  skippedProducts?: number;
  missingProducts?: number;
  details?: ProductTagResult[];
  errors?: string[];
};

const FIND_PRODUCT_QUERY = `#graphql
  query TagImporterFindProduct($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        handle
        tags
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation TagImporterTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation TagImporterTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
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

function normalizeHandle(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/[^/]+\/products\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^handle:/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function extractHandleFromLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const productUrl = trimmed.match(/\/products\/([a-z0-9][a-z0-9-]*[a-z0-9])(?:[/?#\s]|$)/i);
  if (productUrl?.[1]) return normalizeHandle(productUrl[1]);

  const parenthesized = trimmed.match(/\(([a-z0-9][a-z0-9-]*[a-z0-9])\)\s*$/i);
  if (parenthesized?.[1]) return normalizeHandle(parenthesized[1]);

  return normalizeHandle(trimmed);
}

function parseHandles(rawText: string) {
  const seen = new Set<string>();
  const handles: string[] = [];

  rawText
    .split(/[\n,;]+/)
    .map(extractHandleFromLine)
    .filter(Boolean)
    .forEach((handle) => {
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(handle)) return;
      if (seen.has(handle)) return;

      seen.add(handle);
      handles.push(handle);
    });

  return handles;
}

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function sameTag(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function findProductByHandle(admin: any, handle: string): Promise<ProductMatch | null> {
  const data = await adminGraphql(admin, FIND_PRODUCT_QUERY, {
    query: `handle:${handle}`,
  });

  return data.products.nodes[0] ?? null;
}

async function addTag(admin: any, product: ProductMatch, tag: string) {
  const data = await adminGraphql(admin, TAGS_ADD_MUTATION, {
    id: product.id,
    tags: [tag],
  });

  const userErrors = data.tagsAdd.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error: { message: string }) => error.message).join(" "));
  }
}

async function removeTag(admin: any, product: ProductMatch, tag: string) {
  const data = await adminGraphql(admin, TAGS_REMOVE_MUTATION, {
    id: product.id,
    tags: [tag],
  });

  const userErrors = data.tagsRemove.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error: { message: string }) => error.message).join(" "));
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode = formData.get("mode") === "apply" ? "apply" : "preview";
  const operation = formData.get("operation") === "remove" ? "remove" : "add";
  const handlesText = String(formData.get("handles") ?? "");
  const tag = normalizeTag(String(formData.get("tag") ?? ""));
  const handles = parseHandles(handlesText);

  if (!tag) {
    return {
      ok: false,
      errors: [`Inserisci il tag da ${operation === "remove" ? "rimuovere" : "applicare"}.`],
    } satisfies TagImporterResult;
  }

  if (!handles.length) {
    return {
      ok: false,
      errors: ["Inserisci almeno un handle prodotto valido."],
    } satisfies TagImporterResult;
  }

  try {
    const details: ProductTagResult[] = [];
    let foundProducts = 0;
    let changedProducts = 0;
    let skippedProducts = 0;
    let missingProducts = 0;

    for (const handle of handles) {
      const product = await findProductByHandle(admin, handle);

      if (!product) {
        missingProducts += 1;
        details.push({
          handle,
          status: "missing",
          message: "Prodotto non trovato",
        });
        continue;
      }

      foundProducts += 1;

      const hasTag = product.tags.some((existingTag) => sameTag(existingTag, tag));

      if (operation === "add" && hasTag) {
        skippedProducts += 1;
        details.push({
          handle,
          title: product.title,
          status: "skipped",
          message: "Tag gia presente",
        });
        continue;
      }

      if (operation === "remove" && !hasTag) {
        skippedProducts += 1;
        details.push({
          handle,
          title: product.title,
          status: "skipped",
          message: "Tag non presente",
        });
        continue;
      }

      if (mode === "apply") {
        if (operation === "remove") {
          await removeTag(admin, product, tag);
        } else {
          await addTag(admin, product, tag);
        }
      }

      changedProducts += 1;
      details.push({
        handle,
        title: product.title,
        status: "changed",
        message:
          operation === "remove"
            ? mode === "apply" ? "Tag rimosso" : "Tag da rimuovere"
            : mode === "apply" ? "Tag applicato" : "Tag da applicare",
      });
    }

    return {
      ok: true,
      mode,
      operation,
      tag,
      totalHandles: handles.length,
      foundProducts,
      changedProducts,
      skippedProducts,
      missingProducts,
      details,
    } satisfies TagImporterResult;
  } catch (error) {
    return {
      ok: false,
      mode,
      operation,
      tag,
      errors: [error instanceof Error ? error.message : "Errore durante l import dei tag."],
    } satisfies TagImporterResult;
  }
};

export default function TagImporter() {
  const actionData = useActionData() as TagImporterResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state !== "idle";
  const submittingMode = navigation.formData?.get("mode");
  const submittingOperation = navigation.formData?.get("operation") ?? "add";

  useEffect(() => {
    if (actionData?.ok && actionData.mode === "apply") {
      shopify.toast.show(actionData.operation === "remove" ? "Tag rimossi dai prodotti" : "Tag applicati ai prodotti");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="TAG Importer">
      <style>{styles}</style>
      <div className="tag-importer">
        <section className="tag-importer__card">
          <p className="tag-importer__kicker">Tag massivi</p>
          <h1>Aggiungi o rimuovi un tag da una lista di prodotti</h1>
          <p>
            Incolla gli handle prodotto, uno per riga. Puoi usare anche URL prodotto
            oppure righe tipo <strong>Nome prodotto (handle-prodotto)</strong>. Prima
            usa <strong>Anteprima</strong>, poi applica o rimuovi il tag.
          </p>

          <Form method="post" className="tag-importer__form">
            <label className="tag-importer__field tag-importer__field--wide">
              <span>Tag</span>
              <input
                name="tag"
                placeholder="es. CustomPrice, Abbigliamento Promo, calcolatore"
                required
              />
            </label>

            <label className="tag-importer__field tag-importer__field--wide">
              <span>Azione</span>
              <select name="operation" defaultValue="add">
                <option value="add">Aggiungi tag ai prodotti</option>
                <option value="remove">Rimuovi tag dai prodotti</option>
              </select>
            </label>

            <label className="tag-importer__field tag-importer__field--wide">
              <span>Handle prodotti</span>
              <textarea
                name="handles"
                placeholder={"striscioni-pvc\ncamicia-stretch-donna\nhttps://wowstampa.com/products/felpa-premium\nFelpa Standard (felpa-standard)"}
                rows={12}
                required
              />
            </label>

            <div className="tag-importer__actions">
              <button
                className="tag-importer__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingMode === "preview"
                  ? "Analisi..."
                  : submittingOperation === "remove"
                    ? "Anteprima rimozione"
                    : "Anteprima tag"}
              </button>
              <button
                className="tag-importer__button tag-importer__button--primary"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingMode === "apply"
                  ? submittingOperation === "remove" ? "Rimuovo..." : "Applico..."
                  : "Esegui azione"}
              </button>
            </div>
          </Form>
        </section>

        <aside className="tag-importer__result">
          <h2>Risultato</h2>
          {!actionData ? (
            <p className="tag-importer__muted">
              Esegui una anteprima per controllare prodotti trovati, mancanti e tag gia presenti.
            </p>
          ) : actionData.ok ? (
            <div className="tag-importer__success">
              <strong>
                {actionData.mode === "apply" ? "Operazione completata" : "Anteprima completata"}
              </strong>
              <p>
                Tag: <strong>{actionData.tag}</strong>. Handle analizzati:{" "}
                {actionData.totalHandles}. Prodotti trovati: {actionData.foundProducts}.
                {actionData.operation === "remove"
                  ? actionData.mode === "apply" ? " Prodotti modificati: " : " Prodotti da modificare: "
                  : actionData.mode === "apply" ? " Prodotti taggati: " : " Prodotti da taggare: "}
                {actionData.changedProducts}. Saltati: {actionData.skippedProducts}.
                Mancanti: {actionData.missingProducts}.
              </p>
              <ul>
                {actionData.details?.map((detail) => (
                  <li key={`${detail.handle}-${detail.status}`}>
                    <span className={`tag-importer__badge tag-importer__badge--${detail.status}`}>
                      {detail.status === "changed"
                        ? actionData.mode === "apply" ? "OK" : "DA FARE"
                        : detail.status === "skipped"
                          ? "SKIP"
                          : detail.status === "missing"
                            ? "NO"
                            : "ERR"}
                    </span>
                    <span>
                      {detail.title ? `${detail.title} (${detail.handle})` : detail.handle}
                      {detail.message ? ` - ${detail.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="tag-importer__error">
              <strong>Operazione non completata</strong>
              <ul>
                {actionData.errors?.map((error) => <li key={error}>{error}</li>)}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

const styles = `
  .tag-importer {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr);
    gap: 22px;
    max-width: 1180px;
    margin: 0 auto;
    padding: 22px;
    color: #1f2937;
  }

  .tag-importer__card,
  .tag-importer__result {
    border: 1px solid #cfe4d7;
    border-radius: 18px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfffc 100%);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .08);
    padding: 24px;
  }

  .tag-importer__kicker,
  .tag-importer__field span {
    margin: 0 0 8px;
    color: #4b5563;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .tag-importer h1,
  .tag-importer h2 {
    margin: 0 0 10px;
    color: #1f2937;
  }

  .tag-importer p {
    color: #526172;
    line-height: 1.5;
  }

  .tag-importer__form {
    display: grid;
    gap: 16px;
    margin-top: 22px;
  }

  .tag-importer__field {
    display: grid;
    gap: 8px;
  }

  .tag-importer__field input,
  .tag-importer__field select,
  .tag-importer__field textarea {
    width: 100%;
    min-height: 54px;
    border: 1px solid #b8d0c1;
    border-radius: 14px;
    padding: 14px 16px;
    background: #fff;
    color: #111827;
    font: inherit;
    font-weight: 650;
    box-sizing: border-box;
  }

  .tag-importer__field textarea {
    resize: vertical;
    line-height: 1.45;
  }

  .tag-importer__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .tag-importer__button {
    border: 0;
    border-radius: 14px;
    padding: 14px 20px;
    background: #16a34a;
    color: #fff;
    font: inherit;
    font-weight: 900;
    cursor: pointer;
    box-shadow: 0 14px 28px rgba(22, 163, 74, .18);
  }

  .tag-importer__button--primary {
    background: linear-gradient(135deg, #16a34a, #047857);
  }

  .tag-importer__button:disabled {
    cursor: progress;
    opacity: .62;
  }

  .tag-importer__muted {
    color: #6b7280;
  }

  .tag-importer__success,
  .tag-importer__error {
    border-radius: 16px;
    padding: 16px;
  }

  .tag-importer__success {
    border: 1px solid #bbf7d0;
    background: #f0fdf4;
    color: #14532d;
  }

  .tag-importer__error {
    border: 1px solid #fecaca;
    background: #fff5f5;
    color: #991b1b;
  }

  .tag-importer__success ul,
  .tag-importer__error ul {
    display: grid;
    gap: 8px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }

  .tag-importer__success li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid rgba(20, 83, 45, .12);
    border-radius: 12px;
    background: #fff;
  }

  .tag-importer__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 54px;
    min-height: 22px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 900;
  }

  .tag-importer__badge--changed {
    background: #dcfce7;
    color: #15803d;
  }

  .tag-importer__badge--skipped {
    background: #fef3c7;
    color: #92400e;
  }

  .tag-importer__badge--missing,
  .tag-importer__badge--error {
    background: #fee2e2;
    color: #991b1b;
  }

  @media (max-width: 980px) {
    .tag-importer {
      grid-template-columns: 1fr;
      padding: 14px;
    }
  }
`;
