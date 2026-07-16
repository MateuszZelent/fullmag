import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface SourceFile {
  fileName: string;
  source: string;
}

const V2_PREFIX = "/" + "v2/";

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

function resourceFirstViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "visualization-debug-source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations = new Set<string>();
  const dataAliases = new Set<string>();
  const fieldAliases = new Set<string>();
  const vectorAliases = new Set<string>();
  const forbiddenCallAliases = new Map<string, string>();

  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const propertyName = (expression: ts.Expression): string | null => {
    const current = unwrap(expression);
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (ts.isElementAccessExpression(current)) {
      const argument = current.argumentExpression
        ? unwrap(current.argumentExpression)
        : null;
      return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
    }
    if (ts.isIdentifier(current)) return current.text;
    return null;
  };
  const receiver = (expression: ts.Expression): ts.Expression | null => {
    const current = unwrap(expression);
    return ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
      ? current.expression
      : null;
  };
  const path = (expression: ts.Expression): string[] => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return [current.text];
    const parent = receiver(current);
    const name = propertyName(current);
    return parent && name ? [...path(parent), name] : [];
  };
  const endsWith = (values: readonly string[], suffix: readonly string[]) =>
    suffix.every((value, index) => values[values.length - suffix.length + index] === value);
  const expressionKind = (
    expression: ts.Expression,
  ): "data" | "fields" | "vector" | null => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      if (vectorAliases.has(current.text)) return "vector";
      if (fieldAliases.has(current.text)) return "fields";
      if (dataAliases.has(current.text)) return "data";
    }
    const segments = path(current);
    if (endsWith(segments, ["data", "fields", "vector"])) return "vector";
    if (endsWith(segments, ["data", "fields"])) return "fields";
    if (endsWith(segments, ["data"])) return "data";
    const parent = receiver(current);
    const name = propertyName(current);
    if (parent && name === "fields" && expressionKind(parent) === "data") {
      return "fields";
    }
    if (parent && name === "vector" && expressionKind(parent) === "fields") {
      return "vector";
    }
    return null;
  };
  const bindName = (
    name: ts.BindingName,
    kind: "data" | "fields" | "vector" | null,
  ): boolean => {
    let changed = false;
    if (ts.isIdentifier(name)) {
      const target = kind === "data"
        ? dataAliases
        : kind === "fields"
          ? fieldAliases
          : kind === "vector"
            ? vectorAliases
            : null;
      if (target && !target.has(name.text)) {
        target.add(name.text);
        changed = true;
      }
      if (kind === "vector") {
        violations.add("destructured field-vector facade");
      }
      return changed;
    }
    if (!ts.isObjectBindingPattern(name)) return false;
    for (const element of name.elements) {
      if (element.dotDotDotToken) continue;
      const key = element.propertyName
        ? (ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteralLike(element.propertyName)
            ? element.propertyName.text
            : ts.isComputedPropertyName(element.propertyName) &&
                ts.isStringLiteralLike(element.propertyName.expression)
              ? element.propertyName.expression.text
            : null)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      const childKind = key === "data"
        ? "data"
        : key === "fields" && (kind === "data" || kind === null)
          ? "fields"
          : key === "vector" && kind === "fields"
            ? "vector"
            : null;
      changed = bindName(element.name, childKind) || changed;
    }
    return changed;
  };

  const declarations: ts.VariableDeclaration[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      changed = bindName(
        declaration.name,
        expressionKind(declaration.initializer),
      ) || changed;
    }
  }

  const moduleViolation = (specifier: string): void => {
    if (/kernel\/api\/generated|openapi-v2-client/.test(specifier)) {
      violations.add("generated transport import");
    }
    if (/(?:modules\/viewport-3d|(?:^|\/)viewport-3d)(?:\/|$)/.test(specifier)) {
      violations.add("viewport internal import");
    }
  };
  const inspect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        moduleViolation(specifier.text);
      }
      if (ts.isImportDeclaration(node) && node.importClause) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            const localName = element.name.text;
            const label = importedName === "getLiveSessionClient"
              ? "legacy live client"
              : /^use\w*FieldVector\w*$/.test(importedName)
                ? "field-vector resource hook"
                : /^use\w*BinaryResource\w*$/.test(importedName)
                  ? "binary resource hook"
                  : /^(?:requestBinary\w*|requestFieldVectorOnDemand)$/.test(importedName)
                    ? "binary request"
                    : null;
            if (label) {
              violations.add(label);
              forbiddenCallAliases.set(localName, label);
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        moduleViolation(node.arguments[0].text);
      }
      if (expressionKind(node.expression) === "vector") {
        violations.add("field-vector facade call");
        violations.add("direct field-vector facade");
      }
      const name = propertyName(node.expression);
      if (name && forbiddenCallAliases.has(name)) {
        violations.add(forbiddenCallAliases.get(name)!);
      }
      if (name && vectorAliases.has(name)) {
        violations.add("field-vector facade call");
      }
      if (name && /^use\w*FieldVector\w*$/.test(name)) {
        violations.add("field-vector resource hook");
      }
      if (name && /^use\w*BinaryResource\w*$/.test(name)) {
        violations.add("binary resource hook");
      }
      if (name && /^(?:requestBinary\w*|requestFieldVectorOnDemand)$/.test(name)) {
        violations.add("binary request");
      }
      if (name === "getLiveSessionClient") violations.add("legacy live client");
      if (name === "fetch") violations.add("direct fetch");
    }
    if (ts.isNewExpression(node)) {
      const name = propertyName(node.expression);
      if (name === "XMLHttpRequest") violations.add("direct xhr");
      if (name && /^(?:WebSocket|EventSource|RealtimeClient)$/.test(name)) {
        violations.add("websocket or realtime client");
      }
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.startsWith(V2_PREFIX)
    ) {
      violations.add("raw v2 endpoint");
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return [...violations];
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
    ["parent-destructured fields alias", "const { fields: fieldApi } = api.data; fieldApi.vector('m')", "field-vector facade call"],
    ["parent-destructured bracket fields alias", "const { ['fields']: fieldApi } = api['data']; fieldApi['vector']('m')", "field-vector facade call"],
    ["chained data and fields aliases", "const dataApi = api.data; const fieldApi = dataApi.fields; fieldApi.vector('m')", "field-vector facade call"],
    ["bracket field-vector access", "api['data']['fields']['vector']('m')", "field-vector facade call"],
    ["aliased bracket field-vector access", "const fieldApi = api.data['fields']; fieldApi['vector']('m')", "field-vector facade call"],
    ["nested destructuring", "const { data: { fields: { vector: load } } } = api", "destructured field-vector facade"],
    ["binary hook", "useFieldVectorBinaryResource()", "field-vector resource hook"],
    ["binary request", "requestBinaryResource(path)", "binary request"],
    ["live client", "getLiveSessionClient()", "legacy live client"],
    ["generated client", "import client from '@/kernel/api/generated/openapi-v2-client'", "generated transport import"],
    ["aliased live import", "import { getLiveSessionClient as live } from '@/kernel/api/live'; live()", "legacy live client"],
    ["aliased binary import", "import { requestBinaryResource as load } from '@/kernel/api/client'; load()", "binary request"],
    ["direct fetch", "globalThis.fet" + "ch('/resource')", "direct fetch"],
    ["raw v2 endpoint", '"' + "/" + "v2/sessions/current/data" + '"', "raw v2 endpoint"],
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
