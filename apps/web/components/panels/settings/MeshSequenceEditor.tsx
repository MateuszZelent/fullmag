"use client";

import { Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import SelectField from "../../ui/SelectField";
import type { ScriptBuilderMeshOperationEntry } from "../../../lib/session/types";

/* ── types ── */

const OPERATION_KINDS = [
  { label: "Free Tetrahedral", value: "free_tetrahedral" },
  { label: "Swept (through-thickness)", value: "swept" },
  { label: "Boundary Layers", value: "boundary_layers" },
  { label: "Refine (uniform h)", value: "refine" },
  { label: "Adaptive (AFEM)", value: "adapt" },
  { label: "Size Field", value: "size_field" },
] as const;

function defaultParamsFor(kind: string): Record<string, unknown> {
  switch (kind) {
    case "boundary_layers":
      return { nb_layers: 3, hwall_n: "auto", ratio: 1.2 };
    case "refine":
      return { passes: 1 };
    case "adapt":
      return { theta: 0.5, max_passes: 5 };
    case "size_field":
      return { kind: "Box", params: {} };
    case "swept":
      return {
        through_thickness_elements: 6,
        through_thickness_distribution: "fixed",
        through_thickness_element_ratio: 1.0,
        through_thickness_symmetric: false,
        sweep_face_meshing: "triangular",
      };
    default:
      return {};
  }
}

/* ── props ── */

export interface MeshSequenceEditorProps {
  operations: ScriptBuilderMeshOperationEntry[];
  onChange: (ops: ScriptBuilderMeshOperationEntry[]) => void;
  disabled?: boolean;
}

/* ── component ── */

export default function MeshSequenceEditor({
  operations,
  onChange,
  disabled = false,
}: MeshSequenceEditorProps) {
  function addOperation() {
    onChange([
      ...operations,
      { kind: "free_tetrahedral", params: {} },
    ]);
  }

  function removeOperation(index: number) {
    const next = [...operations];
    next.splice(index, 1);
    onChange(next);
  }

  function updateKind(index: number, kind: string) {
    const next = [...operations];
    next[index] = { kind, params: defaultParamsFor(kind) };
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      {operations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/10 bg-card/40 px-3 py-2.5 text-[0.73rem] text-muted-foreground">
          No operations. The mesher will run the default free-tetrahedral pass
          with the parameters set above.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {operations.map((op, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center gap-2 rounded-lg border border-border/10 bg-card/40 px-2.5 py-2",
                disabled && "opacity-60",
              )}
            >
              <span className="w-4 shrink-0 text-center text-[0.65rem] font-mono text-muted-foreground/60">
                {i + 1}
              </span>
              <div className="flex-1">
                <SelectField
                  label=""
                  value={op.kind}
                  onchange={(val) => updateKind(i, val)}
                  options={OPERATION_KINDS.map((k) => ({ label: k.label, value: k.value }))}
                  disabled={disabled}
                />
              </div>
              <button
                type="button"
                className={cn(
                  "shrink-0 rounded-md p-1.5 text-muted-foreground/50 transition-colors",
                  "hover:bg-destructive/10 hover:text-destructive",
                  disabled && "pointer-events-none",
                )}
                onClick={() => removeOperation(i)}
                disabled={disabled}
                title="Remove operation"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5 text-[0.72rem]"
        onClick={addOperation}
        disabled={disabled}
      >
        <Plus size={13} />
        Add Operation
      </Button>
    </div>
  );
}
