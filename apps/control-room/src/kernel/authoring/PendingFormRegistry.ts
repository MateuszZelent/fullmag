export type PendingFormMode = "staged" | "liveViewport" | "immediate";

export interface PendingForm {
  apply: () => Promise<boolean> | boolean;
  applying: boolean;
  dirty: boolean;
  lockReason?: string;
  mode: PendingFormMode;
  reset: () => Promise<void> | void;
  valid: boolean;
}

export interface PendingFormSnapshot {
  active: boolean;
  applying: boolean;
  canApply: boolean;
  canReset: boolean;
  dirty: boolean;
  lockReason: string | null;
  mode: PendingFormMode | null;
  registeredCount: number;
  valid: boolean;
}

export interface PendingFormTransitionSnapshot {
  applyingOwnerCount: number;
  blockedReason: string | null;
  canApplyPendingChanges: boolean;
  dirtyOwnerCount: number;
  generation: number;
  guarded: boolean;
  invalidDirtyOwnerCount: number;
  lockedDirtyOwnerCount: number;
  nonStagedDirtyOwnerCount: number;
  preparing: boolean;
  registeredCount: number;
}

export interface PendingFormTransitionGuard {
  assertCurrent(): void;
  release(): void;
}

export interface PreparePendingFormTransitionOptions {
  applyPendingChanges: boolean;
}

export interface PendingFormCommandResult {
  message: string;
  status: "completed" | "failed" | "cancelled" | "pending";
}

type Listener = () => void;

interface RegisteredFormState {
  apply: PendingForm["apply"];
  applying: boolean;
  dirty: boolean;
  form: PendingForm;
  lockReason: string | undefined;
  mode: PendingFormMode;
  owner: symbol;
  reset: PendingForm["reset"];
  valid: boolean;
}

interface TransitionPreparation {
  acceptedCleanUpdate: boolean;
  activeOwner: symbol | null;
  applyingOwner: symbol | null;
  generation: number;
  expectedForms: Map<symbol, RegisteredFormState>;
}

function applyReason(form: PendingForm | null): string {
  if (!form) return "No Inspector form is active.";
  if (form.lockReason) return form.lockReason;
  if (form.mode === "liveViewport") return "Viewport changes are applied live.";
  if (form.mode === "immediate") return "This Inspector view has no staged changes.";
  if (!form.dirty) return "There are no unapplied Inspector changes.";
  if (!form.valid) return "Resolve Inspector validation errors before applying.";
  if (form.applying) return "Inspector changes are already being applied.";
  return "";
}

function canApply(form: PendingForm | null): boolean {
  return Boolean(
    form &&
      form.mode === "staged" &&
      form.dirty &&
      form.valid &&
      !form.applying &&
      !form.lockReason,
  );
}

function canReset(form: PendingForm | null): boolean {
  return Boolean(
    form &&
      form.mode !== "immediate" &&
      form.dirty &&
      !form.applying,
  );
}

/**
 * Kernel boundary for pending Inspector forms.
 *
 * Draft values stay owned by Inspector panels; commands use registered
 * callbacks without creating a second draft store or bypassing validation.
 */
export class PendingFormRegistry {
  private readonly forms = new Map<symbol, PendingForm>();
  private readonly listeners = new Set<Listener>();
  private activeOwner: symbol | null = null;
  private generation = 0;
  private preparation: TransitionPreparation | null = null;
  private transitionGuard: symbol | null = null;
  private commandOwner: symbol | null = null;

  getSnapshot = (): PendingFormSnapshot => {
    const form = this.current();
    return {
      active: form !== null,
      applying: (form?.applying ?? false) || this.commandOwner !== null,
      canApply: this.canApply(),
      canReset: this.canReset(),
      dirty: form?.dirty ?? false,
      lockReason: form?.lockReason ?? null,
      mode: form?.mode ?? null,
      registeredCount: this.forms.size,
      valid: form?.valid ?? true,
    };
  };

