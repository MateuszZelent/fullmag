import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("ObjectRegionsPanel physical scalar inputs", () => {
  it("buffers scientific notation text locally while editing SI values", () => {
    const source = readFileSync(
      new URL("./ObjectRegionsPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function PhysicalScalarField");
    expect(source).toContain("const [text, setText] = useState(formatted);");
    expect(source).toContain("parseRegionPhysicalScalar(nextText)");
    expect(source).toContain("const parsed = parseRegionPhysicalScalar(displayValue);");
    expect(source).toContain("aria-invalid={invalid || undefined}");
    expect(source).toContain("hint={invalid ? \"Enter a valid SI value\" : undefined}");
    expect(source).toContain('type="text"');
    expect(source).toContain('inputMode="decimal"');
    expect(source).not.toContain("function parsePhysicalInput");
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
      '<InspectorSection value="material-fields"',
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
    expect(materialPanel).toContain('key={`realization:${field.assignmentId}:${row.label}`}');
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

    expect(texturePanel).toContain("buildRegionTextureOverridePatch(");
    expect(texturePanel).toContain("api.model.patchObjectRegionResource(");
    expect(texturePanel).not.toContain("api.model.patchRegion(");
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
});
