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

type CsvRow = {
  productHandle: string;
  sheetTitle: string;
  order: number;
  label: string;
  value: string;
  icon: string;
};

type ImportResult = {
  ok: boolean;
  errors?: string[];
  importedProducts?: number;
  importedSheets?: number;
  importedSpecs?: number;
  details?: string[];
};

type MetaFieldDefinition = {
  key: string;
  namespace: string;
  type: { name: string };
  validations?: Array<{ name: string; value: string }>;
};

type MetaobjectFieldDefinition = {
  key: string;
  name: string;
  type: { name: string };
  validations?: Array<{ name: string; value: string }>;
};

type MetaobjectDefinition = {
  type: string;
  fieldDefinitions: MetaobjectFieldDefinition[];
};

type ImportConfig = {
  namespace: string;
  key: string;
  metafieldType: string;
  groupType: string;
  groupTitleKey: string;
  groupSpecsKey: string;
  itemType: string;
  itemLabelKey: string;
  itemValueKey: string;
  itemValueType: string;
  itemIconKey: string | null;
};

const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "tech_specs";

const METAFIELD_DEFINITION_QUERY = `#graphql
  query TechSpecsMetafieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
      nodes {
        key
        namespace
        type { name }
        validations { name value }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_QUERY = `#graphql
  query TechSpecsMetaobjectDefinition($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      type
      fieldDefinitions {
        key
        name
        type { name }
        validations { name value }
      }
    }
  }
`;

const METAOBJECT_DEFINITIONS_QUERY = `#graphql
  query TechSpecsMetaobjectDefinitions {
    metaobjectDefinitions(first: 250) {
      nodes {
        type
        fieldDefinitions {
          key
          name
          type { name }
          validations { name value }
        }
      }
    }
  }
`;

const FIND_PRODUCT_QUERY = `#graphql
  query TechSpecsFindProduct($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        handle
        descriptionHtml
      }
    }
  }
