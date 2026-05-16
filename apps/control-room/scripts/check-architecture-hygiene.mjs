import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "../..");
const srcRoot = path.join(appRoot, "src");
const failures = [];

checkKernelModuleImports();
checkCrossModuleImports();
checkRibbonCommandModel();
checkAppMenuSlot();
checkLegacyWebPathGovernance();
checkRawHexOutsideDesignTokens();

if (failures.length > 0) {
  console.error(`Architecture hygiene check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("Architecture hygiene check passed.");

function checkKernelModuleImports() {
  const kernelRoot = path.join(srcRoot, "kernel");
  for (const filePath of listSourceFiles(kernelRoot)) {
    const relativePath = relativeAppPath(filePath);
    const content = readFileSync(filePath, "utf8");
    const imports = collectImports(content);
    for (const source of imports) {
      const allowedModuleRegistryImport =
        relativePath === "src/kernel/KernelProvider.tsx" &&
        source === "@/modules";
      if (allowedModuleRegistryImport) continue;

      if (source.startsWith("@/modules/") || source.includes("/modules/")) {
        failures.push(
          `${relativePath} imports module internals through "${source}".`,
        );
      }
      if (source.startsWith("../modules") || source.startsWith("../../modules")) {
        failures.push(
          `${relativePath} imports module internals through "${source}".`,
        );
      }
    }
  }
}

function checkCrossModuleImports() {
  const modulesRoot = path.join(srcRoot, "modules");
  for (const filePath of listSourceFiles(modulesRoot)) {
    const relativePath = relativeAppPath(filePath);
    const moduleId = path.relative(modulesRoot, filePath).split(path.sep)[0];
    if (!moduleId || moduleId === "index.ts") continue;

    const content = readFileSync(filePath, "utf8");
    for (const source of collectImports(content)) {
      const absoluteModuleImport = source.match(/^@\/modules\/([^/]+)/);
      if (absoluteModuleImport && absoluteModuleImport[1] !== moduleId) {
        failures.push(
          `${relativePath} imports sibling module "${absoluteModuleImport[1]}" through "${source}".`,
        );
      }

      if (source.startsWith("../")) {
        const resolved = path.resolve(path.dirname(filePath), source);
        if (resolved.startsWith(modulesRoot)) {
          const targetModuleId = path.relative(modulesRoot, resolved).split(path.sep)[0];
          if (targetModuleId && targetModuleId !== moduleId) {
            failures.push(
              `${relativePath} imports sibling module "${targetModuleId}" through "${source}".`,
            );
          }
        }
      }
    }
  }
}

function checkRibbonCommandModel() {
  const ribbonTypes = readIfExists(
    path.join(srcRoot, "modules/ribbon/ribbonTypes.ts"),
  );
  const ribbonContributions = readIfExists(
    path.join(srcRoot, "modules/ribbon/ribbonContributions.tsx"),
  );

  if (/\bon(?:Select|CheckedChange|ValueChange)\?:/.test(ribbonTypes)) {
    failures.push("ribbonTypes.ts exposes mutating menu callbacks.");
  }

  const callbackMatches = ribbonContributions.match(
    /\bon(?:Select|CheckedChange|ValueChange):/g,
  );
  if (callbackMatches?.length) {
    failures.push(
      `ribbonContributions.tsx defines ${callbackMatches.length} mutating menu callbacks instead of command ids.`,
    );
  }
}

function checkAppMenuSlot() {
  const shellPath = path.join(srcRoot, "kernel/layout/WorkspaceShell.tsx");
  const shell = readIfExists(shellPath);
  if (shell.includes("<AppMenuBar") || shell.includes("AppMenuBar")) {
    failures.push("WorkspaceShell hardcodes AppMenuBar instead of the app-menu slot.");
  }
  if (!shell.includes('slotId="app-menu"')) {
    failures.push("WorkspaceShell does not host the app-menu slot.");
  }

  const manifestPath = path.join(srcRoot, "modules/app-menu/manifest.ts");
  if (!existsSync(manifestPath)) {
    failures.push("app-menu module manifest is missing.");
  }
}

function checkLegacyWebPathGovernance() {
  const legacyPathPattern = /apps\/web/g;
  const activeFiles = [
    "AGENTS.md",
    "package.json",
    ".github/workflows/bootstrap.yml",
    "scripts/dev-control-room.sh",
    "scripts/stop-control-room.sh",
    "scripts/build_desktop_linux_container.sh",
    "scripts/windows/build_windows_msi.ps1",
  ];

  for (const relativePath of activeFiles) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, "utf8");
    if (legacyPathPattern.test(content)) {
      failures.push(`${relativePath} still references apps/web.`);
    }
  }
}

function checkRawHexOutsideDesignTokens() {
  const rawColorPattern = /#[0-9a-fA-F]{3,8}\b/g;
  for (const filePath of listSourceFiles(srcRoot)) {
    const relativePath = relativeAppPath(filePath);
    if (
      relativePath.startsWith("src/design/styles/") ||
      relativePath.startsWith("src/kernel/api/generated/")
    ) {
      continue;
    }

    const matches = readFileSync(filePath, "utf8").match(rawColorPattern);
    if (matches?.length) {
      failures.push(
        `${relativePath} contains raw hex colors outside design tokens: ${[
          ...new Set(matches),
        ].join(", ")}.`,
      );
    }
  }
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function relativeAppPath(filePath) {
  return path.relative(appRoot, filePath).split(path.sep).join("/");
}

function collectImports(content) {
  const imports = [];
  const importPattern =
    /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(importPattern)) {
    imports.push(match[1] ?? match[2]);
  }
  return imports;
}

function listSourceFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...listSourceFiles(filePath));
      continue;
    }

    const isTestFile =
      entry.name.includes(".test.") || entry.name.includes(".spec.");
    if (!isTestFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(filePath);
    }
  }
  return files;
}
