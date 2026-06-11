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
      const finalCents = parseCents(line.finalPriceCents?.value);
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
 * @param {number} cents
 * @returns {string}
 */
function centsToDecimal(cents) {
  return (cents / 100).toFixed(2);
}
