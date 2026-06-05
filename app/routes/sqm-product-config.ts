export type PriceModifierType =
  | "none"
  | "per_sqm"
  | "fixed_order"
  | "fixed_piece"
  | "percentage"
  | "multiplier";

export type PriceModifier = {
  type: PriceModifierType;
  amount: number;
  target?: "base" | "subtotal";
};

export type SqmOption = {
  value: string;
  label: string;
  priceModifier: PriceModifier;
};

export type SqmOptionGroup = {
  id: string;
  label: string;
  type: "radio" | "button";
  defaultValue: string;
  required: boolean;
  showInSummary: boolean;
  saveToProperties: boolean;
  options: SqmOption[];
};

export type ConditionalRule = {
  field: "base" | "height" | "area_per_piece" | "total_area" | "quantity" | "max_side";
  comparison: ">" | ">=" | "<" | "<=" | "==" | "!=";
  value: number;
};

export type ConditionalFee = {
  id: string;
  label: string;
  condition: {
    operator: "and" | "or";
    rules: ConditionalRule[];
  };
  fee: PriceModifier;
  showInSummary: boolean;
  saveToProperties: boolean;
};

export type SqmProductConfig = {
  enableSqmCalculator: boolean;
  optionGroups: SqmOptionGroup[];
  conditionalFees: ConditionalFee[];
};

export const EMPTY_PRODUCT_CONFIG: SqmProductConfig = {
  enableSqmCalculator: true,
  optionGroups: [],
  conditionalFees: [],
};

const PRICE_MODIFIER_TYPES = new Set<PriceModifierType>([
  "none",
  "per_sqm",
  "fixed_order",
  "fixed_piece",
  "percentage",
  "multiplier",
]);

const CONDITION_FIELDS = new Set<ConditionalRule["field"]>([
  "base",
  "height",
  "area_per_piece",
  "total_area",
  "quantity",
  "max_side",
]);

const COMPARISONS = new Set<ConditionalRule["comparison"]>([
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
]);

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.replace(",", ".").trim();
  if (!normalized) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function roundDecimal(value: number) {
  return Math.round(value * 1000) / 1000;
}

function parseJsonObject(value: unknown) {
  if (!value) return {};

  let parsed = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    if (!parsed.trim()) return {};

    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function hasInvalidJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;

  let parsed: unknown = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return true;
    }
  }

  return !(parsed && typeof parsed === "object" && !Array.isArray(parsed));
}

export function parseProductConfig(value: unknown): SqmProductConfig {
  const source = parseJsonObject(value) as Record<string, unknown>;

  return {
    enableSqmCalculator: source.enableSqmCalculator !== false,
    optionGroups: Array.isArray(source.optionGroups)
      ? source.optionGroups
          .map((group) => normalizeOptionGroup(group))
          .filter((group): group is SqmOptionGroup => Boolean(group))
      : [],
    conditionalFees: Array.isArray(source.conditionalFees)
      ? source.conditionalFees
          .map((fee) => normalizeConditionalFee(fee))
          .filter((fee): fee is ConditionalFee => Boolean(fee))
      : [],
  };
}

export function normalizeProductConfig(value: unknown): SqmProductConfig {
  return parseProductConfig(value);
}

export function normalizePriceModifier(value: unknown): PriceModifier {
  if (!value || typeof value !== "object") {
    return { type: "none", amount: 0 };
  }

  const source = value as Record<string, unknown>;
  const type = String(source.type ?? "none") as PriceModifierType;
  const amount = toNumber(source.amount) ?? 0;
  const target = source.target === "base" || source.target === "subtotal"
    ? source.target
    : undefined;

  if (!PRICE_MODIFIER_TYPES.has(type) || type === "none") {
    return { type: "none", amount: 0 };
  }

  return {
    type,
    amount: roundDecimal(amount),
    ...(target ? { target } : {}),
  };
}

function normalizeOptionGroup(value: unknown): SqmOptionGroup | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const id = normalizeId(source.id);
  const label = String(source.label ?? "").trim();
  const type = source.type === "button" ? "button" : "radio";
  const options = Array.isArray(source.options)
    ? source.options
        .map((option) => normalizeOption(option))
        .filter((option): option is SqmOption => Boolean(option))
    : [];
  const defaultValue = String(source.defaultValue ?? options[0]?.value ?? "").trim();

  if (!id || !label || !options.length) return null;

  return {
    id,
    label,
    type,
    defaultValue: options.some((option) => option.value === defaultValue)
      ? defaultValue
      : options[0].value,
    required: source.required !== false,
    showInSummary: source.showInSummary !== false,
    saveToProperties: source.saveToProperties !== false,
    options,
  };
}

function normalizeOption(value: unknown): SqmOption | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const optionValue = String(source.value ?? "").trim();
  const label = String(source.label ?? "").trim();

  if (!optionValue || !label) return null;

  return {
    value: optionValue,
    label,
    priceModifier: normalizePriceModifier(source.priceModifier),
  };
}

function normalizeConditionalFee(value: unknown): ConditionalFee | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const id = normalizeId(source.id);
  const label = String(source.label ?? "").trim();
  const conditionSource =
    source.condition && typeof source.condition === "object"
      ? (source.condition as Record<string, unknown>)
      : {};
  const rules = Array.isArray(conditionSource.rules)
    ? conditionSource.rules
        .map((rule) => normalizeConditionalRule(rule))
        .filter((rule): rule is ConditionalRule => Boolean(rule))
    : [];
  const fee = normalizePriceModifier(source.fee);

  if (!id || !label || !rules.length || fee.type === "none") return null;

  return {
    id,
    label,
    condition: {
      operator: conditionSource.operator === "or" ? "or" : "and",
      rules,
    },
    fee,
    showInSummary: source.showInSummary !== false,
    saveToProperties: source.saveToProperties !== false,
  };
}

function normalizeConditionalRule(value: unknown): ConditionalRule | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const field = String(source.field ?? "") as ConditionalRule["field"];
  const comparison = String(source.comparison ?? "") as ConditionalRule["comparison"];
  const ruleValue = toNumber(source.value);

  if (!CONDITION_FIELDS.has(field) || !COMPARISONS.has(comparison) || ruleValue === null) {
    return null;
  }

  return {
    field,
    comparison,
    value: roundDecimal(ruleValue),
  };
}

export function validateProductConfig(value: unknown) {
  const errors: string[] = [];
  if (hasInvalidJson(value)) {
    return ["La configurazione avanzata deve essere un JSON oggetto valido."];
  }

  const config = normalizeProductConfig(value);
  const groupIds = new Set<string>();
  const feeIds = new Set<string>();

  config.optionGroups.forEach((group) => {
    if (groupIds.has(group.id)) {
      errors.push(`Gruppo opzioni duplicato: ${group.id}.`);
    }
    groupIds.add(group.id);

    const optionValues = new Set<string>();
    group.options.forEach((option) => {
      if (optionValues.has(option.value)) {
        errors.push(`Opzione duplicata nel gruppo "${group.label}": ${option.value}.`);
      }
      optionValues.add(option.value);
    });
  });

  config.conditionalFees.forEach((fee) => {
    if (feeIds.has(fee.id)) {
      errors.push(`Commissione duplicata: ${fee.id}.`);
    }
    feeIds.add(fee.id);
  });

  return errors;
}

export function stringifyProductConfig(value: unknown) {
  return JSON.stringify(normalizeProductConfig(value), null, 2);
}
