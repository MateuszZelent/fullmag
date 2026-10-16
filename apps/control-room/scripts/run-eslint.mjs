import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function runEslintCli() {
  const compilerPath = require.resolve("@typescript/typescript6");
  const compiler = require("@typescript/typescript6");
  if (
    typeof compiler.createProgram !== "function" ||
    typeof compiler.Extension?.Cjs !== "string"
  ) {
    throw new Error("ESLint requires the pinned JavaScript TypeScript compiler API.");
  }

  const manifestPath = require.resolve("eslint/package.json");
  const packageRoot = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.eslint;
  if (
    typeof entry !== "string" ||
    isAbsolute(entry) ||
    entry.split(/[\\/]/).includes("..")
  ) {
    throw new Error("ESLint must declare a relative CLI entrypoint.");
  }

  // Scope the compatibility compiler to this lint process. The normal workspace
  // typecheck command continues to resolve the pinned TypeScript 7 CLI.
  const compilerUrl = pathToFileURL(compilerPath).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === "typescript" ? compilerUrl : specifier, context);
    },
  });
  // ESLint's CommonJS CLI starts asynchronous work before its module import
  // returns, so retain the hook through config/parser loading until process exit.
  process.once("exit", () => hooks.deregister());
  await import(pathToFileURL(resolve(packageRoot, entry)).href);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runEslintCli();
}
