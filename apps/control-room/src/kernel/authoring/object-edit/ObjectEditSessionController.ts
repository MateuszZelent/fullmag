import type {
  ObjectEditApplyOperation,
  ObjectEditSessionIdentity,
  ObjectEditSessionSnapshot,
  ObjectEditSessionTarget,
} from "./objectEditTypes";

type Listener = () => void;

const EMPTY_SNAPSHOT: ObjectEditSessionSnapshot<never> = Object.freeze({
  applyOperationId: null,
  dirty: false,
  draft: null,
  editVersion: 0,
  identity: null,
});

export class ObjectEditSessionController<TDraft> {
  private listeners = new Set<Listener>();
  private draftSequence = 0;
  private epochSequence = 0;
  private operationSequence = 0;
  private gestureSequence = 0;
  private sceneMutationSequence = 0;
  private sceneMutations = new Map<number, { sessionScopeKey: string | null; objectId: string }>();
  private activeGestures = new Map<number, { sessionScopeKey: string | null; objectId: string }>();
  private pendingOperations = new Map<
    string,
    ObjectEditApplyOperation<TDraft>
  >();
  private pendingOperationKey(target: { sessionScopeKey: string | null; objectId?: string | null }): string {
    const scope = target.sessionScopeKey ?? "default";
    return target.objectId ? `${scope}:${target.objectId}` : scope;
  }
  private snapshot: ObjectEditSessionSnapshot<TDraft> = EMPTY_SNAPSHOT;
  /** Last canonical draft seen by the active draft, keyed by draft id. */
  private canonicalDrafts = new Map<string, TDraft>();

  readonly getSnapshot = (): ObjectEditSessionSnapshot<TDraft> => this.snapshot;
  readonly getServerSnapshot = (): ObjectEditSessionSnapshot<TDraft> =>
    EMPTY_SNAPSHOT as ObjectEditSessionSnapshot<TDraft>;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(
    target: ObjectEditSessionTarget,
    initialDraft: TDraft,
  ): ObjectEditSessionIdentity {
    const current = this.snapshot.identity;
    if (
      current &&
      current.targetKey === target.targetKey &&
      current.objectId === target.objectId &&
      current.sessionScopeKey === target.sessionScopeKey
    ) {
      return current;
    }

    const identity: ObjectEditSessionIdentity = Object.freeze({
      ...target,
      draftId: "object-edit-" + String(++this.draftSequence),
      epoch: ++this.epochSequence,
    });
    // Only the active draft can be refreshed, so one canonical baseline is kept.
    this.canonicalDrafts.clear();
    this.canonicalDrafts.set(identity.draftId, initialDraft);
    this.publish({
      applyOperationId: this.pendingOperations.get(this.pendingOperationKey(target))?.id ?? null,
      dirty: false,
      draft: initialDraft,
      editVersion: 0,
      identity,
    });
    return identity;
  }

  updateDraft(
    identity: ObjectEditSessionIdentity,
    update: (draft: TDraft) => TDraft,
  ): boolean {
    if (!this.matches(identity) || this.snapshot.draft === null) return false;
    const draft = update(this.snapshot.draft);
    if (Object.is(draft, this.snapshot.draft)) return true;
    this.publish({
      ...this.snapshot,
      dirty: true,
      draft,
      editVersion: this.snapshot.editVersion + 1,
    });
    return true;
  }

