"use client";

import { useCallback, useMemo } from "react";
import type {
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderExcitationAnalysisEntry,
} from "../../../lib/session/types";
import { useModel } from "../../runs/control-room/ControlRoomContext";
import { useViewport } from "../../runs/control-room/context-hooks";
import { useSelectionActions } from "@/features/selection";
import { fmtSI, resolveAntennaNodeName } from "../../runs/control-room/shared";
import { TextField } from "../../ui/TextField";
import SelectField from "../../ui/SelectField";
import { Button } from "../../ui/button";
import { SidebarSection, InspectorStatTile } from "./primitives";
import { cn } from "@/lib/utils";

const DEFAULT_SOLVER = "mqs_2p5d_az";

function readNumber(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  return typeof params[key] === "number" ? Number(params[key]) : fallback;
}

function nextModuleName(
  prefix: string,
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): string {
  let index = modules.length + 1;
  while (modules.some((module) => module.name === `${prefix}_${index}`)) {
    index += 1;
  }
  return `${prefix}_${index}`;
}

function microstripParamsFrom(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    width: readNumber(params, "width", readNumber(params, "signal_width", 1e-6)),
    thickness: readNumber(params, "thickness", 100e-9),
    height_above_magnet: readNumber(params, "height_above_magnet", 200e-9),
    preview_length: readNumber(params, "preview_length", 5e-6),
    center_x: readNumber(params, "center_x", 0),
    center_y: readNumber(params, "center_y", 0),
    current_distribution: "uniform",
  };
}

function cpwParamsFrom(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const width = readNumber(params, "width", 1e-6);
  return {
    signal_width: readNumber(params, "signal_width", width),
    gap: readNumber(params, "gap", 0.25e-6),
    ground_width: readNumber(params, "ground_width", width),
    thickness: readNumber(params, "thickness", 100e-9),
    height_above_magnet: readNumber(params, "height_above_magnet", 200e-9),
    preview_length: readNumber(params, "preview_length", 5e-6),
    center_x: readNumber(params, "center_x", 0),
    center_y: readNumber(params, "center_y", 0),
    current_distribution: "uniform",
  };
}

function makeAntennaModule(
  kind: "MicrostripAntenna" | "CPWAntenna",
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): ScriptBuilderCurrentModuleEntry {
  return {
    kind: "antenna_field_source",
    name: nextModuleName(kind === "CPWAntenna" ? "cpw" : "microstrip", modules),
    solver: DEFAULT_SOLVER,
    air_box_factor: 12,
    antenna_kind: kind,
    antenna_params:
      kind === "CPWAntenna" ? cpwParamsFrom({}) : microstripParamsFrom({}),
    drive: {
      current_a: 0.01,
      frequency_hz: null,
      phase_rad: 0,
      waveform: null,
    },
  };
}

function antennaKindLabel(kind: string): string {
  return kind === "CPWAntenna" ? "CPW" : "Microstrip";
}

