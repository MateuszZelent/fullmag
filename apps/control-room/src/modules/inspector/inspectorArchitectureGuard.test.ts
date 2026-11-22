import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "../../..");
const srcRoot = join(appRoot, "src");
const inspectorRoot = join(srcRoot, "modules/inspector");
const stylesRoot = join(srcRoot, "design/styles");

function toPosixRelative(filePath: string): string {
  return relative(appRoot, filePath).split(sep).join("/");
}

function isTestOrSupportFile(fileName: string): boolean {
  return (
    fileName.includes(".test.") ||
    fileName.includes(".spec.") ||
    fileName.includes(".stories.") ||
    fileName.includes(".test-support.")
  );
}

function collectFiles(
  root: string,
  predicate: (fullPath: string, entryName: string) => boolean,
): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath, predicate);
    }
    return predicate(fullPath, entry.name) ? [fullPath] : [];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

const DOMAIN_ROUTE_REGISTRIES = [
  "src/modules/inspector/inspectorRouteCatalog.tsx",
  "src/modules/inspector/routes/magneticTextureRoutes.tsx",
  "src/modules/inspector/routes/modelPhysicsRoutes.tsx",
  "src/modules/inspector/routes/meshAntennaRoutes.tsx",
  "src/modules/inspector/routes/studyResultsStartRoutes.tsx",
] as const;

const PURGED_LEGACY_INSPECTOR_WRAPPERS = [
  "src/modules/inspector/panels/DedicatedExplorerInspectorPanels.tsx",
  "src/modules/inspector/panels/ModelTreeOverviewInspectorPanels.tsx",
  "src/modules/inspector/panels/MaskAntennaPanel.tsx",
  "src/modules/inspector/panels/FieldQuantityInspectorPanel.tsx",
  "src/modules/inspector/panels/ObservationFrameInspectorPanel.tsx",
  "src/modules/inspector/panels/PhysicsGraphModuleInspectorPanel.tsx",
  "src/modules/inspector/panels/analysis-results/PinnedVisualizationsInspectorPanel.tsx",
  "src/modules/inspector/panels/antenna/AntennaCompositionSummaryPanel.tsx",
  "src/modules/inspector/panels/antenna/AntennaTerminalsPanel.tsx",
  "src/modules/inspector/panels/antenna/AntennaTerminalSourceDetails.tsx",
  "src/modules/inspector/panels/frequency-domain/ModeCompositionInspectorRouteAdapter.tsx",
  "src/modules/inspector/panels/frequency-domain/modeCompositionInspectorDependencies.ts",
  "src/modules/inspector/panels/physics-first/PhysicsFirstResultInspectorPanel.tsx",
  "src/modules/inspector/panels/physics-first/PostprocessingResultInspectors.tsx",
  "src/modules/inspector/panels/physics-first/ResultsOverviewInspectorPanel.tsx",
  "src/modules/inspector/visualization/defaultPlanarSourceModel.ts",
] as const;

const FORBIDDEN_LEGACY_SHELL_SYMBOLS = [
  "InspectorShell",
  "InspectorFooter",
  "DedicatedExplorerInspectorPanels",
  "ModelTreeOverviewInspectorPanels",
  "DedicatedInspectorRouteFrame",
  "ScientificInspectorTemplate",
  "StageInspectorFrame",
  "AirboxInspectorIdentityFrame",
  "PhysicsFirstResultInspectorPanel",
] as const;

const TEMPLATE_INTERNAL_SEMANTIC_BUTTON_CLASSES = [
  "fm-inspector__commit-status",
  "fm-inspector__breadcrumb",
  "fm-inspector__id-chip",
  "fm-inspector-color-swatch",
] as const;

function getTemplateFiles(): string[] {
  return collectFiles(
    join(inspectorRoot, "template"),
    (_fullPath, name) =>
      /\.(?:ts|tsx)$/.test(name) && !isTestOrSupportFile(name),
  ).sort();
}

function getCanonicalSpecFiles(): string[] {
  const inspectorSpecs = collectFiles(inspectorRoot, (fullPath, name) => {
    if (!/\.(?:ts|tsx)$/.test(name) || isTestOrSupportFile(name)) {
      return false;
    }
    const rel = toPosixRelative(fullPath);
    return (
      /(?:Spec|Specs|SpecPanel)\.tsx$/.test(name) ||
      /^src\/modules\/inspector\/panels\/magnetic-texture\/MagneticTexture.*\.tsx$/.test(
        rel,
      ) ||
      /^src\/modules\/inspector\/panels\/transport\/.*Panels?\.tsx$/.test(rel)
    );
  });

  const startScreenSpec = join(
    srcRoot,
    "modules/start/inspector/StartScreenInspectorSpecs.tsx",
  );
  const all = existsSync(startScreenSpec)
    ? [...inspectorSpecs, startScreenSpec]
    : inspectorSpecs;

  return [...new Set(all)].sort();
}

