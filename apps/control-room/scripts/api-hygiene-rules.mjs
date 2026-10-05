export const LEGACY_PATH_PATTERN = String.raw`/v1/live/current(?:/|["'])|\bbootstrap\b|\bpoll\b|["'][^"']*/preview(?:/|["'])`;

const CANONICAL_PREVIEW_SOURCE_PATH = "src/kernel/api/apiPaths.ts";
const CANONICAL_PREVIEW_DEFINITION =
  'export const PLATFORM_COMPUTE_PREVIEW_PATH = openApiV2Path("/v2/platform/compute/preview");';

export function isCanonicalComputePreviewMatchLine(line) {
  const match = /^(.+?):(\d+):(.*)$/u.exec(line);
  const pathOnlyMatch = match ? null : /^(.+?):(.*)$/u.exec(line);
  const sourcePathValue = match?.[1] ?? pathOnlyMatch?.[1];
  const sourceLine = match?.[3] ?? pathOnlyMatch?.[2];
  if (!sourcePathValue || sourceLine === undefined) return false;

  const sourcePath = sourcePathValue.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return (
    sourcePath === CANONICAL_PREVIEW_SOURCE_PATH &&
    sourceLine === CANONICAL_PREVIEW_DEFINITION
  );
}

export function filterCanonicalComputePreviewMatchLines(output) {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !isCanonicalComputePreviewMatchLine(line))
    .join("\n");
}

export function shouldFailSearchCheck(status, output, filterMatches) {
  if (status === 1) return false;
  if (status !== 0) return true;
  if (!output.trim()) return true;

  const reportedMatches = filterMatches ? filterMatches(output) : output;
  return reportedMatches.length > 0;
}