  /**
   * Replaces a clean draft with the canonical one. A dirty draft is kept; when
   * `rebaseDirty` is given it may move the draft onto the new canonical base,
   * e.g. when only an unrelated part of the scene changed revision.
   */
  refreshCanonical(
    identity: ObjectEditSessionIdentity,
    canonicalDraft: TDraft,
    rebaseDirty?: (draft: TDraft, previousCanonical: TDraft, canonical: TDraft) => TDraft | null,
  ): boolean {
    if (!this.matches(identity)) return false;
    const previousCanonical = this.canonicalDrafts.get(identity.draftId) ?? null;
    this.canonicalDrafts.set(identity.draftId, canonicalDraft);
    if (
      this.pendingOperations.has(this.pendingOperationKey(identity)) ||
      Object.is(this.snapshot.draft, canonicalDraft)
    ) {
      return true;
    }
    if (this.snapshot.dirty) {
      const draft = this.snapshot.draft;
      const rebased = draft !== null && previousCanonical !== null && rebaseDirty
        ? rebaseDirty(draft, previousCanonical, canonicalDraft)
        : null;
      if (rebased !== null && !Object.is(rebased, draft)) {
        this.publish({ ...this.snapshot, draft: rebased });
      }
      return true;
    }
    this.publish({ ...this.snapshot, draft: canonicalDraft });
    return true;
  }

  setDirty(identity: ObjectEditSessionIdentity, dirty: boolean): boolean {
    if (!this.matches(identity) || this.snapshot.dirty === dirty) {
      return this.matches(identity);
    }
    this.publish({ ...this.snapshot, dirty });
    return true;
  }

  /** Scene writes serialize within a session, while owners remain per object. */
  hasPendingApply(sessionScopeKey: string | null): boolean {
    return [...this.pendingOperations.values()].some(
      (operation) => operation.identity.sessionScopeKey === sessionScopeKey,
    );
  }

  hasPendingWrite(sessionScopeKey: string | null): boolean {
    return this.hasPendingApply(sessionScopeKey) || [...this.sceneMutations.values()].some(
      (mutation) => mutation.sessionScopeKey === sessionScopeKey,
    );
  }

  /** A client-side reservation for existing single-object writes, not an API transaction. */
  beginSceneMutation(sessionScopeKey: string | null, objectId: string): number | null {
    if (this.hasPendingWrite(sessionScopeKey) || this.hasActiveGesture(sessionScopeKey)) return null;
    const token = ++this.sceneMutationSequence;
    this.sceneMutations.set(token, { sessionScopeKey, objectId });
    this.publish({ ...this.snapshot });
    return token;
  }

  endSceneMutation(token: number): boolean {
    if (!this.sceneMutations.delete(token)) return false;
    this.publish({ ...this.snapshot });
    return true;
  }

  hasActiveGesture(sessionScopeKey: string | null): boolean {
    return [...this.activeGestures.values()].some(
      (gesture) => gesture.sessionScopeKey === sessionScopeKey,
    );
  }

  beginGesture(sessionScopeKey: string | null, objectId: string): number | null {
    if (this.hasPendingWrite(sessionScopeKey) || this.hasActiveGesture(sessionScopeKey)) return null;
    const token = ++this.gestureSequence;
    this.activeGestures.set(token, { sessionScopeKey, objectId });
    this.publish({ ...this.snapshot });
    return token;
  }

  endGesture(token: number): boolean {
    if (!this.activeGestures.delete(token)) return false;
    this.publish({ ...this.snapshot });
    return true;
  }

  beginApply(
    identity: ObjectEditSessionIdentity,
  ): ObjectEditApplyOperation<TDraft> | null {
    if (
      !this.matches(identity) ||
      this.snapshot.draft === null ||
      this.hasPendingWrite(identity.sessionScopeKey) ||
      this.hasActiveGesture(identity.sessionScopeKey)
    ) {
      return null;
    }
    const operation: ObjectEditApplyOperation<TDraft> = Object.freeze({
      id: ++this.operationSequence,
      identity,
      submittedDraft: this.snapshot.draft,
      submittedVersion: this.snapshot.editVersion,
    });
    this.pendingOperations.set(this.pendingOperationKey(identity), operation);
    this.publish({ ...this.snapshot, applyOperationId: operation.id });
    return operation;
  }

