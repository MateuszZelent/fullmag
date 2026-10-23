/** Draft fields are raw strings, including deliberately opaque JSON textareas. */
export function reconcileSpinAuthoringDraft<T extends object>(incoming: T, local: T, baseline: T): { draft: T; conflicts: string[] } {
  const draft = { ...local };
  const conflicts: string[] = [];
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (Object.is(local[key], baseline[key])) draft[key] = incoming[key];
    else if (!Object.is(incoming[key], baseline[key]) && !Object.is(local[key], incoming[key])) conflicts.push(String(key));
  }
  return { draft, conflicts };
}
