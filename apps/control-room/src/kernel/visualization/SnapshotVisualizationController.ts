export const MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS = 128;
export const MAX_SNAPSHOT_VISUALIZATION_PALETTE_LENGTH = 128;

const SNAPSHOT_VISUALIZATION_COMPONENTS = [
  "x",
  "y",
  "z",
  "magnitude",
] as const;
const SNAPSHOT_VISUALIZATION_RANGE_MODES = [
  "auto",
  "manual",
  "symmetric",
] as const;
const SNAPSHOT_VISUALIZATION_APPEARANCE_KEYS = [
  "component",
  "palette",
  "visible",
  "rangeMode",
  "min",
  "max",
] as const;

export type SnapshotVisualizationComponent =
  (typeof SNAPSHOT_VISUALIZATION_COMPONENTS)[number];
export type SnapshotVisualizationRangeMode =
  (typeof SNAPSHOT_VISUALIZATION_RANGE_MODES)[number];

export interface SnapshotVisualizationIdentity {
  readonly runId: string;
  readonly stageId: string;
  readonly datasetId: string;
  readonly quantityId: string;
  readonly sampleIndex: number;
  readonly revision: string;
}

export interface SnapshotVisualizationAppearance {
  readonly component: SnapshotVisualizationComponent;
  readonly palette: string;
  readonly visible: boolean;
  readonly rangeMode: SnapshotVisualizationRangeMode;
  readonly min: number | null;
  readonly max: number | null;
}

export type SnapshotVisualizationAppearancePatch = Partial<
  SnapshotVisualizationAppearance
>;

export interface SnapshotVisualizationDefinition {
  readonly identity: SnapshotVisualizationIdentity;
  readonly appearance: SnapshotVisualizationAppearance;
}

export interface SnapshotVisualizationState {
  readonly activeKey: string | null;
  readonly definitions: Readonly<
    Record<string, SnapshotVisualizationDefinition>
  >;
}

export const DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE: SnapshotVisualizationAppearance =
  Object.freeze({
    component: "z",
    palette: "coolwarm",
    visible: true,
    rangeMode: "auto",
    min: null,
    max: null,
  } as const);

const EMPTY_DEFINITIONS: Readonly<
  Record<string, SnapshotVisualizationDefinition>
> = Object.freeze({});
const INITIAL_SNAPSHOT: SnapshotVisualizationState = Object.freeze({
  activeKey: null,
  definitions: EMPTY_DEFINITIONS,
});

type SnapshotVisualizationListener = () => void;

/**
 * Stable identity for one saved field sample. JSON tuple encoding prevents
 * delimiter collisions and keeps the source revision in the cache key.
 */
export function snapshotVisualizationKey(
  identity: SnapshotVisualizationIdentity,
): string {
  return JSON.stringify([
    identity.runId,
    identity.stageId,
    identity.datasetId,
    identity.quantityId,
    identity.sampleIndex,
    identity.revision,
  ]);
}

/**
 * Stable logical identity for one dataset/quantity series across revisions
 * and samples.
 */
function snapshotVisualizationSeriesKey(
  identity: SnapshotVisualizationIdentity,
): string {
  return JSON.stringify([
    identity.runId,
    identity.stageId,
    identity.datasetId,
    identity.quantityId,
  ]);
}

/**
 * Stable logical identity for one sample's appearance preference across
 * revisions.
 */
function snapshotVisualizationAppearancePreferenceKey(
  identity: SnapshotVisualizationIdentity,
): string {
  return JSON.stringify([
    identity.runId,
    identity.stageId,
    identity.datasetId,
    identity.quantityId,
    identity.sampleIndex,
  ]);
}

/**
 * Client-owned appearance state for historical snapshots. It deliberately
 * has no transport, buffer, or React concerns; the shared viewport can read
 * the active definition while Inspector controls update it in place.
 */
