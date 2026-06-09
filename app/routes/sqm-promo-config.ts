export type PromoFormatEntry = {
  label: string;
  base: number;
  height: number;
  promoPricePerSqm: number;
  promoDiscountPercent: number;
};

export type PromoFormatConfig = {
  enablePromoFormats: boolean;
  promoBadge: string;
  promoMessage: string;
  formats: PromoFormatEntry[];
};

export const EMPTY_PROMO_CONFIG: PromoFormatConfig = {
  enablePromoFormats: false,
  promoBadge: "",
  promoMessage: "",
  formats: [],
};

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.replace(",", ".").trim();
  if (!normalized) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function roundDecimal(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function parsePromoConfig(value: unknown): PromoFormatConfig {
  if (!value) return { ...EMPTY_PROMO_CONFIG };

  let parsed = value;
  for (let index = 0; index < 2 && typeof parsed === "string"; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ...EMPTY_PROMO_CONFIG };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { ...EMPTY_PROMO_CONFIG };
  }

  const source = parsed as Record<string, unknown>;
  const formats = Array.isArray(source.formats)
    ? source.formats
        .map((entry) => normalizePromoFormatEntry(entry))
        .filter((entry): entry is PromoFormatEntry => Boolean(entry))
    : [];

  return {
    enablePromoFormats: source.enablePromoFormats === true || source.enablePromoFormats === "true",
    promoBadge: String(source.promoBadge ?? "").trim(),
    promoMessage: String(source.promoMessage ?? "").trim(),
    formats,
  };
}

export function normalizePromoFormatEntry(value: unknown): PromoFormatEntry | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const label = String(source.label ?? "").trim();
  const base = toNumber(source.base);
  const height = toNumber(source.height);
  const promoPricePerSqm = toNumber(source.promoPricePerSqm) ?? 0;
  const promoDiscountPercent = toNumber(source.promoDiscountPercent) ?? 0;

  if (!label || base === null || height === null) return null;
  if (base <= 0 || height <= 0) return null;

  return {
    label,
    base: roundDecimal(base),
    height: roundDecimal(height),
    promoPricePerSqm: Math.max(0, roundDecimal(promoPricePerSqm)),
    promoDiscountPercent: Math.min(100, Math.max(0, roundDecimal(promoDiscountPercent))),
  };
}

export function normalizePromoConfig(value: PromoFormatConfig): PromoFormatConfig {
  const parsed = parsePromoConfig(value);

  return {
    enablePromoFormats: parsed.enablePromoFormats && parsed.formats.length > 0,
    promoBadge: parsed.promoBadge,
    promoMessage: parsed.promoMessage,
    formats: parsed.formats,
  };
}

export function validatePromoConfig(config: PromoFormatConfig) {
  const normalized = normalizePromoConfig(config);
  const errors: string[] = [];

  if (!normalized.enablePromoFormats) return errors;

  if (!normalized.formats.length) {
    errors.push("Aggiungi almeno un formato promo valido oppure disattiva la funzione.");
  }

  const seenLabels = new Set<string>();
  normalized.formats.forEach((format, index) => {
    const row = index + 1;
    const key = format.label.trim().toLowerCase();

    if (seenLabels.has(key)) {
      errors.push(`Formato promo ${row}: etichetta duplicata "${format.label}".`);
    }
    seenLabels.add(key);

    if (format.base <= 0 || format.height <= 0) {
      errors.push(`Formato promo ${row}: base e altezza devono essere maggiori di 0.`);
    }

    if (format.promoPricePerSqm < 0) {
      errors.push(`Formato promo ${row}: il prezzo promo al mq non puo essere negativo.`);
    }

    if (format.promoDiscountPercent < 0 || format.promoDiscountPercent > 100) {
      errors.push(`Formato promo ${row}: lo sconto promo deve essere compreso tra 0 e 100.`);
    }
  });

  return errors;
}
