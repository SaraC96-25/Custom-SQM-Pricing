export type PromoPriceRange = {
  minM2: number;
  maxM2: number | null;
  pricePerSqm: number;
};

export type PromoFormatEntry = {
  label: string;
  base: number;
  height: number;
  priceRanges: PromoPriceRange[];
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

function normalizePromoPriceRange(value: unknown): PromoPriceRange | null {
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const minM2 = toNumber(source.minM2 ?? source.min_m2 ?? source.min);
  const maxM2Source = source.maxM2 ?? source.max_m2 ?? source.max;
  const maxM2 =
    maxM2Source === null || maxM2Source === "" || typeof maxM2Source === "undefined"
      ? null
      : toNumber(maxM2Source);
  const pricePerSqm = toNumber(source.pricePerSqm);

  if (minM2 === null || pricePerSqm === null) return null;
  if (minM2 < 0 || pricePerSqm < 0) return null;

  const normalizedMin = Math.max(0, roundDecimal(minM2));

  return {
    minM2: normalizedMin,
    maxM2: maxM2 === null ? null : Math.max(normalizedMin, roundDecimal(maxM2)),
    pricePerSqm: Math.max(0, roundDecimal(pricePerSqm)),
  };
}

function normalizeLegacyPromoQuantityRange(
  value: unknown,
  areaPerPiece: number,
): PromoPriceRange | null {
  if (!value || typeof value !== "object" || areaPerPiece <= 0) return null;

  const source = value as Record<string, unknown>;
  const minQty = toNumber(source.minQty);
  const maxQty = toNumber(source.maxQty);
  const pricePerSqm = toNumber(source.pricePerSqm);

  if (minQty === null || pricePerSqm === null) return null;
  if (minQty < 1 || pricePerSqm < 0) return null;

  return {
    minM2: roundDecimal(Math.max(0, Math.round(minQty) * areaPerPiece)),
    maxM2: maxQty === null || maxQty <= 0
      ? null
      : roundDecimal(Math.max(Math.round(minQty), Math.round(maxQty)) * areaPerPiece),
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

  if (!label || base === null || height === null) return null;
  if (base <= 0 || height <= 0) return null;

  const areaPerPiece = roundDecimal((base * height) / 10000);
  const legacyPromoPricePerSqm = toNumber(source.promoPricePerSqm) ?? 0;
  const priceRangesSource = Array.isArray(source.priceRanges)
    ? source.priceRanges
    : [];
  const legacyQuantityRangesSource = Array.isArray(source.quantityRanges)
    ? source.quantityRanges
    : [];
  const priceRanges = priceRangesSource
    .map((entry) => normalizePromoPriceRange(entry))
    .filter((entry): entry is PromoPriceRange => Boolean(entry));

  if (!priceRanges.length && legacyQuantityRangesSource.length) {
    legacyQuantityRangesSource.forEach((entry) => {
      const range = normalizeLegacyPromoQuantityRange(entry, areaPerPiece);
      if (range) priceRanges.push(range);
    });
  }

  if (!priceRanges.length && legacyPromoPricePerSqm > 0) {
    priceRanges.push({
      minM2: areaPerPiece,
      maxM2: null,
      pricePerSqm: Math.max(0, roundDecimal(legacyPromoPricePerSqm)),
    });
  }

  return {
    label,
    base: roundDecimal(base),
    height: roundDecimal(height),
    priceRanges: priceRanges.sort((left, right) => left.minM2 - right.minM2),
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

    if (!format.priceRanges.length) {
      errors.push(`Formato promo ${row}: aggiungi almeno una fascia mq.`);
    }

    format.priceRanges.forEach((range, rangeIndex) => {
      const rangeRow = `${row}.${rangeIndex + 1}`;

      if (range.minM2 < 0) {
        errors.push(`Formato promo ${rangeRow}: i mq minimi non possono essere negativi.`);
      }

      if (range.maxM2 !== null && range.maxM2 < range.minM2) {
        errors.push(`Formato promo ${rangeRow}: i mq massimi devono essere maggiori o uguali ai minimi.`);
      }

      if (range.pricePerSqm < 0) {
        errors.push(`Formato promo ${rangeRow}: il prezzo al mq non puo essere negativo.`);
      }
    });

    const orderedRanges = [...format.priceRanges].sort((left, right) => left.minM2 - right.minM2);
    for (let rangeIndex = 1; rangeIndex < orderedRanges.length; rangeIndex += 1) {
      const previous = orderedRanges[rangeIndex - 1];
      const current = orderedRanges[rangeIndex];
      const previousMax = previous.maxM2 ?? Number.POSITIVE_INFINITY;

      if (current.minM2 < previousMax) {
        errors.push(`Formato promo ${row}: le fasce mq si sovrappongono.`);
        break;
      }
    }
  });

  return errors;
}
