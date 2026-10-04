import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const controlRoomDirectory = dirname(scriptDirectory);
const managedNodeModulesRoot =
  process.env.FULLMAG_TEST_NODE_MODULES_ROOT ?? process.argv[2];

if (!managedNodeModulesRoot) {
  throw new Error(
    "Set FULLMAG_TEST_NODE_MODULES_ROOT to the managed frontend node_modules directory.",
  );
}

const requireFromManagedNodeModules = createRequire(
  join(resolve(managedNodeModulesRoot), "fullmag-tailwind-source-test.cjs"),
);
const tailwindPostcssModule = requireFromManagedNodeModules("@tailwindcss/postcss");
const tailwindPostcss = tailwindPostcssModule.default ?? tailwindPostcssModule;
const requireFromTailwindPostcss = createRequire(
  requireFromManagedNodeModules.resolve("@tailwindcss/postcss"),
);
const postcss = requireFromTailwindPostcss("postcss");
const managedTailwindPackageRoot = dirname(
  requireFromManagedNodeModules.resolve("tailwindcss/package.json"),
);
const TAILWIND_PACKAGE_FILES = [
  "index.css",
  "package.json",
  "preflight.css",
  "theme.css",
  "utilities.css",
];

test("production Tailwind sources include app/src and exclude external build cache", async () => {
  const productionGlobalsCss = await readFile(
    join(controlRoomDirectory, "app", "globals.css"),
    "utf8",
  );
  const productionDirectives = productionGlobalsCss
    .split(/\r?\n/)
    .filter((line) =>
      line.startsWith('@import "tailwindcss"') || line.startsWith("@source "),
    );
  assert.deepEqual(productionDirectives, [
    '@import "tailwindcss" source(none);',
    '@source "./";',
    '@source "../src";',
  ]);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "fullmag-tailwind-sources-"));
  try {
    const scopedRoot = join(fixtureRoot, "scoped");
    const scopedWithCacheRoot = join(fixtureRoot, "scoped-with-cache");
    const unscopedRoot = join(fixtureRoot, "unscoped-negative-control");
    const scopedCss = productionDirectives.join("\n");

    const scopedFixture = await createFixture(scopedRoot, scopedCss, false);
    const cachedFixture = await createFixture(scopedWithCacheRoot, scopedCss, true);
    const unscopedFixture = await createFixture(
      unscopedRoot,
      '@import "tailwindcss";',
      true,
    );

    const scopedCssOutput = await compileFixture(scopedFixture);
    const cachedCssOutput = await compileFixture(cachedFixture);
    const unscopedCssOutput = await compileFixture(unscopedFixture);

    for (const className of ["grid", "gap-4", "bg-red-500"]) {
      assert.ok(
        hasClassSelector(scopedCssOutput, className),
        `app utility ${className} should be emitted`,
      );
    }
    for (const className of ["flex", "items-center", "rounded-lg", "p-3"]) {
      assert.ok(
        hasClassSelector(scopedCssOutput, className),
        `src utility ${className} should be emitted`,
      );
    }

    assert.equal(
      cachedCssOutput,
      scopedCssOutput,
      "adding a Tailwind class under external storage/builds must not change production CSS",
    );
    assert.doesNotMatch(scopedCssOutput, /min-height:\s*777px/);
    assert.match(
      unscopedCssOutput,
      /min-height:\s*777px/,
      "the negative control confirms the external fixture is discoverable without an explicit source boundary",
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

async function createFixture(projectRoot, globalsCss, includeExternalCache) {
  const appDirectory = join(projectRoot, "apps", "control-room", "app");
  const controlRoomNodeModules = join(
    projectRoot,
    "apps",
    "control-room",
    "node_modules",
    "tailwindcss",
  );
  const sourceDirectory = join(projectRoot, "apps", "control-room", "src");
  await mkdir(appDirectory, { recursive: true });
  await mkdir(controlRoomNodeModules, { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all(
    TAILWIND_PACKAGE_FILES.map((fileName) =>
      copyFile(
        join(managedTailwindPackageRoot, fileName),
        join(controlRoomNodeModules, fileName),
      ),
    ),
  );

  const cssPath = join(appDirectory, "globals.css");
  await writeFile(cssPath, `${globalsCss}\n`);
  await writeFile(
    join(appDirectory, "page.tsx"),
    '<main className="grid gap-4 bg-red-500">app source</main>\n',
  );
  await writeFile(
    join(sourceDirectory, "Widget.tsx"),
    '<button className="flex items-center rounded-lg p-3">src source</button>\n',
  );

  if (includeExternalCache) {
    const cachePath = join(
      projectRoot,
      "storage",
      "builds",
      "external-cache",
      "workspace",
      "apps",
      "control-room",
      "app",
      "cached-page.jsx",
    );
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      '<main className="min-h-[777px]">external cache</main>\n',
    );
  }

  return { cssPath, projectRoot };
}

async function compileFixture({ cssPath, projectRoot }) {
  const input = await readFile(cssPath, "utf8");
  const result = await postcss([tailwindPostcss({ base: projectRoot })]).process(
    input,
    { from: cssPath, map: false },
  );
  return result.css;
}

function hasClassSelector(css, className) {
  return new RegExp(`\\.${className}(?:\\s|\\{)`).test(css);
}
