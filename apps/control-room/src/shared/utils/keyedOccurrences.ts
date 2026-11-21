/** Preserve duplicates while keying each occurrence to its immutable content. */
export function keyedOccurrences<T>(
  items: readonly T[],
  identityOf: (item: T) => string,
): { item: T; key: string }[] {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const identity = identityOf(item);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { item, key: JSON.stringify([identity, occurrence]) };
  });
}
