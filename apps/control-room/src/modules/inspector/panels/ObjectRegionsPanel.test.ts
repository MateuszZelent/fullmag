import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("ObjectRegionsPanel physical scalar inputs", () => {
  it("distinguishes the owner object from its authored subregion", () => {
    const shared = readFileSync(
      new URL("./region/shared.tsx", import.meta.url),
      "utf8",
    );

    expect(shared).toContain('title="Authored Subregion"');
    expect(shared).toContain('label="Owner object ID"');
    expect(shared).toContain('label="Subregion ID"');
    expect(shared).not.toContain('<FieldRow label="Object ID" value={model.objectId} />');
    expect(shared).not.toContain('<FieldRow label="Region ID" value={model.regionId} />');
  });

  it("does not render Radius for Box regions", () => {
    const geometryPanel = readFileSync(
      new URL("./region/ObjectRegionGeometryPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(geometryPanel).toContain('draft.shape.kind === "cylinder"');
    expect(geometryPanel).toContain('draft.shape.kind === "sphere"');
    expect(geometryPanel).not.toContain(
      'draft.shape.kind === "box" || draft.shape.kind === "cylinder" || draft.shape.kind === "sphere"',
    );
  });

  it("buffers scientific notation text locally while editing SI values", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function PhysicalScalarField");
    expect(source).toContain("const [text, setText] = useState(formatted);");
    expect(source).toContain("parseRegionPhysicalScalar(nextText)");
    expect(source).toContain("const parsed = parseRegionPhysicalScalar(displayValue);");
    expect(source).toContain("invalid={invalid}");
    expect(source).toContain('error={invalid ? "Enter a valid SI value" : undefined}');
    expect(source).toContain('type="text"');
    expect(source).toContain('inputMode="decimal"');
    expect(source).not.toContain("function parsePhysicalInput");
  });

  it("does not write region scalar drafts when the parsed value is unchanged", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "if (parsed !== null && !Object.is(parsed, value)) {",
    );
    expect(source).not.toContain(
      "if (parsed !== null) {\n          onValueChange(parsed);",
    );
  });

  it("renders capability diagnostics inline in the relevant region panels", () => {
    const meshPanel = readFileSync(
      new URL("./region/ObjectRegionMeshPanel.tsx", import.meta.url),
      "utf8",
    );
    const materialPanel = readFileSync(
      new URL(
        "./region/ObjectRegionMagneticParametersPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const overviewPanel = readFileSync(
      new URL("./region/ObjectRegionOverviewPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(meshPanel).toContain('capabilityGates={["regions.mesh_policy"]}');
    expect(materialPanel).toContain(
      'capabilityGates={["regions.material_override"]}',
    );
    expect(overviewPanel).toContain(
      '"regions.realized_materialization"',
    );
    expect(overviewPanel).toContain(
      '"regions.conformal_or_projected_boundary"',
    );
  });

  it("shows inherited parent values next to local material overrides", () => {
    const materialPanel = readFileSync(
      new URL(
        "./region/ObjectRegionMagneticParametersPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const overridesStart = materialPanel.indexOf(
      "draft.materialOverrides.map",
    );
    const fieldsStart = materialPanel.indexOf(
      '<InspectorGroup title="Material Fields"',
      overridesStart,
    );

    expect(overridesStart).toBeGreaterThanOrEqual(0);
    expect(fieldsStart).toBeGreaterThan(overridesStart);

    const overrideRows = materialPanel.slice(overridesStart, fieldsStart);
    expect(overrideRows).toContain("getParentParamInfo(");
    expect(overrideRows).toContain('label="Inherited parent"');
    expect(overrideRows).toContain('label="Local override"');
  });

  it("renders region material override selectors through select FormFields", () => {
    const materialPanel = readFileSync(
      new URL(
        "./region/ObjectRegionMagneticParametersPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const overrideSelectorStart = materialPanel.indexOf(
      "label={`Override ${index + 1}`}",
    );
    const inheritedParentStart = materialPanel.indexOf(
      'label="Inherited parent"',
      overrideSelectorStart,
    );

    expect(overrideSelectorStart).toBeGreaterThanOrEqual(0);
    expect(inheritedParentStart).toBeGreaterThan(overrideSelectorStart);
    expect(
      materialPanel.slice(overrideSelectorStart, inheritedParentStart),
    ).toContain('type="select"');
  });

  it("renders material field realization metadata from the resource", () => {
    const materialPanel = readFileSync(
      new URL(
        "./region/ObjectRegionMagneticParametersPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(materialPanel).toContain("materialFieldRealizationRows(");
    expect(materialPanel).toContain('key={`realization:${field.assignmentId}:${rowIndex}`}');
    expect(materialPanel).toContain('key={`override:${index}`}');
    expect(materialPanel).not.toContain("overrideKeys");
    expect(materialPanel).toContain('label={row.label}');
    expect(materialPanel).toContain('value={row.value}');
  });

  it("surfaces active coupling dependencies before destructive region actions", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );
    const shared = readFileSync(
      new URL("./region/shared.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useModelCouplingsResource()");
    expect(source).toContain("resolveRegionCouplingDependencies(");
    expect(source).toContain("couplingDependencies,");
    expect(shared).toContain('label="Active couplings"');
    expect(shared).toContain("Delete Coupling first");
    expect(shared).toContain("couplingDependencies.length > 0");
  });

  it("saves region texture overrides through typed object-region transactions", () => {
    const texturePanel = readFileSync(
      new URL("./region/ObjectRegionTexturePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(texturePanel).toContain("buildMagnetizationTransactionRequest(");
    expect(texturePanel).toContain("api.model.commitTransaction(");
    expect(texturePanel).not.toContain("patchMagnetizationAsset(");
    expect(texturePanel).not.toContain("patchObjectRegionResource(");
  });

  it("syncs the canonical authoring script after region edits", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );

    const applyRegionStart = source.indexOf("async function applyRegion");
    const duplicateRegionStart = source.indexOf("async function duplicateRegion");
    const deleteRegionStart = source.indexOf("async function deleteRegion");
    const subPropsStart = source.indexOf("const subProps");

    expect(applyRegionStart).toBeGreaterThanOrEqual(0);
    expect(duplicateRegionStart).toBeGreaterThan(applyRegionStart);
    expect(deleteRegionStart).toBeGreaterThan(duplicateRegionStart);
    expect(subPropsStart).toBeGreaterThan(deleteRegionStart);

    expect(source.slice(applyRegionStart, duplicateRegionStart)).toContain(
      "syncAuthoringScriptBestEffort(api)",
    );
    expect(source.slice(duplicateRegionStart, deleteRegionStart)).toContain(
      "syncAuthoringScriptBestEffort(api)",
    );
    expect(source.slice(deleteRegionStart, subPropsStart)).toContain(
      "syncAuthoringScriptBestEffort(api)",
    );
  });

  it("keeps region mesh actions tied to realized lifecycle resources", () => {
    const panel = readFileSync(
      new URL("./region/ObjectRegionMeshPanel.tsx", import.meta.url),
      "utf8",
    );
    const shared = readFileSync(
      new URL("./region/shared.tsx", import.meta.url),
      "utf8",
    );
    const parent = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    expect(parent).toContain("useMeshRegionMembershipResource");
    expect(parent).toContain("useMeshBuildCurrent");
    expect(parent).toContain("resolveRegionMeshLifecycle");
    expect(parent).toContain('const femMeshLane = meshLane === "fem";');
    expect(parent).toContain("meshPolicyLane: meshLane");
    expect(panel).toContain("regionMeshLifecycle={regionMeshLifecycle}");
    expect(shared).toContain('label="Mesh realization"');
    expect(shared).toContain("Apply & Build Mesh");
    expect(shared).toContain('status === "unsupported"');
  });

  it("gates region mesh writes and FEM controls from an explicit FDM lane", () => {
    const parent = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );
    const meshPanel = readFileSync(
      new URL("./region/ObjectRegionMeshPanel.tsx", import.meta.url),
      "utf8",
    );
    const shared = readFileSync(
      new URL("./region/shared.tsx", import.meta.url),
      "utf8",
    );

    expect(parent).toContain("useSessionStatusSelector(");
    expect(parent).toContain('const canWriteMeshRegion = canWriteRegion && femMeshLane;');
    expect(parent).toContain('if (meshLane !== "fem")');
    expect(parent).toContain('kernel.commands.execute("mesh.build-shared-domain"');
    expect(meshPanel).toContain('if (meshLane === "fdm")');
    expect(meshPanel).toContain('if (meshLane !== "fem")');
    expect(meshPanel).not.toContain('title="FEM Mesh Controls"');
    expect(meshPanel).toContain('InspectorGroup title="Region Mesh" badge={fdmModel.status}');
    expect(meshPanel).toContain('label="Mesh policy" value="execution-plan owned (read-only)"');
    expect(meshPanel).toContain('label="Mesh scope" value={`${model.objectId} / ${model.regionId}`}');
    expect(meshPanel).toContain('label="Mesh realization" value="structured-grid cell membership"');
    expect(shared).toContain("canWriteMeshRegion");
    expect(shared).toContain("FDM structured-grid membership is read-only");
    expect(shared).toContain('label="Mesh realization"');

    for (const panelName of [
      "ObjectRegionOverviewPanel.tsx",
      "ObjectRegionGeometryPanel.tsx",
      "ObjectRegionMagneticParametersPanel.tsx",
      "ObjectRegionMeshPanel.tsx",
    ]) {
      const panel = readFileSync(
        new URL(`./region/${panelName}`, import.meta.url),
        "utf8",
      );
      expect(panel, panelName).toContain("canWriteMeshRegion");
    }
  });

  it("keeps FDM region actions neutral and scopes FDM membership to the selected region", () => {
    const parent = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );
    const shared = readFileSync(
      new URL("./region/shared.tsx", import.meta.url),
      "utf8",
    );
    const meshPanel = readFileSync(
      new URL("./region/ObjectRegionMeshPanel.tsx", import.meta.url),
      "utf8",
    );
    const overview = readFileSync(
      new URL("./region/ObjectRegionOverviewPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(parent).toContain('meshLane === "fem"');
    expect(parent).toContain("resolveRegionMeshLifecycle");
    expect(shared).toContain('meshLane === "fdm"');
    expect(shared).toContain("FDM structured-grid membership is read-only");
    expect(shared).toContain("const femMeshLifecycle = meshLane === \"fem\"");
    expect(meshPanel).toContain("useFdmRegionMembershipBinaryResource(");
    expect(meshPanel).toContain("model.regionId");
    expect(meshPanel).toContain("regionId: model.regionId");
    expect(overview).toContain('meshLane === "fdm"');
    expect(overview).toContain("Runtime-derived structured-grid membership");
  });

  it("does not fetch the FEM scene while routing explicit-FDM region visualization", () => {
    const parent = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    expect(parent).toContain(
      'const regionVisualizationSelection =\n    selection.kind === "object.region.visualization";',
    );
    expect(parent).toContain(
      'useSceneResource({\n    enabled: !regionVisualizationSelection || meshLane === "fem",\n  })',
    );
  });
});
