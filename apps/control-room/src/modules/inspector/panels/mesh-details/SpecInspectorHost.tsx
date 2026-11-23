"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { useKernel } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  InspectorTemplate,
  useInspectorSpecController,
  type InspectorSpec,
  type UseInspectorSpecControllerOptions,
} from "../../template";

export interface SpecInspectorHostProps<TDraft extends object> {
  spec: InspectorSpec<TDraft>;
  selection: Selection;
  baseline: TDraft;
  serverFieldErrors?: Readonly<Record<string, string | null | undefined>>;
  options?: UseInspectorSpecControllerOptions<TDraft>;
  seedStagedOverrides?: Partial<TDraft>;
  onAfterFieldChange?: <K extends keyof TDraft & string>(
    key: K,
    value: TDraft[K],
    helpers: {
      draft: TDraft;
      patchDraft: (partial: Partial<TDraft>) => void;
    },
  ) => void;
  className?: string;
}

interface CodePreviewModalState {
  title: string;
  language: "python" | "json";
  code: string;
}

/**
 * Shared Wave 5 host binding any declarative `InspectorSpec<TDraft>` to
 * `useInspectorSpecController`, `InspectorTemplate`, guarded selection navigation,
 * 3D fit commands, and a Radix `Dialog` code preview modal.
 */
export function SpecInspectorHost<TDraft extends object>({
  spec,
  selection,
  baseline,
  serverFieldErrors,
  options,
  seedStagedOverrides,
  onAfterFieldChange,
  className,
}: SpecInspectorHostProps<TDraft>): ReactNode {
  const kernel = useKernel();
  const controller = useInspectorSpecController(
    spec,
    selection,
    baseline,
    serverFieldErrors,
    options,
  );
  const [pinned, setPinned] = useState(false);
  const [codePreview, setCodePreview] = useState<CodePreviewModalState | null>(null);
  const seededTargetRef = useRef<string | null>(null);
  const seedKey = `${selection.nodeId ?? selection.kind ?? ""}:${spec.id}`;

  useLayoutEffect(() => {
    if (!seedStagedOverrides) {
      seededTargetRef.current = null;
      return;
    }
    if (seededTargetRef.current === seedKey) return;
    seededTargetRef.current = seedKey;
    controller.patchDraft(seedStagedOverrides);
  }, [controller, seedKey, seedStagedOverrides]);

  const handleFieldChange = useCallback(
    <K extends keyof TDraft & string>(key: K, value: TDraft[K]) => {
      controller.setField(key, value);
      onAfterFieldChange?.(key, value, {
        draft: controller.draft,
        patchDraft: controller.patchDraft,
      });
    },
    [controller, onAfterFieldChange],
  );

  const handleSelectNode = useCallback(
    (next: Omit<Selection, "moduleSource">) => {
      kernel?.selection?.set?.(next, "inspector");
    },
    [kernel],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      const targetCommand = commandId ?? "viewport-3d.fit-selection";
      if (!kernel?.commands?.execute) return;
      void kernel.commands.execute(
        targetCommand,
        createCommandContext("inspector", kernel, {
          sourceDetail: spec.id,
        }),
      );
    },
    [kernel, spec.id],
  );

  const handleHideInspector = useCallback(() => {
    kernel?.layout?.setPanelVisible?.("right", false);
  }, [kernel]);

  const handleOpenCodePreview = useCallback(
    (title: string, language: "python" | "json", code: string) => {
      setCodePreview({ title, language, code });
    },
    [],
  );

  return (
    <>
      <InspectorTemplate
        activeModeTabId={controller.activeModeTabId}
        animationKey={controller.animationKey}
        appliedFlash={controller.appliedFlash}
        applyError={controller.applyError}
        applying={controller.applying}
        baseline={controller.baseline}
        className={className}
        dirtyFields={controller.dirtyFields}
        displayUnits={controller.displayUnits}
        draft={controller.draft}
        forceShowErrors={controller.forceShowErrors}
        invalidFields={controller.invalidFields}
        pinned={pinned}
        selection={selection}
        spec={spec}
        touchedFields={controller.touchedFields}
        onActiveModeTabChange={controller.setActiveModeTabId}
        onApply={controller.requestApply}
        onDisplayUnitChange={controller.setDisplayUnit}
        onFieldChange={handleFieldChange}
        onFieldTouch={controller.touchField}
        onFitView={handleFitView}
        onFocusField={(key) => controller.focusField(key as keyof TDraft & string)}
        onHideInspector={handleHideInspector}
        onOpenCodePreview={handleOpenCodePreview}
        onParseErrorChange={controller.setParseError}
        onPatchDraft={controller.patchDraft}
        onResetDisplay={controller.resetDisplay}
        onRevertAll={controller.revertAll}
        onRevertField={controller.revertField}
        onSelectNode={handleSelectNode}
        onTogglePin={setPinned}
      />

      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        {codePreview ? (
          <DialogContent aria-label={codePreview.title}>
            <DialogHeader>
              <DialogTitle>{codePreview.title}</DialogTitle>
              <DialogDescription>
                {codePreview.language === "python"
                  ? "Reproducible Fullmag Python DSL representation of the current draft."
                  : "Structured diagnostic snapshot."}
              </DialogDescription>
            </DialogHeader>
            <pre className="fm-inspector-code-preview">
              <code>{codePreview.code}</code>
            </pre>
            <DialogFooter>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(codePreview.code).catch(() => undefined);
                }}
              >
                Copy to clipboard
              </Button>
              <DialogClose asChild>
                <Button size="sm" type="button" variant="primary">
                  Close
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
