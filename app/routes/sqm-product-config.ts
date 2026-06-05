export type PriceModifierType =
  | "none"
  | "per_sqm"
  | "fixed_order"
  | "fixed_piece"
  | "percentage"
  | "multiplier";

export type PriceModifierTarget = "base" | "subtotal";

export type OptionGroupType =
  | "button"
  | "radio"
  | "dropdown"
  | "checkbox"
  | "toggle";

export type PriceModifier = {
  type: PriceModifierType;
  amount: number;
  target?: PriceModifierTarget;
  frontendLabel?: string;
};

export type SqmOption = {
  value: string;
  label: string;
  badge?: string;
  priceModifier: PriceModifier;
};

export type SqmOptionGroup = {
  id: string;
  label: string;
  icon?: string;
  helpText?: string;
  type: OptionGroupType;
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

export type SqmPackagingConfig = {
  enabled: boolean;
  costPerSqm: number;
  maxPanelSizeCm: number;
  minimumCost: number;
};

export type SqmProductConfig = {
  enableSqmCalculator: boolean;
  optionGroups: SqmOptionGroup[];
  conditionalFees: ConditionalFee[];
  packaging: SqmPackagingConfig;
};

export const EMPTY_PRICE_MODIFIER: PriceModifier = {
  type: "none",
  amount: 0,
};

export const EMPTY_OPTION: SqmOption = {
  value: "option_1",
  label: "",
  priceModifier: { ...EMPTY_PRICE_MODIFIER },
};

export const EMPTY_OPTION_GROUP: SqmOptionGroup = {
  id: "option_group",
  label: "",
  icon: "",
  helpText: "",
  type: "button",
  defaultValue: "option_1",
  required: true,
  showInSummary: true,
  saveToProperties: true,
  options: [{ ...EMPTY_OPTION }],
};

export const EMPTY_PRODUCT_CONFIG: SqmProductConfig = {
  enableSqmCalculator: true,
  optionGroups: [],
  conditionalFees: [],
  packaging: {
    enabled: false,
    costPerSqm: 0,
    maxPanelSizeCm: 150,
    minimumCost: 0,
  },
};

const PRICE_MODIFIER_TYPES = new Set<PriceModifierType>([
  "none",
  "per_sqm",
  "fixed_order",
  "fixed_piece",
  "percentage",
  "multiplier",
]);

const PRICE_TARGETS = new Set<PriceModifierTarget>(["base", "subtotal"]);

const GROUP_TYPES = new Set<OptionGroupType>([
  "button",
  "radio",
  "dropdown",
  "checkbox",
  "toggle",
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

export function normalizeId(value: unknown) {
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

export function createOptionValue(label: string, index: number) {
  const fromLabel = normalizeId(label).replace(/_/g, "-");
  return fromLabel || `option-${index + 1}`;
}

export function createEmptyOption(index = 0): SqmOption {
  return {
    value: createOptionValue("", index),
    label: "",
    badge: "",
    priceModifier: { ...EMPTY_PRICE_MODIFIER },
  };
}

export function createEmptyOptionGroup(
  type: OptionGroupType = "button",
  index = 0,
): SqmOptionGroup {
  const option = createEmptyOption(0);

  return {
    id: normalizeId(`option_group_${index + 1}`) || `option_group_${index + 1}`,
    label: "",
    icon: "",
    helpText: "",
    type,
    defaultValue: option.value,
    required: type === "checkbox" ? false : true,
    showInSummary: true,
    saveToProperties: true,
    options: [option],
  };
}

export function parseProductConfig(value: unknown): SqmProductConfig {
  const source = parseJsonObject(value) as Record<string, unknown>;

  return {
    enableSqmCalculator: source.enableSqmCalculator !== false,
    optionGroups: Array.isArray(source.optionGroups)
      ? source.optionGroups
          .map((group, index) => normalizeOptionGroup(group, index))
          .filter((group): group is SqmOptionGroup => Boolean(group))
      : [],
    conditionalFees: Array.isArray(source.conditionalFees)
      ? source.conditionalFees
          .map((fee) => normalizeConditionalFee(fee))
          .filter((fee): fee is ConditionalFee => Boolean(fee))
      : [],
    packaging: normalizePackagingConfig(source.packaging),
  };
}

export const parseProductAdvancedConfig = parseProductConfig;

export function normalizeProductConfig(value: unknown): SqmProductConfig {
  return parseProductConfig(value);
}

export function normalizePriceModifier(value: unknown): PriceModifier {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_PRICE_MODIFIER };
  }

  const source = value as Record<string, unknown>;
  const type = String(source.type ?? "none") as PriceModifierType;
  const amount = toNumber(source.amount) ?? 0;
  const target = PRICE_TARGETS.has(source.target as PriceModifierTarget)
    ? (source.target as PriceModifierTarget)
    : undefined;
  const frontendLabel = String(
    source.frontendLabel ?? source.label ?? source.priceLabel ?? "",
  ).trim();

  if (!PRICE_MODIFIER_TYPES.has(type) || type === "none") {
    return {
      type: "none",
      amount: 0,
      ...(frontendLabel ? { frontendLabel } : {}),
    };
  }

  return {
    type,
    amount: roundDecimal(amount),
    ...(target ? { target } : {}),
    ...(frontendLabel ? { frontendLabel } : {}),
  };
}

function normalizeOptionGroup(
  value: unknown,
  groupIndex = 0,
): SqmOptionGroup | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const label = String(source.label ?? "").trim();
  const id =
    normalizeId(source.id) ||
    normalizeId(label) ||
    normalizeId(`option_group_${groupIndex + 1}`);
  const type = GROUP_TYPES.has(source.type as OptionGroupType)
    ? (source.type as OptionGroupType)
    : source.type === "button"
      ? "button"
      : source.type === "dropdown"
        ? "dropdown"
        : "radio";
  const options = Array.isArray(source.options)
    ? source.options
        .map((option, optionIndex) => normalizeOption(option, optionIndex))
        .filter((option): option is SqmOption => Boolean(option))
    : [];
  const defaultValue = String(source.defaultValue ?? options[0]?.value ?? "").trim();

  if (!id || !label || !options.length) return null;

  return {
    id,
    label,
    icon: String(source.icon ?? "").trim(),
    helpText: String(source.helpText ?? source.description ?? "").trim(),
    type,
    defaultValue: options.some((option) => option.value === defaultValue)
      ? defaultValue
      : options[0].value,
    required: type === "checkbox" ? source.required === true : source.required !== false,
    showInSummary: source.showInSummary !== false,
    saveToProperties: source.saveToProperties !== false,
    options,
  };
}

function normalizeOption(value: unknown, optionIndex = 0): SqmOption | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const label = String(source.label ?? "").trim();
  const optionValue =
    String(source.value ?? "").trim() || createOptionValue(label, optionIndex);

  if (!optionValue || !label) return null;

  return {
    value: optionValue,
    label,
    badge: String(source.badge ?? "").trim(),
    priceModifier: normalizePriceModifier(source.priceModifier),
  };
}

