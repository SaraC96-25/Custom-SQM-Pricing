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

type ImportMode = "preview" | "apply";

type DetailStatus =
  | "ready"
  | "updated"
  | "missing-collection"
  | "ambiguous-collection"
  | "error";

type CollectionInputRow = {
  rawInput: string;
  collectionRef: string;
  adjectiveOverride: string;
};

type CollectionMatch = {
  id: string;
  title: string;
  handle: string;
  seo?: {
    title?: string | null;
    description?: string | null;
  } | null;
};

type ImportDetail = {
  input: string;
  collectionTitle?: string;
  collectionHandle?: string;
  adjective: string;
  pageTitle: string;
  metaDescription: string;
  status: DetailStatus;
  message: string;
};

type ImportResult = {
  ok: boolean;
  mode?: ImportMode;
  titleTemplate?: string;
  descriptionTemplate?: string;
  totalInputs?: number;
  readyCount?: number;
  skippedCount?: number;
  details?: ImportDetail[];
  errors?: string[];
};

const DEFAULT_COLLECTIONS = `felpe|personalizzate
magliette|personalizzate
abbigliamento-lavoro|personalizzato`;

const DEFAULT_TITLE_TEMPLATE = "<Categoria> <Personalizzati> | Offerte Stampa Online";
const DEFAULT_DESCRIPTION_TEMPLATE =
  "Sfoglia il catalogo di <Categoria> personalizzabili online ✓ Alta qualità di stampa ✓ Spedizione rapida in 24/48h ✓ Verifica file gratuita";

const COLLECTION_BY_HANDLE_QUERY = `#graphql
  query CollectionSeoImporterByHandle($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      title
      handle
      seo {
        title
        description
      }
    }
  }
`;

const FIND_COLLECTIONS_QUERY = `#graphql
  query CollectionSeoImporterFindCollections($query: String!) {
    collections(first: 10, query: $query) {
      edges {
        node {
          id
          title
          handle
          seo {
            title
            description
          }
        }
      }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `#graphql
  mutation CollectionSeoImporterUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection {
        id
        title
        handle
        seo {
          title
          description
        }
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

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCompare(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseCollectionInputs(rawText: string) {
  const seen = new Set<string>();
  const rows: CollectionInputRow[] = [];

  rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [rawCollectionRef, rawAdjectiveOverride = ""] = line.split("|");
      const collectionRef = normalizeText(rawCollectionRef || "");
      const adjectiveOverride = normalizeText(rawAdjectiveOverride || "");
      const dedupeKey = `${normalizeCompare(collectionRef)}|${normalizeCompare(adjectiveOverride)}`;

      if (!collectionRef || seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      rows.push({
        rawInput: line,
        collectionRef,
        adjectiveOverride,
      });
    });

  return rows;
}

function extractLastWord(value: string) {
  const matches = value.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) ?? [];
  return matches[matches.length - 1] ?? "";
}

function inferAdjective(collectionTitle: string) {
  const lastWord = normalizeCompare(extractLastWord(collectionTitle));

  if (lastWord.endsWith("e")) return "personalizzate";
  if (lastWord.endsWith("a")) return "personalizzata";
  if (lastWord.endsWith("o")) return "personalizzato";
  if (lastWord.endsWith("i")) return "personalizzati";

  return "personalizzati";
}

