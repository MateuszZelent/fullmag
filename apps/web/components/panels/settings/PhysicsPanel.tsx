"use client";

import { useMemo } from "react";

import { useCommand, useModel } from "../../runs/control-room/context-hooks";
import { fmtExp, fmtSI } from "../../runs/control-room/shared";
import { SidebarSection, InfoRow, StatusBadge } from "./primitives";
import {
  buildPhysicsCapabilityView,
  type PhysicsCapabilityViewEntry,
} from "../../../lib/session/physicsCatalog";
import { ensureObjectPhysicsStack } from "../../../lib/session/magneticPhysics";

function formatVector(value: number[] | null | undefined, unit: string): string {
  if (!value || value.length < 3) return "—";
  return value
    .slice(0, 3)
    .map((component) => fmtSI(Number(component) || 0, unit))
    .join(" · ");
}

function availabilityBadge(entry: PhysicsCapabilityViewEntry): {
  label: string;
  tone: "default" | "info" | "success" | "warn";
} {
  if (entry.active) {
    return { label: "Active", tone: "success" };
  }
  if (entry.available && entry.authorableInObjectPanel) {
    return { label: "Available", tone: "info" };
  }
  if (entry.available) {
    return { label: "Backend only", tone: "warn" };
  }
  return { label: "Unavailable", tone: "default" };
}

export default function PhysicsPanel() {
  const cmd = useCommand();
  const model = useModel();
  const solverPlan = model.solverPlan;
  const material = model.material;
  const selectedObject = useMemo(
    () => model.sceneDocument?.objects.find((entry) => entry.id === model.selectedObjectId) ?? null,
    [model.sceneDocument, model.selectedObjectId],
  );
  const selectedMaterialDind = useMemo(() => {
    if (!selectedObject || !model.sceneDocument) return null;
    return (
      model.sceneDocument.materials.find((entry) => entry.id === selectedObject.material_ref)?.properties.Dind
      ?? null
    );
  }, [model.sceneDocument, selectedObject]);
  const physicsStack = useMemo(
    () =>
      ensureObjectPhysicsStack(
        selectedObject?.physics_stack ?? null,
        selectedMaterialDind,
      ),
    [selectedMaterialDind, selectedObject],
  );
  const capabilityEntries = useMemo(
    () => buildPhysicsCapabilityView(cmd.capabilities, physicsStack),
    [cmd.capabilities, physicsStack],
  );

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Active Physics Stack" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow
            label="Backend"
            value={solverPlan?.resolvedBackend ?? solverPlan?.backendKind ?? cmd.sessionFooter.requestedBackend ?? "—"}
          />
          <InfoRow
            label="Integrator"
            value={solverPlan?.integrator ?? model.solverSettings.integrator ?? "—"}
          />
          <InfoRow
            label="Demag realization"
            value={model.scriptBuilderDemagRealization ?? (solverPlan?.demagEnabled ? "resolved by planner" : "disabled")}
          />
          <InfoRow
            label="Exchange BC"
            value={solverPlan?.exchangeBoundary ?? "—"}
          />
          <InfoRow
            label="External field"
            value={formatVector(material?.zeemanField ?? solverPlan?.externalField ?? null, "T")}
          />
          <InfoRow
            label="Gamma"
            value={solverPlan?.gyromagneticRatio != null ? `${fmtExp(solverPlan.gyromagneticRatio)} m/(A·s)` : "—"}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {capabilityEntries.filter((entry) => entry.active).map((entry) => (
            <StatusBadge key={entry.id} label={entry.label} tone="info" />
          ))}
        </div>
      </SidebarSection>

      <SidebarSection title="Capability Matrix" defaultOpen={true}>
        <div className="rounded-lg border border-border/35 bg-background/35 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
          UI reads the current engine capability profile and compares it with the authored object stack. Terms marked as backend only exist in runtime/Python semantics but are not yet first-class in this object editor.
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {capabilityEntries.map((entry) => {
            const badge = availabilityBadge(entry);
            return (
              <div
                key={entry.id}
                className="rounded-lg border border-border/35 bg-background/35 px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{entry.label}</div>
                    <div className="mt-1 text-[0.72rem] text-muted-foreground">{entry.description}</div>
                  </div>
                  <div className="ml-auto flex flex-wrap gap-1">
                    {entry.required ? <StatusBadge label="Required" tone="accent" /> : null}
                    <StatusBadge label={badge.label} tone={badge.tone} />
                  </div>
                </div>
                <div className="mt-2 text-[0.72rem] text-muted-foreground">
                  {entry.detail}
                </div>
                {entry.parameterHints.length > 0 ? (
                  <div className="mt-2 text-[0.68rem] text-muted-foreground">
                    Parameters: {entry.parameterHints.join(" · ")}
                  </div>
                ) : null}
                <div className="mt-2 text-[0.68rem] text-muted-foreground">
                  Runtime tags: <span className="font-mono text-foreground">{entry.backendTerms.join(", ")}</span>
                </div>
              </div>
            );
          })}
        </div>
      </SidebarSection>

      <SidebarSection title="Material Coupling" defaultOpen={true}>
        <div className="grid gap-1">
          <InfoRow label="Ms" value={material?.msat != null ? fmtSI(material.msat, "A/m") : "—"} />
          <InfoRow label="Aex" value={material?.aex != null ? fmtSI(material.aex, "J/m") : "—"} />
          <InfoRow label="Alpha" value={material?.alpha != null ? material.alpha.toPrecision(3) : "—"} />
        </div>
      </SidebarSection>

      {solverPlan?.notes.length ? (
        <SidebarSection title="Planner Notes" defaultOpen={true}>
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100/90">
            {solverPlan.notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        </SidebarSection>
      ) : null}
    </div>
  );
}
