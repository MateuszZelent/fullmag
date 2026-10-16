/** The immutable revision of a ready, published frequency-domain artifact envelope. */
export function publishedFrequencyDomainArtifactRevision(
  resource: { revision?: unknown; status?: unknown } | null | undefined,
): string | null {
  if (resource?.status !== "ready") return null;
  const revision = resource.revision;
  return typeof revision === "string" &&
    revision.trim().length > 0 &&
    revision !== "unknown"
    ? revision
    : null;
}
