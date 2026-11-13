"use client";

import type { ReactNode } from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Button } from "@/shared/ui/Button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { viewport3dStore, useViewport3DCommandState } from "../viewport3dStore";

function EffectToggle({
  id,
  label,
  description,
  enabled,
  onToggle,
}: {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div
      className="fm-viewport-3d__settings-toggle"
      data-enabled={String(enabled)}
    >
      <div className="fm-viewport-3d__settings-toggle-info">
        <span className="fm-viewport-3d__settings-toggle-label">{label}</span>
        <span className="fm-viewport-3d__settings-toggle-desc">
          {description}
        </span>
      </div>
      <label className="fm-viewport-3d__settings-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-checked={enabled}
          checked={enabled}
          onChange={() => onToggle(!enabled)}
        />
        <span className="fm-viewport-3d__settings-switch-track" />
      </label>
    </div>
  );
}

export function Viewport3DSettingsDialog({ onCommand }: { onCommand: (id: string) => void }) {
  const state = useViewport3DCommandState();
  const a = state.appearance;

  const isOpen = state.widgets.settingsDialogOpen;
  const { effectAmbientOcclusion, effectAntialias, effectBloom } = state.widgets;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => viewport3dStore.setSettingsDialogOpen(open)}
    >
      <DialogContent className="fm-viewport-3d__appearance-dialog" aria-describedby="fm-viewport-settings-dialog-description">
        <DialogHeader>
          <DialogTitle>3D View Settings</DialogTitle>
          <DialogDescription id="fm-viewport-settings-dialog-description">
            Set the background, reference scales, geometry lighting and capture options. View preferences are saved on this device.
          </DialogDescription>
        </DialogHeader>

        <div className="fm-viewport-3d__settings-body">
          <SettingsSection title="Background" onReset={() => onCommand("viewport-3d.reset-appearance-background")}>
            <Choice id="fm-view-background" label="Background" value={a.backgroundMode} options={[["gradient", "Subtle gradient"], ["solid", "Solid"]]} onChange={(v) => viewport3dStore.setAppearance({ backgroundMode: v as typeof a.backgroundMode })} />
            <Range id="fm-view-background-strength" label="Gradient strength" value={a.backgroundStrength} min={0} max={1} step={0.05} disabled={a.backgroundMode === "solid"} onChange={(backgroundStrength) => viewport3dStore.setAppearance({ backgroundStrength })} />
            {a.backgroundMode === "solid" ? <p>Gradient strength applies only with a gradient background.</p> : null}
          </SettingsSection>
          <SettingsSection title="Grid and scale" onReset={() => onCommand("viewport-3d.reset-appearance-frame")}>
            <Choice id="fm-view-frame" label="Reference frame" value={state.widgets.dimensionFrameMode} options={[["floor", "Floor"], ["cage", "Floor and vertical planes"], ["off", "Off"]]} onChange={(v) => viewport3dStore.setDimensionFrameMode(v as typeof state.widgets.dimensionFrameMode)} />
            <Choice id="fm-view-origin" label="Scale coordinates" value={a.dimensionOrigin} options={[["frame-center", "Relative to frame center"], ["world", "World coordinates"]]} onChange={(v) => viewport3dStore.setAppearance({ dimensionOrigin: v as typeof a.dimensionOrigin })} />
            <Choice id="fm-view-density" label="Grid density" value={state.widgets.dimensionFrameDensity} options={[["auto", "Auto"], ["coarse", "Coarse"], ["fine", "Fine"]]} onChange={(v) => viewport3dStore.setDimensionFrameDensity(v as typeof state.widgets.dimensionFrameDensity)} />
            <Choice id="fm-view-annotations" label="Annotations" value={state.widgets.dimensionFrameAnnotation} options={[["ticks", "Tick scales"], ["extents", "Overall dimensions"], ["both", "Ticks and dimensions"]]} onChange={(v) => viewport3dStore.setDimensionFrameAnnotation(v as typeof state.widgets.dimensionFrameAnnotation)} />
            <Choice id="fm-view-scale-unit" label="Scale unit" value={state.widgets.scaleUnitMode} options={[["auto", "Auto (SI)"], ["nm", "nm"], ["um", "µm"], ["mm", "mm"], ["m", "m"]]} onChange={(v) => viewport3dStore.setScaleUnitMode(v as typeof state.widgets.scaleUnitMode)} />
            <EffectToggle id="fm-view-scale-labels" label="Scale labels" description="Reference lines remain visible when labels are hidden." enabled={state.widgets.scaleLabelsVisible} onToggle={(visible) => viewport3dStore.setScaleLabelsVisible(visible)} />
            <Range id="fm-view-grid-contrast" label="Grid contrast" value={a.gridOpacity} min={0.25} max={2} step={0.05} onChange={(gridOpacity) => viewport3dStore.setAppearance({ gridOpacity })} />
          </SettingsSection>
          <SettingsSection title="Geometry lighting" onReset={() => onCommand("viewport-3d.reset-appearance-lighting")}>
            <Choice id="fm-view-render-mode" label="Visualization mode" value={a.renderMode} options={[["scientific", "Scientific — faithful field colors"], ["presentation", "Presentation — PBR and studio HDRI"]]} onChange={(v) => { viewport3dStore.setAppearance({ renderMode: v as typeof a.renderMode }); if (v === "presentation") viewport3dStore.setEffectAmbientOcclusion(true); }} />
            <p>Scientific field colors remain independent of lighting in both modes. Presentation materials apply to uniform geometry.</p>
            <Choice id="fm-view-lighting" label="Geometry appearance" value={a.lightingMode} options={[["studio", "Studio"], ["flat", "Flat"]]} onChange={(v) => viewport3dStore.setAppearance({ lightingMode: v as typeof a.lightingMode })} />
            <Choice id="fm-view-light-space" label="Lighting reference" value={a.lightingSpace} options={[["camera", "Follow camera"], ["world", "Lock to world"]]} disabled={a.lightingMode === "flat"} onChange={(v) => viewport3dStore.setAppearance({ lightingSpace: v as typeof a.lightingSpace })} />
            <Range id="fm-view-light-strength" label="Light intensity" value={a.lightingIntensity} min={0} max={2} step={0.05} disabled={a.lightingMode === "flat"} onChange={(lightingIntensity) => viewport3dStore.setAppearance({ lightingIntensity })} />
            <Range id="fm-view-light-azimuth" label="Light azimuth (deg)" value={a.lightingAzimuth} min={-180} max={180} step={1} disabled={a.lightingMode === "flat"} onChange={(lightingAzimuth) => viewport3dStore.setAppearance({ lightingAzimuth })} />
            <Range id="fm-view-light-elevation" label="Light elevation (deg)" value={a.lightingElevation} min={-85} max={85} step={1} disabled={a.lightingMode === "flat"} onChange={(lightingElevation) => viewport3dStore.setAppearance({ lightingElevation })} />
            {a.lightingMode === "flat" ? <p>Flat geometry uses unlit materials; studio light controls are inactive.</p> : null}
            {a.renderMode === "presentation" ? <>
              <Range id="fm-view-roughness" label="Surface roughness" value={a.materialRoughness} min={0.05} max={1} step={0.05} onChange={(materialRoughness) => viewport3dStore.setAppearance({ materialRoughness })} />
              <Range id="fm-view-metalness" label="Surface metalness" value={a.materialMetalness} min={0} max={1} step={0.05} onChange={(materialMetalness) => viewport3dStore.setAppearance({ materialMetalness })} />
              <EffectToggle id="fm-view-shadows" label="Soft shadows" description="Filtered geometry shadows; unavailable in Interactive Lite quality." enabled={a.softShadows} onToggle={(softShadows) => viewport3dStore.setAppearance({ softShadows })} />
            </> : null}
          </SettingsSection>
          <SettingsSection title="Camera">
            <p>Camera position and target use meters (SI). Camera state belongs to the current session or inspected dataset.</p>
            <div className="fm-viewport-3d__settings-actions">
              <Button variant="secondary" onClick={() => { viewport3dStore.setSettingsDialogOpen(false); onCommand("viewport-3d.open-camera-dialog"); }}>Camera parameters</Button>
              <Button variant="secondary" onClick={() => onCommand("viewport-3d.fit")}>Fit scene</Button>
            </div>
          </SettingsSection>
          <SettingsSection title="Quality and effects" onReset={() => onCommand("viewport-3d.reset-appearance-effects")}>
          <Choice id="fm-view-quality" label="Render quality" value={state.visualProfileId === "capture" ? state.captureReturnProfileId ?? "interactive" : state.visualProfileId} options={[["interactive-lite", "Interactive Lite"], ["interactive", "Interactive"], ["balanced", "Balanced"], ["figure", "Figure"]]} onChange={(v) => viewport3dStore.setVisualProfile(v as typeof state.visualProfileId)} />
          <p>Interactive Lite omits shadows and AO. Higher qualities increase shadow detail; Figure uses full-resolution AO.</p>
          <EffectToggle id="fm-viewport-3d-effect-antialias" label="Anti-Aliasing" description="Smooths polygon boundaries within the selected quality profile." enabled={effectAntialias} onToggle={(v) => viewport3dStore.setEffectAntialias(v)} />
          <EffectToggle
            id="fm-viewport-3d-effect-ambient-occlusion"
            label="Ambient occlusion"
            description="Contact and crevice shading for geometry. Disabled where it would alter quantitative field colors."
            enabled={effectAmbientOcclusion}
            onToggle={(v) => viewport3dStore.setEffectAmbientOcclusion(v)}
          />

          <EffectToggle
            id="fm-viewport-3d-effect-bloom"
            label="Bloom (Glow)"
            description="Presentation effect for geometry; unavailable for quantitative field colors."
            enabled={effectBloom}
            onToggle={(v) => viewport3dStore.setEffectBloom(v)}
          />
          <Range id="fm-view-ao-intensity" label="AO strength" value={a.aoIntensity} min={0} max={3} step={0.1} onChange={(aoIntensity) => viewport3dStore.setAppearance({ aoIntensity })} />
          <Range id="fm-view-ao-radius" label="AO radius (fraction of scene)" value={a.aoRadius} min={0.001} max={0.1} step={0.001} onChange={(aoRadius) => viewport3dStore.setAppearance({ aoRadius })} />
          {Object.entries(state.appearanceDiagnostics).map(([effect, diagnostic]) => diagnostic.reason ? <p key={effect} role="status">{effect}: {diagnostic.reason}</p> : null)}
          </SettingsSection>
          <SettingsSection title="Image export">
            <Choice id="fm-view-export-background" label="PNG background" value={a.exportBackground} options={[["view", "Match viewport"], ["transparent", "Transparent"]]} onChange={(v) => viewport3dStore.setAppearance({ exportBackground: v as typeof a.exportBackground })} />
            <Choice id="fm-view-export-scale" label="PNG resolution" value={String(a.exportScale)} options={[["1", "1× viewport"], ["2", "2× viewport"], ["4", "4× viewport"]]} onChange={(v) => viewport3dStore.setAppearance({ exportScale: Number(v) as typeof a.exportScale })} />
            <p>PNG is rendered at the selected resolution with the current geometry effects. Large exports may require a lower scale on this device.</p>
            <EffectToggle id="fm-view-export-annotations" label="Include annotations" description="Include the reference scale, legend and orientation in the captured image." enabled={a.exportAnnotations} onToggle={(exportAnnotations) => viewport3dStore.setAppearance({ exportAnnotations })} />
            <Button variant="secondary" onClick={() => { viewport3dStore.setSettingsDialogOpen(false); onCommand("viewport-3d.capture-frame"); }}>Export PNG</Button>
          </SettingsSection>
        </div>

        <DialogFooter className="fm-viewport-3d__settings-footer">
          <Button variant="secondary" onClick={() => onCommand("viewport-3d.reset-appearance-all")}>Reset view preferences</Button>
          <DialogClose asChild>
            <Button variant="secondary" onClick={() => viewport3dStore.setSettingsDialogOpen(false)}>
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({ title, onReset, children }: { title: string; onReset?: () => void; children: ReactNode }) {
  return <fieldset className="fm-viewport-3d__settings-section"><legend>{title}</legend>{children}{onReset ? <Button size="sm" variant="secondary" onClick={onReset}>Reset {title.toLowerCase()}</Button> : null}</fieldset>;
}

function Choice({ id, label, value, options, disabled = false, onChange }: { id: string; label: string; value: string; options: readonly (readonly [string, string])[]; disabled?: boolean; onChange: (value: string) => void }) {
  return <div className="fm-viewport-3d__settings-field"><label htmlFor={id}>{label}</label><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent>{options.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></div>;
}

function Range({ id, label, value, min, max, step, disabled = false, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <div className="fm-viewport-3d__settings-field"><label htmlFor={id}>{label} <output htmlFor={id}>{Number(value.toFixed(3))}</output></label><input id={id} type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} /></div>;
}