function normalizeConditionalFee(value: unknown): ConditionalFee | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const condition = source.condition && typeof source.condition === "object"
    ? (source.condition as Record<string, unknown>)
    : {};
  const rules = Array.isArray(condition.rules)
    ? condition.rules
        .map((rule) => normalizeConditionalRule(rule))
        .filter((rule): rule is ConditionalRule => Boolean(rule))
    : [];
  const fee = normalizePriceModifier(source.fee);
  const id = normalizeId(source.id);
  const label = String(source.label ?? "").trim();

  if (!id || !label || !rules.length || fee.type === "none") return null;

  return {
    id,
    label,
    condition: {
      operator: condition.operator === "or" ? "or" : "and",
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
  const field = source.field as ConditionalRule["field"];
  const comparison = source.comparison as ConditionalRule["comparison"];
  const parsedValue = toNumber(source.value);

  if (
    !CONDITION_FIELDS.has(field) ||
    !COMPARISONS.has(comparison) ||
    parsedValue === null
  ) {
    return null;
  }

  return {
    field,
    comparison,
    value: roundDecimal(parsedValue),
  };
}

function normalizePackagingConfig(value: unknown): SqmPackagingConfig {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_PRODUCT_CONFIG.packaging };
  }

  const source = value as Record<string, unknown>;

  return {
    enabled: source.enabled === true || source.enabled === "true",
    costPerSqm: Math.max(0, roundDecimal(toNumber(source.costPerSqm) ?? 0)),
    maxPanelSizeCm: Math.max(
      1,
      roundDecimal(toNumber(source.maxPanelSizeCm) ?? EMPTY_PRODUCT_CONFIG.packaging.maxPanelSizeCm),
    ),
    minimumCost: Math.max(0, roundDecimal(toNumber(source.minimumCost) ?? 0)),
  };
}