function ensureUniqueName(
  rawValue: string,
  activeIndex: number,
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): string {
  const base = rawValue.trim() || `antenna_${activeIndex + 1}`;
  let candidate = base;
  let suffix = 2;
  while (modules.some((module, index) => index !== activeIndex && module.name === candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export default function AntennaPanel({ nodeId }: { nodeId?: string }) {
  const model = useModel();
  const { setSelectedSidebarNodeId } = useSelectionActions();
  const vp = useViewport();
  const modules = model.scriptBuilderCurrentModules;
  const antennaNames = useMemo(() => modules.map((module) => module.name), [modules]);
  const activeName = useMemo(
    () => resolveAntennaNodeName(nodeId, antennaNames),
    [antennaNames, nodeId],
  );
  const activeIndex = useMemo(
    () => (activeName ? modules.findIndex((module) => module.name === activeName) : -1),
    [activeName, modules],
  );
  const activeModule = activeIndex >= 0 ? modules[activeIndex] : null;

  const updateModuleAt = useCallback(
    (
      index: number,
      updater: (module: ScriptBuilderCurrentModuleEntry) => ScriptBuilderCurrentModuleEntry,
    ) => {
      model.setScriptBuilderCurrentModules((prev) => {
        const next = [...prev];
        const target = next[index];
        if (target) {
          next[index] = updater(target);
        }
        return next;
      });
    },
    [model],
  );

  const updateActiveModule = useCallback(
    (updater: (module: ScriptBuilderCurrentModuleEntry) => ScriptBuilderCurrentModuleEntry) => {
      if (activeIndex < 0) {
        return;
      }
      updateModuleAt(activeIndex, updater);
    },
    [activeIndex, updateModuleAt],
  );

  const addModule = useCallback(
    (kind: "MicrostripAntenna" | "CPWAntenna") => {
      const nextModule = makeAntennaModule(kind, modules);
      model.setScriptBuilderCurrentModules((prev) => [...prev, nextModule]);
      setSelectedSidebarNodeId(`ant-${nextModule.name}`);
    },
    [model, modules, setSelectedSidebarNodeId],
  );

  const selectModule = useCallback(
    (name: string) => {
      setSelectedSidebarNodeId(`ant-${name}`);
    },
    [setSelectedSidebarNodeId],
  );

  const renameActiveModule = useCallback(
    (value: string) => {
      if (activeIndex < 0 || !activeModule) {
        return;
      }
      const nextName = ensureUniqueName(value, activeIndex, modules);
      updateModuleAt(activeIndex, (module) => ({ ...module, name: nextName }));
      setSelectedSidebarNodeId(`ant-${nextName}`);
      if (model.scriptBuilderExcitationAnalysis?.source === activeModule.name) {
        model.setScriptBuilderExcitationAnalysis((prev) =>
          prev ? { ...prev, source: nextName } : prev,
        );
      }
    },
    [activeIndex, activeModule, model, modules, updateModuleAt],
  );

  const updateParam = useCallback(
    (key: string, value: string, scale = 1) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      updateActiveModule((module) => ({
        ...module,
        antenna_params: {
          ...module.antenna_params,
          [key]: parsed * scale,
        },
      }));
    },
    [updateActiveModule],
  );

  const updateDrive = useCallback(
    (key: "current_a" | "phase_rad" | "frequency_hz", value: string, scale = 1) => {
      const trimmed = value.trim();
      if (key === "frequency_hz" && trimmed.length === 0) {
        updateActiveModule((module) => ({
          ...module,
          drive: { ...module.drive, frequency_hz: null },
        }));
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return;
      }
      updateActiveModule((module) => ({
        ...module,
        drive: {
          ...module.drive,
          [key]: parsed * scale,
        },
      }));
    },
    [updateActiveModule],
  );

  const switchAntennaKind = useCallback(
    (nextKind: string) => {
      if (nextKind !== "MicrostripAntenna" && nextKind !== "CPWAntenna") {
        return;
      }
      updateActiveModule((module) => ({
        ...module,
        antenna_kind: nextKind,
        antenna_params:
          nextKind === "CPWAntenna"
            ? cpwParamsFrom(module.antenna_params)
            : microstripParamsFrom(module.antenna_params),
      }));
    },
    [updateActiveModule],
  );

  const deleteActiveModule = useCallback(() => {
    if (activeIndex < 0 || !activeModule) {
      return;
    }
    model.setScriptBuilderCurrentModules((prev) => prev.filter((_, index) => index !== activeIndex));
    if (model.scriptBuilderExcitationAnalysis?.source === activeModule.name) {
      model.setScriptBuilderExcitationAnalysis(null);
    }
    setSelectedSidebarNodeId("antennas");
  }, [activeIndex, activeModule, model]);

  const enableExcitationAnalysis = useCallback(() => {
    const fallbackSource = activeModule?.name ?? modules[0]?.name ?? null;
    if (!fallbackSource) {
      return;
    }
    model.setScriptBuilderExcitationAnalysis({
      source: fallbackSource,
      method: "source_k",
      propagation_axis: [1, 0, 0],
      k_max_rad_per_m: null,
      samples: 256,
    });
  }, [activeModule, model, modules]);

  const updateExcitationAnalysis = useCallback(
    (
      updater: (
        analysis: ScriptBuilderExcitationAnalysisEntry,
      ) => ScriptBuilderExcitationAnalysisEntry,
    ) => {
      model.setScriptBuilderExcitationAnalysis((prev) => (prev ? updater(prev) : prev));
    },
    [model],
  );

  const computeAntennaField = useCallback(() => {
    vp.requestPreviewQuantity("H_ant");
    if (vp.previewControlsActive) {
      void vp.patchDisplay({ active_quantity_id: "H_ant" });
    }
  }, [vp]);

  const analysis = model.scriptBuilderExcitationAnalysis;
  const moduleParams = activeModule?.antenna_params ?? {};
  const physicsBadges = [
    "physics 2.5D",
    "preview extruded 3D",
    "current axis +Y",
  ];

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Environment Overview" defaultOpen={true}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-1.5">
            {physicsBadges.map((badge) => (
              <span
                key={badge}
                className="inline-flex w-fit rounded-md border border-border/10 bg-card/40 px-2 py-1 text-[0.58rem] font-bold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {badge}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 py-1">
            <InspectorStatTile label="RF Sources" value={modules.length > 0 ? modules.length : "none"} />
            <InspectorStatTile label="Mesh Top" value={model.meshBoundsMax?.[2] != null ? fmtSI(model.meshBoundsMax[2], "m") : "waiting"} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => addModule("MicrostripAntenna")}>
              + Add Microstrip
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => addModule("CPWAntenna")}>
              + Add CPW
            </Button>
          </div>

          {modules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/10 bg-card/40 p-4 text-[0.72rem] leading-relaxed text-muted-foreground">
              Add a Microstrip or CPW antenna to configure RF synthesis. 3D previews will appear automatically after meshing.
            </div>
          ) : (
            <div className="grid gap-2">
              {modules.map((module) => (
                <button
                  key={module.name}
                  type="button"
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    activeModule?.name === module.name
                      ? "border-primary/40 bg-primary/10"
                      : "border-border/10 bg-card/40 hover:bg-card/60",
                  )}
                  onClick={() => selectModule(module.name)}
                >
                  <span className="text-lg leading-none text-muted-foreground">
                    {module.antenna_kind === "CPWAntenna" ? "≋" : "▭"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {module.name}
                    </span>
                    <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
                      {antennaKindLabel(module.antenna_kind)} · {(module.drive.current_a * 1e3).toFixed(2)} mA
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </SidebarSection>

      {activeModule ? (
        <div key={`${activeModule.name}:${activeModule.antenna_kind}`}>
          <SidebarSection title="Source Definition" defaultOpen={true}>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Name"
                defaultValue={activeModule.name}
                onBlur={(event) => renameActiveModule(event.target.value)}
                mono
                tooltip="Unique identifier for this RF source."
              />
              <SelectField
                label="Type"
                value={activeModule.antenna_kind}
                onchange={switchAntennaKind}
                options={[
                  { label: "Microstrip", value: "MicrostripAntenna" },
                  { label: "CPW", value: "CPWAntenna" },
                ]}
                tooltip="Antenna topology. Microstrip is a single signal line, CPW includes parallel ground planes."
              />
              <SelectField
                label="Solver"
                value={activeModule.solver}
                onchange={(value) =>
                  updateActiveModule((module) => ({ ...module, solver: value }))
                }
                options={[
                  { label: "2.5D MQS (az)", value: DEFAULT_SOLVER },
                ]}
                tooltip="Numerical model used to compute the generated Oersted field limit."
              />
              <TextField
                label="Air Box Factor"
                defaultValue={activeModule.air_box_factor}
                onBlur={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) {
                    return;
                  }
                  updateActiveModule((module) => ({ ...module, air_box_factor: parsed }));
                }}
                mono
                tooltip="Multiplier for the solver's computational domain extending outwards."
              />
            </div>
          </SidebarSection>

          <SidebarSection title="Conductor Geometry" defaultOpen={true}>
            {activeModule.antenna_kind === "CPWAntenna" ? (
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Signal Width"
                  defaultValue={(readNumber(moduleParams, "signal_width", 1e-6) * 1e6).toFixed(3)}
                  onBlur={(event) => updateParam("signal_width", event.target.value, 1e-6)}
                  unit="µm"
                  mono
                  tooltip="Width of the central signal trace."
                />
                <TextField
                  label="Gap"
                  defaultValue={(readNumber(moduleParams, "gap", 0.25e-6) * 1e6).toFixed(3)}
                  onBlur={(event) => updateParam("gap", event.target.value, 1e-6)}
                  unit="µm"
                  mono
                  tooltip="Clearance gap between the signal trace and ground planes."
                />
                <TextField
                  label="Ground Width"
                  defaultValue={(readNumber(moduleParams, "ground_width", 1e-6) * 1e6).toFixed(3)}
                  onBlur={(event) => updateParam("ground_width", event.target.value, 1e-6)}
                  unit="µm"
                  mono
                  tooltip="Width of the flanking ground planes."
                />
                <TextField
                  label="Thickness"
                  defaultValue={(readNumber(moduleParams, "thickness", 100e-9) * 1e9).toFixed(1)}
                  onBlur={(event) => updateParam("thickness", event.target.value, 1e-9)}
                  unit="nm"
                  mono
                  tooltip="Vertical thickness of the deposited metal layer."
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Strip Width"
                  defaultValue={(readNumber(moduleParams, "width", 1e-6) * 1e6).toFixed(3)}
                  onBlur={(event) => updateParam("width", event.target.value, 1e-6)}
                  unit="µm"
                  mono
                  tooltip="Width of the microstrip trace."
                />
                <TextField
                  label="Thickness"
                  defaultValue={(readNumber(moduleParams, "thickness", 100e-9) * 1e9).toFixed(1)}
                  onBlur={(event) => updateParam("thickness", event.target.value, 1e-9)}
                  unit="nm"
                  mono
                  tooltip="Vertical thickness of the deposited metal layer."
                />
              </div>
            )}
          </SidebarSection>

          <SidebarSection title="Placement" defaultOpen={true}>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Height Above Magnet"
                defaultValue={(readNumber(moduleParams, "height_above_magnet", 200e-9) * 1e9).toFixed(1)}
                onBlur={(event) => updateParam("height_above_magnet", event.target.value, 1e-9)}
                unit="nm"
                mono
                tooltip="Vertical Z-distance from the magnetic layer."
              />
              <TextField
                label="Preview Length"
                defaultValue={(readNumber(moduleParams, "preview_length", 5e-6) * 1e6).toFixed(2)}
                onBlur={(event) => updateParam("preview_length", event.target.value, 1e-6)}
                unit="µm"
                mono
                tooltip="Length of the conductive element rendered in the 3D viewport (for visualization only)."
              />
              <TextField
                label="Center X"
                defaultValue={(readNumber(moduleParams, "center_x", 0) * 1e9).toFixed(1)}
                onBlur={(event) => updateParam("center_x", event.target.value, 1e-9)}
                unit="nm"
                mono
                tooltip="Horizontal X-offset from the simulation origin."
              />
              <TextField
                label="Center Y"
                defaultValue={(readNumber(moduleParams, "center_y", 0) * 1e9).toFixed(1)}
                onBlur={(event) => updateParam("center_y", event.target.value, 1e-9)}
                unit="nm"
                mono
                tooltip="Horizontal Y-offset from the simulation origin."
              />
            </div>
            <div className="mt-3 rounded-lg border border-border/10 bg-card/40 p-3 text-[0.68rem] leading-relaxed text-muted-foreground">
              Position is calculated relative to the center of the magnetic scene. The 3D view shows an 
              extrusion along the <span className="font-mono text-foreground">y</span> axis, per the 
              2.5D solver's assumption.
            </div>
          </SidebarSection>

          <SidebarSection title="RF Drive" defaultOpen={true}>
            <div className="grid grid-cols-3 gap-3">
              <TextField
                label="Current (peak)"
                defaultValue={(activeModule.drive.current_a * 1e3).toFixed(3)}
                onBlur={(event) => updateDrive("current_a", event.target.value, 1e-3)}
                unit="mA"
                mono
                tooltip="Amplitude of the alternating current flowing through the signal line."
              />
              <TextField
                label="Frequency"
                defaultValue={
                  activeModule.drive.frequency_hz != null
                    ? (activeModule.drive.frequency_hz / 1e9).toFixed(4)
                    : ""
                }
                onBlur={(event) => updateDrive("frequency_hz", event.target.value, 1e9)}
                unit="GHz"
                mono
                placeholder="DC"
                tooltip="Operating frequency. Leave empty for continuous DC drive."
              />
              <TextField
                label="Phase"
                defaultValue={activeModule.drive.phase_rad.toFixed(3)}
                onBlur={(event) => updateDrive("phase_rad", event.target.value)}
                unit="rad"
                mono
                tooltip="Initial phase shift of the excitation signal."
              />
            </div>
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={computeAntennaField}
                disabled={!vp.previewControlsActive}
                title={
                  vp.previewControlsActive
                    ? "Compute Biot-Savart field and show H_ant in viewport"
                    : "Open a workspace to compute the antenna field"
                }
              >
                {vp.previewBusy ? "Computing…" : "Compute Antenna Field (H_ant)"}
              </Button>
            </div>
          </SidebarSection>

          <div className="px-3 pb-3">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="w-full opacity-80 hover:opacity-100"
              onClick={deleteActiveModule}
            >
              Delete RF Source
            </Button>
          </div>
        </div>
      ) : null}

      <SidebarSection title="Excitation Analysis" defaultOpen={true}>
        {!analysis ? (
          <div className="grid gap-3">
            <div className="rounded-lg border border-dashed border-border/10 bg-card/40 p-3 text-[0.68rem] leading-relaxed text-muted-foreground">
              Analysis config is optional. Turn it on to store source-profile settings for the
              currently selected antenna.
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={enableExcitationAnalysis}
              disabled={modules.length === 0}
            >
              Enable Source-k Analysis
            </Button>
          </div>
        ) : (
          <div key={analysis.source} className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Source Module"
                value={analysis.source}
                onchange={(value) =>
                  updateExcitationAnalysis((current) => ({ ...current, source: value }))
                }
                options={modules.map((module) => ({
                  label: module.name,
                  value: module.name,
                }))}
                tooltip="Select which active RF source drives this analysis."
              />
              <SelectField
                label="Method"
                value={analysis.method}
                onchange={(value) =>
                  updateExcitationAnalysis((current) => ({ ...current, method: value }))
                }
                options={[
                  { label: "Source k-profile", value: "source_k" },
                  { label: "Mode overlap", value: "mode_overlap" },
                  { label: "Driven response", value: "driven_response" },
                ]}
                tooltip="Analysis pipeline to execute (k-space footprint, overlap integral, or full driven sweep)."
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {analysis.propagation_axis.map((value, axisIndex) => (
                <TextField
                  key={`axis-${axisIndex}`}
                  label={`Axis ${axisIndex === 0 ? "x" : axisIndex === 1 ? "y" : "z"}`}
                  defaultValue={value}
                  onBlur={(event) => {
                    const parsed = Number(event.target.value);
                    if (!Number.isFinite(parsed)) {
                      return;
                    }
                    updateExcitationAnalysis((current) => {
                      const nextAxis = [...current.propagation_axis] as [number, number, number];
                      nextAxis[axisIndex] = parsed;
                      return { ...current, propagation_axis: nextAxis };
                    });
                  }}
                  mono
                  tooltip={`Propagation unit vector component ${axisIndex === 0 ? "x" : axisIndex === 1 ? "y" : "z"}.`}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Sweep k max"
                defaultValue={analysis.k_max_rad_per_m ?? ""}
                onBlur={(event) => {
                  const trimmed = event.target.value.trim();
                  updateExcitationAnalysis((current) => ({
                    ...current,
                    k_max_rad_per_m: trimmed.length === 0 ? null : Number(trimmed),
                  }));
                }}
                unit="rad/m"
                mono
                placeholder="auto"
                tooltip="Maximum wavenumber to resolve in the dispersion integral (leave empty for auto from mesh limit)."
              />
              <TextField
                label="Samples"
                defaultValue={analysis.samples}
                onBlur={(event) => {
                  const parsed = Number(event.target.value);
                  if (!Number.isFinite(parsed)) {
                    return;
                  }
                  updateExcitationAnalysis((current) => ({
                    ...current,
                    samples: Math.max(2, Math.round(parsed)),
                  }));
                }}
                mono
                tooltip="Number of discrete points in the generated analysis spectra."
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => model.setScriptBuilderExcitationAnalysis(null)}
            >
              Disable Analysis
            </Button>
          </div>
        )}
      </SidebarSection>
    </div>
  );
}
