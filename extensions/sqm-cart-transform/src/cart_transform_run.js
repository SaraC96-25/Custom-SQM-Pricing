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
      );

      if (!cents) return null;

      return {
        lineUpdate: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount: centsToDecimal(cents),
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