function getPreviewFiles(): string[] {
  return collectFiles(
    join(inspectorRoot, "panels/magnetic-texture"),
    (_fullPath, name) =>
      /\.(?:ts|tsx)$/.test(name) && !isTestOrSupportFile(name),
  ).sort();
}

/**
 * Extracts opening native lowercase HTML/SVG tags (`<div ...>`, `<span ...>`, etc.)
 * while skipping nested `{ ... }` JSX expression bodies so props on child React
 * components (`prop={<InspectorGroup title="..." />}`) are not mistaken for
 * attributes on the outer lowercase HTML tag.
 */
function findNativeHtmlTitleAttributes(source: string): number[] {
  const cleaned = stripComments(source);
  const tagStartPattern = /<([a-z][a-z0-9-]*)\b/g;
  const hitLines: number[] = [];

  for (const match of cleaned.matchAll(tagStartPattern)) {
    const startIndex = match.index ?? 0;
    let cursor = startIndex + match[0].length;
    let braceDepth = 0;
    let quoteChar: string | null = null;
    let topLevelAttrs = "";

    while (cursor < cleaned.length) {
      const ch = cleaned[cursor]!;
      if (quoteChar !== null) {
        if (ch === "\\" && cursor + 1 < cleaned.length) {
          cursor += 2;
          continue;
        }
        if (ch === quoteChar) {
          quoteChar = null;
        }
        cursor += 1;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quoteChar = ch;
        cursor += 1;
        continue;
      }

      if (ch === "{") {
        braceDepth += 1;
        cursor += 1;
        continue;
      }

      if (ch === "}") {
        if (braceDepth > 0) braceDepth -= 1;
        cursor += 1;
        continue;
      }

      if (braceDepth === 0 && ch === ">") {
        break;
      }

      if (braceDepth === 0) {
        topLevelAttrs += ch;
      }
      cursor += 1;
    }

    if (/(?:^|\s)title\s*=/.test(topLevelAttrs)) {
      hitLines.push(lineNumberAt(cleaned, startIndex));
    }
  }

  return hitLines;
}

