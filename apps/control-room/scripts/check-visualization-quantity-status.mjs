import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const root = new URL("../src/", import.meta.url);
const cache = new Map();
function load(url, source = readFileSync(url, "utf8")) {
  if (!cache.has(url.href)) cache.set(url.href, new vm.SourceTextModule(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }, fileName: url.pathname,
  }).outputText, { identifier: url.href }));
  return cache.get(url.href);
}
// Isolate the real pure selector from the large panel model, without mocking its normalizer.
const modelUrl = new URL("modules/inspector/panels/ObjectVisualizationPanelModel.ts", root);
const modelSource = readFileSync(modelUrl, "utf8");
const ast = ts.createSourceFile(modelUrl.pathname, modelSource, ts.ScriptTarget.Latest, true);
// Exercise the reported overview symptom before requiring the new selector symbol.
const overviewUrl = new URL("modules/inspector/panels/ObjectVisualizationPanel.tsx", root);
const overviewAst = ts.createSourceFile(overviewUrl.pathname, readFileSync(overviewUrl, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let overviewExpression;
function findOverview(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(overviewAst) === "quantitySource") overviewExpression = node.initializer.expression.getText(overviewAst);
  ts.forEachChild(node, findOverview);
}
findOverview(overviewAst); assert.ok(overviewExpression);
assert.equal(new vm.Script(overviewExpression).runInNewContext({ capabilities: { supportsFieldData: true },
  analysisFieldShown: false, settings: { activeQuantityId: "m" }, quantitySelection: { summary: "No compatible field available" } }),
  "No compatible field available", "An empty Universe catalog must not advertise retained m as its quantity source");
console.log("PASS actual overview expression does not label an empty Universe with a retained magnetic quantity");
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "visualizationQuantitySelectionState");
assert.ok(declaration);
const entry = load(modelUrl, `import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";\n${declaration.getText(ast)}`);
await entry.link((name, parent) => load(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.ts`, parent.identifier)));
await entry.evaluate();
const select = entry.namespace.visualizationQuantitySelectionState;
// Execute the actual parent view's resource classification, not a parallel model.
const view = overviewAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ObjectVisualizationPanelView");
const viewNames = new Set(["executionRequired", "fieldCatalogError", "fieldCatalogRefreshWarning", "fieldCatalogLoading"]);
const viewDeclarations = [];
function findViewState(node) {
  if (ts.isVariableDeclaration(node) && viewNames.has(node.name.getText(overviewAst))) viewDeclarations.push(`const ${node.getText(overviewAst)};`);
  ts.forEachChild(node, findViewState);
}
findViewState(view); assert.ok(viewDeclarations.length >= 3);
function viewResourceState(fieldCatalog, quantityCatalog, panel = { artifactInspection: true, artifactExecutionSelected: true, catalogOwnerReady: true }) {
  return new vm.Script(`${viewDeclarations.join("\n")}\n({error:fieldCatalogError,loading:fieldCatalogLoading,warning:typeof fieldCatalogRefreshWarning === "undefined" ? null : fieldCatalogRefreshWarning})`).runInNewContext({
    fieldCatalog, quantityCatalog, panel, fdmTarget: false, target: { kind: "airbox" },
  });
}
const verifiedCatalog = { data: { quantities: [{ id: "H_ant" }] }, status: "ready", error: null, refreshError: null };
for (const status of ["ready", "stale", "loading"]) {
  const retained = { ...verifiedCatalog, status, refreshError: { message: "antenna_store_busy" } };
  const state = viewResourceState(retained, retained);
  assert.equal(state.error, null, "A transient catalog refresh with matching last-good data must not disable the selector");
  assert.equal(state.loading, false, "Retained current-key data must not become an initial loading panel");
  assert.equal(state.warning, "antenna_store_busy");
}
assert.ok(viewResourceState({ ...verifiedCatalog, data: null, refreshError: { message: "Initial refresh failed" } }, verifiedCatalog).error);
assert.ok(viewResourceState({ ...verifiedCatalog, error: { message: "Fatal validation error" } }, verifiedCatalog).error);
assert.ok(viewResourceState(verifiedCatalog, verifiedCatalog, { artifactInspection: true, artifactExecutionSelected: true, catalogOwnerReady: false }).error,
  "A foreign historical catalog remains a hard owner failure even with retained data");
assert.equal(viewResourceState({ ...verifiedCatalog, data: null, status: "loading" }, verifiedCatalog).loading, true);
console.log("PASS actual parent classification retains matching catalogs with warning and hard-rejects missing/fatal/foreign-owner resources");

const item = { value: "H_ant", label: "Antenna field" };
const input = { activeQuantityId: "H_ant", items: [item], loading: false };
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
check("empty Universe never presents a retained magnetic quantity as selected", () => {
  const result = select({ ...input, activeQuantityId: "m", items: [] });
  assert.equal(result.status, "empty"); assert.equal(result.selectedValue, "");
  assert.equal(result.summary, "No compatible field available");
});
check("missing selection asks explicitly without auto-selecting a result", () => {
  const result = select({ ...input, activeQuantityId: "m" });
  assert.equal(result.status, "unselected"); assert.equal(result.selectedValue, "");
  assert.equal(result.summary, "Select an available quantity");
});
check("compatible selection uses the catalog label", () => {
  const result = select(input); assert.equal(result.status, "selected"); assert.equal(result.summary, item.label);
});
check("disabled selection is retained but never advertised as available", () => {
  const result = select({ ...input, items: [{ ...item, disabled: true }] });
  assert.equal(result.status, "unavailable"); assert.equal(result.selectedValue, "H_ant");
  assert.equal(result.summary, "Unavailable / Antenna field");
});
check("initial loading is distinct from an empty completed catalog", () => {
  assert.equal(select({ ...input, items: [], loading: true }).status, "loading");
  assert.equal(select({ ...input, items: [], loading: false }).status, "empty");
});
check("hard catalog error remains an error even with retained values or loading flag", () => {
  for (const loading of [true, false]) {
    const result = select({ ...input, loading, error: "Catalog request failed" });
    assert.equal(result.status, "error"); assert.equal(result.summary, "Field catalog unavailable");
    assert.equal(result.selectedValue, "H_ant");
  }
});
check("missing execution never shows loading or a stale selected field", () => {
  for (const loading of [true, false]) {
    const result = select({ ...input, loading, executionRequired: true });
    assert.equal(result.status, "execution-required");
    assert.equal(result.selectedValue, "");
    assert.equal(result.summary, "Select a source and execution");
  }
  assert.equal(select({ ...input, executionRequired: false }).status, "selected");
});
check("selector and overview share the state resolver and error input", () => {
  for (const file of ["ObjectVisualizationPanel.tsx", "ObjectVisualizationTargetSection.tsx"]) {
    const source = readFileSync(new URL(`modules/inspector/panels/${file}`, root), "utf8");
    assert.match(source, /visualizationQuantitySelectionState\(/);
    assert.match(source, /error: fieldCatalogError/);
  }
});
const require = createRequire(new URL("../package.json", import.meta.url));
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const sectionUrl = new URL("modules/inspector/panels/ObjectVisualizationTargetSection.tsx", root);
const sectionAst = ts.createSourceFile(sectionUrl.pathname, readFileSync(sectionUrl, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const section = sectionAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "VisualizationQuantitySection");
const patchDeclaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "quantitySourcePatch");
assert.ok(section && patchDeclaration);
const quantities = cache.get(new URL("kernel/api/quantityIds.ts", root).href).namespace;
let renderedItems = [], selectedProps;
const bindings = {
  useId: React.useId,
  visualizationQuantitySelectionState: select,
  visualizationQuantityItems: () => renderedItems,
  resolveCanonicalQuantityId: quantities.resolveCanonicalQuantityId,
  isScalarSpatialQuantityId: quantities.isScalarSpatialQuantityId,
  isFlowMajorTensorDescriptor: () => false,
  quantityCatalogEntrySpatialProjections: () => [],
  InspectorPropertyRow: ({ label, children }) => React.createElement("section", null, label, children),
  FieldRow: ({ label, value }) => React.createElement("p", null, label, ": ", value),
  Select: props => { selectedProps = props; return React.createElement("div", { "data-disabled": props.disabled }, props.children); },
  SelectTrigger: ({ children, ...props }) => React.createElement("button", props, children),
  SelectValue: ({ children }) => React.createElement("span", null, children),
  SelectContent: ({ children }) => React.createElement("div", null, children),
  SelectItem: ({ children }) => React.createElement("span", null, children),
};
const source = `import { ${Object.keys(bindings).join(",")} } from "bindings";\n${patchDeclaration.getText(ast)}\n${section.getText(sectionAst)}`;
const ui = new vm.SourceTextModule(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
} }).outputText);
function synthetic(values) {
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); });
}
await ui.link(name => name === "bindings" ? synthetic(bindings) : synthetic(require(name)));
await ui.evaluate();
let patchCount = 0, lastPatch = null, catalogRequests = 0;
const props = {
  settings: { visible: true, activeQuantityId: "H_ant", surfaceColorSource: "solid" }, fieldCatalog: null,
  quantityCatalog: { quantities: [{ id: "H_ant", unit: "A/m" }] }, fieldCatalogLoading: false,
  isFieldPending: () => false, targetKind: "airbox", onFieldCatalogRequest: () => { catalogRequests++; },
  patch: value => { patchCount++; lastPatch = value; return Promise.resolve(); },
};
for (const [name, extra, items, expected, disabled] of [
  ["empty", {}, [], "No compatible field available", true],
  ["loading", { fieldCatalogLoading: true }, [], "Loading quantities", true],
  ["error", { fieldCatalogError: "Catalog failed" }, [], "Catalog failed", true],
  ["execution required", { executionRequired: true }, [item], "Select a source and execution", true],
  ["selected", {}, [item], "A/m", false],
  ["matching refresh warning", { fieldCatalogRefreshWarning: "antenna_store_busy" }, [item], "antenna_store_busy", false],
  ["unavailable", {}, [{ ...item, disabled: true }], "Unavailable / Antenna field", false],
  ["unrelated pending", { isFieldPending: name => name === "pointSize" }, [item], "A/m", false],
  ["quantity pending", { isFieldPending: name => name === "activeQuantityId" }, [item], "A/m", true],
]) {
  renderedItems = items;
  check(`actual quantity section SSR: ${name}`, () => {
    const html = renderToStaticMarkup(React.createElement(ui.namespace.VisualizationQuantitySection, { ...props, ...extra }));
    assert.ok(html.includes(expected)); assert.equal(selectedProps.disabled, disabled);
    assert.ok(html.includes('aria-label="Quantity source"'));
    assert.equal(patchCount, 0, "Render must not mutate quantity or select an owner");
    assert.equal(catalogRequests, 0, "Render must not request computation");
  });
}
check("actual quantity handler preserves a canonical local patch without starting computation", () => {
  renderedItems = [item];
  renderToStaticMarkup(React.createElement(ui.namespace.VisualizationQuantitySection, props));
  selectedProps.onValueChange("H_ant");
  assert.equal(patchCount, 1); assert.equal(lastPatch.activeQuantityId, "H_ant");
  assert.equal(lastPatch.tensorProjection, null); assert.equal(catalogRequests, 0);
});
console.log(JSON.stringify({ status: "passed", checks, browser_qualification: false, unit_test_compilation: false }));
