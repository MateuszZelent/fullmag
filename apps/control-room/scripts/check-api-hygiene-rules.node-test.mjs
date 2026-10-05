import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCanonicalComputePreviewMatchLines,
  isCanonicalComputePreviewMatchLine,
  LEGACY_PATH_PATTERN,
  shouldFailSearchCheck,
} from "./api-hygiene-rules.mjs";

const legacyPathPattern = new RegExp(LEGACY_PATH_PATTERN, "iu");
const canonicalDefinition =
  'export const PLATFORM_COMPUTE_PREVIEW_PATH = openApiV2Path("/v2/platform/compute/preview");';

test("allows only the exact canonical compute preview definition", () => {
  const unixRecord = `src/kernel/api/apiPaths.ts:1157:${canonicalDefinition}`;
  const windowsRecord = `src\\kernel\\api\\apiPaths.ts:1157:${canonicalDefinition}`;
  const windowsPathOnlyRecord =
    `src\\kernel\\api\\apiPaths.ts:${canonicalDefinition}`;

  assert.ok(legacyPathPattern.test(unixRecord));
  assert.ok(isCanonicalComputePreviewMatchLine(unixRecord));
  assert.ok(isCanonicalComputePreviewMatchLine(windowsRecord));
  assert.ok(isCanonicalComputePreviewMatchLine(windowsPathOnlyRecord));
  assert.equal(filterCanonicalComputePreviewMatchLines(unixRecord), "");
  assert.equal(filterCanonicalComputePreviewMatchLines(windowsRecord), "");
  assert.equal(filterCanonicalComputePreviewMatchLines(windowsPathOnlyRecord), "");
  assert.equal(
    shouldFailSearchCheck(0, unixRecord, filterCanonicalComputePreviewMatchLines),
    false,
  );
});

test("keeps legacy, misplaced, changed, and expanded preview matches blocked", () => {
  const deniedRecords = [
    'src/kernel/api/apiPaths.ts:12:const legacy = "/v1/live/current/preview";',
    "src/kernel/api/apiPaths.ts:13:const value = bootstrap();",
    "src/kernel/api/apiPaths.ts:14:function poll() {}",
    `src/kernel/api/otherPaths.ts:15:${canonicalDefinition}`,
    'src/kernel/api/apiPaths.ts:16:export const OTHER_PREVIEW_PATH = ' +
      'openApiV2Path("/v2/platform/compute/preview");',
    `src/kernel/api/apiPaths.ts:17:${canonicalDefinition} // trailing comment`,
    'src/kernel/api/apiPaths.ts:18:export const LEGACY_QUANTITY_PREVIEW_PATH = ' +
      'openApiV2Path("/v2/sessions/current/quantities/preview");',
    `src/modules/results/quantityPreview.ts:19:${canonicalDefinition}`,
  ];

  for (const record of deniedRecords) {
    assert.ok(
      legacyPathPattern.test(record),
      `expected the legacy scan to catch: ${record}`,
    );
    assert.equal(isCanonicalComputePreviewMatchLine(record), false);
    assert.equal(filterCanonicalComputePreviewMatchLines(record), record);
  }
});

test("an allowed definition does not hide a neighboring legacy match", () => {
  assert.equal(shouldFailSearchCheck(0, "", undefined), true);
  assert.equal(
    shouldFailSearchCheck(0, "", filterCanonicalComputePreviewMatchLines),
    true,
  );
  const legacyRecord =
    'src/kernel/api/apiPaths.ts:12:const legacy = "/v1/live/current/preview";';
  const matches = [
    `src/kernel/api/apiPaths.ts:1157:${canonicalDefinition}`,
    legacyRecord,
  ].join("\n");

  assert.equal(filterCanonicalComputePreviewMatchLines(matches), legacyRecord);
  assert.equal(
    shouldFailSearchCheck(0, matches, filterCanonicalComputePreviewMatchLines),
    true,
  );
  assert.equal(
    shouldFailSearchCheck(1, "", filterCanonicalComputePreviewMatchLines),
    false,
  );
  assert.equal(
    shouldFailSearchCheck(2, "", filterCanonicalComputePreviewMatchLines),
    true,
  );
});
