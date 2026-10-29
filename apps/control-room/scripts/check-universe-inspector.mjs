import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const root = new URL("../src/modules/inspector/panels/", import.meta.url);
function declaration(file, name) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
const layoutModules = new Map();
function loadLayout(url) {
  if (!layoutModules.has(url.href)) layoutModules.set(url.href,
    new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8"), { mode: "transform" }), { identifier: url.href }));
  return layoutModules.get(url.href);
}
const layoutModule = loadLayout(new URL("../src/kernel/layout/LayoutController.ts", import.meta.url));
await layoutModule.link((name, parent) => loadLayout(new URL(name + ".ts", parent.identifier)));
await layoutModule.evaluate();
const layout = new layoutModule.namespace.LayoutController({ emit() {} });
let items = [], selectedProps, buttonProps;
const host = tag => function Host({ children }) { return React.createElement(tag, null, children); };
const bindings = {
  useId: React.useId,
  useKernel: () => ({ layout }),
  InspectorGroup: ({ title, children }) => React.createElement("section", null, React.createElement("h2", null, title), children),
  Button: props => { buttonProps = props; return React.createElement("button", null, props.children); }, FeedbackBanner: ({ message }) => React.createElement("p", null, message),
  resolveCanonicalQuantityId: value => value,
  visualizationQuantityItems: () => items,
  isScalarSpatialQuantityId: value => value === "V_electric",
  isFlowMajorTensorDescriptor: () => false,
  quantityCatalogEntrySpatialProjections: () => [],
  InspectorPropertyRow: ({ label, children }) => React.createElement("section", null, label, children),
  FieldRow: ({ label, value }) => React.createElement("p", null, label, ": ", value),
  Select: props => { selectedProps = props; return React.createElement("div", { "data-disabled": props.disabled }, props.children); },
  SelectTrigger: ({ children, ...props }) => React.createElement("button", props, children),
  SelectValue: host("span"), SelectContent: host("div"), SelectItem: host("span"),
};
const synthetic = new vm.SyntheticModule(Object.keys(bindings), function () {
  for (const [name, value] of Object.entries(bindings)) this.setExport(name, value);
});
const source = `import { ${Object.keys(bindings).join(",")} } from "bindings";\n${declaration("ObjectVisualizationPanelModel.ts", "visualizationQuantitySelectionState")}\n${declaration("ObjectVisualizationPanelModel.ts", "quantitySourcePatch")}\n${declaration("ObjectVisualizationTargetSection.tsx", "VisualizationQuantitySection")}
${declaration("ArtifactInspectionSource.tsx", "artifactInspectionSourceGuidance")}
${declaration("ArtifactInspectionSource.tsx", "ArtifactInspectionSource")}`;
const entry = new vm.SourceTextModule(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText);
await entry.link(name => {
  if (name === "bindings") return synthetic;
  assert.equal(name, "react/jsx-runtime");
  const runtime = require(name);
  return new vm.SyntheticModule(Object.keys(runtime), function () { for (const [key, value] of Object.entries(runtime)) this.setExport(key, value); });
});
await entry.evaluate();
const patches = [];
let catalogRequests = 0;
const base = { patch: value => { patches.push(value); return Promise.resolve(); }, onFieldCatalogRequest: () => { catalogRequests++; }, settings: { visible: true, activeQuantityId: "H_ant", surfaceColorSource: "solid" }, fieldCatalog: null, quantityCatalog: null, fieldCatalogLoading: false, isFieldPending: () => false, targetKind: "airbox" };
let checks = 0;
for (const [name, overrides, options, expected, disabled] of [
  ["empty Universe", {}, [], "No compatible field available", true],
  ["execution required", { executionRequired: true }, [], "Select a source and execution", true],
  ["loading", { fieldCatalogLoading: true }, [], "Loading quantities", true],
  ["catalog error", { fieldCatalogError: "Catalog failed" }, [], "Catalog failed", true],
  ["available Oersted H", { quantityCatalog: { quantities: [{ id: "H_ant", unit: "A/m" }] } }, [{ value: "H_ant", label: "Oersted field" }], "A/m", false],
  ["unavailable H", {}, [{ value: "H_ant", label: "Oersted field", disabled: true }], "Unavailable / Oersted field", false],
  ["hidden target", { settings: { visible: false, activeQuantityId: "H_ant" } }, [{ value: "H_ant", label: "Oersted field" }], "Oersted field", true],
]) {
  items = options;
  const html = renderToStaticMarkup(React.createElement(entry.namespace.VisualizationQuantitySection, { ...base, ...overrides }));
  assert.ok(html.includes(expected), `${name}: missing ${expected}`);
  assert.equal(selectedProps.disabled, disabled, name);
  assert.ok(html.includes('aria-label="Quantity source"'));
  assert.ok(!html.includes("frozen_spins"));
  console.log(`PASS ${name}`); checks++;
}
items = [{ value: "H_ant", label: "Oersted field" }];
renderToStaticMarkup(React.createElement(entry.namespace.VisualizationQuantitySection, base));
selectedProps.onValueChange("H_ant");
assert.deepEqual(patches, [{ activeQuantityId: "H_ant", tensorProjection: null }]);
assert.equal(catalogRequests, 0);
console.log("PASS source selection preserves the canonical patch without starting computation"); checks++;
const airbox = readFileSync(new URL("airbox/AirboxVisualizationPanel.tsx", root), "utf8");
assert.ok(airbox.indexOf("<ArtifactInspectionSource") > airbox.indexOf("<VisualizationTargetInspectorPanel"));
assert.ok(airbox.indexOf("<ArtifactInspectionSource") < airbox.indexOf("</VisualizationTargetInspectorPanel>"));
checks++;
for (const [name, status, candidateStatuses, error, expected, inspectionState = "retained"] of [
  ["loading source", "loading", [], null, "Loading executions"],
  ["missing source", "ready", [], null, "No execution is retained"],
  ["ambiguous source", "ready", ["completed", "completed"], "Multiple inspection owners exist. Select a source and execution.", "Select the antenna execution"],
  ["running source", "ready", ["running"], null, "has not completed"],
  ["failed source", "ready", ["failed"], null, "did not complete successfully"],
  ["completed source", "ready", ["completed"], null, "Choose an available Quantity source"],
  ["source catalog failure", "ready", [], "Execution catalog failed", "Execution information is unavailable"],
  ["absent retained field", "ready", ["failed"], null, "no retained field", "absent"],
  ["unknown retained field", "ready", ["completed"], null, "availability is not confirmed", "unknown"],
]) {
  const candidates = candidateStatuses.map((value, i) => ({ runtimeStageId: `stage-${i}`, sourceObjectId: "antenna", authoredStageId: "solve", runId: "run", status: value }));
  const source = { inspection: { state: inspectionState, owner: null }, execution: { status, data: { stages: [] } }, pin: null, candidates, selected: candidates.length === 1 ? candidates[0] : null, error, sourceNames: new Map([["antenna", "Loop antenna"]]), visualization: { setAntennaFieldIntent: () => assert.fail("Render must not mutate selection"), setArtifactFieldSelection: () => assert.fail("Render must not select an execution") } };
  for (const universe of [false, true]) {
    layout.replace({ ...layout.get(), activeModuleTab: "geometry", resultsSource: "current",
      focusedSlot: null, panelVisible: { ...layout.get().panelVisible, left: false } });
    const beforeRender = layout.get();
    const html = renderToStaticMarkup(React.createElement(entry.namespace.ArtifactInspectionSource, { source, universe }));
    assert.ok(html.includes(expected), `${name}: ${expected}`);
    assert.ok(html.includes("Browse saved results"));
    assert.ok(html.includes(universe ? "Antenna field result" : "Field result"));
    assert.ok(!html.includes("frozen_spins"));
    if (universe) {
      assert.ok(html.includes("Saved sampling mesh"));
      assert.ok(!html.includes("Global mesh"), "Opening Universe must not assert a result’s sampling scope");
      assert.ok(html.includes("does not establish full-volume coverage"));
    }
    assert.strictEqual(layout.get(), beforeRender, "Render must not navigate");
    buttonProps.onClick();
    assert.equal(layout.get().activeModuleTab, "results", "Saved results button must open Results");
    assert.equal(layout.get().resultsSource, "saved", "Saved results button must select Saved before mounting");
    assert.equal(layout.get().panelVisible.left, true);
    assert.equal(layout.get().focusedSlot, "panel-left");
    assert.equal(layout.get().activeViewportMainModuleId, beforeRender.activeViewportMainModuleId);
    checks++;
  }
  console.log(`PASS ${name} for Universe and Antenna`);
}
console.log(JSON.stringify({ status: "passed", checks, browser_qualification: false, unit_test_compilation: false }));
