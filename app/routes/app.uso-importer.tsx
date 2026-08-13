import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useNavigation, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import JSZip from "jszip";
import { authenticate } from "../shopify.server";

type ImportMode = "preview" | "apply";

type ParsedUsoRow = {
  rowNumber: number;
  productTitle: string;
  productHandle: string;
  usoLabel: string;
  usoHandle: string;
  note: string;
};

type PreparedRow = ParsedUsoRow & {
  productId: string;
  matchedHandle: string;
  metaobjectId: string;
  metaobjectHandle: string;
};

type DetailStatus =
  | "ready"
  | "updated"
  | "missing-product"
  | "missing-uso-handle"
  | "missing-metaobject"
  | "ambiguous-product"
  | "error";

type UsoImportDetail = {
  rowNumber: number;
  productTitle: string;
  productHandle?: string;
  usoLabel: string;
  usoHandle?: string;
  status: DetailStatus;
  message: string;
};

type UsoImportResult = {
  ok: boolean;
  mode?: ImportMode;
  metafieldType?: string;
  totalRows?: number;
  preparedRows?: number;
  updatedRows?: number;
  skippedRows?: number;
  details?: UsoImportDetail[];
  errors?: string[];
};

type ProductMatch = {
  id: string;
  title: string;
  handle: string;
};

type MetaobjectMatch = {
  id: string;
  handle: string;
};

const METAFIELD_DEFINITION_QUERY = `#graphql
  query UsoImporterMetafieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
      nodes {
        namespace
        key
        type { name }
      }
    }
  }
`;

const FIND_PRODUCTS_QUERY = `#graphql
  query UsoImporterFindProducts($query: String!) {
    products(first: 10, query: $query) {
      nodes {
        id
        title
        handle
      }
    }
  }
`;

const METAOBJECT_BY_HANDLE_QUERY = `#graphql
  query UsoImporterMetaobjectByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      handle
      type
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation UsoImporterMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
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
  return normalizeText(value).toLowerCase();
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function columnFromRef(ref: string) {
  const match = ref.match(/[A-Z]+/i)?.[0] ?? "";
  return match.toUpperCase();
}

function stripXmlTags(value: string) {
  return decodeXml(value.replace(/<[^>]+>/g, ""));
}

function extractSharedStrings(xml: string) {
  const strings: string[] = [];
  const matcher = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(xml))) {
    const richText = Array.from(match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((entry) => stripXmlTags(entry[1]))
      .join("");
    strings.push(richText);
  }

  return strings;
}

function extractCellValue(cellXml: string, cellType: string | undefined, sharedStrings: string[]) {
  if (cellType === "inlineStr") {
    const inlineMatch = cellXml.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
    return inlineMatch ? stripXmlTags(inlineMatch[1]) : "";
  }

  const valueMatch = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  if (!valueMatch) return "";

  const rawValue = stripXmlTags(valueMatch[1]);
  if (cellType === "s") {
    const index = Number(rawValue);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }

  return rawValue;
}

function parseSheetRows(xml: string, sharedStrings: string[]) {
  const rows: Array<Record<string, string>> = [];
  const rowMatcher = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowMatcher.exec(xml))) {
    const current: Record<string, string> = {};
    const cellMatcher = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellMatcher.exec(rowMatch[1]))) {
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      if (!ref) continue;
      current[columnFromRef(ref)] = extractCellValue(cellMatch[2], type, sharedStrings);
    }

    if (Object.keys(current).length > 0) {
      rows.push(current);
    }
  }

  return rows;
}

function parseWorkbookSheetPath(workbookXml: string, relsXml: string, targetSheetName: string) {
  const sheets = Array.from(
    workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g),
  ).map((match) => ({ name: decodeXml(match[1]), relId: match[2] }));

  const selectedSheet =
    sheets.find((sheet) => normalizeCompare(sheet.name) === normalizeCompare(targetSheetName)) ??
    sheets[0];

  if (!selectedSheet) {
    throw new Error("Nessun foglio trovato nel file Excel.");
  }

  const rels = Array.from(
    relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g),
  ).map((match) => ({ id: match[1], target: match[2] }));

  const relationship = rels.find((entry) => entry.id === selectedSheet.relId);
  if (!relationship) {
    throw new Error(`Relazione non trovata per il foglio ${selectedSheet.name}.`);
  }

  return relationship.target.startsWith("xl/")
    ? relationship.target
    : `xl/${relationship.target.replace(/^\.\//, "")}`;
}

async function parseXlsxFile(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");

  if (!workbookXml || !relsXml) {
    throw new Error("File Excel non valido: struttura workbook mancante.");
  }

  const sheetPath = parseWorkbookSheetPath(workbookXml, relsXml, "Definizioni");
  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) {
    throw new Error("Foglio Definizioni non trovato nel file Excel.");
  }

  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedStringsXml ? extractSharedStrings(sharedStringsXml) : [];

  return parseSheetRows(sheetXml, sharedStrings);
}