export class SnapshotVisualizationController {
  private snapshot: SnapshotVisualizationState = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<SnapshotVisualizationListener>();
  /**
   * Definitions are capped so browsing a very large result folder cannot
   * retain an unbounded set of revision-pinned render identities. The logical
   * appearance preference cache is separately capped to the same bound.
   */
  private readonly archivedDefinitions = new Map<
    string,
    SnapshotVisualizationDefinition
  >();
  private readonly lastUsed = new Map<string, number>();
  private usageCounter = 0;
  /** Last Inspector sample per logical dataset series, bounded like definitions. */
  private readonly rememberedSampleIndices = new Map<string, number>();
  private readonly rememberedSampleUsage = new Map<string, number>();
  private sampleUsageCounter = 0;
  /** Latest edited appearance per logical sample, independent of metadata revision. */
  private readonly appearancePreferences = new Map<
    string,
    SnapshotVisualizationAppearance
  >();
  private readonly appearancePreferenceUsage = new Map<string, number>();
  private appearancePreferenceCounter = 0;

  getSnapshot(): SnapshotVisualizationState {
    return this.snapshot;
  }

  subscribe(listener: SnapshotVisualizationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Remembers Inspector navigation without changing the active viewport source.
   * The series key includes run, stage, dataset, and quantity; metadata
   * revisions do not reset the Inspector's selected sample.
   */
  rememberSampleIndex(identity: SnapshotVisualizationIdentity): boolean {
    if (!isSnapshotVisualizationIdentity(identity)) return false;

    const key = snapshotVisualizationSeriesKey(identity);
    if (
      !this.rememberedSampleIndices.has(key) &&
      this.rememberedSampleIndices.size >= MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS
    ) {
      const evictable = [...this.rememberedSampleIndices.keys()]
        .sort(
          (left, right) =>
            (this.rememberedSampleUsage.get(left) ?? 0) -
            (this.rememberedSampleUsage.get(right) ?? 0),
        )[0];
      if (evictable) {
        this.rememberedSampleIndices.delete(evictable);
        this.rememberedSampleUsage.delete(evictable);
      }
    }

    this.rememberedSampleIndices.set(key, identity.sampleIndex);
    this.touchRememberedSample(key);
    return true;
  }

  /**
   * Resolves the sample an Inspector should restore for one logical series.
   * The latest explicit Inspector selection wins across metadata revisions;
   * the active viewport is a fallback when no Inspector preference remains.
   */
  getPreferredSampleIndex(
    identity: SnapshotVisualizationIdentity,
  ): number | null {
    if (!isSnapshotVisualizationIdentity(identity)) return null;

    const key = snapshotVisualizationSeriesKey(identity);
    const remembered = this.rememberedSampleIndices.get(key);
    if (remembered !== undefined) {
      this.touchRememberedSample(key);
      return remembered;
    }

    const activeDefinition = this.snapshot.activeKey
      ? this.snapshot.definitions[this.snapshot.activeKey]
      : undefined;
    if (
      activeDefinition &&
      snapshotVisualizationSeriesKey(activeDefinition.identity) === key
    ) {
      return activeDefinition.identity.sampleIndex;
    }

    return null;
  }

  /** Selects a saved snapshot, creating its default definition on first use. */
  select(identity: SnapshotVisualizationIdentity): boolean {
    if (!isSnapshotVisualizationIdentity(identity)) return false;

    const key = snapshotVisualizationKey(identity);
    const wasActive = this.snapshot.activeKey === key;
    const ensured = this.ensureDefinition(identity, false);
    if (!ensured) return false;

    this.rememberSampleIndex(identity);
    if (wasActive) return false;

    this.touch(key);
    this.snapshot = makeSnapshot(key, this.snapshot.definitions);
    this.notify();
    return true;
  }

  /**
   * Retains a definition without making it the active viewport source.
   * Inspectors use this while a user edits a snapshot before pressing
   * "Load into 3D".
   */
  ensureDefinition(
    identity: SnapshotVisualizationIdentity,
    notify = true,
  ): boolean {
    if (!isSnapshotVisualizationIdentity(identity)) return false;

    const key = snapshotVisualizationKey(identity);
    if (this.snapshot.definitions[key]) {
      this.touch(key);
      return true;
    }

    const archived = this.archivedDefinitions.get(key);
    const inheritedAppearance = archived
      ? null
      : this.getAppearancePreference(identity);
    const definition =
      archived ??
      makeDefinition(
        identity,
        inheritedAppearance ?? DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE,
      );
    this.archivedDefinitions.delete(key);

    const definitions = { ...this.snapshot.definitions };
    if (Object.keys(definitions).length >= MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS) {
      const evictable = Object.keys(definitions)
        .filter((candidate) => candidate !== this.snapshot.activeKey)
        .sort((left, right) =>
          (this.lastUsed.get(left) ?? 0) - (this.lastUsed.get(right) ?? 0),
        )[0];
      if (evictable) {
        const evicted = definitions[evictable];
        if (evicted && !sameAppearance(evicted.appearance, DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE)) {
          this.archivedDefinitions.set(evictable, evicted);
        } else {
          this.archivedDefinitions.delete(evictable);
        }
        this.lastUsed.delete(evictable);
        delete definitions[evictable];
      }
    }

    definitions[key] = definition;
    this.touch(key);
    this.snapshot = makeSnapshot(
      this.snapshot.activeKey,
      Object.freeze(definitions),
    );
    if (notify) this.notify();
    return true;
  }

  /** Applies a validated patch to an existing definition. */
  updateAppearance(
    key: string,
    patch: SnapshotVisualizationAppearancePatch,
  ): boolean {
    const currentDefinition =
      this.snapshot.definitions[key] ?? this.archivedDefinitions.get(key);
    if (!currentDefinition || !isAppearancePatch(patch)) return false;

    const nextAppearance = {
      ...currentDefinition.appearance,
      ...patch,
    };
    if (!isSnapshotVisualizationAppearance(nextAppearance)) return false;
    if (sameAppearance(currentDefinition.appearance, nextAppearance)) {
      return false;
    }

    const definition = Object.freeze({
      identity: currentDefinition.identity,
      appearance: Object.freeze(nextAppearance),
    });
    this.rememberAppearancePreference(
      currentDefinition.identity,
      definition.appearance,
    );
    if (this.snapshot.definitions[key]) {
      const definitions = Object.freeze({
        ...this.snapshot.definitions,
        [key]: definition,
      });
      this.snapshot = makeSnapshot(this.snapshot.activeKey, definitions);
    } else {
      if (sameAppearance(nextAppearance, DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE)) {
        this.archivedDefinitions.delete(key);
        this.lastUsed.delete(key);
      } else {
        this.archivedDefinitions.set(key, definition);
      }
    }
    if (this.snapshot.definitions[key] || this.archivedDefinitions.has(key)) {
      this.touch(key);
    }
    this.notify();
    return true;
  }

  /** Leaves retained snapshot definitions untouched while selecting live data. */
  returnToLive(): boolean {
    if (this.snapshot.activeKey === null) return false;
    this.snapshot = makeSnapshot(null, this.snapshot.definitions);
    this.notify();
    return true;
  }

  /** Drops all retained definitions for an explicit session change. */
  clear(): boolean {
    if (
      this.snapshot.activeKey === null &&
      Object.keys(this.snapshot.definitions).length === 0 &&
      this.archivedDefinitions.size === 0 &&
      this.rememberedSampleIndices.size === 0 &&
      this.appearancePreferences.size === 0
    ) {
      return false;
    }
    this.snapshot = INITIAL_SNAPSHOT;
    this.archivedDefinitions.clear();
    this.lastUsed.clear();
    this.usageCounter = 0;
    this.rememberedSampleIndices.clear();
    this.rememberedSampleUsage.clear();
    this.sampleUsageCounter = 0;
    this.appearancePreferences.clear();
    this.appearancePreferenceUsage.clear();
    this.appearancePreferenceCounter = 0;
    this.notify();
    return true;
  }

  private touch(key: string): void {
    this.usageCounter += 1;
    this.lastUsed.set(key, this.usageCounter);
  }

  private touchRememberedSample(key: string): void {
    this.sampleUsageCounter += 1;
    this.rememberedSampleUsage.set(key, this.sampleUsageCounter);
  }

  private getAppearancePreference(
    identity: SnapshotVisualizationIdentity,
  ): SnapshotVisualizationAppearance | null {
    const key = snapshotVisualizationAppearancePreferenceKey(identity);
    const appearance = this.appearancePreferences.get(key);
    if (appearance) this.touchAppearancePreference(key);
    return appearance ?? null;
  }

  private rememberAppearancePreference(
    identity: SnapshotVisualizationIdentity,
    appearance: SnapshotVisualizationAppearance,
  ): void {
    const key = snapshotVisualizationAppearancePreferenceKey(identity);
    if (
      !this.appearancePreferences.has(key) &&
      this.appearancePreferences.size >= MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS
    ) {
      const evictable = [...this.appearancePreferences.keys()].sort(
        (left, right) =>
          (this.appearancePreferenceUsage.get(left) ?? 0) -
          (this.appearancePreferenceUsage.get(right) ?? 0),
      )[0];
      if (evictable) {
        this.appearancePreferences.delete(evictable);
        this.appearancePreferenceUsage.delete(evictable);
      }
    }

    this.appearancePreferences.set(key, appearance);
    this.touchAppearancePreference(key);
  }

  private touchAppearancePreference(key: string): void {
    this.appearancePreferenceCounter += 1;
    this.appearancePreferenceUsage.set(key, this.appearancePreferenceCounter);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function makeSnapshot(
  activeKey: string | null,
  definitions: Readonly<Record<string, SnapshotVisualizationDefinition>>,
): SnapshotVisualizationState {
  return Object.freeze({ activeKey, definitions });
}

function makeDefinition(
  identity: SnapshotVisualizationIdentity,
  appearance: SnapshotVisualizationAppearance =
    DEFAULT_SNAPSHOT_VISUALIZATION_APPEARANCE,
): SnapshotVisualizationDefinition {
  return Object.freeze({
    identity: Object.freeze({
      runId: identity.runId,
      stageId: identity.stageId,
      datasetId: identity.datasetId,
      quantityId: identity.quantityId,
      sampleIndex: identity.sampleIndex,
      revision: identity.revision,
    }),
    appearance: Object.freeze({ ...appearance }),
  });
}

function isSnapshotVisualizationIdentity(
  value: unknown,
): value is SnapshotVisualizationIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<SnapshotVisualizationIdentity>;
  return (
    nonEmptyString(identity.runId) &&
    nonEmptyString(identity.stageId) &&
    nonEmptyString(identity.datasetId) &&
    nonEmptyString(identity.quantityId) &&
    typeof identity.sampleIndex === "number" &&
    Number.isInteger(identity.sampleIndex) &&
    identity.sampleIndex >= 0 &&
    nonEmptyString(identity.revision)
  );
}

function isAppearancePatch(
  value: unknown,
): value is SnapshotVisualizationAppearancePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) =>
    SNAPSHOT_VISUALIZATION_APPEARANCE_KEYS.includes(
      key as (typeof SNAPSHOT_VISUALIZATION_APPEARANCE_KEYS)[number],
    ),
  );
}

