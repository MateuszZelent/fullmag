/**
 * Visits items in order and waits for each operation before starting the next.
 * Use for operations that share mutable state, such as one browser page.
 */
export function visitSequentially(items, visit) {
  return items.reduce(
    (pending, item, index) => pending.then(() => visit(item, index)),
    Promise.resolve(),
  );
}
