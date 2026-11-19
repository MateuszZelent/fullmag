/**
 * Default display names for newly authored scene objects.
 *
 * A region falls back to its object's name, and the geometry validator rejects
 * two visible objects whose region names match case-insensitively. New
 * primitives therefore get the first free name in the "New sphere",
 * "New sphere 2", ... sequence. The name is presentation only; `object_id`
 * stays the identity.
 */

/** Default name base for a primitive draft selection (`geometry:draft:<identity>`). */
export function primitiveDraftBaseName(draftNodeId: string | null | undefined): string {
  const identity = draftNodeId?.split(":").at(-1);
  if (identity === "thin-film") return "New thin film";
  return identity === "cylinder" || identity === "sphere" ? `New ${identity}` : "New box";
}

function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

function recordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Names and region names already used by objects in a SceneDocument payload. */
export function sceneObjectNameKeys(scene: unknown): Set<string> {
  const keys = new Set<string>();
  const objects =
    scene && typeof scene === "object" && !Array.isArray(scene)
      ? (scene as { objects?: unknown }).objects
      : undefined;
  if (!Array.isArray(objects)) return keys;
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const record = object as Record<string, unknown>;
    for (const value of [recordString(record, "name"), recordString(record, "region_name")]) {
      if (value !== null) keys.add(nameKey(value));
    }
  }
  return keys;
}

/** First name in `base`, `base 2`, `base 3`, ... not taken by the scene. */
export function uniqueObjectName(base: string, scene: unknown): string {
  const taken = sceneObjectNameKeys(scene);
  if (!taken.has(nameKey(base))) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/** True when `name` is `base` or `base N` as produced by {@link uniqueObjectName}. */
export function isDefaultObjectName(name: string, base: string): boolean {
  const trimmed = name.trim();
  if (trimmed === base) return true;
  if (!trimmed.startsWith(`${base} `)) return false;
  return /^[1-9]\d*$/.test(trimmed.slice(base.length + 1));
}

/**
 * Keep a draft's name unless it is a generated default that the scene took in
 * the meantime; then pick the next free default. Names the user typed are kept
 * as they are, so the validator still reports a deliberate duplicate.
 */
export function resolveDraftObjectName(draftName: string, base: string, scene: unknown): string {
  if (!isDefaultObjectName(draftName, base)) return draftName;
  return sceneObjectNameKeys(scene).has(nameKey(draftName))
    ? uniqueObjectName(base, scene)
    : draftName;
}
