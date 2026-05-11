import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const viewportRoot = path.join(appRoot, "src/modules/viewport-3d");
const viewportModule = readFileSync(
  path.join(viewportRoot, "Viewport3DModule.tsx"),
  "utf8",
);
const viewportTypes = readFileSync(
  path.join(viewportRoot, "viewport3dTypes.ts"),
  "utf8",
);

const failures = [];

if (!viewportTypes.includes('VIEWPORT_3D_FRAMELOOP = "demand"')) {
  failures.push("viewport3dTypes must export VIEWPORT_3D_FRAMELOOP = \"demand\".");
}

if (!viewportModule.includes("frameloop={VIEWPORT_3D_FRAMELOOP}")) {
  failures.push("Viewport3DModule must wire Canvas frameloop to VIEWPORT_3D_FRAMELOOP.");
}

for (const filePath of listSourceFiles(viewportRoot)) {
  const content = readFileSync(filePath, "utf8");
  const relativePath = path.relative(viewportRoot, filePath);
  if (content.includes("requestAnimationFrame(")) {
    failures.push(`${relativePath} uses requestAnimationFrame().`);
  }
  if (content.includes("setInterval(")) {
    failures.push(`${relativePath} uses setInterval().`);
  }
  if (content.includes('frameloop="always"')) {
    failures.push(`${relativePath} configures an always-on R3F frameloop.`);
  }
}

if (failures.length > 0) {
  console.error(`Idle performance audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("Idle performance audit passed.");

function listSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(filePath));
      continue;
    }

    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(filePath);
    }
  }
  return files;
}
