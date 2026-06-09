export type PromoQuantityRange = {
  minQty: number;
  maxQty: number | null;
  pricePerSqm: number;
};

export type PromoFormatEntry = {
  label: string;
  base: number;
  height: number;
  quantityRanges: PromoQuantityRange[];
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

function normalizePromoQuantityRange(value: unknown): PromoQuantityRange | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const minQty = toNumber(source.minQty);
  const maxQtySource = toNumber(source.maxQty);
  const pricePerSqm = toNumber(source.pricePerSqm);

  if (minQty === null || pricePerSqm === null) return null;
  if (minQty < 1 || pricePerSqm < 0) return null;

  const maxQty =
    maxQtySource === null || maxQtySource <= 0 ? null : Math.max(minQty, Math.round(maxQtySource));

  return {
    minQty: Math.max(1, Math.round(minQty)),
    maxQty,
    pricePerSqm: Math.max(0, roundDecimal(pricePerSqm)),
  };
}

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
  const legacyPromoPricePerSqm = toNumber(source.promoPricePerSqm) ?? 0;
  const quantityRangesSource = Array.isArray(source.quantityRanges)
    ? source.quantityRanges
    : [];
  const quantityRanges = quantityRangesSource
    .map((entry) => normalizePromoQuantityRange(entry))
    .filter((entry): entry is PromoQuantityRange => Boolean(entry))
    .sort((left, right) => left.minQty - right.minQty);

  if (!label || base === null || height === null) return null;
  if (base <= 0 || height <= 0) return null;

  if (!quantityRanges.length && legacyPromoPricePerSqm > 0) {
    quantityRanges.push({
      minQty: 1,
      maxQty: null,
      pricePerSqm: Math.max(0, roundDecimal(legacyPromoPricePerSqm)),
    });
  }

  return {
    label,
    base: roundDecimal(base),
    height: roundDecimal(height),
    quantityRanges,
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

    if (!format.quantityRanges.length) {
      errors.push(`Formato promo ${row}: aggiungi almeno una fascia quantità.`);
    }

    format.quantityRanges.forEach((range, rangeIndex) => {
      const rangeRow = `${row}.${rangeIndex + 1}`;

      if (range.minQty < 1) {
        errors.push(`Formato promo ${rangeRow}: la quantità minima deve essere almeno 1.`);
      }

      if (range.maxQty !== null && range.maxQty < range.minQty) {
        errors.push(`Formato promo ${rangeRow}: la quantità massima deve essere maggiore o uguale alla minima.`);
      }

      if (range.pricePerSqm < 0) {
        errors.push(`Formato promo ${rangeRow}: il prezzo al mq non puo essere negativo.`);
      }
    });

    const orderedRanges = [...format.quantityRanges].sort((left, right) => left.minQty - right.minQty);
    for (let rangeIndex = 1; rangeIndex < orderedRanges.length; rangeIndex += 1) {
      const previous = orderedRanges[rangeIndex - 1];
      const current = orderedRanges[rangeIndex];
      const previousMax = previous.maxQty ?? Number.POSITIVE_INFINITY;

      if (current.minQty <= previousMax) {
        errors.push(`Formato promo ${row}: le fasce quantità si sovrappongono.`);
        break;
      }
    }
  });

  return errors;
}