function parseDelimitedRecords(text: string) {
  const records: string[][] = [];
  let cells: string[] = [];
  let current = "";
  let quoted = false;
  let delimiter = ",";

  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.includes("\t")) delimiter = "\t";
  else if (firstLine.includes(";")) delimiter = ";";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      cells.push(current);
      if (cells.some((cell) => cell.trim())) {
        records.push(cells.map((cell) => cell.trim()));
      }
      cells = [];
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  if (cells.some((cell) => cell.trim())) {
    records.push(cells.map((cell) => cell.trim()));
  }

  if (quoted) {
    throw new Error("CSV/TSV non valido: virgolette non chiuse.");
  }

  return records;
}

function headerIndexMap(headers: string[]) {
  const normalized = headers.map((header) => normalizeCompare(header));
  const findIndex = (...options: string[]) =>
    normalized.findIndex((header) => options.some((option) => header === normalizeCompare(option)));

  return {
    productTitle: findIndex("Titolo Prodotto"),
    productHandle: findIndex("Handle prodotto"),
    usoLabel: findIndex("Custom.uso"),
    usoHandle: findIndex("Handle voce metafield"),
    note: findIndex("Note match"),
  };
}

function buildRowsFromTabularData(records: string[][]) {
  if (!records.length) {
    throw new Error("Il file e vuoto.");
  }

  const indexes = headerIndexMap(records[0]);
  if (indexes.productTitle === -1 || indexes.usoLabel === -1) {
    throw new Error(
      "Colonne richieste non trovate. Servono almeno Titolo Prodotto e Custom.uso.",
    );
  }

  return records.slice(1).reduce<ParsedUsoRow[]>((rows, record, offset) => {
    const productTitle = normalizeText(record[indexes.productTitle] ?? "");
    const productHandle =
      indexes.productHandle >= 0 ? normalizeText(record[indexes.productHandle] ?? "") : "";
    const usoLabel = normalizeText(record[indexes.usoLabel] ?? "");
    const usoHandle =
      indexes.usoHandle >= 0 ? normalizeText(record[indexes.usoHandle] ?? "") : "";
    const note = indexes.note >= 0 ? normalizeText(record[indexes.note] ?? "") : "";

    if (!productTitle && !productHandle && !usoLabel && !usoHandle && !note) {
      return rows;
    }

    if (!productTitle || !usoLabel) {
      return rows;
    }

    rows.push({
      rowNumber: offset + 2,
      productTitle,
      productHandle,
      usoLabel,
      usoHandle,
      note,
    });
    return rows;
  }, []);
}

function buildRowsFromSheetCells(rows: Array<Record<string, string>>) {
  if (!rows.length) {
    throw new Error("Il foglio Definizioni e vuoto.");
  }

  const headerRow = rows[0];
  const headers = Object.keys(headerRow)
    .sort()
    .map((column) => headerRow[column] ?? "");
  const indexes = headerIndexMap(headers);

  const getColumnByIndex = (index: number) =>
    index >= 0 ? Object.keys(headerRow).sort()[index] ?? "" : "";

  const titleColumn = getColumnByIndex(indexes.productTitle);
  const handleColumn = getColumnByIndex(indexes.productHandle);
  const usoLabelColumn = getColumnByIndex(indexes.usoLabel);
  const usoHandleColumn = getColumnByIndex(indexes.usoHandle);
  const noteColumn = getColumnByIndex(indexes.note);

  if (!titleColumn || !usoLabelColumn) {
    throw new Error(
      "Colonne richieste non trovate nel foglio Definizioni. Servono almeno Titolo Prodotto e Custom.uso.",
    );
  }

  return rows.slice(1).reduce<ParsedUsoRow[]>((result, row, offset) => {
    const productTitle = normalizeText(row[titleColumn] ?? "");
    const productHandle = normalizeText(row[handleColumn] ?? "");
    const usoLabel = normalizeText(row[usoLabelColumn] ?? "");
    const usoHandle = normalizeText(row[usoHandleColumn] ?? "");
    const note = normalizeText(row[noteColumn] ?? "");

    if (!productTitle && !productHandle && !usoLabel && !usoHandle && !note) {
      return result;
    }

    if (!productTitle || !usoLabel) {
      return result;
    }

    result.push({
      rowNumber: offset + 2,
      productTitle,
      productHandle,
      usoLabel,
      usoHandle,
      note,
    });
    return result;
  }, []);
}

