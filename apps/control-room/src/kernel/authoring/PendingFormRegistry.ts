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

export interface PendingFormCommandResult {
  message: string;
  status: "completed" | "failed" | "cancelled" | "pending";
}

type Listener = () => void;

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
 * The registry deliberately keeps only the active form's callbacks. Draft
 * values stay owned by the Inspector panel; commands can request Apply/Reset
 * without creating a second draft store or bypassing panel validation.
 */
export class PendingFormRegistry {
  private readonly forms = new Map<symbol, PendingForm>();
  private readonly listeners = new Set<Listener>();
  private activeOwner: symbol | null = null;

  getSnapshot = (): PendingFormSnapshot => {
    const form = this.current();
    return {
      active: form !== null,
      applying: form?.applying ?? false,
      canApply: canApply(form),
      canReset: canReset(form),
      dirty: form?.dirty ?? false,
      lockReason: form?.lockReason ?? null,
      mode: form?.mode ?? null,
      registeredCount: this.forms.size,
      valid: form?.valid ?? true,
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
    this.notify();
  }

  update(owner: symbol, form: PendingForm | null): void {
    if (form === null) {
      this.unregister(owner);
      return;
    }
    if (!this.forms.has(owner)) return;
    this.forms.set(owner, form);
    if (this.activeOwner === null) this.activeOwner = owner;
    this.notify();
  }

  unregister(owner: symbol): void {
    if (!this.forms.delete(owner)) return;
    if (this.activeOwner === owner) this.activeOwner = null;
    this.notify();
  }

  clear(): void {
    if (this.forms.size === 0 && this.activeOwner === null) return;
    this.forms.clear();
    this.activeOwner = null;
    this.notify();
  }

  current(): PendingForm | null {
    return this.activeOwner ? this.forms.get(this.activeOwner) ?? null : null;
  }

  canApply(): boolean {
    return canApply(this.current());
  }

  canReset(): boolean {
    return canReset(this.current());
  }

  async apply(): Promise<PendingFormCommandResult> {
    const form = this.current();
    if (!form || !canApply(form)) {
      return { message: applyReason(form), status: "failed" };
    }
    try {
      const applied = await form.apply();
      return applied
        ? { message: "Inspector changes applied.", status: "completed" }
        : { message: "Inspector changes were not applied.", status: "failed" };
    } catch (error) {
      return {
        message: `Inspector Apply failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      };
    }
  }

  async reset(): Promise<PendingFormCommandResult> {
    const form = this.current();
    if (!form || !canReset(form)) {
      return {
        message: form?.applying
          ? "Inspector changes are already being applied."
          : "There are no unapplied Inspector changes.",
        status: "cancelled",
      };
    }
    try {
      await form.reset();
      return { message: "Inspector changes reset.", status: "completed" };
    } catch (error) {
      return {
        message: `Inspector Reset failed: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
      };
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
