import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { CommandId } from "@/kernel/commands/commandTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

/** Seven canonical visual domains mapped to `--fm-hue-<domain>` and `--fm-hue-<domain>-text`. */
export type InspectorDomain =
  | "geometry"
  | "material"
  | "physics"
  | "study"
  | "visualization"
  | "mesh"
  | "definition";

/** Semantic status tone (strictly decoupled from domain hue). */
export type InspectorTone =
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "live"
  | "stale"
  | "degraded"
  | "neutral";

/** Physical symbol definition card shown in HoverCard on hover or keyboard focus. */
export interface SymbolInfo {
  /** Full physical quantity name in Sentence case (e.g. "Saturation magnetization"). */
  name: string;
  /** Concise physical definition and role in LLG / Maxwell / transport equations. */
  definition: string;
  /** Canonical SI unit label (e.g. "A/m", "J/m", "J/m\u00b3", "T", "dimensionless"). */
  siUnit: string;
  /** Optional reference magnitude range (e.g. "Permalloy \u2248 800 kA/m, YIG \u2248 140 kA/m"). */
  typicalRange?: string;
  /** Optional formula rendered as accessible MathML or clean JSX (never raw LaTeX). */
  formula?: ReactNode;
}

/** Display unit option with exact SI multiplier: `siValue = displayValue * toSiFactor`. */
export interface UnitOption {
  /** Upright UI unit label (e.g. "nm", "kA/m", "mT", "pJ/m", "GHz", "deg"). */
  unit: string;
  /** Conversion factor to the SI value stored in the draft (e.g. `1e-9` for "nm"). */
  toSiFactor: number;
}

/** Single breadcrumb segment in Slot 1. */
export interface InspectorBreadcrumbItem {
  id: string;
  label: string;
  /** Clicking a parent breadcrumb navigates via the guarded selection controller. */
  selection?: Omit<Selection, "moduleSource">;
}

/** Extra domain action inside the Slot 1 "More actions" menu. */
export interface InspectorNodeMenuAction<TDraft> {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  destructive?: boolean;
  disabledReason?: string;
  /** When set, running this action first requires confirmation in an AlertDialog. */
  confirm?: {
    title: string | ((draft: TDraft) => string);
    description?: string | ((draft: TDraft) => string);
    message?: string | ((draft: TDraft) => string);
    confirmLabel: string;
  };
  onSelect: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
}

/** Slot 1 specification: breadcrumb path, property filter, fit view, and node actions. */
export interface InspectorHeaderSpec<TDraft> {
  /** Real ancestor path from the Explorer tree (never fabricated paths). */
  breadcrumbs: readonly InspectorBreadcrumbItem[];
  /** Enables the "Fit view to selection" button when the node has spatial bounds. */
  canFitView?: boolean;
  /** Optional command override (defaults to `viewport-3d.fit-selection`). */
  fitCommandId?: CommandId;
  /** Enables the "Find a property" search toggle (defaults to true when >= 4 rows exist). */
  searchable?: boolean;
  /** Optional prominent node operation in the header (e.g. Re-voxelize, Rebuild mesh, Stop run). */
  primaryHeaderAction?: {
    label: string;
    icon: LucideIcon;
    variant?: "outline" | "secondary" | "destructive";
    disabledReason?: string;
    confirm?: {
      title: string | ((draft: TDraft) => string);
      description?: string | ((draft: TDraft) => string);
      message?: string | ((draft: TDraft) => string);
      confirmLabel: string;
    };
    onRun: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
  };
  /** Extra domain actions appended to the node menu. */
  extraMenuActions?: readonly InspectorNodeMenuAction<TDraft>[];
  /** Optional node delete action backed by a mandatory AlertDialog confirmation. */
  deleteAction?: {
    label?: string;
    confirmTitle: string | ((draft: TDraft) => string);
    confirmDescription?: string | ((draft: TDraft) => string);
    confirmMessage?: string | ((draft: TDraft) => string);
    onDelete: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
  };
}

/** Slot 2 specification: domain glyph, title/inline rename, kind label, copyable ID, and 1 StatePill. */
export interface InspectorIdentitySpec<TDraft> {
  domain: InspectorDomain;
  icon: LucideIcon;
  title: (draft: TDraft) => string;
  /** Draft key that enables inline renaming directly in the Slot 2 heading. */
  renameFieldKey?: keyof TDraft & string;
  /** Node classification in Sentence case (e.g. "Magnetic object", "Relaxation stage"). */
  kindLabel: string;
  /** Canonical copyable identifier pill (omitted when absent). */
  entityId?: string;
  /** Exactly one status pill per node (never "unknown"). */
  statePill: (draft: TDraft) => {
    tone: InspectorTone;
    label: string;
  };
}