describe("Inspector permanent CI architecture guard", () => {
  it("keeps purged dead legacy inspector wrappers deleted and forbids legacy shell imports across canonical routes, template, and specs", () => {
    const resurrectedWrappers = PURGED_LEGACY_INSPECTOR_WRAPPERS.filter(
      (relPath) => existsSync(join(appRoot, relPath)),
    );
    expect(resurrectedWrappers).toEqual([]);

    const routePaths = DOMAIN_ROUTE_REGISTRIES.map((relPath) =>
      join(appRoot, relPath),
    );
    const guardedFiles = [
      ...routePaths,
      ...getTemplateFiles(),
      ...getCanonicalSpecFiles(),
    ];
    expect(guardedFiles.length).toBeGreaterThanOrEqual(50);

    const legacyImportOrSymbolPattern = new RegExp(
      `\\b(?:${FORBIDDEN_LEGACY_SHELL_SYMBOLS.join("|")})\\b`,
    );
    const violations: string[] = [];

    for (const filePath of guardedFiles) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      const match = cleaned.match(legacyImportOrSymbolPattern);
      if (match) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(`${toPosixRelative(filePath)}:${line} references ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero raw HTML <input>, <select>, <textarea>, and <button> tags in canonical spec and template files", () => {
    const templateFiles = getTemplateFiles();
    const specFiles = getCanonicalSpecFiles();
    const violations: string[] = [];

    for (const filePath of specFiles) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(/<(input|select|textarea|button)\b/g)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(
          `${toPosixRelative(filePath)}:${line} uses raw <${match[1]}> instead of @/shared/ui primitive`,
        );
      }
    }

    for (const filePath of templateFiles) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(/<(input|select|textarea)\b/g)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(
          `${toPosixRelative(filePath)}:${line} uses raw <${match[1]}> instead of @/shared/ui primitive`,
        );
      }

      for (const match of cleaned.matchAll(/<button\b[\s\S]*?>/g)) {
        const tagText = match[0];
        const isSemanticSlotTrigger = TEMPLATE_INTERNAL_SEMANTIC_BUTTON_CLASSES.some(
          (cls) => tagText.includes(cls),
        );
        if (!isSemanticSlotTrigger) {
          const line = lineNumberAt(cleaned, match.index ?? 0);
          violations.push(
            `${toPosixRelative(filePath)}:${line} uses unapproved raw <button> outside shared/ui`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero bare HTML title= attributes in canonical spec and template files", () => {
    const guardedFiles = [
      ...getTemplateFiles(),
      ...getCanonicalSpecFiles(),
      ...getPreviewFiles(),
    ];
    const violations: string[] = [];

    for (const filePath of [...new Set(guardedFiles)]) {
      const source = readFileSync(filePath, "utf8");
      for (const line of findNativeHtmlTitleAttributes(source)) {
        violations.push(
          `${toPosixRelative(filePath)}:${line} uses native HTML title= attribute instead of Radix Tooltip`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero sub-12px Tailwind arbitrary font-size classes in canonical spec, template, and preview files", () => {
    const guardedFiles = [
      ...getTemplateFiles(),
      ...getCanonicalSpecFiles(),
      ...getPreviewFiles(),
    ];
    const sub12pxPattern = /\btext-\[(?:[0-9]|1[01])(?:\.[0-9]+)?px\]/g;
    const violations: string[] = [];

    for (const filePath of [...new Set(guardedFiles)]) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(sub12pxPattern)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(
          `${toPosixRelative(filePath)}:${line} uses sub-12px class "${match[0]}"`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero hardcoded #hex color literals in canonical spec, template, and preview TS/TSX files", () => {
    const guardedFiles = [
      ...DOMAIN_ROUTE_REGISTRIES.map((relPath) => join(appRoot, relPath)),
      ...getTemplateFiles(),
      ...getCanonicalSpecFiles(),
      ...getPreviewFiles(),
    ];
    const hexColorPattern = /#[0-9a-fA-F]{3,8}\b/g;
    const violations: string[] = [];

    for (const filePath of [...new Set(guardedFiles)]) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(hexColorPattern)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(
          `${toPosixRelative(filePath)}:${line} hardcodes hex color "${match[0]}"`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero `as never` type escapes in canonical route, template, and spec files", () => {
    const guardedFiles = [
      ...DOMAIN_ROUTE_REGISTRIES.map((relPath) => join(appRoot, relPath)),
      ...getTemplateFiles(),
      ...getCanonicalSpecFiles(),
    ];
    const violations: string[] = [];

    for (const filePath of [...new Set(guardedFiles)]) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(/\bas\s+never\b/g)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(`${toPosixRelative(filePath)}:${line} uses \`as never\``);
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero `!important` overrides in inspector.css, inspector-widgets.css, and inspector-visualization.css", () => {
    const guardedStylesheets = [
      "inspector.css",
      "inspector-widgets.css",
      "inspector-visualization.css",
    ] as const;
    const violations: string[] = [];

    for (const fileName of guardedStylesheets) {
      const fullPath = join(stylesRoot, fileName);
      const cleaned = stripComments(readFileSync(fullPath, "utf8"));
      for (const match of cleaned.matchAll(/!important\b/g)) {
        const line = lineNumberAt(cleaned, match.index ?? 0);
        violations.push(`src/design/styles/${fileName}:${line} uses !important`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces zero user-facing \"unknown\" or \"unavailable\" fallback literals in canonical inspector headers and specs", () => {
    const guardedFiles = [...getTemplateFiles(), ...getCanonicalSpecFiles()];
    const literalPattern = /(["'`])(unknown|unavailable)\1/gi;
    const violations: string[] = [];

    for (const filePath of guardedFiles) {
      const cleaned = stripComments(readFileSync(filePath, "utf8"));
      for (const match of cleaned.matchAll(literalPattern)) {
        const idx = match.index ?? 0;
        const before = cleaned.slice(Math.max(0, idx - 60), idx);
        const after = cleaned.slice(
          idx + match[0].length,
          Math.min(cleaned.length, idx + match[0].length + 60),
        );

        // Allow schema/state equality checks (`x === "unavailable"`, `"unknown" !== x`),
        // `case "unavailable":` switch arms, and typed model discriminants (`lane: ... "unknown"`).
        const isSchemaEqualityComparison =
          /(?:===|!==|==|!=)\s*$/.test(before) || /^\s*(?:===|!==|==|!=)/.test(after);
        const isSwitchCase = /\bcase\s+$/.test(before) && /^\s*:/.test(after);
        const isInternalLaneUnion =
          /\blane:\s*fdmLane\s*\?\s*"fdm"\s*:\s*femLane\s*\?\s*"fem"\s*:\s*$/.test(
            before,
          );
        const isInternalDiscretizationDefault =
          /\binteractionDiscretization\s*===\s*"unknown"\b/.test(before);

        if (
          !isSchemaEqualityComparison &&
          !isSwitchCase &&
          !isInternalLaneUnion &&
          !isInternalDiscretizationDefault
        ) {
          const line = lineNumberAt(cleaned, idx);
          violations.push(
            `${toPosixRelative(filePath)}:${line} emits user-facing fallback literal ${match[0]}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps mesh.root, study.execution, and physics.spin-transport locked to session discretization with zero editable FEM/FDM switchers", () => {
    const meshRootSpec = stripComments(
      `${readFileSync(
        join(inspectorRoot, "inspectors/mesh/meshShared.ts"),
        "utf8",
      )}\n${readFileSync(
        join(inspectorRoot, "inspectors/mesh/MeshRootSpec.tsx"),
        "utf8",
      )}`,
    );
    expect(meshRootSpec).toContain("resolveSessionDiscretization");
    expect(meshRootSpec).toContain('label: "Session method"');
    expect(meshRootSpec).toContain('"Assigned by the session simulation mode"');
    expect(meshRootSpec).not.toMatch(/key:\s*["']lane["'][\s\S]{0,240}?type:\s*["']segmented["']/);
    expect(meshRootSpec).not.toMatch(/type:\s*["']segmented["'][\s\S]{0,240}?key:\s*["']lane["']/);
    expect(meshRootSpec).not.toContain("patchStudy(");

    const studyBranchSpec = stripComments(
      `${readFileSync(
        join(inspectorRoot, "inspectors/study/studyShared.ts"),
        "utf8",
      )}\n${readFileSync(
        join(inspectorRoot, "inspectors/study/StudyExecutionSpec.tsx"),
        "utf8",
      )}`,
    );
    expect(studyBranchSpec).toContain("resolveLockedSessionDiscretization");
    expect(studyBranchSpec).toContain('"Assigned by the session simulation mode"');
    expect(studyBranchSpec).not.toMatch(
      /key:\s*["']discretization["'][\s\S]{0,240}?type:\s*["']segmented["']/,
    );
    expect(studyBranchSpec).not.toMatch(
      /type:\s*["']segmented["'][\s\S]{0,240}?key:\s*["']discretization["']/,
    );
    expect(studyBranchSpec).not.toContain('aria-label="Backend override"');

    const spinTransportPanel = stripComments(
      readFileSync(
        join(inspectorRoot, "panels/transport/SpinTransportPanel.tsx"),
        "utf8",
      ),
    );
    expect(spinTransportPanel).toContain("session.sessionDiscretization");
    expect(spinTransportPanel).toContain('"Assigned by the session simulation mode"');
    expect(spinTransportPanel).not.toMatch(
      /key:\s*["']executionDiscretization["'][\s\S]{0,240}?type:\s*["']segmented["']/,
    );
    expect(spinTransportPanel).not.toMatch(
      /type:\s*["']segmented["'][\s\S]{0,240}?key:\s*["']executionDiscretization["']/,
    );
  });

  it("enforces Explorer-aligned modular inspector layout (shared/ + 7 branch dirs) and <= 950 LOC per modular file", () => {
    expect(existsSync(join(inspectorRoot, "shared/index.ts"))).toBe(true);
    const requiredBranches = [
      "definitions",
      "universe",
      "objects",
      "mesh",
      "study",
      "results",
      "visualizations",
    ] as const;

    for (const branch of requiredBranches) {
      expect(
        existsSync(join(inspectorRoot, "inspectors", branch, "index.ts")),
        `Missing Explorer-aligned inspector branch barrel: inspectors/${branch}/index.ts`,
      ).toBe(true);
    }

    const modularFiles = collectFiles(
      join(inspectorRoot, "inspectors"),
      (_fullPath, name) => /\.(?:ts|tsx)$/.test(name) && !isTestOrSupportFile(name),
    );
    expect(modularFiles.length).toBeGreaterThanOrEqual(100);

    const oversized: string[] = [];
    for (const filePath of modularFiles) {
      const lineCount = readFileSync(filePath, "utf8").split("\n").length;
      if (lineCount > 950) {
        oversized.push(`${toPosixRelative(filePath)} (${lineCount} LOC > 950)`);
      }
    }
    expect(oversized).toEqual([]);
  });
});
