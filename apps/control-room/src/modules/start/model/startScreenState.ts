import type { CommandContext, CommandResult } from "@/kernel/commands/commandTypes";

export type StartSection =
  | "home"
  | "templates"
  | "import"
  | "learn"
  | "docs"
  | "settings"
  | "about";

/**
 * What a mounted start screen lends to its commands. The commands come from
 * the manifest and stay registered for the whole app lifetime, so they need a
 * way to reach the kernel registry and to know whether the screen is showing.
 */
export interface StartScreenHost {
  readonly createProblemDisabledReason: string | null;
  readonly disabledReason: (commandId: string, context: CommandContext) => string | null;
  readonly execute: (commandId: string, context: CommandContext) => Promise<CommandResult>;
  readonly isEnabled: (commandId: string, context: CommandContext) => boolean;
}

export interface StartScreenSnapshot {
  readonly host: StartScreenHost | null;
  readonly section: StartSection;
  /** Shared with the inspector, which describes the selection without opening it. */
  readonly selectedProjectId: string | null;
  /** The gallery card shown in the inspector while on Templates. */
  readonly selectedTemplateId: string | null;
  /** Bumped by palette commands so the mounted list can react without props. */
  readonly searchFocusNonce: number;
  readonly rebuildNonce: number;
  /** Palette request to focus the recent list; each one is distinct. */
  readonly focusListNonce: number;
  /** A documentation page requested by Help or a deep link; `seq` makes each distinct. */
  readonly docsRequest: { readonly seq: number; readonly page: string } | null;
  /** A palette-driven action on the selected project; `seq` makes each request distinct. */
  readonly selectionAction: { readonly seq: number; readonly kind: SelectionActionKind } | null;
}

export type SelectionActionKind = "open" | "pin" | "remove";

type Listener = () => void;

const INITIAL_SNAPSHOT: StartScreenSnapshot = {
  host: null,
  section: "home",
  selectedProjectId: null,
  selectedTemplateId: null,
  searchFocusNonce: 0,
  rebuildNonce: 0,
  focusListNonce: 0,
  docsRequest: null,
  selectionAction: null,
};

class StartScreenStore {
  private listeners = new Set<Listener>();
  private snapshot = INITIAL_SNAPSHOT;

  getSnapshot = (): StartScreenSnapshot => this.snapshot;

  getServerSnapshot = (): StartScreenSnapshot => INITIAL_SNAPSHOT;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSection(section: StartSection): void {
    if (this.snapshot.section === section) return;
    this.publish({ ...this.snapshot, section });
  }

  requestSearchFocus(): void {
    this.publish({ ...this.snapshot, searchFocusNonce: this.snapshot.searchFocusNonce + 1 });
  }

  requestSelectionAction(kind: SelectionActionKind): void {
    const seq = (this.snapshot.selectionAction?.seq ?? 0) + 1;
    this.publish({ ...this.snapshot, selectionAction: { seq, kind } });
  }

  requestListFocus(): void {
    this.publish({ ...this.snapshot, focusListNonce: this.snapshot.focusListNonce + 1 });
  }

  /** Show the Docs section, at `page` (relative to the docs root) when given. */
  requestDocs(page = "index.html"): void {
    const seq = (this.snapshot.docsRequest?.seq ?? 0) + 1;
    this.publish({ ...this.snapshot, section: "docs", docsRequest: { seq, page } });
  }

  requestRebuild(): void {
    this.publish({ ...this.snapshot, rebuildNonce: this.snapshot.rebuildNonce + 1 });
  }

  setSelectedTemplate(selectedTemplateId: string | null): void {
    if (this.snapshot.selectedTemplateId === selectedTemplateId) return;
    this.publish({ ...this.snapshot, selectedTemplateId });
  }

  setSelectedProject(selectedProjectId: string | null): void {
    if (this.snapshot.selectedProjectId === selectedProjectId) return;
    this.publish({ ...this.snapshot, selectedProjectId });
  }

  /**
   * The returned detach clears only the host it installed, so a remount that
   * attaches before the previous cleanup runs is not undone by that cleanup.
   * Detaching also returns to Home: closing a project should land on the
   * launcher's front page, not on whichever section was open before.
   */
  attach(host: StartScreenHost): () => void {
    this.publish({ ...this.snapshot, host });
    return () => {
      if (this.snapshot.host === host) this.publish(INITIAL_SNAPSHOT);
    };
  }

  resetForTests(): void {
    this.snapshot = INITIAL_SNAPSHOT;
    this.listeners.clear();
  }

  private publish(next: StartScreenSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const startScreenStore = new StartScreenStore();
