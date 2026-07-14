import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelFiles = [
  "AirboxOverviewPanel.tsx",
  "AirboxMeshOverviewPanel.tsx",
  "AirboxMeshParametersPanel.tsx",
  "AirboxMeshQualityGatesPanel.tsx",
  "AirboxMeshStatisticsPanel.tsx",
  "AirboxMeshTopologyPanel.tsx",
  "AirboxMeshBuildPanel.tsx",
];
const panelSources = Object.fromEntries(
  panelFiles.map((file) => [
    file,
    readFileSync(
      join(process.cwd(), "src/modules/inspector/panels/airbox", file),
      "utf8",
    ),
  ]),
);
const panelSource = Object.values(panelSources).join("\n");

describe("Airbox inspector panel performance contracts", () => {
  it("uses scoped resources without subscribing to the full status resource", () => {
    for (const file of [
      "AirboxOverviewPanel.tsx",
      "AirboxMeshOverviewPanel.tsx",
      "AirboxMeshTopologyPanel.tsx",
    ]) {
      expect(panelSources[file]).toMatch(
        /useMeshSharedDomainManifestResource\s*\(\s*\{\s*enabled:\s*shouldLoadRuntimeMeshManifest\s*\(\s*true\s*,\s*runtimeStatus\s*\)/,
      );
    }
    expect(panelSources["AirboxMeshBuildPanel.tsx"]).toMatch(
      /const\s+buildEnabled\s*=\s*shouldLoadRuntimeMeshBuild\s*\(\s*true\s*,\s*runtimeStatus\s*\)/,
    );
    for (const hook of [
      "useMeshUniverseReportResource",
      "useMeshBuildCurrent",
      "useMeshBuildLatestSuccessful",
    ]) {
      expect(panelSources["AirboxMeshBuildPanel.tsx"]).toMatch(
        new RegExp(`${hook}\\s*\\(\\s*\\{\\s*enabled:\\s*buildEnabled\\s*\\}\\s*\\)`),
      );
    }
    expect(panelSources["AirboxMeshBuildPanel.tsx"]).toMatch(
      /<pre\s+className="fm-mesh-json-preview">\{lifecycle\.rawDetails\.serialized\}<\/pre>/,
    );
    expect(panelSource.match(/fm-mesh-json-preview/g)).toHaveLength(1);
    expect(panelSource).not.toContain("JsonResourceSection");
    expect(panelSource).not.toMatch(/\{\s*JSON\.stringify\s*\(/);
    expect(panelSources["AirboxMeshBuildPanel.tsx"]).not.toContain(
      "value={report.data}",
    );
    expect(panelSources["AirboxMeshQualityGatesPanel.tsx"]).toMatch(
      /useMeshUniverseQualityResource\s*\(\s*\{\s*enabled:\s*shouldLoadRuntimeMeshSummary\s*\(\s*true\s*,\s*runtimeStatus\s*\)/,
    );
    expect(panelSources["AirboxMeshStatisticsPanel.tsx"]).not.toContain("MeshQualityStatisticsView");
    expect(panelSources["AirboxOverviewPanel.tsx"]).toContain("authored.mode");
    expect(panelSources["AirboxOverviewPanel.tsx"]).not.toContain("authored.airbox_mode");
    expect(panelSources["AirboxMeshTopologyPanel.tsx"]).toContain('label="Canonical marker" value="not published"');
    const statistics = panelSources["AirboxMeshStatisticsPanel.tsx"];
    expect(statistics).toMatch(
      /const\s+summaryEnabled\s*=\s*shouldLoadRuntimeMeshSummary\s*\(\s*true\s*,\s*runtimeStatus\s*\)/,
    );
    expect(statistics).toMatch(
      /useMeshUniverseQualityResource\s*\(\s*\{\s*enabled:\s*summaryEnabled\s*\}\s*\)/,
    );
    expect(statistics).toMatch(
      /useMeshUniverseReportResource\s*\(\s*\{\s*enabled:\s*summaryEnabled\s*\}\s*\)/,
    );
    expect(panelSource).not.toContain("const sessionStatus = useSessionStatus();");
    expect(panelSource).not.toContain("sessionStatus.data");
    expect(panelSource).not.toContain("useSessionStatus(");
  });

  it("does not fetch binary topology from the Inspector", () => {
    expect(panelSource).not.toContain("useMeshSharedDomainTopologyResource");
  });
});
