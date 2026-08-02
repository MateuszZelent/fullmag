import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { createSourceFile, forEachChild, isCallExpression, isExportDeclaration, isImportDeclaration, isStringLiteral, ScriptKind, ScriptTarget, SyntaxKind } from "typescript";

const appSourceRoot = resolve(process.cwd(), "src");
const sharedRoots = [
  join(appSourceRoot, "shared/analysis-charts"),
  join(appSourceRoot, "shared/domain/analysis"),
];

describe("shared analysis import boundary", () => {
  it("detects static, re-export, dynamic, alias, and relative module imports", () => {
    const file = join(appSourceRoot, "shared/analysis-charts/fixture.ts");
    expect(moduleImportSpecifiers(file, [
      'import value from "@/modules/analysis-plots";',
      'export { value } from "../../modules/analysis-plots";',
      'const module = import("@/modules/live-charts");',
      'import value from "@/shared/analysis-charts";',
    ].join("\n"))).toEqual([
      "@/modules/analysis-plots",
      "../../modules/analysis-plots",
      "@/modules/live-charts",
    ]);
  });

  it("keeps every shared analysis source file independent from modules", () => {
    const violations = sharedRoots.flatMap((root) => sourceFiles(root).flatMap((file) =>
      moduleImportSpecifiers(file, readFileSync(file, "utf8")).map((specifier) =>
        `${relative(appSourceRoot, file)} -> ${specifier}`,
      ),
    ));
    expect(violations).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function moduleImportSpecifiers(fileName: string, source: string): string[] {
  const sourceFile = createSourceFile(fileName, source, ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS);
  const specifiers: string[] = [];
  const visit = (node: import("typescript").Node) => {
    const specifier = isImportDeclaration(node) || isExportDeclaration(node)
      ? node.moduleSpecifier
      : isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
        ? node.arguments[0]
        : undefined;
    if (specifier && isStringLiteral(specifier) && pointsToModules(fileName, specifier.text)) {
      specifiers.push(specifier.text);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function pointsToModules(fileName: string, specifier: string): boolean {
  if (specifier.startsWith("@/")) return specifier.startsWith("@/modules/");
  return specifier.startsWith(".") && resolve(fileName, "..", specifier).startsWith(join(appSourceRoot, "modules"));
}
