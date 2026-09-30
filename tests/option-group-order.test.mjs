import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/routes/sqm-product-config.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { moveOptionGroup, parseProductConfig, stringifyProductConfig } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const config = parseProductConfig({
  optionGroups: ["finishing", "orientation", "material"].map((id) => ({
    id, label: id, type: "radio", defaultValue: "standard",
    options: [{ value: "standard", label: "Standard", priceModifier: { type: "fixed", value: 5 } }],
  })),
});
const ids = (value) => value.optionGroups.map((group) => group.id);

test("moves up and down without changing group contents or the source", () => {
  const moved = moveOptionGroup(config, 1, -1);
  assert.deepEqual(ids(moved), ["orientation", "finishing", "material"]);
  assert.equal(moved.optionGroups[0], config.optionGroups[1]);
  assert.deepEqual(moveOptionGroup(moved, 0, 1), config);
  assert.deepEqual(ids(config), ["finishing", "orientation", "material"]);
});
test("does not move past either end or accept an invalid index", () => {
  for (const [index, direction] of [[0, -1], [2, 1], [-1, 1], [3, -1], [0.5, 1]]) {
    assert.equal(moveOptionGroup(config, index, direction), config);
  }
  const empty = parseProductConfig({});
  assert.equal(moveOptionGroup(empty, 0, 1), empty);
});
test("saved JSON preserves the reordered groups and their settings", () => {
  const moved = moveOptionGroup(config, 2, -1);
  assert.deepEqual(parseProductConfig(stringifyProductConfig(moved)), moved);
});