/** Single key-value fact tile in Slot 3 (max 4, auto-collapsed on scroll). */
export interface InspectorFact {
  id: string;
  label: ReactNode;
  /** Null, undefined, empty, or forbidden placeholder literals are stripped by `sanitizeInspectorFacts`. */
  value: ReactNode | null | undefined;
  tone?: Extract<InspectorTone, "ok" | "warn" | "err" | "info" | "live" | "stale" | "degraded">;
}

/** Mode tab in Slot 4 (strictly for modes of the same node, never duplicating tree children). */
export interface InspectorModeTab {
  id: string;
  label: string;
  icon?: LucideIcon;
  commitModeOverride?: CommitBarSpec<unknown>["mode"];
  badgeCount?: number;
}

/** Diagnostic or warning notice in Slot 5. */
export interface InspectorNotice<TDraft> {
  id: string;
  tone: "info" | "warn" | "err";
  /** Places mutable follow-up information after the form so it does not shift the current scroll position. */
  placement?: "after-content";
  title?: string;
  text: string;
  /** Jumps directly to the associated field (switches tab, opens section, scrolls, focuses). */
  focusFieldKey?: keyof TDraft & string;
  /** One-click remediation action. */
  quickFix?: {
    label: string;
    ghost?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    onApply: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
  };
}

/** Typed action and row context passed to callbacks, validators, and controlled `custom` slots. */
export interface InspectorActionContext<TDraft> {
  specId: string;
  selection: Selection;
  draft: TDraft;
  baseline: TDraft;
  setField: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  patchDraft: (partial: Partial<TDraft>) => void;
  revertField: (key: keyof TDraft & string) => void;
  focusField: (key: keyof TDraft & string) => void;
  selectNode: (next: Omit<Selection, "moduleSource">) => void;
  openCodePreview: (title: string, language: "python" | "json", code: string) => void;
  notify: (title: string, description?: string) => void;
}

export type InspectorRowContext<TDraft> = InspectorActionContext<TDraft>;

/** Common base properties for every `PropertyRow` in Slot 7. */
export interface InspectorRowBase<
  TDraft,
  K extends (keyof TDraft & string) | undefined = keyof TDraft & string,
  TValue = K extends keyof TDraft ? TDraft[K] : unknown,
> {
  /** Unique property key in `TDraft` (required for editable rows). */
  key?: K;
  /** Sentence-case label without trailing colon or uppercase transform. */
  label?: string;
  /** Italic STIX Two Text physics symbol (e.g. `<>M<sub>s</sub></>`). */
  symbol?: ReactNode;
  /** Physical definition card displayed in HoverCard on hover or keyboard focus. */
  symbolInfo?: SymbolInfo;
  /** Concise physical hint rendered below the control only when it adds new information. */
  hint?: string;
  /** Forces full-width stacked layout even above 22 rem container width. */
  wide?: boolean;
  /** Conditional visibility predicate evaluated against the current draft. */
  showWhen?: (draft: TDraft) => boolean;
  /** Keyboard-accessible disabled reason (rendered via DisabledReason, never bare `title=`). */
  disabledReason?: (draft: TDraft) => string | null;
  /** Synchronous validator returning an error message or null. */
  validate?(value: TValue, draft: TDraft): string | null;
  /** Backend / planner error pinned directly to this field. */
  serverError?: (draft: TDraft) => string | null;
  /** Indicates that editing this field changes conditional visibility of sibling rows. */
  structural?: boolean;
  /** Custom Python DSL generator for the row context menu "Copy as Python" action. */
  toPythonSnippet?(value: TValue, draft: TDraft): string;
}

/** Column descriptor for compact side-inspector tables (`type: "table"`, max 4 columns). */
export interface InspectorTableColumn<TRow = unknown> {
  id: string;
  header: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  renderCell(row: TRow, rowIndex: number): ReactNode;
}

/** Helper table row contract requiring a durable non-content `rowKey`. */
export interface InspectorTableRowSpec<TDraft, TRow = unknown>
  extends InspectorRowBase<TDraft, (keyof TDraft & string) | undefined, unknown> {
  type: "table";
  /** Mandatory durable row key selector (never derive keys from edited cell values). */
  rowKey(row: TRow): string;
  rows(draft: TDraft): readonly TRow[];
  /** At most 4 columns render inline; wider tables open via `expandedViewAction`. */
  columns: readonly InspectorTableColumn<TRow>[];
  maxInlineRows?: number;
  onAddRow?: (ctx: InspectorActionContext<TDraft>) => void;
  onRemoveRow?: (rowId: string, ctx: InspectorActionContext<TDraft>) => void;
  onSelectRow?(row: TRow, ctx: InspectorActionContext<TDraft>): void;
  expandedViewAction?: {
    label: string;
    onOpen: (ctx: InspectorActionContext<TDraft>) => void;
  };
}