function capitalize(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildTemplateValue(template: string, category: string, adjective: string) {
  return template
    .replace(/<Categoria>/g, category)
    .replace(/<categoria>/g, category.toLowerCase())
    .replace(/<Personalizzati>/g, capitalize(adjective))
    .replace(/<personalizzati>/g, adjective);
}

async function findCollectionByHandle(admin: any, handle: string): Promise<CollectionMatch | null> {
  const data = await adminGraphql(admin, COLLECTION_BY_HANDLE_QUERY, {
    handle,
  });

  const collection = data.collectionByHandle as CollectionMatch | null;
  if (!collection) return null;

  return normalizeCompare(collection.handle) === normalizeCompare(handle) ? collection : null;
}

async function findCollectionsByTitle(admin: any, title: string): Promise<CollectionMatch[]> {
  const data = await adminGraphql(admin, FIND_COLLECTIONS_QUERY, {
    query: `title:"${title.replace(/"/g, '\\"')}"`,
  });

  const nodes = (data.collections.edges as Array<{ node: CollectionMatch }>).map((edge) => edge.node);
  return nodes.filter((collection) => normalizeCompare(collection.title) === normalizeCompare(title));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode: ImportMode = formData.get("mode") === "apply" ? "apply" : "preview";
  const rawCollections = String(formData.get("collections") ?? "");
  const titleTemplate =
    normalizeText(String(formData.get("titleTemplate") ?? DEFAULT_TITLE_TEMPLATE)) ||
    DEFAULT_TITLE_TEMPLATE;
  const descriptionTemplate =
    normalizeText(String(formData.get("descriptionTemplate") ?? DEFAULT_DESCRIPTION_TEMPLATE)) ||
    DEFAULT_DESCRIPTION_TEMPLATE;
  const rows = parseCollectionInputs(rawCollections);

  if (!rows.length) {
    return {
      ok: false,
      mode,
      errors: ["Inserisci almeno una collezione."],
    } satisfies ImportResult;
  }

  try {
    const details: ImportDetail[] = [];
    const prepared: Array<{
      input: string;
      collection: CollectionMatch;
      adjective: string;
      pageTitle: string;
      metaDescription: string;
    }> = [];

    for (const row of rows) {
      let collection = await findCollectionByHandle(admin, row.collectionRef);

      if (!collection) {
        const matches = await findCollectionsByTitle(admin, row.collectionRef);
        if (matches.length > 1) {
          details.push({
            input: row.collectionRef,
            adjective: row.adjectiveOverride || "personalizzati",
            pageTitle: "",
            metaDescription: "",
            status: "ambiguous-collection",
            message: `Piu collezioni con questo titolo: ${matches.map((entry) => entry.handle).join(", ")}.`,
          });
          continue;
        }

        collection = matches[0] ?? null;
      }

      if (!collection) {
        details.push({
          input: row.collectionRef,
          adjective: row.adjectiveOverride || "personalizzati",
          pageTitle: "",
          metaDescription: "",
          status: "missing-collection",
          message: "Collezione non trovata.",
        });
        continue;
      }

      const adjective = row.adjectiveOverride || inferAdjective(collection.title);
      const pageTitle = buildTemplateValue(titleTemplate, collection.title, adjective);
      const metaDescription = buildTemplateValue(descriptionTemplate, collection.title, adjective);

      prepared.push({
        input: row.collectionRef,
        collection,
        adjective,
        pageTitle,
        metaDescription,
      });

      details.push({
        input: row.collectionRef,
        collectionTitle: collection.title,
        collectionHandle: collection.handle,
        adjective,
        pageTitle,
        metaDescription,
        status: mode === "apply" ? "updated" : "ready",
        message:
          mode === "apply"
            ? "SEO pronta da aggiornare."
            : "SEO generata correttamente per l anteprima.",
      });
    }

    if (mode === "apply") {
      for (const item of prepared) {
        const data = await adminGraphql(admin, COLLECTION_UPDATE_MUTATION, {
          collection: {
            id: item.collection.id,
            seo: {
              title: item.pageTitle,
              description: item.metaDescription,
            },
          },
        });

        const userErrors = data.collectionUpdate.userErrors as Array<{
          field?: string[];
          message: string;
        }>;

        if (!userErrors?.length) continue;

        const detail = details.find(
          (entry) => normalizeCompare(entry.input) === normalizeCompare(item.input),
        );
        if (!detail) continue;

        detail.status = "error";
        detail.message = userErrors.map((error) => error.message).join(" ");
      }

      details.forEach((detail) => {
        if (detail.status === "updated") {
          detail.message = "Meta title e meta description aggiornate.";
        }
      });
    }

    const readyCount = details.filter((detail) =>
      mode === "apply" ? detail.status === "updated" : detail.status === "ready",
    ).length;

    return {
      ok: true,
      mode,
      titleTemplate,
      descriptionTemplate,
      totalInputs: rows.length,
      readyCount,
      skippedCount: details.length - readyCount,
      details,
    } satisfies ImportResult;
  } catch (error) {
    return {
      ok: false,
      mode,
      titleTemplate,
      descriptionTemplate,
      errors: [
        error instanceof Error ? error.message : "Errore durante l aggiornamento SEO delle collezioni.",
      ],
    } satisfies ImportResult;
  }
};

export default function CollectionSeoImporter() {
  const actionData = useActionData() as ImportResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state !== "idle";
  const submittingMode = navigation.formData?.get("mode");

  useEffect(() => {
    if (actionData?.ok && actionData.mode === "apply") {
      shopify.toast.show("SEO collezioni aggiornata");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Collection SEO Importer">
      <style>{styles}</style>
      <div className="collection-seo-importer">
        <section className="collection-seo-importer__card">
          <p className="collection-seo-importer__kicker">SEO batch collezioni</p>
          <h1>Genera e applica meta title e meta description alle collezioni</h1>
          <p>
            Incolla un titolo o handle collezione per riga. Se vuoi forzare il genere o numero
            dell aggettivo, usa il formato <strong>collezione|personalizzate</strong>.
            In assenza di override, l app prova a dedurlo dal titolo della collezione.
          </p>

          <Form className="collection-seo-importer__form" method="post">
            <label className="collection-seo-importer__field">
              <span>Template page title</span>
              <input defaultValue={DEFAULT_TITLE_TEMPLATE} name="titleTemplate" required />
            </label>

            <label className="collection-seo-importer__field">
              <span>Template meta description</span>
              <textarea
                defaultValue={DEFAULT_DESCRIPTION_TEMPLATE}
                name="descriptionTemplate"
                rows={4}
                required
              />
            </label>

            <label className="collection-seo-importer__field">
              <span>Collezioni</span>
              <textarea defaultValue={DEFAULT_COLLECTIONS} name="collections" rows={14} required />
            </label>

            <p className="collection-seo-importer__help">
              Placeholder disponibili: <code>&lt;Categoria&gt;</code>, <code>&lt;categoria&gt;</code>,{" "}
              <code>&lt;Personalizzati&gt;</code>, <code>&lt;personalizzati&gt;</code>.
            </p>

            <div className="collection-seo-importer__actions">
              <button
                className="collection-seo-importer__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingMode === "preview" ? "Analisi..." : "Anteprima batch"}
              </button>
              <button
                className="collection-seo-importer__button collection-seo-importer__button--primary"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingMode === "apply" ? "Aggiorno..." : "Applica SEO"}
              </button>
            </div>
          </Form>
        </section>

        <aside className="collection-seo-importer__result">
          <h2>Risultato</h2>
          {!actionData ? (
            <p className="collection-seo-importer__muted">
              Esegui una anteprima per controllare il testo generato prima di applicarlo.
            </p>
          ) : actionData.ok ? (
            <div className="collection-seo-importer__success">
              <strong>
                {actionData.mode === "apply" ? "Aggiornamento completato" : "Anteprima completata"}
              </strong>
              <p>
                Input letti: {actionData.totalInputs}.{" "}
                {actionData.mode === "apply" ? "Aggiornati" : "Pronti"}: {actionData.readyCount}. Da
                controllare: {actionData.skippedCount}.
              </p>
              <ul>
                {actionData.details?.map((detail) => (
                  <li key={`${detail.input}-${detail.status}`}>
                    <span
                      className={`collection-seo-importer__badge collection-seo-importer__badge--${detail.status}`}
                    >
                      {detail.status === "updated"
                        ? "OK"
                        : detail.status === "ready"
                          ? "PRONTO"
                          : detail.status === "missing-collection"
                            ? "NO COLL"
                            : detail.status === "ambiguous-collection"
                              ? "AMB"
                              : "ERR"}
                    </span>
                    <span>
                      {detail.collectionTitle
                        ? `${detail.collectionTitle} (${detail.collectionHandle})`
                        : detail.input}
                      {detail.pageTitle ? ` - Title: ${detail.pageTitle}.` : ""}
                      {detail.metaDescription ? ` Description: ${detail.metaDescription}.` : ""}
                      {detail.message ? ` ${detail.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="collection-seo-importer__error">
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
  .collection-seo-importer {
    display: grid;
    grid-template-columns: minmax(0, 1.12fr) minmax(320px, .88fr);
    gap: 22px;
    max-width: 1240px;
    margin: 0 auto;
    padding: 22px;
    color: #1f2937;
  }

  .collection-seo-importer__card,
  .collection-seo-importer__result {
    border: 1px solid #d7e4f2;
    border-radius: 18px;
    background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .08);
    padding: 24px;
  }

  .collection-seo-importer__kicker,
  .collection-seo-importer__field span {
    margin: 0 0 8px;
    color: #475569;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .collection-seo-importer h1,
  .collection-seo-importer h2 {
    margin: 0 0 10px;
    color: #0f172a;
  }

  .collection-seo-importer p {
    color: #526172;
    line-height: 1.5;
  }

  .collection-seo-importer__form {
    display: grid;
    gap: 16px;
    margin-top: 22px;
  }

  .collection-seo-importer__field {
    display: grid;
    gap: 8px;
  }

  .collection-seo-importer__field input,
  .collection-seo-importer__field textarea {
    width: 100%;
    min-height: 54px;
    border: 1px solid #bfd1e5;
    border-radius: 14px;
    padding: 14px 16px;
    background: #fff;
    color: #111827;
    font: inherit;
    font-weight: 650;
    box-sizing: border-box;
  }

  .collection-seo-importer__field textarea {
    resize: vertical;
    line-height: 1.45;
  }

  .collection-seo-importer__help {
    margin: -2px 0 0;
    font-size: 14px;
  }

  .collection-seo-importer__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .collection-seo-importer__button {
    min-height: 50px;
    border: 1px solid #bfd1e5;
    border-radius: 14px;
    padding: 0 18px;
    background: #eff6ff;
    color: #1d4ed8;
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }

  .collection-seo-importer__button--primary {
    border-color: #2563eb;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
  }

  .collection-seo-importer__button:disabled {
    opacity: .6;
    cursor: wait;
  }

  .collection-seo-importer__muted {
    color: #6b7280;
  }

  .collection-seo-importer__success strong,
  .collection-seo-importer__error strong {
    display: block;
    margin-bottom: 10px;
  }

  .collection-seo-importer__success ul,
  .collection-seo-importer__error ul {
    margin: 14px 0 0;
    padding-left: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }

  .collection-seo-importer__success li,
  .collection-seo-importer__error li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: #334155;
    line-height: 1.45;
  }

  .collection-seo-importer__badge {
    flex: 0 0 auto;
    min-width: 76px;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .05em;
    text-align: center;
  }

  .collection-seo-importer__badge--updated {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .collection-seo-importer__badge--ready {
    background: #e0f2fe;
    color: #0369a1;
  }

  .collection-seo-importer__badge--missing-collection,
  .collection-seo-importer__badge--ambiguous-collection,
  .collection-seo-importer__badge--error {
    background: #fee2e2;
    color: #991b1b;
  }

  @media (max-width: 960px) {
    .collection-seo-importer {
      grid-template-columns: 1fr;
      padding: 16px;
    }
  }
`;