  getTransitionSnapshot = (): PendingFormTransitionSnapshot => {
    const forms = [...this.forms.values()];
    const dirtyForms = forms.filter((form) => form.dirty);
    const applyingOwners = new Set(
      [...this.forms.entries()]
        .filter(([, form]) => form.applying)
        .map(([owner]) => owner),
    );
    if (this.preparation?.applyingOwner) {
      applyingOwners.add(this.preparation.applyingOwner);
    }
    if (this.commandOwner !== null) applyingOwners.add(this.commandOwner);
    const applyingOwnerCount = applyingOwners.size;
    const invalidDirtyOwnerCount = dirtyForms.filter(
      (form) => !form.valid,
    ).length;
    const lockedDirtyOwnerCount = dirtyForms.filter(
      (form) => Boolean(form.lockReason),
    ).length;
    const nonStagedDirtyOwnerCount = dirtyForms.filter(
      (form) => form.mode !== "staged",
    ).length;
    const canApplyPendingChanges = Boolean(
      dirtyForms.length > 0 &&
        this.preparation === null &&
        this.transitionGuard === null &&
        applyingOwnerCount === 0 &&
        invalidDirtyOwnerCount === 0 &&
        lockedDirtyOwnerCount === 0 &&
        nonStagedDirtyOwnerCount === 0,
    );

    let blockedReason: string | null = null;
    if (this.preparation !== null) {
      blockedReason = "A workspace transition is already being prepared.";
    } else if (this.transitionGuard !== null) {
      blockedReason = "A prepared workspace transition is still active.";
    } else if (applyingOwnerCount > 0) {
      blockedReason = "Inspector changes are already being applied.";
    } else if (invalidDirtyOwnerCount > 0) {
      blockedReason = "Resolve Inspector validation errors before continuing.";
    } else if (lockedDirtyOwnerCount > 0) {
      blockedReason = "Unlock Inspector changes before continuing.";
    } else if (nonStagedDirtyOwnerCount > 0) {
      blockedReason = "Resolve live or immediate Inspector changes before continuing.";
    } else if (dirtyForms.length > 0) {
      blockedReason = "Choose Apply or Cancel for pending Inspector changes.";
    }

    return {
      applyingOwnerCount,
      blockedReason,
      canApplyPendingChanges,
      dirtyOwnerCount: dirtyForms.length,
      generation: this.generation,
      guarded: this.transitionGuard !== null,
      invalidDirtyOwnerCount,
      lockedDirtyOwnerCount,
      nonStagedDirtyOwnerCount,
      preparing: this.preparation !== null,
      registeredCount: forms.length,
    };
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(owner: symbol, form: PendingForm | null): void {
    if (form === null) {
      this.unregister(owner);
      return;
    }
    this.forms.set(owner, form);
    this.activeOwner = owner;
    this.generation += 1;
    this.notify();
  }

  update(owner: symbol, form: PendingForm | null): void {
    if (form === null) {
      this.unregister(owner);
      return;
    }
    if (!this.forms.has(owner)) return;
    const previousGeneration = this.generation;
    const preparation = this.preparation;
    const canAdoptCleanUpdate = Boolean(
      preparation !== null &&
        preparation.applyingOwner === owner &&
        !preparation.acceptedCleanUpdate &&
        !form.dirty &&
        !form.applying &&
        previousGeneration === preparation.generation &&
        this.activeOwner === preparation.activeOwner &&
        this.registeredFormStatesMatch(preparation.expectedForms, owner),
    );
    this.forms.set(owner, form);
    if (this.activeOwner === null) this.activeOwner = owner;
    this.generation = previousGeneration + 1;
    if (canAdoptCleanUpdate && preparation !== null) {
      preparation.generation = this.generation;
      preparation.acceptedCleanUpdate = true;
      preparation.activeOwner = this.activeOwner;
      preparation.expectedForms.set(owner, this.captureFormState(owner, form));
    }
    this.notify();
  }

  unregister(owner: symbol): void {
    if (!this.forms.delete(owner)) return;
    if (this.activeOwner === owner) this.activeOwner = null;
    this.generation += 1;
    this.notify();
  }

  clear(): void {
    if (
      this.forms.size === 0 &&
      this.activeOwner === null &&
      this.preparation === null &&
      this.transitionGuard === null &&
      this.commandOwner === null
    ) return;
    this.forms.clear();
    this.activeOwner = null;
    this.generation += 1;
    this.notify();
  }

  async prepareTransition(
    options: PreparePendingFormTransitionOptions,
  ): Promise<PendingFormTransitionGuard> {
    if (this.preparation !== null || this.transitionGuard !== null || this.commandOwner !== null) {
      throw new Error("Another workspace transition is already active.");
    }

    const initialForms = this.captureFormStates();
    const preparation: TransitionPreparation = {
      acceptedCleanUpdate: false,
      activeOwner: this.activeOwner,
      applyingOwner: null,
      generation: this.generation,
      expectedForms: new Map(initialForms.map((form) => [form.owner, form])),
    };
    this.preparation = preparation;

    try {
      this.notify();
      this.assertPreparationCurrent(preparation);

      const applyingForms = initialForms.filter((entry) => entry.applying);
      if (applyingForms.length > 0) {
        throw new Error("Inspector changes are already being applied.");
      }

      const dirtyForms = initialForms.filter((entry) => entry.dirty);
      if (dirtyForms.length > 0 && !options.applyPendingChanges) {
        throw new Error("Choose Apply or Cancel for pending Inspector changes.");
      }
      if (options.applyPendingChanges) {
        const ineligible = dirtyForms.find((entry) =>
          entry.mode !== "staged" || !entry.valid || Boolean(entry.lockReason),
        );
        if (ineligible) {
          throw new Error(this.dirtyFormBlockReason(ineligible));
        }

        for (const entry of dirtyForms) {
          this.assertPreparationCurrent(preparation);
          if (this.forms.get(entry.owner) !== entry.form) {
            throw new Error("Inspector forms changed during transition preparation.");
          }

          preparation.applyingOwner = entry.owner;
          preparation.acceptedCleanUpdate = false;
          let applied: boolean;
          try {
            applied = await entry.form.apply();
          } finally {
            preparation.applyingOwner = null;
          }
          this.assertPreparationCurrent(preparation);
          if (!applied) {
            throw new Error("Inspector changes were not applied.");
          }
        }
      }

      this.assertPreparationCurrent(preparation);
      const currentForms = [...this.forms.values()];
      if (currentForms.some((form) => form.dirty || form.applying)) {
        throw new Error("Inspector forms are not quiescent after preparation.");
      }

      const pinnedForms = this.captureFormStates();
      const pinnedGeneration = this.generation;
      const guardToken = Symbol("pending-form-transition-guard");
      this.transitionGuard = guardToken;
      this.preparation = null;
      try {
        this.notify();
      } catch (error) {
        this.transitionGuard = null;
        throw error;
      }

      if (!this.isGuardCurrent(guardToken, pinnedGeneration, pinnedForms)) {
        this.transitionGuard = null;
        this.notify();
        throw new Error("Inspector forms changed while the transition guard was being issued.");
      }

      let released = false;
      return {
        assertCurrent: () => {
          if (released || !this.isGuardCurrent(guardToken, pinnedGeneration, pinnedForms)) {
            throw new Error("The prepared workspace transition is no longer current.");
          }
        },
        release: () => {
          if (released) return;
          released = true;
          if (this.transitionGuard === guardToken) {
            this.transitionGuard = null;
            this.notify();
          }
        },
      };
    } finally {
      if (this.preparation === preparation) {
        this.preparation = null;
        this.notify();
      }
    }
  }

  current(): PendingForm | null {
    return this.activeOwner ? this.forms.get(this.activeOwner) ?? null : null;
  }

  canApply(): boolean {
    return (
      this.preparation === null &&
      this.transitionGuard === null &&
      this.commandOwner === null &&
      canApply(this.current())
    );
  }

  canReset(): boolean {
    return (
      this.preparation === null &&
      this.transitionGuard === null &&
      this.commandOwner === null &&
      canReset(this.current())
    );
  }

  async apply(): Promise<PendingFormCommandResult> {
    if (this.preparation !== null || this.transitionGuard !== null || this.commandOwner !== null) {
      return { message: "A workspace transition is in progress.", status: "failed" };
    }
    const form = this.current();
    if (!form || !canApply(form)) {
      return { message: applyReason(form), status: "failed" };
    }
    this.commandOwner = this.activeOwner;
    const commandGeneration = this.generation;
    const commandForms = new Map(this.captureFormStates().map((entry) => [entry.owner, entry]));
    try {
      this.notify();
      if (this.generation !== commandGeneration || this.current() !== form || !this.registeredFormStatesMatch(commandForms)) {
        throw new Error("Inspector forms changed before Apply began.");
      }
      const applied = await form.apply();
      return applied
        ? { message: "Inspector changes applied.", status: "completed" }
        : { message: "Inspector changes were not applied.", status: "failed" };
    } catch (error) {
      return {
        message: `Inspector Apply failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      };
    } finally {
      this.commandOwner = null;
      this.notify();
    }
  }

  async reset(): Promise<PendingFormCommandResult> {
    if (this.preparation !== null || this.transitionGuard !== null || this.commandOwner !== null) {
      return { message: "A workspace transition is in progress.", status: "cancelled" };
    }
    const form = this.current();
    if (!form || !canReset(form)) {
      return {
        message: form?.applying
          ? "Inspector changes are already being applied."
          : "There are no unapplied Inspector changes.",
        status: "cancelled",
      };
    }
    this.commandOwner = this.activeOwner;
    const commandGeneration = this.generation;
    const commandForms = new Map(this.captureFormStates().map((entry) => [entry.owner, entry]));
    try {
      this.notify();
      if (this.generation !== commandGeneration || this.current() !== form || !this.registeredFormStatesMatch(commandForms)) {
        throw new Error("Inspector forms changed before Reset began.");
      }
      await form.reset();
      return { message: "Inspector changes reset.", status: "completed" };
    } catch (error) {
      return {
        message: `Inspector Reset failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      };
    } finally {
      this.commandOwner = null;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private captureFormStates(): RegisteredFormState[] {
    return [...this.forms.entries()].map(([owner, form]) => ({
      ...this.captureFormState(owner, form),
    }));
  }

  private captureFormState(owner: symbol, form: PendingForm): RegisteredFormState {
    return {
      apply: form.apply,
      applying: form.applying,
      dirty: form.dirty,
      form,
      lockReason: form.lockReason,
      mode: form.mode,
      owner,
      reset: form.reset,
      valid: form.valid,
    };
  }

  private registeredFormStatesMatch(
    expectedForms: Map<symbol, RegisteredFormState>,
    exceptOwner?: symbol,
  ): boolean {
    if (this.forms.size !== expectedForms.size) return false;
    for (const [owner, expected] of expectedForms) {
      if (owner === exceptOwner) continue;
      const current = this.forms.get(owner);
      if (
        !current ||
        current !== expected.form ||
        current.apply !== expected.apply ||
        current.reset !== expected.reset ||
        current.applying !== expected.applying ||
        current.dirty !== expected.dirty ||
        current.lockReason !== expected.lockReason ||
        current.mode !== expected.mode ||
        current.valid !== expected.valid
      ) {
        return false;
      }
    }
    return true;
  }

  private dirtyFormBlockReason(form: RegisteredFormState): string {
    if (form.mode === "liveViewport") return "Viewport changes are applied live.";
    if (form.mode === "immediate") return "This Inspector view has no staged changes.";
    if (form.lockReason) return form.lockReason;
    if (!form.valid) return "Resolve Inspector validation errors before applying.";
    return "Inspector changes cannot be applied in their current state.";
  }

  private assertPreparationCurrent(preparation: TransitionPreparation): void {
    if (
      this.preparation !== preparation ||
      this.generation !== preparation.generation ||
      this.activeOwner !== preparation.activeOwner ||
      !this.registeredFormStatesMatch(preparation.expectedForms)
    ) {
      throw new Error("Inspector forms changed during transition preparation.");
    }
  }

  private isGuardCurrent(
    guard: symbol,
    generation: number,
    pinnedForms: RegisteredFormState[],
  ): boolean {
    if (
      this.transitionGuard !== guard ||
      this.generation !== generation ||
      this.preparation !== null ||
      this.forms.size !== pinnedForms.length
    ) {
      return false;
    }

    for (const pinned of pinnedForms) {
      const current = this.forms.get(pinned.owner);
      if (
        !current ||
        current !== pinned.form ||
        current.apply !== pinned.apply ||
        current.reset !== pinned.reset ||
        current.applying !== pinned.applying ||
        current.dirty !== pinned.dirty ||
        current.lockReason !== pinned.lockReason ||
        current.mode !== pinned.mode ||
        current.valid !== pinned.valid ||
        current.dirty ||
        current.applying
      ) {
        return false;
      }
    }
    return true;
  }
}