/**
 * Full discriminated union `InspectorRowSpec<TDraft>` covering all 11 canonical
 * scientific control families plus 6 auxiliary scalar/presentation variants.
 */
export type InspectorRowSpec<TDraft> =
  | (InspectorRowBase<TDraft, keyof TDraft & string, number> & {
      /** 1. SI physical quantity with lossless in-field unit conversion and symbol drag-scrubbing. */
      type: "quantity";
      units: readonly [UnitOption, ...UnitOption[]];
      defaultDisplayUnit?: string;
      min?: number;
      max?: number;
      minExclusive?: boolean;
      step?: number;
      scrub?: "lin" | "log";
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, number> & {
      /** 2. Dimensionless, integer, or fixed-suffix scalar number. */
      type: "number";
      unitSuffix?: string;
      integer?: boolean;
      min?: number;
      max?: number;
      step?: number;
      scrub?: "lin" | "log";
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, readonly [number, number, number]> & {
      /** 3. 3D vector (x, y, z) with high-contrast axis prefixes, optional units, presets, and normalization. */
      type: "vector3";
      units?: readonly UnitOption[];
      defaultDisplayUnit?: string;
      unitSuffix?: string;
      coordinateModes?: readonly ("cartesian" | "spherical")[];
      axisPresets?: boolean;
      normalizeAction?: boolean;
      vectorNote?: (
        vec: readonly [number, number, number],
        draft: TDraft,
      ) => { tone: "ok" | "warn"; text: string } | null;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** 4. Radix Select dropdown with optional grouping, swatch bar, and disabled reasons. */
      type: "select";
      options: readonly {
        value: string;
        label: string;
        group?: string;
        swatchCss?: string;
        disabledReason?: string;
      }[];
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** 5. Segmented pill or tile grid selector for 2-6 options. */
      type: "segmented";
      presentation?: "pill" | "tiles";
      options: readonly {
        value: string;
        label: string;
        icon?: LucideIcon | ReactNode;
        disabledReason?: string;
      }[];
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, boolean> & {
      /** 6. Binary Radix Switch. */
      type: "switch";
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** 7. Theme-aware color selector with token swatches and custom input. */
      type: "color";
      allowAlpha?: boolean;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** 8. Monospace mathematical expression, path, or identifier field. */
      type: "expression";
      placeholder?: string;
      allowedVariables?: readonly string[];
      multiline?: boolean;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string | null> & {
      /** 9. Typed entity reference picker with jump-to-target and shared-usage warning. */
      type: "reference";
      targetKindLabel: string;
      options: (draft: TDraft) => readonly {
        id: string;
        label: string;
        subtitle?: string;
        tone?: InspectorTone;
        jumpSelection?: Omit<Selection, "moduleSource">;
      }[];
      allowNone?: { label: string };
      sharedUsageWarning?: (draft: TDraft) => string | null;
      onCreateNew?: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
      onDuplicateUnlink?: (ctx: InspectorActionContext<TDraft>) => void | Promise<void>;
    })
  | InspectorTableRowSpec<TDraft>
  | (InspectorRowBase<TDraft, (keyof TDraft & string) | undefined, unknown> & {
      /** 11. Controlled custom slot exclusively for charts and 2D scientific previews. */
      type: "custom";
      render: (ctx: InspectorRowContext<TDraft>) => ReactNode;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** Auxiliary: single-line text field. */
      type: "text";
      placeholder?: string;
      mono?: boolean;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, string> & {
      /** Auxiliary: multi-line authoring notes field. */
      type: "textarea";
      rows?: number;
      placeholder?: string;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, number> & {
      /** Auxiliary: Radix Slider paired with tabular `<output>`. */
      type: "range";
      min: number;
      max: number;
      step: number;
      unitSuffix?: string;
    })
  | (InspectorRowBase<TDraft, keyof TDraft & string, readonly string[]> & {
      /** Auxiliary: multi-select toggle pills (`ToggleGroup type="multiple"`). */
      type: "toggles";
      options: readonly { value: string; label: string; icon?: LucideIcon }[];
    })
  | (InspectorRowBase<TDraft, (keyof TDraft & string) | undefined, unknown> & {
      /** Auxiliary: read-only computed value with optional copy button. */
      type: "readonly";
      format: (draft: TDraft) => ReactNode;
      copyText?: (draft: TDraft) => string | null;
      mono?: boolean;
    })
  | (InspectorRowBase<TDraft, (keyof TDraft & string) | undefined, unknown> & {
      /** Auxiliary: reference chip list with optional jump selection. */
      type: "chips";
      items: (draft: TDraft) => readonly {
        id: string;
        label: string;
        jumpSelection?: Omit<Selection, "moduleSource">;
      }[];
    });

/** Slot 6 specification: unified collapsible section with collapsed summary and dirty/error dot. */
export interface InspectorSectionSpec<TDraft> {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Optional Slot 4 mode tab association (omitted = visible on all tabs). */
  modeTabId?: string;
  /** Initial expanded state (defaults to true). */
  defaultOpen?: boolean;
  /**
   * Renders the rows without the collapsible section card. Reserved for a
   * single hosted workspace that already owns its own groups, so the panel
   * does not stack a section card around nested group cards.
   */
  flush?: boolean;
  /** Marks a live display section inside a staged panel; renders a Live badge and never dirties staged drafts. */
  live?: boolean;
  /** Conditional section visibility predicate. */
  showWhen?: (draft: TDraft) => boolean;
  /** Single-line summary shown ONLY while the section is collapsed. */
  summary?: (draft: TDraft) => string;
  rows: readonly InspectorRowSpec<TDraft>[];
  emptyState?: (draft: TDraft) => {
    icon?: LucideIcon;
    title: string;
    description: string;
    action?: { label: string; onRun: (ctx: InspectorActionContext<TDraft>) => void };
  } | null;
  /** Section-level helper actions (e.g. "Assign from library..."), never Apply/Revert. */
  footer?: (ctx: InspectorRowContext<TDraft>) => ReactNode;
}

/** Slot 8 specification: floating CommitBar with four mutually exclusive session modes. */
export type CommitBarSpec<TDraft> =
  | {
      mode: "staged";
      /**
       * Allows applying even when `dirtyFields.size === 0` (e.g. creating a default
       * draft resource or reapplying a texture after geometry/mesh rebuilds).
       */
      allowCleanApply?: boolean | ((draft: TDraft, baseline: TDraft) => boolean);
      /**
       * Optional label for the primary Apply button (defaults to `"Apply"`).
       * Accepts either a static string or `(draft, dirty) => label`.
       */
      applyLabel?: string | ((draft: TDraft, dirty: boolean) => string);
      cleanMessage?: (draft: TDraft) => string;
      lockReason?: (draft: TDraft) => string | null;
      confirmApply?: (
        draft: TDraft,
        baseline: TDraft,
      ) => {
        title: string;
        description: string;
        confirmLabel: string;
        destructive?: boolean;
      } | null;
      onApply: (
        draft: TDraft,
        baseline: TDraft,
      ) => Promise<boolean | void> | boolean | void;
      onRevert?: (baseline: TDraft) => void;
    }
  | {
      mode: "liveViewport";
      statusMessage?: string;
      hasOverrides: (draft: TDraft, baseline: TDraft) => boolean;
      onResetDisplay: () => void | Promise<void>;
    }
  | {
      mode: "immediate";
      statusMessage: (draft: TDraft) => string;
      actions?: readonly {
        id: string;
        label: string;
        icon?: LucideIcon;
        variant?: "primary" | "secondary" | "outline" | "destructive";
        disabledReason?: (draft: TDraft) => string | null;
        onRun: (ctx: InspectorActionContext<TDraft>) => Promise<void>;
      }[];
    }
  | {
      mode: "readOnly";
      statusMessage?: (draft: TDraft) => string;
    };

/** Canonical declarative descriptor for any Inspector view rendered by `InspectorTemplate`. */
export interface InspectorSpec<TDraft> {
  id: string;
  header: InspectorHeaderSpec<TDraft>;
  identity: InspectorIdentitySpec<TDraft>;
  facts: (draft: TDraft) => readonly InspectorFact[];
  modeTabs?: readonly InspectorModeTab[];
  notices?: (draft: TDraft) => readonly InspectorNotice<TDraft>[];
  sections: readonly InspectorSectionSpec<TDraft>[];
  details?: (draft: TDraft) => readonly {
    label: string;
    value: string | null | undefined;
    mono?: boolean;
  }[];
  toPythonModuleSnippet?: (draft: TDraft) => string;
  commitBar: CommitBarSpec<TDraft>;
}
