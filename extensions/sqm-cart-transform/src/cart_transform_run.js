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
      const cents = parseCents(
        line.finalPriceCents?.value ?? line.calculatedPriceCents?.value,
      ) ?? parseMoneyCents(line.calculatedPriceLabel?.value);

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
function parseMoneyCents(value) {
  if (typeof value !== "string") return null;

  const normalized = value
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!normalized) return null;

  const commaIndex = normalized.lastIndexOf(",");
  const dotIndex = normalized.lastIndexOf(".");
  const decimalSeparator =
    commaIndex > -1 && commaIndex > dotIndex ? "," : dotIndex > -1 ? "." : "";
  const decimalValue = decimalSeparator
    ? normalized
        .replace(new RegExp(`\\${decimalSeparator === "," ? "." : ","}`, "g"), "")
        .replace(decimalSeparator, ".")
    : normalized;
  const amount = Number.parseFloat(decimalValue);

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
