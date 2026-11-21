"use client";

import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Crosshair,
  Ellipsis,
  EyeOff,
  FileCode2,
  Info,
  ListTree,
  PanelRightClose,
  Pin,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { CommandId } from "@/kernel/commands/commandTypes";
import { useSelectionPath } from "@/kernel/selection/selectionPath";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
import { Badge } from "@/shared/ui/Badge";
import { Button, type ButtonProps } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { Input } from "@/shared/ui/Input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/shared/ui/InputGroup";
import { usePanelChromeControls } from "@/shared/ui/PanelFrame";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";
import { cn } from "@/shared/utils/className";

import { CommitBar } from "./CommitBar";
import {
  useInspectorHostContext,
  type InspectorHostBreadcrumbSelection,
} from "./InspectorHostContext";
import {
  InspectorDetailsSection,
  InspectorSection,
  rowMatchesSearchQuery,
} from "./InspectorSection";
import type {
  InspectorActionContext,
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "./types";

const MAX_FACTS = 4;
const FORBIDDEN_FACT_RE =
  /^(?:unknown|unavailable|n\/a|not\s+available|unresolved|identity\s+unknown)(?:\s+.*)?$/i;

/**
 * Strips null, undefined, empty, non-finite, and forbidden placeholder fact literals
 * (`unknown`, `unavailable`, `n/a`, `not available`, `unresolved`) and caps Slot 3 at 4 facts.
 */
export function sanitizeInspectorFacts(
  facts: readonly InspectorFact[],
): InspectorFact[] {
  const sanitized: InspectorFact[] = [];
  for (const fact of facts) {
    if (sanitized.length >= MAX_FACTS) break;
    const { value } = fact;
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || FORBIDDEN_FACT_RE.test(trimmed)) continue;
    }
    sanitized.push(fact);
  }
  return sanitized;
}

export function StatePill({ tone, label }: { tone: InspectorTone; label: string }) {
  return (
    <Badge className="fm-inspector-state-pill" data-slot="inspector-state-pill" data-tone={tone}>
      <span aria-hidden="true" className="fm-inspector-state-pill__dot" />
      <span>{label}</span>
    </Badge>
  );
}

function buildFallbackPythonSnippet<TDraft>(
  spec: InspectorSpec<TDraft>,
  draft: TDraft,
): string {
  const lines: string[] = [
    `# ${spec.identity.kindLabel}: ${spec.identity.title(draft)}`,
    `node = study.get(${JSON.stringify(spec.identity.entityId ?? spec.id)})`,
  ];
  const record = draft as Record<string, unknown>;
  for (const section of spec.sections) {
    if (section.showWhen && !section.showWhen(draft)) continue;
    for (const row of section.rows) {
      if (!row.key || row.type === "custom" || row.type === "readonly" || row.type === "table") {
        continue;
      }
      if (row.showWhen && !row.showWhen(draft)) continue;
      const val = record[row.key];
      const generator = row.toPythonSnippet as ((v: unknown, d: TDraft) => string) | undefined;
      if (generator) {
        lines.push(generator(val, draft));
      } else {
        const pyVal = Array.isArray(val)
          ? `(${val.join(", ")})`
          : typeof val === "boolean"
            ? val
              ? "True"
              : "False"
            : typeof val === "string"
              ? JSON.stringify(val)
              : String(val ?? "None");
        lines.push(`node.${row.key} = ${pyVal}`);
      }
    }
  }
  return lines.join("\n");
}

function mapHeaderButtonVariant(
  variant?: "outline" | "secondary" | "destructive",
): ButtonProps["variant"] {
  if (variant === "destructive") return "danger";
  return "secondary";
}