async function parseUsoFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (extension === "xlsx") {
    const buffer = Buffer.from(await file.arrayBuffer());
    const rows = await parseXlsxFile(buffer);
    return buildRowsFromSheetCells(rows);
  }

  if (extension === "csv" || extension === "tsv" || file.type.startsWith("text/")) {
    const text = await file.text();
    return buildRowsFromTabularData(parseDelimitedRecords(text.replace(/^\uFEFF/, "")));
  }

  throw new Error("Formato non supportato. Carica un file .xlsx, .csv o .tsv.");
}

async function getMetafieldType(admin: any) {
  const data = await adminGraphql(admin, METAFIELD_DEFINITION_QUERY, {
    namespace: "custom",
    key: "uso",
  });

  const definition = data.metafieldDefinitions.nodes[0];
  if (!definition) {
    throw new Error("Definizione metafield product.custom.uso non trovata.");
  }

  return String(definition.type?.name || "metaobject_reference");
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

async function findMetaobjectByHandle(
  admin: any,
  metaobjectType: string,
  handle: string,
): Promise<MetaobjectMatch | null> {
  const data = await adminGraphql(admin, METAOBJECT_BY_HANDLE_QUERY, {
    handle: {
      type: metaobjectType,
      handle,
    },
  });

  return data.metaobjectByHandle ?? null;
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

    const existing = byIndex.get(index) ?? [];
    existing.push(error.message);
    byIndex.set(index, existing);
  }

  return { byIndex, generic };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const mode: ImportMode = formData.get("mode") === "apply" ? "apply" : "preview";
  const metaobjectType = normalizeText(String(formData.get("metaobjectType") ?? "custom.uso_prodotto")) || "custom.uso_prodotto";
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      mode,
      errors: ["Carica il file Excel con il mapping da applicare."],
    } satisfies UsoImportResult;
  }

  try {
    const rows = await parseUsoFile(file);
    const metafieldType = await getMetafieldType(admin);
    const details: UsoImportDetail[] = [];
    const prepared: PreparedRow[] = [];
    const metaobjectCache = new Map<string, MetaobjectMatch | null>();

    for (const row of rows) {
      if (!row.usoHandle) {
        details.push({
          rowNumber: row.rowNumber,
          productTitle: row.productTitle,
          productHandle: row.productHandle,
          usoLabel: row.usoLabel,
          status: "missing-uso-handle",
          message: row.note || "Handle voce metafield mancante.",
        });
        continue;
      }

      let metaobject = metaobjectCache.get(row.usoHandle);
      if (metaobject === undefined) {
        metaobject = await findMetaobjectByHandle(admin, metaobjectType, row.usoHandle);
        metaobjectCache.set(row.usoHandle, metaobject);
      }

      if (!metaobject) {
        details.push({
          rowNumber: row.rowNumber,
          productTitle: row.productTitle,
          productHandle: row.productHandle,
          usoLabel: row.usoLabel,
          usoHandle: row.usoHandle,
          status: "missing-metaobject",
          message: `Metaobject ${metaobjectType}/${row.usoHandle} non trovato.`,
        });
        continue;
      }

      let product: ProductMatch | null = null;
      if (row.productHandle) {
        product = await findProductByHandle(admin, row.productHandle);
      }

      if (!product) {
        const matches = await findProductsByTitle(admin, row.productTitle);
        if (matches.length > 1) {
          details.push({
            rowNumber: row.rowNumber,
            productTitle: row.productTitle,
            productHandle: row.productHandle,
            usoLabel: row.usoLabel,
            usoHandle: row.usoHandle,
            status: "ambiguous-product",
            message: `Piu prodotti con questo titolo: ${matches.map((entry) => entry.handle).join(", ")}.`,
          });
          continue;
        }

        product = matches[0] ?? null;
      }

      if (!product) {
        details.push({
          rowNumber: row.rowNumber,
          productTitle: row.productTitle,
          productHandle: row.productHandle,
          usoLabel: row.usoLabel,
          usoHandle: row.usoHandle,
          status: "missing-product",
          message: row.note || "Prodotto non trovato nello store.",
        });
        continue;
      }

      prepared.push({
        ...row,
        productId: product.id,
        matchedHandle: product.handle,
        metaobjectId: metaobject.id,
        metaobjectHandle: metaobject.handle,
      });
      details.push({
        rowNumber: row.rowNumber,
        productTitle: row.productTitle,
        productHandle: product.handle,
        usoLabel: row.usoLabel,
        usoHandle: row.usoHandle,
        status: mode === "apply" ? "updated" : "ready",
        message:
          mode === "apply"
            ? `Da aggiornare con ${metaobject.handle}.`
            : `Pronto per ${metaobject.handle}.`,
      });
    }

    if (mode === "apply" && prepared.length) {
      for (let index = 0; index < prepared.length; index += 25) {
        const batch = prepared.slice(index, index + 25);
        const data = await adminGraphql(admin, METAFIELDS_SET_MUTATION, {
          metafields: batch.map((item) => ({
            ownerId: item.productId,
            namespace: "custom",
            key: "uso",
            type: metafieldType,
            value: item.metaobjectId,
          })),
        });

        const userErrors = data.metafieldsSet.userErrors ?? [];
        if (!userErrors.length) {
          continue;
        }

        const { byIndex, generic } = parseBatchUserErrors(userErrors, batch.length);
        batch.forEach((item, batchIndex) => {
          const errorMessages = byIndex.get(batchIndex);
          if (!errorMessages?.length) return;

          const detail = details.find((entry) => entry.rowNumber === item.rowNumber);
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
          detail.message = `Metafield custom.uso aggiornato con ${detail.usoHandle}.`;
        }
      });
    }

    const updatedRows = details.filter((detail) =>
      mode === "apply" ? detail.status === "updated" : detail.status === "ready",
    ).length;
    const skippedRows = details.length - updatedRows;

    return {
      ok: true,
      mode,
      metafieldType,
      totalRows: rows.length,
      preparedRows: prepared.length,
      updatedRows,
      skippedRows,
      details,
    } satisfies UsoImportResult;
  } catch (error) {
    return {
      ok: false,
      mode,
      errors: [error instanceof Error ? error.message : "Errore durante l import del metafield uso."],
    } satisfies UsoImportResult;
  }
};

