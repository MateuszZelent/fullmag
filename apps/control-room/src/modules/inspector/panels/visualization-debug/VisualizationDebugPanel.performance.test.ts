import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

interface SourceFile {
  fileName: string;
  source: string;
}

const debugPanelDirectory = join(
  process.cwd(),
  "src/modules/inspector/panels/visualization-debug",
);

function collectProductionSources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectProductionSources(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [{
      fileName: relative(debugPanelDirectory, path),
      source: readFileSync(path, "utf8"),
    }];
  });
}

const forbiddenSourcePatterns = [
  ["direct field-vector facade", /(?:\.\s*data\s*\.\s*fields|\bfields)\s*\.\s*vector\b/],
  ["destructured field-vector facade", /\{[^{}]*\bvector(?:\s*:\s*\w+)?[^{}]*\}\s*=/],
  ["nested destructured field-vector facade", /\bfields\s*:\s*\{[^{}]*\bvector(?:\s*:\s*\w+)?/],
  ["field-vector resource hook", /\buse\w*FieldVector\w*\s*\(/],
  ["binary resource hook", /\buse\w*BinaryResource\w*\s*\(/],
  ["binary request", /\b(?:requestBinary\w*|requestFieldVectorOnDemand)\s*\(/],
  ["legacy live client", /\bgetLiveSessionClient\s*\(/],
  ["generated transport import", /(?:from\s*|import\s*\()\s*["'`][^"'`]*(?:kernel\/api\/generated|openapi-v2-client)/],
  ["direct fetch", /\bfetch\s*\(/],
  ["direct xhr", /\bXMLHttpRequest\b/],
  ["websocket or realtime client", /\b(?:WebSocket|EventSource|RealtimeClient)\b/],
  ["raw v2 endpoint", /["'`]\/v2\//],
  ["viewport internal import", /(?:from\s*|import\s*\()\s*["'`][^"'`]*(?:modules\/viewport-3d|(?:^|\/)viewport-3d)(?:\/[^"'`]*)?["'`]/m],
] as const;

function resourceFirstViolations(source: string): string[] {
  return forbiddenSourcePatterns.flatMap(([label, pattern]) =>
    pattern.test(source) ? [label] : [],
  );
}

const productionSources = collectProductionSources(debugPanelDirectory);

describe("Visualization Debug Inspector resource-first contracts", () => {
  it("checks every production source recursively and independently", () => {
    expect(productionSources.length).toBeGreaterThan(0);
    for (const file of productionSources) {
      expect(resourceFirstViolations(file.source), file.fileName).toEqual([]);
    }
  });

  it.each([
    ["direct facade", "api.data.fields.vector('m')", "direct field-vector facade"],
    ["spaced facade", "api . data . fields . vector('m')", "direct field-vector facade"],
    ["aliased fields facade", "const fields = api.data.fields; fields.vector('m')", "direct field-vector facade"],
    ["destructured alias", "const { vector: load } = api.data.fields; load('m')", "destructured field-vector facade"],
    ["destructured aliased facade", "const fields = api.data.fields; const { vector: load } = fields", "destructured field-vector facade"],
    ["nested destructuring", "const { data: { fields: { vector: load } } } = api", "nested destructured field-vector facade"],
    ["binary hook", "useFieldVectorBinaryResource()", "field-vector resource hook"],
    ["binary request", "requestBinaryResource(path)", "binary request"],
    ["live client", "getLiveSessionClient()", "legacy live client"],
    ["generated client", "import client from '@/kernel/api/generated/openapi-v2-client'", "generated transport import"],
    ["direct fetch", "globalThis.fet" + "ch('/resource')", "direct fetch"],
    ["websocket", "new globalThis.WebSocket(url)", "websocket or realtime client"],
    ["absolute viewport import", "import x from '@/modules/viewport-3d/model/x'", "viewport internal import"],
    ["relative viewport import", "import x from '../../../viewport-3d/model/x'", "viewport internal import"],
    ["dynamic viewport import", "import('../../../viewport-3d/model/x')", "viewport internal import"],
  ])("detects representative %s bypasses", (_name, source, violation) => {
    expect(resourceFirstViolations(source)).toContain(violation);
  });

  it("uses the approved Task 10 resource paths", () => {
    const sources = new Map(
      productionSources.map((file) => [file.fileName, file.source]),
    );
    expect(sources.get("useVisualizationDebugPanelModel.ts")).toContain(
      "useFieldMetaResource",
    );
    expect(sources.get("useVisualizationDebugPanelModel.ts")).toContain(
      "useVisualizationClientAcksResource",
    );
    expect(sources.get("VisualizationDebugPanelModel.ts")).toContain(
      "resolveFieldMetaResourceKey",
    );
  });
});
