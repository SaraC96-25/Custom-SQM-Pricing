// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = input.cart.lines
    .map((line) => {
      const gazeboFinalCents = parseCents(line.gazeboFinalPriceCents?.value);
      const calculatedCents = parseCents(line.calculatedPriceCents?.value);
      const packagingCents = parseCents(line.packagingPriceCents?.value) ?? 0;
      const fallbackCalculatedCents = calculatedCents
        ? calculatedCents + packagingCents
        : null;
      const finalCents = gazeboFinalCents
        ?? parseCents(line.finalPriceCents?.value)
        ?? fallbackCalculatedCents
        ?? parseMoneyToCents(line.calculatedPriceLabel?.value);
      const cents = finalCents;

      if (!cents) return null;

      const quantity = Number.isFinite(line.quantity) && line.quantity > 0
        ? line.quantity
        : 1;
      const unitCents = Math.round(cents / quantity);

      return {
        lineUpdate: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: centsToDecimal(unitCents),
              },
            },
          },
        },
      };
    })
    .filter(Boolean);

  return operations.length ? { operations } : NO_CHANGES;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseCents(value) {
  if (typeof value !== "string") return null;

  const cents = Number.parseInt(value, 10);
  if (!Number.isFinite(cents) || cents <= 0) return null;

  return cents;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseMoneyToCents(value) {
  if (typeof value !== "string") return null;

  let normalized = value
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!normalized) return null;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return Math.round(amount * 100);
}

/**
 * @param {number} cents
 * @returns {string}
 */
function centsToDecimal(cents) {
  return (cents / 100).toFixed(2);
}