export default function UsoImporter() {
  const actionData = useActionData() as UsoImportResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state !== "idle";
  const submittingMode = navigation.formData?.get("mode");

  useEffect(() => {
    if (actionData?.ok && actionData.mode === "apply") {
      shopify.toast.show("Metafield custom.uso aggiornato");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Uso Importer">
      <style>{styles}</style>
      <div className="uso-importer">
        <section className="uso-importer__card">
          <p className="uso-importer__kicker">Metafield batch</p>
          <h1>Importa il metafield prodotto custom.uso da Excel</h1>
          <p>
            Carica il file <strong>.xlsx</strong> con il foglio{" "}
            <strong>Definizioni</strong>. L importer usa la sessione autenticata
            dell app Shopify, fa una anteprima dei prodotti trovati e poi aggiorna il
            metafield <strong>product.custom.uso</strong>.
          </p>

          <Form className="uso-importer__form" method="post" encType="multipart/form-data">
            <label className="uso-importer__field uso-importer__field--wide">
              <span>File Excel o CSV</span>
              <input accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values" name="file" required type="file" />
            </label>

            <label className="uso-importer__field uso-importer__field--wide">
              <span>Tipo metaobject</span>
              <input defaultValue="custom.uso_prodotto" name="metaobjectType" />
            </label>

            <div className="uso-importer__actions">
              <button
                className="uso-importer__button"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="preview"
              >
                {isSubmitting && submittingMode === "preview" ? "Analisi..." : "Anteprima import"}
              </button>
              <button
                className="uso-importer__button uso-importer__button--primary"
                disabled={isSubmitting}
                name="mode"
                type="submit"
                value="apply"
              >
                {isSubmitting && submittingMode === "apply" ? "Aggiorno..." : "Applica metafield"}
              </button>
            </div>
          </Form>
        </section>

        <aside className="uso-importer__result">
          <h2>Risultato</h2>
          {!actionData ? (
            <p className="uso-importer__muted">
              Esegui una anteprima per controllare righe pronte, prodotti mancanti e
              metaobject non trovati prima di applicare l aggiornamento.
            </p>
          ) : actionData.ok ? (
            <div className="uso-importer__success">
              <strong>
                {actionData.mode === "apply" ? "Import completato" : "Anteprima completata"}
              </strong>
              <p>
                Righe lette: {actionData.totalRows}. Pronte: {actionData.preparedRows}.{" "}
                {actionData.mode === "apply" ? "Aggiornate" : "Da aggiornare"}:{" "}
                {actionData.updatedRows}. Altre righe da controllare: {actionData.skippedRows}.
                {actionData.metafieldType ? ` Tipo metafield: ${actionData.metafieldType}.` : ""}
              </p>
              <ul>
                {actionData.details?.map((detail) => (
                  <li key={`${detail.rowNumber}-${detail.productTitle}-${detail.status}`}>
                    <span className={`uso-importer__badge uso-importer__badge--${detail.status}`}>
                      {detail.status === "updated"
                        ? "OK"
                        : detail.status === "ready"
                          ? "PRONTO"
                          : detail.status === "missing-product"
                            ? "NO PROD"
                            : detail.status === "missing-metaobject"
                              ? "NO META"
                              : detail.status === "missing-uso-handle"
                                ? "NO HANDLE"
                                : detail.status === "ambiguous-product"
                                  ? "AMB"
                                  : "ERR"}
                    </span>
                    <span>
                      riga {detail.rowNumber} - {detail.productTitle}
                      {detail.productHandle ? ` (${detail.productHandle})` : ""}
                      {detail.message ? ` - ${detail.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="uso-importer__error">
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
  .uso-importer {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr);
    gap: 22px;
    max-width: 1200px;
    margin: 0 auto;
    padding: 22px;
    color: #1f2937;
  }

  .uso-importer__card,
  .uso-importer__result {
    border: 1px solid #cfe4d7;
    border-radius: 18px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfffc 100%);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .08);
    padding: 24px;
  }

  .uso-importer__kicker,
  .uso-importer__field span {
    margin: 0 0 8px;
    color: #4b5563;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .uso-importer h1,
  .uso-importer h2 {
    margin: 0 0 10px;
    color: #1f2937;
  }

  .uso-importer p {
    color: #526172;
    line-height: 1.5;
  }

  .uso-importer__form {
    display: grid;
    gap: 16px;
    margin-top: 22px;
  }

  .uso-importer__field {
    display: grid;
    gap: 8px;
  }

  .uso-importer__field input {
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

  .uso-importer__field input[type="file"] {
    padding: 12px;
  }

  .uso-importer__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .uso-importer__button {
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

  .uso-importer__button--primary {
    border-color: #16a34a;
    background: linear-gradient(135deg, #1ec361 0%, #14994a 100%);
    color: white;
  }

  .uso-importer__button:disabled {
    opacity: .6;
    cursor: wait;
  }

  .uso-importer__muted {
    color: #6b7280;
  }

  .uso-importer__success strong,
  .uso-importer__error strong {
    display: block;
    margin-bottom: 10px;
  }

  .uso-importer__success ul,
  .uso-importer__error ul {
    margin: 14px 0 0;
    padding-left: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }

  .uso-importer__success li,
  .uso-importer__error li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: #374151;
    line-height: 1.45;
  }

  .uso-importer__badge {
    flex: 0 0 auto;
    min-width: 76px;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .05em;
    text-align: center;
  }

  .uso-importer__badge--updated {
    background: #dcfce7;
    color: #166534;
  }

  .uso-importer__badge--ready {
    background: #ecfccb;
    color: #4d7c0f;
  }

  .uso-importer__badge--missing-product,
  .uso-importer__badge--missing-metaobject,
  .uso-importer__badge--missing-uso-handle,
  .uso-importer__badge--ambiguous-product,
  .uso-importer__badge--error {
    background: #fee2e2;
    color: #991b1b;
  }

  @media (max-width: 960px) {
    .uso-importer {
      grid-template-columns: 1fr;
      padding: 16px;
    }
  }
`;