export function validateOptionGroup(group: SqmOptionGroup, index = 0) {
  const errors: string[] = [];
  const normalized = normalizeOptionGroup(group, index);

  if (!normalized) {
    errors.push(`L opzione #${index + 1} non e valida.`);
    return errors;
  }

  if (!normalized.label.trim()) {
    errors.push(`L opzione #${index + 1} deve avere un titolo.`);
  }

  if (!normalized.options.length) {
    errors.push(`L opzione "${normalized.label || index + 1}" deve avere almeno un valore.`);
  }

  const seenValues = new Set<string>();

  normalized.options.forEach((option, optionIndex) => {
    if (!option.label.trim()) {
      errors.push(
        `Il valore #${optionIndex + 1} di "${normalized.label || index + 1}" deve avere un etichetta.`,
      );
    }

    if (seenValues.has(option.value)) {
      errors.push(
        `I valori di "${normalized.label || index + 1}" devono avere un identificatore univoco.`,
      );
    }
    seenValues.add(option.value);

    const modifier = option.priceModifier;
    if (
      modifier.type !== "none" &&
      modifier.type !== "multiplier" &&
      !Number.isFinite(modifier.amount)
    ) {
      errors.push(
        `Il prezzo di "${option.label || optionIndex + 1}" in "${normalized.label}" non e valido.`,
      );
    }

    if (
      modifier.type === "multiplier" &&
      (!Number.isFinite(modifier.amount) || modifier.amount <= 0)
    ) {
      errors.push(
        `Il moltiplicatore di "${option.label || optionIndex + 1}" in "${normalized.label}" deve essere maggiore di zero.`,
      );
    }
  });

  const defaultCount = normalized.options.filter(
    (option) => option.value === normalized.defaultValue,
  ).length;
  if (normalized.type !== "checkbox" && defaultCount !== 1) {
    errors.push(`L opzione "${normalized.label}" deve avere un solo valore di default.`);
  }

  return errors;
}

export function validateProductConfig(value: unknown) {
  const errors: string[] = [];

  if (hasInvalidJson(value)) {
    return ["JSON configurazione prodotto non valido."];
  }

  const config = normalizeProductConfig(value);
  const groupIds = new Set<string>();

  config.optionGroups.forEach((group, index) => {
    if (groupIds.has(group.id)) {
      errors.push(`ID opzione duplicato: ${group.id}.`);
    }
    groupIds.add(group.id);
    errors.push(...validateOptionGroup(group, index));
  });

  config.conditionalFees.forEach((fee, index) => {
    if (!fee.id) {
      errors.push(`La commissione automatica #${index + 1} deve avere un id.`);
    }
    if (!fee.label) {
      errors.push(`La commissione automatica #${index + 1} deve avere un titolo.`);
    }
    if (!fee.condition.rules.length) {
      errors.push(`La commissione automatica "${fee.label || index + 1}" deve avere almeno una regola.`);
    }
  });

  if (config.packaging.enabled) {
    if (config.packaging.costPerSqm <= 0) {
      errors.push("Il costo imballaggio al mq deve essere maggiore di zero.");
    }
    if (config.packaging.maxPanelSizeCm <= 0) {
      errors.push("La dimensione massima pannello per spedizione deve essere maggiore di zero.");
    }
    if (config.packaging.minimumCost < 0) {
      errors.push("Il costo minimo imballaggio non puo essere negativo.");
    }
  }

  return errors;
}

export function calculateOptionPriceModifiers(
  options: SqmOption[],
  getSelectedValue: (option: SqmOption) => boolean,
) {
  return options.reduce((total, option) => {
    if (!getSelectedValue(option)) return total;
    return total + (option.priceModifier.type === "none" ? 0 : option.priceModifier.amount);
  }, 0);
}

export function formatPriceModifierLabel(modifier: PriceModifier) {
  if (!modifier || modifier.type === "none") return "";
  if (modifier.frontendLabel?.trim()) return modifier.frontendLabel.trim();

  const amount = roundDecimal(modifier.amount || 0).toLocaleString("it-IT", {
    minimumFractionDigits: modifier.type === "percentage" ? 0 : 2,
    maximumFractionDigits: modifier.type === "percentage" ? 2 : 2,
  });

  if (modifier.type === "per_sqm") return `+${amount} €/mq`;
  if (modifier.type === "fixed_order") return `+${amount} €`;
  if (modifier.type === "fixed_piece") return `+${amount} €/pz`;
  if (modifier.type === "percentage") return `+${amount}%`;
  if (modifier.type === "multiplier") return `x${amount}`;
  return "";
}

export function buildProductAdvancedConfigFromForm(value: unknown) {
  return stringifyProductConfig(normalizeProductConfig(value));
}

export function stringifyProductConfig(value: unknown) {
  return JSON.stringify(normalizeProductConfig(value), null, 2);
}