  acknowledge(
    operation: ObjectEditApplyOperation<TDraft>,
    canonicalDraft: TDraft,
    reconcile: (
      currentDraft: TDraft,
      submittedDraft: TDraft,
      canonicalDraft: TDraft,
    ) => { dirty: boolean; draft: TDraft },
    options: { reconcileUnchangedDraft?: boolean } = {},
  ): boolean {
    const opKey = this.pendingOperationKey(operation.identity);
    const pending = this.pendingOperations.get(opKey);
    const ownsPending = pending?.id === operation.id;
    if (ownsPending) {
      this.pendingOperations.delete(opKey);
    }
    const ownsCurrentDraft =
      this.matches(operation.identity) &&
      this.snapshot.applyOperationId === operation.id &&
      this.snapshot.draft !== null;
    if (!ownsCurrentDraft) {
      if (ownsPending && this.snapshot.identity?.sessionScopeKey === operation.identity.sessionScopeKey) {
        this.publish({
          ...this.snapshot,
          applyOperationId: this.snapshot.applyOperationId === operation.id
            ? null
            : this.snapshot.applyOperationId,
        });
      }
      return false;
    }
    const reconciled =
      this.snapshot.editVersion === operation.submittedVersion && !options.reconcileUnchangedDraft
        ? { dirty: false, draft: canonicalDraft }
        : reconcile(
            this.snapshot.draft as TDraft,
            operation.submittedDraft,
            canonicalDraft,
          );
    this.publish({
      ...this.snapshot,
      applyOperationId: null,
      dirty: reconciled.dirty,
      draft: reconciled.draft,
    });
    return true;
  }

  reject(operation: ObjectEditApplyOperation<TDraft>): boolean {
    const opKey = this.pendingOperationKey(operation.identity);
    const pending = this.pendingOperations.get(opKey);
    const ownsPending = pending?.id === operation.id;
    if (ownsPending) {
      this.pendingOperations.delete(opKey);
    }
    const ownsCurrentDraft =
      this.matches(operation.identity) &&
      this.snapshot.applyOperationId === operation.id;
    if (ownsPending && this.snapshot.identity?.sessionScopeKey === operation.identity.sessionScopeKey) {
      this.publish({
        ...this.snapshot,
        applyOperationId: this.snapshot.applyOperationId === operation.id
          ? null
          : this.snapshot.applyOperationId,
      });
    }
    return ownsCurrentDraft;
  }

  reset(identity: ObjectEditSessionIdentity, initialDraft: TDraft): boolean {
    if (
      !this.matches(identity) ||
      this.hasPendingWrite(identity.sessionScopeKey) ||
      this.hasActiveGesture(identity.sessionScopeKey)
    ) {
      return false;
    }
    this.publish({
      applyOperationId: null,
      dirty: false,
      draft: initialDraft,
      editVersion: this.snapshot.editVersion + 1,
      identity: this.snapshot.identity,
    });
    return true;
  }

  clear(): void {
    const hadReservations = this.pendingOperations.size > 0 ||
      this.activeGestures.size > 0 || this.sceneMutations.size > 0;
    this.epochSequence += 1;
    this.pendingOperations.clear();
    this.activeGestures.clear();
    this.sceneMutations.clear();
    if (!hadReservations && this.snapshot.identity === null && this.snapshot.draft === null) return;
    this.publish(EMPTY_SNAPSHOT as ObjectEditSessionSnapshot<TDraft>);
  }

  isCurrent(identity: ObjectEditSessionIdentity): boolean {
    return this.matches(identity);
  }

  private matches(identity: ObjectEditSessionIdentity): boolean {
    const current = this.snapshot.identity;
    return Boolean(
      current &&
        current.targetKey === identity.targetKey &&
        current.objectId === identity.objectId &&
        current.sessionScopeKey === identity.sessionScopeKey &&
        current.epoch === identity.epoch &&
        current.draftId === identity.draftId,
    );
  }

  private publish(snapshot: ObjectEditSessionSnapshot<TDraft>): void {
    this.snapshot = Object.freeze(snapshot);
    this.listeners.forEach((listener) => listener());
  }
}