function isSnapshotVisualizationAppearance(
  value: Partial<SnapshotVisualizationAppearance>,
): value is SnapshotVisualizationAppearance {
  if (
    !isAllowedComponent(value.component) ||
    typeof value.palette !== "string" ||
    value.palette.trim().length === 0 ||
    value.palette.length > MAX_SNAPSHOT_VISUALIZATION_PALETTE_LENGTH ||
    typeof value.visible !== "boolean" ||
    !isAllowedRangeMode(value.rangeMode) ||
    !isNullableFiniteNumber(value.min) ||
    !isNullableFiniteNumber(value.max)
  ) {
    return false;
  }

  return (
    value.rangeMode !== "manual" ||
    (value.min !== null && value.max !== null && value.min < value.max)
  );
}

function isAllowedComponent(
  value: unknown,
): value is SnapshotVisualizationComponent {
  return (
    typeof value === "string" &&
    SNAPSHOT_VISUALIZATION_COMPONENTS.includes(
      value as SnapshotVisualizationComponent,
    )
  );
}

function isAllowedRangeMode(
  value: unknown,
): value is SnapshotVisualizationRangeMode {
  return (
    typeof value === "string" &&
    SNAPSHOT_VISUALIZATION_RANGE_MODES.includes(
      value as SnapshotVisualizationRangeMode,
    )
  );
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function sameAppearance(
  left: SnapshotVisualizationAppearance,
  right: SnapshotVisualizationAppearance,
): boolean {
  return (
    left.component === right.component &&
    left.palette === right.palette &&
    left.visible === right.visible &&
    left.rangeMode === right.rangeMode &&
    left.min === right.min &&
    left.max === right.max
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