interface PendingConfirmDialogState {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

function NoticeCard<TDraft>({
  notice,
  ctx,
}: {
  notice: InspectorNotice<TDraft>;
  ctx: InspectorActionContext<TDraft>;
}) {
  const Icon =
    notice.tone === "err" ? CircleAlert : notice.tone === "warn" ? TriangleAlert : Info;

  return (
    <div
      className="fm-inspector-notice"
      data-notice-id={notice.id}
      data-slot="inspector-notice"
      data-tone={notice.tone}
      role={notice.tone === "err" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="fm-inspector-notice__icon" size={16} />
      <div className="fm-inspector-notice__body">
        {notice.title ? <p className="fm-inspector-notice__title">{notice.title}</p> : null}
        <p className="fm-inspector-notice__text">{notice.text}</p>
        {notice.focusFieldKey || notice.quickFix ? (
          <div className="fm-inspector-notice__actions">
            {notice.focusFieldKey ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => ctx.focusField(notice.focusFieldKey!)}
              >
                Go to field
              </Button>
            ) : null}
            {notice.quickFix ? (
              <Button
                size="sm"
                type="button"
                variant={notice.quickFix.ghost ? "ghost" : "secondary"}
                onClick={() => void notice.quickFix?.onApply(ctx)}
              >
                {notice.quickFix.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface InspectorTemplateProps<TDraft> {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  draft: TDraft;
  baseline: TDraft;
  dirtyFields: ReadonlySet<string>;
  touchedFields: ReadonlySet<string>;
  invalidFields: ReadonlyMap<string, string>;
  onFieldChange: <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => void;
  onPatchDraft?: (partial: Partial<TDraft>) => void;
  onFieldTouch: (fieldKey: string) => void;
  onRevertField: (fieldKey: string) => void;
  onRevertAll?: () => void;
  onApply?: () => Promise<boolean> | boolean | void;
  onResetDisplay?: () => Promise<void> | void;
  onFocusField?: (fieldKey: string) => void;
  onParseErrorChange?: (fieldKey: string, error: string | null) => void;
  onSelectNode?: (next: Omit<Selection, "moduleSource">) => void;
  onFitView?: (commandId?: CommandId) => void;
  onRevealInTree?: () => void;
  onTogglePin?: (pinned: boolean) => void;
  pinned?: boolean;
  onHideInspector?: () => void;
  onOpenCodePreview?: (title: string, language: "python" | "json", code: string) => void;
  onNotify?: (title: string, description?: string) => void;
  activeModeTabId?: string;
  onActiveModeTabChange?: (tabId: string) => void;
  displayUnits?: Readonly<Record<string, string>>;
  onDisplayUnitChange?: (fieldKey: string, unit: string) => void;
  applying?: boolean;
  appliedFlash?: boolean;
  appliedMessage?: string | null;
  applyError?: string | null;
  forceShowErrors?: boolean;
  animationKey?: string;
  className?: string;
}

export function InspectorTemplate<TDraft>({
  spec,
  selection,
  draft,
  baseline,
  dirtyFields,
  touchedFields,
  invalidFields,
  onFieldChange,
  onPatchDraft,
  onFieldTouch,
  onRevertField,
  onRevertAll,
  onApply,
  onResetDisplay,
  onFocusField,
  onParseErrorChange,
  onSelectNode,
  onFitView,
  onRevealInTree,
  onTogglePin,
  pinned = false,
  onHideInspector,
  onOpenCodePreview,
  onNotify,
  activeModeTabId: controlledModeTabId,
  onActiveModeTabChange,
  displayUnits: controlledDisplayUnits,
  onDisplayUnitChange,
  applying: controlledApplying = false,
  appliedFlash = false,
  appliedMessage = null,
  applyError = null,
  forceShowErrors = false,
  animationKey,
  className,
}: InspectorTemplateProps<TDraft>): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState(false);
  const [localApplying, setLocalApplying] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmDialogState | null>(null);
  const [flashState, setFlashState] = useState<{
    fieldKey: string;
    kind: "applied" | "live" | "focus";
  } | null>(null);

  const [uncontrolledTabId, setUncontrolledTabId] = useState<string | undefined>(
    () => spec.modeTabs?.[0]?.id,
  );
  const [uncontrolledUnits, setUncontrolledUnits] = useState<Record<string, string>>({});
  const [sectionOpenOverrides, setSectionOpenOverrides] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);

  const targetIdentity = `${selection.nodeId ?? selection.kind}:${spec.id}`;
  const prevTargetRef = useRef(targetIdentity);
  useEffect(() => {
    if (prevTargetRef.current === targetIdentity) return;
    prevTargetRef.current = targetIdentity;
    setScrolled(false);
    setSearchOpen(false);
    setSearchQuery("");
    setDetailsOpen(false);
    setPendingConfirm(null);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [targetIdentity]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  const currentModeTabId = useMemo(() => {
    const tabs = spec.modeTabs;
    if (!tabs || tabs.length === 0) return undefined;
    if (controlledModeTabId && tabs.some((tab) => tab.id === controlledModeTabId)) {
      return controlledModeTabId;
    }
    if (uncontrolledTabId && tabs.some((tab) => tab.id === uncontrolledTabId)) {
      return uncontrolledTabId;
    }
    return tabs[0]?.id;
  }, [controlledModeTabId, spec.modeTabs, uncontrolledTabId]);

  const handleModeTabChange = useCallback(
    (nextTabId: string) => {
      setUncontrolledTabId(nextTabId);
      onActiveModeTabChange?.(nextTabId);
    },
    [onActiveModeTabChange],
  );

  const displayUnits = controlledDisplayUnits ?? uncontrolledUnits;
  const handleDisplayUnitChange = useCallback(
    (fieldKey: string, unit: string) => {
      if (onDisplayUnitChange) {
        onDisplayUnitChange(fieldKey, unit);
      } else {
        setUncontrolledUnits((prev) => ({ ...prev, [fieldKey]: unit }));
      }
    },
    [onDisplayUnitChange],
  );

  const isSectionOpen = useCallback(
    (sectionId: string, defaultOpen = true): boolean => {
      const scopedKey = `${spec.id}:${sectionId}`;
      const override = sectionOpenOverrides[scopedKey];
      return override !== undefined ? override : defaultOpen;
    },
    [sectionOpenOverrides, spec.id],
  );

  const setSectionOpen = useCallback(
    (sectionId: string, nextOpen: boolean) => {
      const scopedKey = `${spec.id}:${sectionId}`;
      setSectionOpenOverrides((prev) => ({ ...prev, [scopedKey]: nextOpen }));
    },
    [spec.id],
  );

  const setAllSectionsOpen = useCallback(
    (nextOpen: boolean) => {
      setSectionOpenOverrides((prev) => {
        const next = { ...prev };
        for (const section of spec.sections) {
          next[`${spec.id}:${section.id}`] = nextOpen;
        }
        return next;
      });
    },
    [spec.id, spec.sections],
  );

  const focusField = useCallback(
    (fieldKey: keyof TDraft & string) => {
      // Locate the owning section (switching mode tab and opening the section if needed).
      for (const section of spec.sections) {
        if (section.rows.some((row) => row.key === fieldKey)) {
          if (section.modeTabId && section.modeTabId !== currentModeTabId) {
            handleModeTabChange(section.modeTabId);
          }
          setSectionOpen(section.id, true);
          break;
        }
      }
      setFlashState({ fieldKey, kind: "focus" });
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null;
        setFlashState(null);
      }, 900);
      onFocusField?.(fieldKey);
    },
    [currentModeTabId, handleModeTabChange, onFocusField, setSectionOpen, spec.sections],
  );

  const actionContext = useMemo<InspectorActionContext<TDraft>>(
    () => ({
      specId: spec.id,
      selection,
      draft,
      baseline,
      setField: onFieldChange,
      patchDraft: (partial) => {
        if (onPatchDraft) {
          onPatchDraft(partial);
          return;
        }
        for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
          onFieldChange(k as keyof TDraft & string, v as TDraft[keyof TDraft & string]);
        }
      },
      revertField: onRevertField,
      focusField,
      selectNode: (next) => onSelectNode?.(next),
      openCodePreview: (title, language, code) => onOpenCodePreview?.(title, language, code),
      notify: (title, description) => onNotify?.(title, description),
    }),
    [
      baseline,
      draft,
      focusField,
      onFieldChange,
      onNotify,
      onOpenCodePreview,
      onPatchDraft,
      onRevertField,
      onSelectNode,
      selection,
      spec.id,
    ],
  );

  const activeTab = useMemo(
    () => (spec.modeTabs ?? []).find((tab) => tab.id === currentModeTabId),
    [currentModeTabId, spec.modeTabs],
  );
  const effectiveCommitMode = activeTab?.commitModeOverride ?? spec.commitBar.mode;

  const isApplying = controlledApplying || localApplying;
  const lockReason =
    spec.commitBar.mode === "staged" ? (spec.commitBar.lockReason?.(draft) ?? null) : null;

  const runDirectApply = useCallback(async () => {
    setLocalApplying(true);
    try {
      if (onApply) {
        await onApply();
      } else if (spec.commitBar.mode === "staged") {
        await spec.commitBar.onApply(draft, baseline);
      }
    } finally {
      setLocalApplying(false);
    }
  }, [baseline, draft, onApply, spec.commitBar]);

  const triggerApply = useCallback(() => {
    if (effectiveCommitMode !== "staged") return;
    if (dirtyFields.size === 0 || invalidFields.size > 0 || isApplying || Boolean(lockReason)) {
      return;
    }

    if (spec.commitBar.mode === "staged") {
      const confirmSpec = spec.commitBar.confirmApply?.(draft, baseline) ?? null;
      if (confirmSpec) {
        setPendingConfirm({
          title: confirmSpec.title,
          description: confirmSpec.description,
          confirmLabel: confirmSpec.confirmLabel,
          destructive: confirmSpec.destructive,
          onConfirm: runDirectApply,
        });
        return;
      }
    }

    void runDirectApply();
  }, [
    baseline,
    dirtyFields.size,
    draft,
    effectiveCommitMode,
    invalidFields.size,
    isApplying,
    lockReason,
    runDirectApply,
    spec.commitBar,
  ]);

  const handleRevertAll = useCallback(() => {
    if (onRevertAll) {
      onRevertAll();
      return;
    }
    for (const key of dirtyFields) {
      onRevertField(key);
    }
    if (spec.commitBar.mode === "staged") {
      spec.commitBar.onRevert?.(baseline);
    }
  }, [baseline, dirtyFields, onRevertAll, onRevertField, spec.commitBar]);

  const handleResetDisplay = useCallback(() => {
    if (onResetDisplay) {
      void onResetDisplay();
      return;
    }
    if (spec.commitBar.mode === "liveViewport") {
      void spec.commitBar.onResetDisplay();
    }
  }, [onResetDisplay, spec.commitBar]);

  const totalRowCount = useMemo(
    () => spec.sections.reduce((acc, section) => acc + section.rows.length, 0),
    [spec.sections],
  );
  const isSearchable = spec.header.searchable ?? totalRowCount >= 4;

  const openSearch = useCallback(() => {
    if (!isSearchable) return;
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [isSearchable]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleAsideKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && isSearchable) {
        event.preventDefault();
        openSearch();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        triggerApply();
      }
    },
    [isSearchable, openSearch, triggerApply],
  );

  const sanitizedFacts = useMemo(
    () => sanitizeInspectorFacts(spec.facts(draft)),
    [draft, spec],
  );
  const notices = useMemo(() => spec.notices?.(draft) ?? [], [draft, spec]);
  const detailsEntries = useMemo(() => spec.details?.(draft) ?? [], [draft, spec]);
  const statePill = spec.identity.statePill(draft);
  const IdentityIcon = spec.identity.icon;

  const trimmedQuery = searchQuery.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  // When searching, scan ALL sections across ALL modeTabs; otherwise filter by activeModeTabId.
  const sectionsToRender = useMemo(() => {
    if (normalizedQuery) return spec.sections;
    return spec.sections.filter(
      (section) => !section.modeTabId || section.modeTabId === currentModeTabId,
    );
  }, [currentModeTabId, normalizedQuery, spec.sections]);

  const matchCount = useMemo(() => {
    if (!normalizedQuery) return 0;
    let count = 0;
    for (const section of spec.sections) {
      if (section.showWhen && !section.showWhen(draft)) continue;
      for (const row of section.rows) {
        if (row.showWhen && !row.showWhen(draft)) continue;
        if (rowMatchesSearchQuery(row, section.title, normalizedQuery)) {
          count += 1;
        }
      }
    }
    return count;
  }, [draft, normalizedQuery, spec.sections]);

  const firstInvalidFieldKey = useMemo<(keyof TDraft & string) | null>(() => {
    const firstKey = invalidFields.keys().next().value;
    return (firstKey as (keyof TDraft & string) | undefined) ?? null;
  }, [invalidFields]);

  const hasLiveSection = useMemo(
    () => spec.sections.some((section) => Boolean(section.live)),
    [spec.sections],
  );

  const renameFieldKey = spec.identity.renameFieldKey;
  const renameValue = renameFieldKey
    ? String((draft as Record<string, unknown>)[renameFieldKey] ?? "")
    : "";

  const stableAnimationKey =
    animationKey ?? `${selection.nodeId ?? selection.kind}:${currentModeTabId ?? "default"}`;

  const primaryAction = spec.header.primaryHeaderAction;
  const PrimaryActionIcon = primaryAction?.icon;

  const chrome = usePanelChromeControls();
  const host = useInspectorHostContext();
  const hostNodeId =
    host?.descriptor.metadata.find((item) => item.label === "Node")?.value ??
    selection.nodeId ??
    undefined;
  const treePath = useSelectionPath(host ? hostNodeId : null);

  const resolvedBreadcrumbs = useMemo(() => {
    if (host && treePath && treePath.crumbs.length > 0) {
      return treePath.crumbs;
    }
    if (spec.header.breadcrumbs.length > 0) {
      return spec.header.breadcrumbs;
    }
    if (host && host.descriptor.breadcrumbs.length > 0) {
      return host.descriptor.breadcrumbs;
    }
    return [];
  }, [host, spec.header.breadcrumbs, treePath]);

  const handleBreadcrumbSelect = useCallback(
    (crumbSelection: InspectorHostBreadcrumbSelection) => {
      if (host) {
        host.onSelectBreadcrumb(crumbSelection);
        return;
      }
      actionContext.selectNode(crumbSelection as Omit<Selection, "moduleSource">);
    },
    [actionContext, host],
  );

  const copyableNodeId = spec.identity.entityId ?? hostNodeId;
  const showFitView = host ? !host.focusDisabled : Boolean(spec.header.canFitView);
  const handleFitViewClick = useCallback(() => {
    if (spec.header.fitCommandId && onFitView) {
      onFitView(spec.header.fitCommandId);
      return;
    }
    if (host && !host.focusDisabled) {
      host.onFocus();
      return;
    }
    onFitView?.(spec.header.fitCommandId);
  }, [host, onFitView, spec.header.fitCommandId]);

  const nodeMenuItems = (
    <>
      <DropdownMenuLabel>{spec.identity.kindLabel}</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem
          disabled={!copyableNodeId}
          onSelect={() => {
            if (!copyableNodeId) return;
            navigator.clipboard?.writeText(copyableNodeId).catch(() => undefined);
            actionContext.notify("Copied node ID", copyableNodeId);
          }}
        >
          <Copy aria-hidden="true" size={14} />
          <span>Copy node ID</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            const code =
              spec.toPythonModuleSnippet?.(draft) ??
              buildFallbackPythonSnippet(spec, draft);
            actionContext.openCodePreview(
              `${spec.identity.title(draft)} as Python`,
              "python",
              code,
            );
          }}
        >
          <FileCode2 aria-hidden="true" size={14} />
          <span>Show as Python</span>
        </DropdownMenuItem>
        {onRevealInTree ? (
          <DropdownMenuItem onSelect={() => onRevealInTree()}>
            <ListTree aria-hidden="true" size={14} />
            <span>Reveal in Explorer tree</span>
          </DropdownMenuItem>
        ) : null}
        {onTogglePin ? (
          <DropdownMenuItem onSelect={() => onTogglePin(!pinned)}>
            <Pin aria-hidden="true" size={14} />
            <span>{pinned ? "Unpin inspector" : "Pin inspector"}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>

      {spec.header.extraMenuActions && spec.header.extraMenuActions.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {spec.header.extraMenuActions.map((action) => {
              const ActionIcon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.id}
                  disabled={Boolean(action.disabledReason)}
                  onSelect={() => {
                    if (action.confirm) {
                      setPendingConfirm({
                        title: action.confirm.title,
                        description: action.confirm.description,
                        confirmLabel: action.confirm.confirmLabel,
                        destructive: action.destructive,
                        onConfirm: () => action.onSelect(actionContext),
                      });
                    } else {
                      void action.onSelect(actionContext);
                    }
                  }}
                >
                  <ActionIcon aria-hidden="true" size={14} />
                  <span>{action.label}</span>
                  {action.shortcut ? (
                    <span className="fm-inspector-menu-shortcut">
                      {action.shortcut}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onSelect={() => setAllSectionsOpen(true)}>
          <ChevronsUpDown aria-hidden="true" size={14} />
          <span>Expand all sections</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setAllSectionsOpen(false)}>
          <ChevronsDownUp aria-hidden="true" size={14} />
          <span>Collapse all sections</span>
        </DropdownMenuItem>
        {!chrome && onHideInspector ? (
          <DropdownMenuItem onSelect={() => onHideInspector()}>
            <EyeOff aria-hidden="true" size={14} />
            <span>Hide Inspector panel</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>

      {spec.header.deleteAction ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              const del = spec.header.deleteAction!;
              setPendingConfirm({
                title: del.confirmTitle(draft),
                description: del.confirmDescription,
                confirmLabel: del.label ?? "Delete",
                destructive: true,
                onConfirm: () => del.onDelete(actionContext),
              });
            }}
          >
            <Trash2 aria-hidden="true" size={14} />
            <span>{spec.header.deleteAction.label ?? "Delete…"}</span>
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <aside
        aria-label="Inspector"
        className={cn("fm-inspector", className)}
        data-domain={spec.identity.domain}
        data-inspector-owner={host?.descriptor.ownerId ?? spec.id}
        data-slot="inspector-root"
        onKeyDown={handleAsideKeyDown}
      >
        {/* ── Slots 1–4: Sticky Glass Header ── */}
        <header
          className="fm-inspector__header"
          data-scrolled={scrolled ? "true" : "false"}
          data-slot="inspector-header"
        >
          {/* Slot 1: Unified Panel Chrome, Path & Node Actions */}
          <div className="fm-inspector__path-bar" data-slot="inspector-path-bar">
            {chrome?.move}

            <nav aria-label="Inspector breadcrumb" className="fm-inspector__breadcrumbs">
              <ol className="fm-inspector__breadcrumb-list">
                {resolvedBreadcrumbs.map((crumb, index) => {
                  const isLast = index === resolvedBreadcrumbs.length - 1;
                  return (
                    <li key={crumb.id} className="fm-inspector__breadcrumb-item">
                      {index > 0 ? (
                        <ChevronRight
                          aria-hidden="true"
                          className="fm-inspector__breadcrumb-separator"
                          size={12}
                        />
                      ) : null}
                      {isLast ? (
                        <span aria-current="page" className="fm-inspector__breadcrumb">
                          {crumb.label}
                        </span>
                      ) : crumb.selection ? (
                        <button
                          className="fm-inspector__breadcrumb"
                          type="button"
                          onClick={() => handleBreadcrumbSelect(crumb.selection!)}
                        >
                          {crumb.label}
                        </button>
                      ) : (
                        <span className="fm-inspector__breadcrumb">{crumb.label}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>

            <div className="fm-inspector__path-actions">
              {isSearchable ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Find a property"
                      aria-pressed={searchOpen}
                      className="fm-inspector-header-btn"
                      size="icon"
                      type="button"
                      variant="ghost"
                      onClick={() => (searchOpen ? closeSearch() : openSearch())}
                    >
                      <Search aria-hidden="true" size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Find a property (Ctrl+F)</TooltipContent>
                </Tooltip>
              ) : null}

              {showFitView ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Fit view to selection"
                      className="fm-inspector-header-btn"
                      size="icon"
                      type="button"
                      variant="ghost"
                      onClick={handleFitViewClick}
                    >
                      <Crosshair aria-hidden="true" size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Fit view to selection</TooltipContent>
                </Tooltip>
              ) : null}

              {chrome ? (
                chrome.actions(nodeMenuItems)
              ) : (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          aria-label="More actions"
                          className="fm-inspector-header-btn"
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Ellipsis aria-hidden="true" size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>More actions</TooltipContent>
                  </Tooltip>

                  <DropdownMenuContent align="end">{nodeMenuItems}</DropdownMenuContent>
                </DropdownMenu>
              )}

              {host ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Hide Inspector"
                      className="fm-inspector-header-btn fm-inspector__panel-toggle"
                      data-panel-toggle="inspector"
                      size="icon"
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        chrome
                          ? chrome.hideWith(host.onToggleVisibility)
                          : host.onToggleVisibility()
                      }
                    >
                      <PanelRightClose aria-hidden="true" size={15} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Hide Inspector</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>

          {host && host.descriptor.metadata.length > 0 ? (
            <dl className="fm-inspector__metadata" data-slot="inspector-metadata" hidden>
              {host.descriptor.metadata.map((item) => (
                <div
                  className="fm-inspector__metadata-item"
                  key={`${item.label}=${item.value}`}
                >
                  <dt>{item.label}</dt>
                  <dd data-metadata-value={item.value}>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {/* Slot 2: Identity */}
          <div className="fm-inspector__identity" data-slot="inspector-identity">
            <span aria-hidden="true" className="fm-inspector__identity-icon">
              <IdentityIcon size={20} />
            </span>

            <div className="fm-inspector__identity-copy">
              {renameFieldKey ? (
                <Input
                  aria-label="Name"
                  className="fm-inspector__rename-input"
                  spellCheck={false}
                  type="text"
                  value={renameValue}
                  onChange={(event) =>
                    onFieldChange(
                      renameFieldKey,
                      event.target.value as TDraft[typeof renameFieldKey],
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onRevertField(renameFieldKey);
                      event.currentTarget.blur();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <h2 className="fm-inspector__title">{spec.identity.title(draft)}</h2>
              )}

              <div className="fm-inspector__subtitle">
                <span>{spec.identity.kindLabel}</span>
                {spec.identity.entityId ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={`Copy ID ${spec.identity.entityId}`}
                        className="fm-inspector__id-chip"
                        type="button"
                        onClick={() => {
                          const idText = spec.identity.entityId!;
                          navigator.clipboard?.writeText(idText).catch(() => undefined);
                          setCopiedId(true);
                          actionContext.notify("Copied ID", idText);
                          setTimeout(() => setCopiedId(false), 1200);
                        }}
                      >
                        <span className="fm-inspector__id-chip-text">
                          {spec.identity.entityId}
                        </span>
                        {copiedId ? (
                          <Check aria-hidden="true" size={12} />
                        ) : (
                          <Copy aria-hidden="true" size={12} />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {copiedId ? "Copied" : `Copy ${spec.identity.entityId}`}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </div>

            <StatePill label={statePill.label} tone={statePill.tone} />
          </div>

          {/* Slot 3: Facts (<= 4 sanitized items, collapsed with 40px/4px scroll hysteresis) */}
          {sanitizedFacts.length > 0 ? (
            <div
              className="fm-inspector__facts-wrap"
              data-collapsed={scrolled ? "true" : "false"}
              data-slot="inspector-facts-wrap"
            >
              <div className="fm-inspector__facts-inner">
                <dl className="fm-inspector__facts" data-slot="inspector-facts">
                  {sanitizedFacts.map((fact) => (
                    <div key={fact.id} className="fm-inspector__fact">
                      <dt className="fm-inspector__fact-label">{fact.label}</dt>
                      <dd
                        className="fm-inspector__fact-value"
                        data-tone={fact.tone ?? "neutral"}
                      >
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}

          {primaryAction && PrimaryActionIcon ? (
            <div className="fm-inspector__primary-action">
              <Button
                disabled={Boolean(primaryAction.disabledReason)}
                disabledReason={primaryAction.disabledReason}
                size="sm"
                type="button"
                variant={mapHeaderButtonVariant(primaryAction.variant)}
                onClick={() => {
                  if (primaryAction.confirm) {
                    setPendingConfirm({
                      title: primaryAction.confirm.title,
                      description: primaryAction.confirm.description,
                      confirmLabel: primaryAction.confirm.confirmLabel,
                      destructive: primaryAction.variant === "destructive",
                      onConfirm: () => primaryAction.onRun(actionContext),
                    });
                  } else {
                    void primaryAction.onRun(actionContext);
                  }
                }}
              >
                <PrimaryActionIcon aria-hidden="true" data-icon="inline-start" size={14} />
                {primaryAction.label}
              </Button>
            </div>
          ) : null}

          {/* Inline property search bar */}
          {searchOpen ? (
            <InputGroup className="fm-inspector__search">
              <InputGroupAddon align="inline-start">
                <Search aria-hidden="true" size={14} />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInputRef}
                aria-label="Find a property"
                data-slot="inspector-search-input"
                placeholder="Find a property"
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
              />
              <InputGroupAddon align="inline-end">
                {trimmedQuery ? (
                  <InputGroupText
                    className="fm-inspector__search-count"
                    data-slot="inspector-search-count"
                  >
                    {matchCount} {matchCount === 1 ? "match" : "matches"}
                  </InputGroupText>
                ) : null}
                <InputGroupButton
                  aria-label="Close search"
                  size="sm"
                  variant="ghost"
                  onClick={closeSearch}
                >
                  <X aria-hidden="true" size={14} />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          ) : null}

          {/* Slot 4: Mode Tabs */}
          {spec.modeTabs && spec.modeTabs.length >= 2 && !trimmedQuery ? (
            <Tabs value={currentModeTabId} onValueChange={handleModeTabChange}>
              <TabsList
                className="fm-inspector__mode-tabs"
                data-slot="inspector-mode-tabs"
                presentation="segmented"
              >
                {spec.modeTabs.map((tab) => {
                  const TabIcon = tab.icon;
                  return (
                    <TabsTrigger
                      key={tab.id}
                      className="fm-inspector__mode-tab"
                      value={tab.id}
                    >
                      {TabIcon ? <TabIcon aria-hidden="true" size={14} /> : null}
                      <span>{tab.label}</span>
                      {tab.badgeCount !== undefined && tab.badgeCount > 0 ? (
                        <span className="fm-inspector__mode-tab-badge">{tab.badgeCount}</span>
                      ) : null}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          ) : null}
        </header>

        {/* ── Slots 5–7: Scrollable Body ── */}
        <div
          ref={scrollRef}
          className="fm-inspector__scroll"
          data-slot="inspector-scroll"
          onScroll={(event) => {
            const y = event.currentTarget.scrollTop;
            if (!scrolled && y > 40) {
              setScrolled(true);
            } else if (scrolled && y < 4) {
              setScrolled(false);
            }
          }}
        >
          <div key={stableAnimationKey} className="fm-inspector__body-inner">
            {/* Slot 5: Notices */}
            {notices.length > 0 ? (
              <div className="fm-inspector__notices" data-slot="inspector-notices">
                {notices.map((notice) => (
                  <NoticeCard key={notice.id} ctx={actionContext} notice={notice} />
                ))}
              </div>
            ) : null}

            {/* Slots 6 & 7: Sections & PropertyRows */}
            {sectionsToRender.map((section) => (
              <InspectorSection
                key={section.id}
                ctx={actionContext}
                dirtyFields={dirtyFields}
                displayUnits={displayUnits}
                filterQuery={searchQuery}
                flashFieldKey={flashState?.fieldKey ?? null}
                flashKind={flashState?.kind}
                forceShowErrors={forceShowErrors}
                invalidFields={invalidFields}
                open={isSectionOpen(section.id, section.defaultOpen ?? true)}
                section={section}
                spec={spec}
                touchedFields={touchedFields}
                onDisplayUnitChange={handleDisplayUnitChange}
                onOpenChange={(nextOpen) => setSectionOpen(section.id, nextOpen)}
                onParseErrorChange={onParseErrorChange}
                onTouchField={onFieldTouch}
              />
            ))}

            {trimmedQuery && matchCount === 0 ? (
              <p className="fm-inspector__search-empty" role="status">
                No property matches “{trimmedQuery}”.
              </p>
            ) : null}

            {!trimmedQuery ? (
              <InspectorDetailsSection
                entries={detailsEntries}
                open={detailsOpen}
                onNotify={onNotify}
                onOpenChange={setDetailsOpen}
              />
            ) : null}
          </div>
        </div>

        {/* ── Slot 8: Floating CommitBar ── */}
        <CommitBar
          appliedFlash={appliedFlash}
          appliedMessage={appliedMessage}
          applyError={applyError}
          applying={isApplying}
          ctx={actionContext}
          dirtyCount={dirtyFields.size}
          effectiveMode={effectiveCommitMode}
          firstInvalidFieldKey={firstInvalidFieldKey}
          hasLiveSection={hasLiveSection}
          invalidCount={invalidFields.size}
          spec={spec.commitBar}
          onApply={triggerApply}
          onFocusFirstInvalid={() => {
            if (firstInvalidFieldKey) focusField(firstInvalidFieldKey);
          }}
          onResetDisplay={handleResetDisplay}
          onRevert={handleRevertAll}
        />

        {/* Shared confirmation AlertDialog for costly apply, extra actions, and delete */}
        <AlertDialog
          open={pendingConfirm !== null}
          onOpenChange={(open) => {
            if (!open) setPendingConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{pendingConfirm?.title}</AlertDialogTitle>
              <AlertDialogDescription>{pendingConfirm?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={pendingConfirm?.destructive ? "danger" : "primary"}
                onClick={() => {
                  const action = pendingConfirm?.onConfirm;
                  setPendingConfirm(null);
                  if (action) void action();
                }}
              >
                {pendingConfirm?.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </aside>
    </TooltipProvider>
  );
}