`;

const METAOBJECT_UPSERT_MUTATION = `#graphql
  mutation TechSpecsMetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject {
        id
        handle
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const METAOBJECT_ACTIVATE_MUTATION = `#graphql
  mutation TechSpecsMetaobjectActivate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation TechSpecsSetProductMetafield($metafields: [MetafieldsSetInput!]!) {
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

function parseCsvRecords(text: string) {
  const records: string[][] = [];
  let cells: string[] = [];
  let current = "";
  let quoted = false;

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

    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

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
    throw new Error("CSV non valido: virgolette non chiuse.");
  }

  return records;
}

function parseCsv(text: string): CsvRow[] {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));

  if (!records.length) {
    throw new Error("Il CSV e vuoto.");
  }

  const headers = records[0].map((header) => header.trim());
  const required = ["product_handle", "scheda", "label", "value"];
  const missing = required.filter((key) => !headers.includes(key));

  if (missing.length) {
    throw new Error(`Colonne CSV mancanti: ${missing.join(", ")}.`);
  }

  return records.slice(1).map((cells, index) => {
    const raw: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      raw[header] = cells[headerIndex] ?? "";
    });

    const productHandle = raw.product_handle?.trim();
    const sheetTitle = raw.scheda?.trim();
    const label = raw.label?.trim();
    const value = raw.value?.trim();
    const order = Number(raw.ordine?.replace(",", ".") || index + 1);

    if (!productHandle || !sheetTitle || !label || !value) {
      throw new Error(
        `Riga ${index + 2}: product_handle, scheda, label e value sono obbligatori.`,
      );
    }

    if (!Number.isFinite(order)) {
      throw new Error(`Riga ${index + 2}: ordine deve essere numerico.`);
    }

    return {
      productHandle,
      sheetTitle,
      label,
      value,
      order,
      icon: raw.icon?.trim() ?? "",
    };
  });
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
    const normalizedCode = code.toLowerCase();
    if (normalizedCode[0] === "#") {
      const radix = normalizedCode[1] === "x" ? 16 : 10;
      const number = parseInt(
        normalizedCode[1] === "x" ? normalizedCode.slice(2) : normalizedCode.slice(1),
        radix,
      );
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }

    return namedEntities[normalizedCode] ?? entity;
  });
}

function normalizeCellHtml(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n"),
  ).trim();
}

function guessIcon(label: string) {
  const normalized = slugify(label);
  if (/material|tessut|carta|support|pvc|poliestere/.test(normalized)) return "layers";
  if (/stamp|tecnica|print|sublimazione|ricamo/.test(normalized)) return "print";
  if (/peso|grammatura|kg|gr/.test(normalized)) return "package";
  if (/dimension|formato|misur|ingombro/.test(normalized)) return "ruler";
  return "";
}

function isHeaderLike(label: string, value: string) {
  const left = slugify(label);
  const right = slugify(value);
  const labelWords = ["label", "nome", "specifica", "specifiche", "caratteristica"];
  const valueWords = ["value", "valore", "descrizione", "testo", "dettaglio"];

  return labelWords.includes(left) && valueWords.includes(right);
}

function parseTechSpecsFromDescription(
  descriptionHtml: string,
  productHandle: string,
  requestedSheetTitle: string,
  fallbackSheetTitle: string,
) {
  const rows: CsvRow[] = [];
  const tables = descriptionHtml.match(/<table[\s\S]*?<\/table>/gi) ?? [];

  for (const table of tables) {
    const tableRows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const parsedRows: CsvRow[] = [];
    let detectedSheetTitle = "";

    tableRows.forEach((rowHtml) => {
      const cells = Array.from(rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
        .map((match) => normalizeCellHtml(match[1] ?? ""))
        .filter(Boolean);

      if (cells.length === 1 && !requestedSheetTitle && !parsedRows.length) {
        detectedSheetTitle = cells[0];
        return;
      }

      if (cells.length < 2) return;

      const label = cells[0];
      const value = cells.slice(1).join("\n");
      if (!label || !value || isHeaderLike(label, value)) return;

      parsedRows.push({
        productHandle,
        sheetTitle: requestedSheetTitle || detectedSheetTitle || fallbackSheetTitle,
        order: parsedRows.length + 1,
        label,
        value,
        icon: guessIcon(label),
      });
    });

    if (parsedRows.length) {
      rows.push(...parsedRows);
      break;
    }
  }

  if (!rows.length) {
    throw new Error(
      "Non ho trovato una tabella valida nella descrizione del prodotto. Serve una tabella con almeno due colonne: nome specifica e valore.",
    );
  }

  return rows;
}

function groupRows(rows: CsvRow[]) {
  const grouped = new Map<string, Map<string, CsvRow[]>>();

  rows.forEach((row) => {
    if (!grouped.has(row.productHandle)) {
      grouped.set(row.productHandle, new Map());
    }

    const productSheets = grouped.get(row.productHandle)!;
    if (!productSheets.has(row.sheetTitle)) {
      productSheets.set(row.sheetTitle, []);
    }

    productSheets.get(row.sheetTitle)!.push(row);
  });

  grouped.forEach((sheets) => {
    sheets.forEach((sheetRows) => {
      sheetRows.sort((first, second) => first.order - second.order);
    });
  });

  return grouped;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

async function adminGraphql(admin: any, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message: string }) => error.message).join(" "));
  }

  return json.data;
}

function getValidationValue(
  definition: { validations?: Array<{ name: string; value: string }> },
  names: string[],
) {
  return (
    definition.validations?.find(
      (validation) => names.includes(validation.name) && validation.value,
    )?.value ?? ""
  );
}

function findField(
  definition: MetaobjectDefinition,
  candidates: string[],
  typeNames: string[] = [],
) {
  const fields = definition.fieldDefinitions ?? [];

  for (const candidate of candidates) {
    const exact = fields.find(
      (field) =>
        field.key === candidate &&
        (!typeNames.length || typeNames.includes(field.type.name)),
    );
    if (exact) return exact;
  }

  for (const field of fields) {
    const name = field.name.toLowerCase();
    if (typeNames.length && !typeNames.includes(field.type.name)) continue;
    if (candidates.some((candidate) => name.includes(candidate.replace("_", " ")))) {
      return field;
    }
  }

  throw new Error(
    `Non riesco a identificare il campo in '${definition.type}'. Campi disponibili: ${fields
      .map((field) => field.key)
      .join(", ")}.`,
  );
}

async function getMetaobjectDefinitions(admin: any): Promise<MetaobjectDefinition[]> {
  const data = await adminGraphql(admin, METAOBJECT_DEFINITIONS_QUERY, {});
  return data.metaobjectDefinitions?.nodes ?? [];
}

function hasField(
  definition: MetaobjectDefinition,
  candidates: string[],
  typeNames: string[] = [],
) {
  try {
    findField(definition, candidates, typeNames);
    return true;
  } catch {
    return false;
  }
}

function scoreDefinition(type: string, words: string[]) {
  const normalized = type.toLowerCase();
  return words.reduce(
    (score, word) => score + (normalized.includes(word) ? 1 : 0),
    0,
  );
}

function inferGroupDefinition(definitions: MetaobjectDefinition[]) {
  const candidates = definitions
    .filter(
      (definition) =>
        hasField(definition, ["title", "label", "name", "scheda"], [
          "single_line_text_field",
          "multi_line_text_field",
        ]) &&
        hasField(definition, ["specs", "specifiche", "items", "rows", "voci"], [
          "list.metaobject_reference",
        ]),
    )
    .sort(
      (first, second) =>
        scoreDefinition(second.type, ["tech", "spec", "scheda"]) -
        scoreDefinition(first.type, ["tech", "spec", "scheda"]),
    );

  if (!candidates.length) {
    throw new Error(
      "Non riesco a trovare un metaobject scheda con campi tipo title/specs.",
    );
  }

  return candidates[0];
}

function inferItemDefinition(definitions: MetaobjectDefinition[], groupType: string) {
  const candidates = definitions
    .filter(
      (definition) =>
        definition.type !== groupType &&
        hasField(definition, ["label", "title", "name", "nome"], [
          "single_line_text_field",
          "multi_line_text_field",
        ]) &&
        hasField(definition, ["value", "valore", "text", "testo", "content"], [
          "single_line_text_field",
          "multi_line_text_field",
          "rich_text_field",
        ]),
    )
    .sort(
      (first, second) =>
        scoreDefinition(second.type, ["tech", "spec", "item", "row", "voce"]) -
        scoreDefinition(first.type, ["tech", "spec", "item", "row", "voce"]),
    );

  if (!candidates.length) {
    throw new Error(
      "Non riesco a trovare un metaobject voce con campi tipo label/value.",
    );
  }

  return candidates[0];
}

async function discoverImportConfig(admin: any): Promise<ImportConfig> {
  const metafieldData = await adminGraphql(admin, METAFIELD_DEFINITION_QUERY, {
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
  });
  const metafieldDefinition: MetaFieldDefinition | undefined =
    metafieldData.metafieldDefinitions?.nodes?.[0];

  if (!metafieldDefinition) {
    throw new Error(`Metafield product.${METAFIELD_NAMESPACE}.${METAFIELD_KEY} non trovato.`);
  }

  const allDefinitions = await getMetaobjectDefinitions(admin);
  const configuredGroupType = getValidationValue(metafieldDefinition, [
    "metaobject_definition_type",
    "metaobject_type",
  ]);

  let groupDefinition: MetaobjectDefinition | null = null;

  if (configuredGroupType) {
    const groupDefinitionData = await adminGraphql(admin, METAOBJECT_DEFINITION_QUERY, {
      type: configuredGroupType,
    });
    groupDefinition = groupDefinitionData.metaobjectDefinitionByType;
  } else {
    groupDefinition = inferGroupDefinition(allDefinitions);
  }

  if (!groupDefinition) {
    throw new Error(`Definizione metaobject '${configuredGroupType}' non trovata.`);
  }

  const titleField = findField(groupDefinition, ["title", "label", "name", "scheda"], [
    "single_line_text_field",
    "multi_line_text_field",
  ]);
  const specsField = findField(groupDefinition, ["specs", "specifiche", "items", "rows", "voci"], [
    "list.metaobject_reference",
  ]);
  const configuredItemType = getValidationValue(specsField, [
    "metaobject_definition_type",
    "metaobject_type",
  ]);

  let itemDefinition: MetaobjectDefinition | null = null;

  if (configuredItemType) {
    const itemDefinitionData = await adminGraphql(admin, METAOBJECT_DEFINITION_QUERY, {
      type: configuredItemType,
    });
    itemDefinition = itemDefinitionData.metaobjectDefinitionByType;
  } else {
    itemDefinition = inferItemDefinition(allDefinitions, groupDefinition.type);
  }

  if (!itemDefinition) {
    throw new Error(`Definizione metaobject '${configuredItemType}' non trovata.`);
  }

  const labelField = findField(itemDefinition, ["label", "title", "name", "nome"], [
    "single_line_text_field",
    "multi_line_text_field",
  ]);
  const valueField = findField(itemDefinition, ["value", "valore", "text", "testo", "content"], [
    "single_line_text_field",
    "multi_line_text_field",
    "rich_text_field",
  ]);
  let iconField: MetaobjectFieldDefinition | null = null;
  try {
    iconField = findField(itemDefinition, ["icon", "icona"], ["single_line_text_field"]);
  } catch {
    iconField = null;
  }

  return {
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
    metafieldType: metafieldDefinition.type.name,
    groupType: groupDefinition.type,
    groupTitleKey: titleField.key,
    groupSpecsKey: specsField.key,
    itemType: itemDefinition.type,
    itemLabelKey: labelField.key,
    itemValueKey: valueField.key,
    itemValueType: valueField.type.name,
    itemIconKey: iconField?.key ?? null,
  };
}

function richTextValue(value: string) {
  const children = value.split(/\n+/).filter(Boolean).map((line) => ({
    type: "paragraph",
    children: [{ type: "text", value: line }],
  }));

  return JSON.stringify({
    type: "root",
    children: children.length ? children : [{ type: "paragraph", children: [{ type: "text", value: "" }] }],
  });
}

function fieldValue(value: string, fieldType: string) {
  if (fieldType === "rich_text_field") {
    return richTextValue(value);
  }

  return value;
}

function hash(value: string) {
  let output = 0;
  for (let index = 0; index < value.length; index += 1) {
    output = (output * 31 + value.charCodeAt(index)) >>> 0;
  }
  return output.toString(16).padStart(8, "0");
}

function itemHandle(productHandle: string, sheetTitle: string, row: CsvRow, index: number) {
  return [
    slugify(productHandle),
    slugify(sheetTitle),
    String(index + 1).padStart(3, "0"),
    slugify(row.label),
    hash(`${row.label}|${row.value}`).slice(0, 8),
  ]
    .join("-")
    .slice(0, 255);
}

function groupHandle(productHandle: string, sheetTitle: string) {
  return `${slugify(productHandle)}-${slugify(sheetTitle)}`.slice(0, 255);
}

async function findProduct(admin: any, handle: string) {
  const data = await adminGraphql(admin, FIND_PRODUCT_QUERY, {
    query: `handle:${handle}`,
  });
  const product = data.products?.nodes?.[0];
  if (!product) {
    throw new Error(`Prodotto non trovato: ${handle}.`);
  }
  return product as { id: string; title: string; handle: string; descriptionHtml?: string };
}

async function upsertMetaobject(
  admin: any,
  type: string,
  handle: string,
  fields: Array<{ key: string; value: string }>,
) {
  const data = await adminGraphql(admin, METAOBJECT_UPSERT_MUTATION, {
    handle: { type, handle },
    metaobject: { fields },
  });
  const errors = data.metaobjectUpsert?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: { message: string }) => error.message).join(" "));
  }

  const id = data.metaobjectUpsert?.metaobject?.id;
  if (!id) {
    throw new Error(`Shopify non ha restituito il metaobject ${type}/${handle}.`);
  }

  return id as string;
}

async function activateMetaobject(admin: any, id: string) {
  const data = await adminGraphql(admin, METAOBJECT_ACTIVATE_MUTATION, {
    id,
    metaobject: {
      capabilities: {
        publishable: {
          status: "ACTIVE",
        },
      },
    },
  });
  const errors = data.metaobjectUpdate?.userErrors ?? [];
  const messages = errors.map((error: { message: string }) => error.message).join(" ");
  if (errors.length && !/publishable|capabilities/i.test(messages)) {
    throw new Error(messages);
  }
}

async function setProductTechSpecs(
  admin: any,
  productId: string,
  config: ImportConfig,
  metaobjectIds: string[],
) {
  const data = await adminGraphql(admin, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: productId,
        namespace: config.namespace,
        key: config.key,
        type: config.metafieldType,
        value: JSON.stringify(metaobjectIds),
      },
    ],
  });
  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: { message: string }) => error.message).join(" "));
  }
}

async function importRows(admin: any, rows: CsvRow[]) {
  const config = await discoverImportConfig(admin);
  const grouped = groupRows(rows);
  const details: string[] = [];
  let importedSheets = 0;
  let importedSpecs = 0;

  for (const [productHandle, sheets] of grouped) {
    const product = await findProduct(admin, productHandle);
    const groupIds: string[] = [];

    for (const [sheetTitle, sheetRows] of sheets) {
      const itemIds: string[] = [];

      for (let index = 0; index < sheetRows.length; index += 1) {
        const row = sheetRows[index];
        const fields = [
          { key: config.itemLabelKey, value: row.label },
          {
            key: config.itemValueKey,
            value: fieldValue(row.value, config.itemValueType),
          },
        ];

        if (config.itemIconKey && row.icon) {
          fields.push({ key: config.itemIconKey, value: row.icon });
        }

        const itemId = await upsertMetaobject(
          admin,
          config.itemType,
          itemHandle(productHandle, sheetTitle, row, index),
          fields,
        );
        await activateMetaobject(admin, itemId);
        itemIds.push(itemId);
        importedSpecs += 1;
      }

      const groupId = await upsertMetaobject(
        admin,
        config.groupType,
        groupHandle(productHandle, sheetTitle),
        [
          { key: config.groupTitleKey, value: sheetTitle },
          { key: config.groupSpecsKey, value: JSON.stringify(itemIds) },
        ],
      );
      await activateMetaobject(admin, groupId);
      groupIds.push(groupId);
      importedSheets += 1;
    }

    await setProductTechSpecs(admin, product.id, config, groupIds);
    details.push(`${product.title}: ${groupIds.length} schede collegate`);
  }

  return {
    importedProducts: grouped.size,
    importedSheets,
    importedSpecs,
    details,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const importSource = String(formData.get("importSource") || "csv");

  try {
    let rows: CsvRow[];

    if (importSource === "description") {
      const productHandle = String(formData.get("productHandle") || "").trim();
      if (!productHandle) {
        return {
          ok: false,
          errors: ["Inserisci l'handle prodotto prima di importare dalla descrizione."],
        } satisfies ImportResult;
      }

      const product = await findProduct(admin, productHandle);
      rows = parseTechSpecsFromDescription(
        product.descriptionHtml || "",
        product.handle,
        String(formData.get("sheetTitle") || "").trim(),
        product.title,
      );
    } else {
      const file = formData.get("csvFile");

      if (!(file instanceof File) || !file.name) {
        return {
          ok: false,
          errors: ["Carica un file CSV prima di importare."],
        } satisfies ImportResult;
      }

      rows = parseCsv(await file.text());
    }

    const result = await importRows(admin, rows);
    return {
      ok: true,
      ...result,
    } satisfies ImportResult;
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Errore import specifiche tecniche."],
    } satisfies ImportResult;
  }
};

export default function ImportTechSpecs() {
  const actionData = useActionData() as ImportResult | undefined;
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const isImporting = navigation.state !== "idle";
  const importingSource = navigation.formData?.get("importSource");

  useEffect(() => {
    if (actionData?.ok) {
      shopify.toast.show("Specifiche tecniche importate");
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Import tech specs">
      <style>{styles}</style>
      <div className="tech-import">
        <section className="tech-import__card">
          <div className="tech-import__header">
            <p className="tech-import__kicker">Descrizione o CSV a metaobject</p>
            <h1>Importa schede tecniche</h1>
            <p>
              Importa le specifiche dalla tabella nella descrizione prodotto oppure
              carica un CSV. L'app aggiornera il metafield
              <code> custom.tech_specs </code>
              mantenendo identica la sezione frontend.
            </p>
          </div>

          <Form method="post" encType="multipart/form-data" className="tech-import__form">
            <input name="importSource" type="hidden" value="description" />
            <div className="tech-import__form-head">
              <h2>Da descrizione prodotto</h2>
              <p>
                Legge la prima tabella a due colonne dalla descrizione Shopify.
                La prima colonna diventa il nome specifica, la seconda il valore.
              </p>
            </div>
            <label className="tech-import__field">
              <span>Handle prodotto</span>
              <input name="productHandle" type="text" placeholder="es. maglia-running" required />
            </label>
            <label className="tech-import__field">
              <span>Titolo scheda opzionale</span>
              <input
                name="sheetTitle"
                type="text"
                placeholder="Lascia vuoto per usare il titolo della tabella"
              />
            </label>
            <button className="tech-import__button" disabled={isImporting} type="submit">
              {isImporting && importingSource === "description"
                ? "Import dalla descrizione..."
                : "Importa dalla descrizione"}
            </button>
          </Form>

          <div className="tech-import__divider" />

          <Form method="post" encType="multipart/form-data" className="tech-import__form">
            <input name="importSource" type="hidden" value="csv" />
            <div className="tech-import__form-head">
              <h2>Da CSV</h2>
              <p>Utile per import massivi o quando le specifiche non sono nella descrizione.</p>
            </div>
            <label className="tech-import__field">
              <span>File CSV</span>
              <input name="csvFile" type="file" accept=".csv,text/csv" required />
            </label>
            <button className="tech-import__button" disabled={isImporting} type="submit">
              {isImporting && importingSource === "csv" ? "Import CSV..." : "Importa CSV"}
            </button>
          </Form>

          {actionData?.errors?.length ? (
            <div className="tech-import__errors">
              {actionData.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          ) : null}

          {actionData?.ok ? (
            <div className="tech-import__success">
              <strong>Import completato</strong>
              <p>
                Prodotti: {actionData.importedProducts}, schede:{" "}
                {actionData.importedSheets}, righe tecniche:{" "}
                {actionData.importedSpecs}
              </p>
              {actionData.details?.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="tech-import__card tech-import__card--muted">
          <h2>Formato CSV</h2>
          <p>Una riga per ogni voce tecnica.</p>
          <pre>{`product_handle,scheda,ordine,label,value,icon
berretti-invernali,Berretti Invernali,1,Materiale,"100% acrilico",layers
berretti-invernali,Berretti Invernali,2,Tecnica di stampa,"Ricamo / DTF",print`}</pre>
          <p>
            <strong>product_handle</strong> e l'handle prodotto Shopify.
            <strong> scheda</strong> e il titolo del gruppo, ad esempio
            "Berretti Invernali". <strong>icon</strong> e opzionale.
          </p>
          <div className="tech-import__hint">
            <h2>Formato descrizione supportato</h2>
            <p>
              Nella descrizione prodotto puoi usare una tabella come:
              prima riga titolo, poi righe <strong>Materiale</strong> /
              <strong>100% Poliestere</strong>, <strong>Peso</strong> /
              <strong>120 gr/m</strong>, ecc.
            </p>
          </div>
        </section>
      </div>
    </s-page>
  );
}

const styles = `
  .tech-import {
    width: min(1120px, calc(100vw - 48px));
    margin: 0 auto;
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr);
    gap: 22px;
  }

  .tech-import__card {
    border: 1px solid #dce8df;
    border-radius: 22px;
    background: rgba(255, 255, 255, .94);
    box-shadow: 0 18px 48px rgba(18, 38, 29, .08);
    padding: 24px;
  }

  .tech-import__card--muted {
    background: linear-gradient(180deg, #f7fbf8 0%, #ffffff 100%);
  }

  .tech-import__header {
    display: grid;
    gap: 8px;
    margin-bottom: 22px;
  }

  .tech-import__kicker {
    margin: 0;
    color: #667085;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .tech-import h1,
  .tech-import h2,
  .tech-import p {
    margin: 0;
  }

  .tech-import h1 {
    color: #1f2933;
    font-size: 28px;
    line-height: 1.1;
  }

  .tech-import h2 {
    color: #1f2933;
    font-size: 18px;
    line-height: 1.2;
    margin-bottom: 8px;
  }

  .tech-import p {
    color: #556371;
    font-size: 14px;
    line-height: 1.55;
  }

  .tech-import code {
    padding: 2px 6px;
    border-radius: 8px;
    background: #edf8f0;
    color: #0f8a3d;
    font-weight: 800;
  }

  .tech-import__form {
    display: grid;
    gap: 16px;
  }

  .tech-import__form-head {
    display: grid;
    gap: 5px;
  }

  .tech-import__divider {
    height: 1px;
    margin: 22px 0;
    background: linear-gradient(90deg, transparent, #d9e7de, transparent);
  }

  .tech-import__field {
    display: grid;
    gap: 8px;
    color: #344054;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .tech-import__field input {
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

  .tech-import__button {
    min-height: 50px;
    border: 0;
    border-radius: 14px;
    background: linear-gradient(135deg, #18b65b 0%, #0c8c3f 100%);
    color: #fff;
    cursor: pointer;
    font-size: 15px;
    font-weight: 900;
    box-shadow: 0 12px 24px rgba(12, 140, 63, .2);
  }

  .tech-import__button:disabled {
    cursor: wait;
    opacity: .72;
  }

  .tech-import__errors,
  .tech-import__success {
    margin-top: 18px;
    padding: 14px 16px;
    border-radius: 16px;
    display: grid;
    gap: 6px;
  }

  .tech-import__errors {
    border: 1px solid #fecaca;
    background: #fff5f5;
  }

  .tech-import__errors p {
    color: #b42318;
    font-weight: 800;
  }

  .tech-import__success {
    border: 1px solid #ccefd7;
    background: #f0fbf3;
  }

  .tech-import__success strong {
    color: #0f7a39;
  }

  .tech-import pre {
    overflow: auto;
    margin: 16px 0;
    padding: 16px;
    border: 1px dashed #bfd0c6;
    border-radius: 16px;
    background: #ffffff;
    color: #1f2933;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre;
  }

  .tech-import__hint {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid #dce8df;
  }

  @media (max-width: 900px) {
    .tech-import {
      width: min(100%, calc(100vw - 24px));
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
