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
  | "missing-product"
  | "ambiguous-product"
  | "missing-category"
  | "error";

type ImportDetail = {
  input: string;
  productTitle?: string;
  productHandle?: string;
  status: DetailStatus;
  message: string;
};

type ImportResult = {
  ok: boolean;
  mode?: ImportMode;
  categoryLabel?: string;
  metafieldType?: string;
  metaobjectType?: string;
  totalInputs?: number;
  readyCount?: number;
  skippedCount?: number;
  details?: ImportDetail[];
  errors?: string[];
};

type ProductMatch = {
  id: string;
  title: string;
  handle: string;
};

type MetaobjectNode = {
  id: string;
  handle: string;
  displayName?: string | null;
  fields?: Array<{ key: string; value: string | null }>;
};

type CategoryTarget = {
  id: string;
  handle: string;
  label: string;
};

const DEFAULT_PRODUCTS = `T-shirt Economy UNISEX
T-shirt Economy BAMBINO/A
T-shirt classica UNISEX
T-shirt classica DONNA
T-shirt classica BAMBINO/A
T-shirt Premium UNISEX
T-shirt oversize UNISEX
T-shirt oversize premium UNISEX
T-shirt crop DONNA
T-shirt tecnica UNISEX
T-shirt tecnica BAMBINO/A
Maglia manica lunga UNISEX
Maglia manica lunga DONNA
T-shirt Lavoro UNISEX
T-shirt Alta Visibilità UNISEX`;

const DEFAULT_CATEGORY = "T-shirt e Maglie";

const METAFIELD_DEFINITION_QUERY = `#graphql
  query CategoriaProdottoDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
      nodes {
        namespace
        key
        type { name }
        validations {
          name
          value
        }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_ID_QUERY = `#graphql
  query CategoriaProdottoMetaobjectDefinition($id: ID!) {
    metaobjectDefinition(id: $id) {
      id
      type
    }
  }
`;

const METAOBJECTS_BY_TYPE_QUERY = `#graphql
  query CategoriaProdottoMetaobjects($type: String!) {
    metaobjects(first: 250, type: $type) {
      nodes {
        id
        handle
        displayName
        fields {
          key
          value
        }
      }
    }
  }
