import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("openapi-typescript/package.json");
const packageRoot = dirname(manifestPath);
const packageUrl = pathToFileURL(packageRoot + "/").href;

// TypeScript 7 remains the workspace typechecker. This generator still consumes
// the JavaScript compiler API, supplied by the already pinned compatibility package.
export function registerOpenApiCompilerApi() {
  const compilerPath = require.resolve("@typescript/typescript6");
  const compiler = require("@typescript/typescript6");
  if (typeof compiler.factory?.createKeywordTypeNode !== "function") {
    throw new Error("OpenAPI generation requires the pinned JavaScript compiler API.");
  }
  const compilerUrl = pathToFileURL(compilerPath).href;
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "typescript" && context.parentURL?.startsWith(packageUrl)) {
        return nextResolve(compilerUrl, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

async function runCli() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.bin?.["openapi-typescript"];
  if (typeof entry !== "string" || isAbsolute(entry) || entry.includes("..")) {
    throw new Error("OpenAPI generator must declare a relative CLI entrypoint.");
  }
  const hooks = registerOpenApiCompilerApi();
  try {
    // Keep the upstream CLI, flags, Redocly configuration and generated header.
    await import(pathToFileURL(resolve(packageRoot, entry)).href);
  } finally {
    hooks.deregister();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
