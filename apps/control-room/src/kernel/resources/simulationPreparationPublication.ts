export function preparationPublicationState(
  publishedRevision: number | null | undefined,
  requiredRevision: number | null,
): "absent" | "published" | "unknown" {
  if (publishedRevision === undefined) return "unknown";
  if (publishedRevision !== null &&
      (!Number.isFinite(publishedRevision) || publishedRevision < 0)) return "unknown";
  if ((publishedRevision ?? 0) > 0 || (requiredRevision ?? 0) > 0) return "published";
  return "absent";
}

export function preparationMinimumRevision(
  publishedRevision: number | null | undefined,
  requiredRevision: number | null,
): number | null {
  return preparationPublicationState(publishedRevision, requiredRevision) === "published"
    ? Math.max(publishedRevision ?? 0, requiredRevision ?? 0)
    : null;
}

export function preparationRetryKey(resourceKey: string, minimumRevision: number | null): string | null {
  return minimumRevision === null ? null : `${resourceKey}\u0000${minimumRevision}`;
}