`;

const FIND_PRODUCTS_QUERY = `#graphql
  query CategoriaProdottoFindProducts($query: String!) {
    products(first: 10, query: $query) {
      nodes {
        id
        title
        handle
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation CategoriaProdottoSetMetafields($metafields: [MetafieldsSetInput!]!) {
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

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCompare(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseProductInputs(rawText: string) {
  const seen = new Set<string>();
  const values: string[] = [];

  rawText
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .forEach((line) => {
      const key = normalizeCompare(line);
      if (seen.has(key)) return;
      seen.add(key);
      values.push(line);
    });

  return values;
}

function extractMetaobjectDefinitionId(validations: Array<{ name: string; value: string }> = []) {
  const exactMatch = validations.find((entry) =>
    ["metaobject_definition_id", "metaobject_definition", "definition_id"].includes(
      normalizeCompare(entry.name),
    ),
  );
  if (exactMatch?.value) return exactMatch.value;

  const idLike = validations.find((entry) => /MetaobjectDefinition\/\d+/i.test(entry.value));
  return idLike?.value ?? "";
}

function parseBatchUserErrors(errors: Array<{ field?: string[]; message: string }>, batchSize: number) {
  const byIndex = new Map<number, string[]>();
  const generic: string[] = [];

  for (const error of errors) {
    const fieldPath = error.field?.join(".") ?? "";
    const match = fieldPath.match(/metafields\.(\d+)/);
    if (!match) {
      generic.push(error.message);
      continue;
    }

    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= batchSize) {
      generic.push(error.message);
      continue;
    }

    const messages = byIndex.get(index) ?? [];
    messages.push(error.message);
    byIndex.set(index, messages);
  }

  return { byIndex, generic };
}

async function getCategoryTarget(admin: any, categoryLabel: string) {
  const definitionData = await adminGraphql(admin, METAFIELD_DEFINITION_QUERY, {
    namespace: "custom",
    key: "categoria_prodotto",
  });

  const definition = definitionData.metafieldDefinitions.nodes[0];
  if (!definition) {
    throw new Error("Definizione metafield product.custom.categoria_prodotto non trovata.");
  }

  const metafieldType = String(definition.type?.name || "metaobject_reference");
  const definitionId = extractMetaobjectDefinitionId(definition.validations ?? []);

  if (!definitionId) {
    throw new Error(
      "Non riesco a capire quale definizione metaobject usa custom.categoria_prodotto.",
    );
  }

  const metaobjectDefinitionData = await adminGraphql(admin, METAOBJECT_DEFINITION_BY_ID_QUERY, {
    id: definitionId,
  });

  const metaobjectType = String(metaobjectDefinitionData.metaobjectDefinition?.type || "");
  if (!metaobjectType) {
    throw new Error("Tipo metaobject per categoria_prodotto non trovato.");
  }

  const metaobjectsData = await adminGraphql(admin, METAOBJECTS_BY_TYPE_QUERY, {
    type: metaobjectType,
  });

  const category = (metaobjectsData.metaobjects.nodes as MetaobjectNode[]).find((node) => {
    const values = [
      node.displayName ?? "",
      node.handle,
      ...(node.fields ?? []).map((field) => field.value ?? ""),
    ];
    return values.some((value) => normalizeCompare(value) === normalizeCompare(categoryLabel));
  });

  if (!category) {
    throw new Error(`Voce categoria "${categoryLabel}" non trovata tra i metaobject ${metaobjectType}.`);
  }

  const label =
    category.displayName ||
    category.fields?.find((field) =>
      ["label", "title", "name", "nome"].includes(normalizeCompare(field.key)),
    )?.value ||
    category.handle;

  return {
    metafieldType,
    metaobjectType,
    category: {
      id: category.id,
      handle: category.handle,
      label: String(label || category.handle),
    } satisfies CategoryTarget,
  };
}

async function findProductByHandle(admin: any, handle: string): Promise<ProductMatch | null> {
  const data = await adminGraphql(admin, FIND_PRODUCTS_QUERY, {
    query: `handle:${handle}`,
  });

  const matches = (data.products.nodes as ProductMatch[]).filter(
    (product) => normalizeCompare(product.handle) === normalizeCompare(handle),
  );

  return matches[0] ?? null;
}

async function findProductsByTitle(admin: any, title: string): Promise<ProductMatch[]> {
  const data = await adminGraphql(admin, FIND_PRODUCTS_QUERY, {
    query: `title:"${title.replace(/"/g, '\\"')}"`,
  });

  return (data.products.nodes as ProductMatch[]).filter(
    (product) => normalizeCompare(product.title) === normalizeCompare(title),
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode: ImportMode = formData.get("mode") === "apply" ? "apply" : "preview";
  const rawProducts = String(formData.get("products") ?? "");
  const categoryLabel = normalizeText(String(formData.get("categoryLabel") ?? DEFAULT_CATEGORY));
  const products = parseProductInputs(rawProducts);

  if (!products.length) {
    return {
      ok: false,
      mode,
      errors: ["Inserisci almeno un prodotto."],
    } satisfies ImportResult;
  }

  if (!categoryLabel) {
    return {
      ok: false,
      mode,
      errors: ["Inserisci la voce categoria da applicare."],
    } satisfies ImportResult;
  }

  try {
    const { metafieldType, metaobjectType, category } = await getCategoryTarget(admin, categoryLabel);
    const details: ImportDetail[] = [];
    const prepared: Array<{ input: string; product: ProductMatch }> = [];

    for (const input of products) {
      let product = await findProductByHandle(admin, input);
      if (!product) {
        const matches = await findProductsByTitle(admin, input);
        if (matches.length > 1) {
          details.push({
            input,
            status: "ambiguous-product",
            message: `Piu prodotti con questo titolo: ${matches.map((entry) => entry.handle).join(", ")}.`,
          });
          continue;
        }
        product = matches[0] ?? null;
      }

      if (!product) {
        details.push({
          input,
          status: "missing-product",
          message: "Prodotto non trovato.",
        });
        continue;
      }

      prepared.push({ input, product });
      details.push({
        input,
        productTitle: product.title,
        productHandle: product.handle,
        status: mode === "apply" ? "updated" : "ready",
        message:
          mode === "apply"
            ? `Da aggiornare con ${category.label}.`
            : `Pronto per ${category.label}.`,
      });
    }

    if (mode === "apply" && prepared.length) {
      for (let index = 0; index < prepared.length; index += 25) {
        const batch = prepared.slice(index, index + 25);
        const data = await adminGraphql(admin, METAFIELDS_SET_MUTATION, {
          metafields: batch.map((item) => ({
            ownerId: item.product.id,
            namespace: "custom",
            key: "categoria_prodotto",
            type: metafieldType,
            value: category.id,
          })),
        });

        const userErrors = data.metafieldsSet.userErrors ?? [];
        if (!userErrors.length) continue;

        const { byIndex, generic } = parseBatchUserErrors(userErrors, batch.length);
        batch.forEach((item, batchIndex) => {
          const errorMessages = byIndex.get(batchIndex);
          if (!errorMessages?.length) return;

          const detail = details.find((entry) => normalizeCompare(entry.input) === normalizeCompare(item.input));
          if (!detail) return;

          detail.status = "error";
          detail.message = errorMessages.join(" ");
        });

        if (generic.length) {
          throw new Error(generic.join(" "));
        }
      }

      details.forEach((detail) => {
        if (detail.status === "updated") {
          detail.message = `Metafield custom.categoria_prodotto aggiornato con ${category.label}.`;
        }
      });
    }

    const readyCount = details.filter((detail) =>
      mode === "apply" ? detail.status === "updated" : detail.status === "ready",
    ).length;

    return {
      ok: true,
      mode,
      categoryLabel: category.label,
      metafieldType,
      metaobjectType,
      totalInputs: products.length,
      readyCount,
      skippedCount: details.length - readyCount,
      details,
    } satisfies ImportResult;
  } catch (error) {
    return {
      ok: false,
      mode,
      categoryLabel,
      errors: [
        error instanceof Error
          ? error.message
          : "Errore durante l aggiornamento di custom.categoria_prodotto.",
      ],
    } satisfies ImportResult;
  }
};

export default function CategoriaProdottoImporter() {
  const actionData = useActionData() as ImportResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state !== "idle";
  const submittingMode = navigation.formData?.get("mode");

  useEffect(() => {
    if (actionData?.ok && actionData.mode === "apply") {
      shopify.toast.show("Categoria prodotto aggiornata");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Categoria Prodotto Importer">
      <style>{styles}</style>
      <div className="categoria-importer">
        <section className="categoria-importer__card">
          <p className="categoria-importer__kicker">Metafield batch</p>
          <h1>Imposta custom.categoria_prodotto su una lista di prodotti</h1>
          <p>
            Incolla titoli o handle prodotto, uno per riga. La pagina cerca la voce
            metaobject esistente e poi aggiorna il metafield{" "}
            <strong>product.custom.categoria_prodotto</strong> usando la sessione
            autenticata dell app Shopify.
          </p>

          <Form className="categoria-importer__form" method="post">
            <label className="categoria-importer__field categoria-importer__field--wide">
              <span>Voce categoria esistente</span>
              <input defaultValue={DEFAULT_CATEGORY} name="categoryLabel" required />
            </label>

            <label className="categoria-importer__field categoria-importer__field--wide">
              <span>Prodotti</span>
              <textarea defaultValue={DEFAULT_PRODUCTS} name="products" rows={16} required />
            </label>

            <div className="categoria-importer__actions">
              <button
                className="categoria-importer__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingMode === "preview" ? "Analisi..." : "Anteprima batch"}
              </button>
              <button
                className="categoria-importer__button categoria-importer__button--primary"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingMode === "apply" ? "Aggiorno..." : "Applica categoria"}
              </button>
            </div>
          </Form>
        </section>

        <aside className="categoria-importer__result">
          <h2>Risultato</h2>
          {!actionData ? (
            <p className="categoria-importer__muted">
              Esegui una anteprima per controllare prodotti trovati e voce categoria
              prima di applicare l aggiornamento.
            </p>
          ) : actionData.ok ? (
            <div className="categoria-importer__success">
              <strong>
                {actionData.mode === "apply" ? "Aggiornamento completato" : "Anteprima completata"}
              </strong>
              <p>
                Categoria: <strong>{actionData.categoryLabel}</strong>. Input letti:{" "}
                {actionData.totalInputs}.{" "}
                {actionData.mode === "apply" ? "Aggiornati" : "Pronti"}: {actionData.readyCount}.
                Da controllare: {actionData.skippedCount}.
                {actionData.metaobjectType ? ` Tipo metaobject: ${actionData.metaobjectType}.` : ""}
              </p>
              <ul>
                {actionData.details?.map((detail) => (
                  <li key={`${detail.input}-${detail.status}`}>
                    <span className={`categoria-importer__badge categoria-importer__badge--${detail.status}`}>
                      {detail.status === "updated"
                        ? "OK"
                        : detail.status === "ready"
                          ? "PRONTO"
                          : detail.status === "missing-product"
                            ? "NO PROD"
                            : detail.status === "missing-category"
                              ? "NO CAT"
                              : detail.status === "ambiguous-product"
                                ? "AMB"
                                : "ERR"}
                    </span>
                    <span>
                      {detail.productTitle ? `${detail.productTitle} (${detail.productHandle})` : detail.input}
                      {detail.message ? ` - ${detail.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="categoria-importer__error">
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
  .categoria-importer {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr);
    gap: 22px;
    max-width: 1200px;
    margin: 0 auto;
    padding: 22px;
    color: #1f2937;
  }

  .categoria-importer__card,
  .categoria-importer__result {
    border: 1px solid #cfe4d7;
    border-radius: 18px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfffc 100%);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .08);
    padding: 24px;
  }

  .categoria-importer__kicker,
  .categoria-importer__field span {
    margin: 0 0 8px;
    color: #4b5563;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .categoria-importer h1,
  .categoria-importer h2 {
    margin: 0 0 10px;
    color: #1f2937;
  }

  .categoria-importer p {
    color: #526172;
    line-height: 1.5;
  }

  .categoria-importer__form {
    display: grid;
    gap: 16px;
    margin-top: 22px;
  }

  .categoria-importer__field {
    display: grid;
    gap: 8px;
  }

  .categoria-importer__field input,
  .categoria-importer__field textarea {
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

  .categoria-importer__field textarea {
    resize: vertical;
    line-height: 1.45;
  }

  .categoria-importer__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .categoria-importer__button {
    min-height: 50px;
    border: 1px solid #b9d8c2;
    border-radius: 14px;
    padding: 0 18px;
    background: #f4fbf6;
    color: #14532d;
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }

  .categoria-importer__button--primary {
    border-color: #16a34a;
    background: linear-gradient(135deg, #1ec361 0%, #14994a 100%);
    color: white;
  }

  .categoria-importer__button:disabled {
    opacity: .6;
    cursor: wait;
  }

  .categoria-importer__muted {
    color: #6b7280;
  }

  .categoria-importer__success strong,
  .categoria-importer__error strong {
    display: block;
    margin-bottom: 10px;
  }

  .categoria-importer__success ul,
  .categoria-importer__error ul {
    margin: 14px 0 0;
    padding-left: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }

  .categoria-importer__success li,
  .categoria-importer__error li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: #374151;
    line-height: 1.45;
  }

  .categoria-importer__badge {
    flex: 0 0 auto;
    min-width: 76px;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .05em;
    text-align: center;
  }

  .categoria-importer__badge--updated {
    background: #dcfce7;
    color: #166534;
  }

  .categoria-importer__badge--ready {
    background: #ecfccb;
    color: #4d7c0f;
  }

  .categoria-importer__badge--missing-product,
  .categoria-importer__badge--missing-category,
  .categoria-importer__badge--ambiguous-product,
  .categoria-importer__badge--error {
    background: #fee2e2;
    color: #991b1b;
  }

  @media (max-width: 960px) {
    .categoria-importer {
      grid-template-columns: 1fr;
      padding: 16px;
    }
  }
`;
