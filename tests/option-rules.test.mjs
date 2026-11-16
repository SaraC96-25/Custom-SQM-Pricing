import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/routes/sqm-product-config.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseProductConfig, stringifyProductConfig, validateProductConfig, getDisabledOptionValues } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const group = (id, values) => ({
  id, label: id, type: "button", defaultValue: values[0],
  options: values.map((value) => ({ value, label: value })),
});
const base = {
  optionGroups: [group("materiale", ["trasparente", "opalino", "nero"]), group("spessore", ["3-mm", "5-mm"])],
  optionRules: [{ id: "opalino-no-3mm", when: { groupId: "materiale", values: ["opalino"] }, disable: { groupId: "spessore", values: ["3-mm"] } }],
};

test("parses rules and round-trips through JSON", () => {
  const parsed = parseProductConfig(base);
  assert.equal(parsed.optionRules.length, 1);
  assert.deepEqual(parseProductConfig(stringifyProductConfig(parsed)), parsed);
  assert.deepEqual(validateProductConfig(stringifyProductConfig(parsed)), []);
});

test("old configs without rules still parse", () => {
  assert.deepEqual(parseProductConfig({ optionGroups: base.optionGroups }).optionRules, []);
});

test("drops incomplete rules", () => {
  const parsed = parseProductConfig({ ...base, optionRules: [{ when: { groupId: "materiale", values: [] }, disable: { groupId: "spessore", values: ["3-mm"] } }] });
  assert.deepEqual(parsed.optionRules, []);
});

test("disables 3 mm only when opalino is selected", () => {
  const { optionRules } = parseProductConfig(base);
  assert.deepEqual(getDisabledOptionValues(optionRules, { materiale: "opalino", spessore: "3-mm" }), { spessore: ["3-mm"] });
  assert.deepEqual(getDisabledOptionValues(optionRules, { materiale: "trasparente" }), {});
});

test("rules pointing to removed groups or values are pruned", () => {
  const stale = { ...base, optionRules: [
    { when: { groupId: "colore", values: ["x"] }, disable: { groupId: "spessore", values: ["3-mm"] } },
    { when: { groupId: "materiale", values: ["opalino", "rimosso"] }, disable: { groupId: "spessore", values: ["3-mm"] } },
  ] };
  const parsed = parseProductConfig(stale);
  assert.equal(parsed.optionRules.length, 1);
  assert.deepEqual(parsed.optionRules[0].when.values, ["opalino"]);
});

test("validation flags a rule that disables every value", () => {
  const all = { ...base, optionRules: [{ when: { groupId: "materiale", values: ["opalino"] }, disable: { groupId: "spessore", values: ["3-mm", "5-mm"] } }] };
  assert.match(validateProductConfig(JSON.stringify(all))[0], /tutti i valori/);
});
