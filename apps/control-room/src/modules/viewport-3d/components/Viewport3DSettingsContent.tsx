"use client";

import { useState, type ReactNode } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui/Tabs";

import { viewport3dStore, useViewport3DCommandState } from "../viewport3dStore";

export type Viewport3DSettingsSection = "view" | "appearance" | "quality" | "export";

type Viewport3DSettingsContentProps = {
  activeSection: Viewport3DSettingsSection;
  onSectionChange: (section: Viewport3DSettingsSection) => void;
  onCommand: (id: string) => void;
  cameraContent: ReactNode;
};

const QUALITY_OPTIONS = [
  ["interactive-lite", "Interactive Lite"],
  ["interactive", "Interactive"],
  ["balanced", "Balanced"],
  ["figure", "Figure"],
] as const;

const QUALITY_LABELS: Record<(typeof QUALITY_OPTIONS)[number][0] | "capture", string> = {
  "interactive-lite": "Interactive Lite",
  interactive: "Interactive",
  balanced: "Balanced",
  figure: "Figure",
  capture: "Capture",
};

const SETTINGS_SECTIONS: readonly {
  id: Viewport3DSettingsSection;
  label: string;
}[] = [
  { id: "view", label: "View" },
  { id: "appearance", label: "Appearance" },
  { id: "quality", label: "Quality" },
  { id: "export", label: "Export" },
];

export function Viewport3DSettingsContent({
  activeSection,
  onCommand,
  onSectionChange,
  cameraContent,
}: Viewport3DSettingsContentProps) {
  const state = useViewport3DCommandState();
  const appearance = state.appearance;
  const requestedQuality = state.visualProfileId === "capture"
    ? state.captureReturnProfileId ?? "interactive"
    : state.visualProfileId;
  const currentQualityLabel = QUALITY_LABELS[state.visualProfileId];

  return (
    <section
      aria-label="3D View Settings"
      className="fm-viewport-3d-settings"
    >
      <Tabs
        className="fm-viewport-3d-settings__tabs"
        onValueChange={(value) => {
          if (isViewport3DSettingsSection(value)) onSectionChange(value);
        }}
        value={activeSection}
      >
        <TabsList
          aria-label="3D view settings sections"
          className="fm-viewport-3d-settings__tab-list"
          presentation="segmented"
        >
          {SETTINGS_SECTIONS.map((section) => (
            <TabsTrigger
              className="fm-viewport-3d-settings__tab"
              key={section.id}
              value={section.id}
            >
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="fm-viewport-3d-settings__panels">
          <TabsContent forceMount hidden={activeSection !== "view"} className="fm-viewport-3d-settings__panel" value="view">
            <div className="fm-viewport-3d-settings__camera-content">
              {cameraContent}
            </div>

            <SettingsGroup
              onReset={() => onCommand("viewport-3d.reset-appearance-frame")}
              resetLabel="Reset reference frame"
              title="Reference frame"
            >
              <Choice
                id="fm-view-frame"
                label="Grid and axes"
                onChange={(value) => viewport3dStore.setDimensionFrameMode(value as "floor" | "cage" | "off")}
                options={[["floor", "Floor"], ["cage", "Floor and vertical planes"], ["off", "Off"]]}
                value={state.widgets.dimensionFrameMode}
              />
              <Choice
                id="fm-view-origin"
                label="Scale coordinates"
                onChange={(value) => viewport3dStore.setAppearance({ dimensionOrigin: value as typeof appearance.dimensionOrigin })}
                options={[["frame-center", "Relative to frame center"], ["world", "World coordinates"]]}
                value={appearance.dimensionOrigin}
              />
              <Choice
                id="fm-view-density"
                label="Grid density"
                onChange={(value) => viewport3dStore.setDimensionFrameDensity(value as typeof state.widgets.dimensionFrameDensity)}
                options={[["auto", "Auto"], ["coarse", "Coarse"], ["fine", "Fine"]]}
                value={state.widgets.dimensionFrameDensity}
              />
              <Choice
                id="fm-view-annotations"
                label="Scale annotations"
                onChange={(value) => viewport3dStore.setDimensionFrameAnnotation(value as typeof state.widgets.dimensionFrameAnnotation)}
                options={[["ticks", "Tick scales"], ["extents", "Overall dimensions"], ["both", "Ticks and dimensions"]]}
                value={state.widgets.dimensionFrameAnnotation}
              />
              <Choice
                id="fm-view-scale-unit"
                label="Scale unit"
                onChange={(value) => viewport3dStore.setScaleUnitMode(value as typeof state.widgets.scaleUnitMode)}
                options={[["auto", "Auto (SI)"], ["nm", "nm"], ["um", "µm"], ["mm", "mm"], ["m", "m"]]}
                value={state.widgets.scaleUnitMode}
              />
              <TogglePreference
                description="Reference lines remain visible when labels are hidden."
                id="fm-view-scale-labels"
                label="Scale labels"
                onCheckedChange={(visible) => viewport3dStore.setScaleLabelsVisible(visible)}
                checked={state.widgets.scaleLabelsVisible}
              />
              <RangePreference
                id="fm-view-grid-contrast"
                label="Grid contrast"
                max={2}
                min={0.25}
                onChange={(gridOpacity) => viewport3dStore.setAppearance({ gridOpacity })}
                step={0.05}
                value={appearance.gridOpacity}
              />
            </SettingsGroup>

            <SettingsGroup title="Orientation aids">
              <TogglePreference
                description="Show the orientation cube in the viewport."
                id="fm-view-cube"
                label="View cube"
                onCheckedChange={(visible) => {
                  if (visible !== state.widgets.viewCubeVisible) viewport3dStore.toggleViewCube();
                }}
                checked={state.widgets.viewCubeVisible}
              />
              <Choice
                id="fm-view-hsl-reference"
                label="HSL reference"
                onChange={(value) => viewport3dStore.setHslReferenceMode(value as typeof state.widgets.hslReferenceMode)}
                options={[["auto", "Automatic"], ["on", "On"], ["off", "Off"]]}
                value={state.widgets.hslReferenceMode}
              />
            </SettingsGroup>
          </TabsContent>

          <TabsContent forceMount hidden={activeSection !== "appearance"} className="fm-viewport-3d-settings__panel" value="appearance">
            <SettingsGroup
              onReset={() => onCommand("viewport-3d.reset-appearance-background")}
              resetLabel="Reset backgrounds"
              title="Background"
            >
              <Choice
                id="fm-view-background"
                label="Background"
                onChange={(value) => viewport3dStore.setAppearance({ backgroundMode: value as typeof appearance.backgroundMode })}
                options={[["gradient", "Subtle gradient"], ["solid", "Solid"]]}
                value={appearance.backgroundMode}
              />
              <RangePreference
                disabled={appearance.backgroundMode === "solid"}
                id="fm-view-background-strength"
                label="Gradient strength"
                max={1}
                min={0}
                onChange={(backgroundStrength) => viewport3dStore.setAppearance({ backgroundStrength })}
                step={0.05}
                value={appearance.backgroundStrength}
              />
              {appearance.backgroundMode === "solid" ? (
                <p className="fm-viewport-3d-settings__help">
                  Gradient strength applies only with a gradient background.
                </p>
              ) : null}
              <p className="fm-viewport-3d-settings__help">
                Reset restores both the viewport and PNG backgrounds.
              </p>
            </SettingsGroup>

            <SettingsGroup
              onReset={() => onCommand("viewport-3d.reset-appearance-lighting")}
              resetLabel="Reset lighting"
              title="Geometry lighting"
            >
              <Choice
                id="fm-view-render-mode"
                label="Visualization mode"
                onChange={(value) => {
                  const renderMode = value as typeof appearance.renderMode;
                  viewport3dStore.setAppearance({ renderMode });
                  if (renderMode === "presentation") viewport3dStore.setEffectAmbientOcclusion(true);
                }}
                options={[["scientific", "Scientific"], ["presentation", "Presentation"]]}
                value={appearance.renderMode}
              />
              <p className="fm-viewport-3d-settings__help">
                Field colors stay faithful in both modes. Presentation materials and lighting affect uniform geometry.
              </p>
              <Choice
                id="fm-view-lighting"
                label="Geometry appearance"
                onChange={(value) => viewport3dStore.setAppearance({ lightingMode: value as typeof appearance.lightingMode })}
                options={[["studio", "Studio"], ["flat", "Flat"]]}
                value={appearance.lightingMode}
              />
              <Choice
                disabled={appearance.lightingMode === "flat"}
                id="fm-view-light-space"
                label="Lighting reference"
                onChange={(value) => viewport3dStore.setAppearance({ lightingSpace: value as typeof appearance.lightingSpace })}
                options={[["camera", "Follow camera"], ["world", "Lock to world"]]}
                value={appearance.lightingSpace}
              />
              <RangePreference
                disabled={appearance.lightingMode === "flat"}
                id="fm-view-light-strength"
                label="Light intensity"
                max={2}
                min={0}
                onChange={(lightingIntensity) => viewport3dStore.setAppearance({ lightingIntensity })}
                step={0.05}
                value={appearance.lightingIntensity}
              />

              <Accordion className="fm-viewport-3d-settings__advanced" collapsible type="single">
                <AccordionItem value="light-direction">
                  <AccordionTrigger>Advanced light direction</AccordionTrigger>
                  <AccordionContent>
                    <div className="fm-viewport-3d-settings__field-list">
                      <RangePreference
                        disabled={appearance.lightingMode === "flat"}
                        id="fm-view-light-azimuth"
                        label="Light azimuth (deg)"
                        max={180}
                        min={-180}
                        onChange={(lightingAzimuth) => viewport3dStore.setAppearance({ lightingAzimuth })}
                        step={1}
                        value={appearance.lightingAzimuth}
                      />
                      <RangePreference
                        disabled={appearance.lightingMode === "flat"}
                        id="fm-view-light-elevation"
                        label="Light elevation (deg)"
                        max={85}
                        min={-85}
                        onChange={(lightingElevation) => viewport3dStore.setAppearance({ lightingElevation })}
                        step={1}
                        value={appearance.lightingElevation}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
              {appearance.lightingMode === "flat" ? (
                <p className="fm-viewport-3d-settings__help">
                  Flat geometry uses unlit materials; studio light controls are inactive.
                </p>
              ) : null}
            </SettingsGroup>

            {appearance.renderMode === "presentation" ? (
              <SettingsGroup title="Presentation materials">
                <RangePreference
                  id="fm-view-roughness"
                  label="Surface roughness"
                  max={1}
                  min={0.05}
                  onChange={(materialRoughness) => viewport3dStore.setAppearance({ materialRoughness })}
                  step={0.05}
                  value={appearance.materialRoughness}
                />
                <RangePreference
                  id="fm-view-metalness"
                  label="Surface metalness"
                  max={1}
                  min={0}
                  onChange={(materialMetalness) => viewport3dStore.setAppearance({ materialMetalness })}
                  step={0.05}
                  value={appearance.materialMetalness}
                />
              </SettingsGroup>
            ) : null}
          </TabsContent>

          <TabsContent forceMount hidden={activeSection !== "quality"} className="fm-viewport-3d-settings__panel" value="quality">
            <SettingsGroup title="Render quality">
              <Choice
                id="fm-view-quality"
                label="Requested quality"
                onChange={(value) => viewport3dStore.setVisualProfile(value as typeof requestedQuality)}
                options={QUALITY_OPTIONS}
                value={requestedQuality}
              />
              <p className="fm-viewport-3d-settings__status" role="status">
                {state.visualProfileId === "capture"
                  ? `Requested: ${QUALITY_LABELS[requestedQuality]}; active for export: ${currentQualityLabel}.`
                  : `Requested and active: ${currentQualityLabel}.`}
              </p>
              <p className="fm-viewport-3d-settings__help">
                Interactive Lite omits shadows and AO. Higher profiles increase shadow detail; Figure uses full-resolution AO.
              </p>

              <TogglePreference
                description="Smooth polygon boundaries within the selected quality profile."
                id="fm-viewport-3d-effect-antialias"
                label="Anti-Aliasing"
                onCheckedChange={(enabled) => viewport3dStore.setEffectAntialias(enabled)}
                checked={state.widgets.effectAntialias}
              />
              <EffectStatus label="Anti-Aliasing" diagnostic={state.appearanceDiagnostics.antialias} />

              <TogglePreference
                description="Contact and crevice shading for geometry. Protected field colors remain unchanged."
                id="fm-viewport-3d-effect-ambient-occlusion"
                label="Ambient occlusion"
                onCheckedChange={(enabled) => viewport3dStore.setEffectAmbientOcclusion(enabled)}
                checked={state.widgets.effectAmbientOcclusion}
              />
              <EffectStatus label="Ambient occlusion" diagnostic={state.appearanceDiagnostics.ambientOcclusion} />

              <TogglePreference
                description="Glow for presentation geometry; quantitative field colors remain unchanged."
                id="fm-viewport-3d-effect-bloom"
                label="Bloom (Glow)"
                onCheckedChange={(enabled) => viewport3dStore.setEffectBloom(enabled)}
                checked={state.widgets.effectBloom}
              />
              <EffectStatus label="Bloom" diagnostic={state.appearanceDiagnostics.bloom} />

              <TogglePreference
                description="Filtered shadows for presentation geometry. Interactive Lite does not include shadows."
                disabled={appearance.renderMode !== "presentation"}
                id="fm-view-shadows"
                label="Soft shadows"
                onCheckedChange={(softShadows) => viewport3dStore.setAppearance({ softShadows })}
                checked={appearance.softShadows}
              />
              <EffectStatus
                effective={
                  appearance.renderMode === "presentation" &&
                  appearance.softShadows &&
                  state.visualProfileId !== "interactive-lite"
                }
                label="Soft shadows"
                reason={
                  appearance.renderMode !== "presentation"
                    ? "Only active in Presentation mode"
                    : state.visualProfileId === "interactive-lite"
                      ? "Unavailable in Interactive Lite quality"
                      : null
                }
                requested={appearance.softShadows}
              />

              <Accordion className="fm-viewport-3d-settings__advanced" collapsible type="single">
                <AccordionItem value="ambient-occlusion">
                  <AccordionTrigger>Advanced ambient occlusion</AccordionTrigger>
                  <AccordionContent>
                    <div className="fm-viewport-3d-settings__field-list">
                      <RangePreference
                        disabled={!state.widgets.effectAmbientOcclusion}
                        id="fm-view-ao-intensity"
                        label="AO strength"
                        max={3}
                        min={0}
                        onChange={(aoIntensity) => viewport3dStore.setAppearance({ aoIntensity })}
                        step={0.1}
                        value={appearance.aoIntensity}
                      />
                      <RangePreference
                        disabled={!state.widgets.effectAmbientOcclusion}
                        id="fm-view-ao-radius"
                        label="AO radius (fraction of scene)"
                        max={0.1}
                        min={0.001}
                        onChange={(aoRadius) => viewport3dStore.setAppearance({ aoRadius })}
                        step={0.001}
                        value={appearance.aoRadius}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </SettingsGroup>
          </TabsContent>

          <TabsContent forceMount hidden={activeSection !== "export"} className="fm-viewport-3d-settings__panel" value="export">
            <SettingsGroup title="PNG export">
              <Choice
                id="fm-view-export-background"
                label="PNG background"
                onChange={(value) => viewport3dStore.setAppearance({ exportBackground: value as typeof appearance.exportBackground })}
                options={[["view", "Match viewport"], ["transparent", "Transparent"]]}
                value={appearance.exportBackground}
              />
              <Choice
                id="fm-view-export-scale"
                label="PNG resolution"
                onChange={(value) => viewport3dStore.setAppearance({ exportScale: Number(value) as 1 | 2 | 4 })}
                options={[["1", "1× viewport"], ["2", "2× viewport"], ["4", "4× viewport"]]}
                value={String(appearance.exportScale)}
              />
              <p className="fm-viewport-3d-settings__help">
                PNG uses the active geometry effects. Large captures may need a lower scale on this device.
              </p>
              <TogglePreference
                description="Include the reference scale, legend and orientation in the captured image."
                id="fm-view-export-annotations"
                label="Include annotations"
                onCheckedChange={(exportAnnotations) => viewport3dStore.setAppearance({ exportAnnotations })}
                checked={appearance.exportAnnotations}
              />
              <div className="fm-viewport-3d-settings__actions">
                <Button onClick={() => onCommand("viewport-3d.capture-frame")} variant="primary">
                  Export PNG
                </Button>
              </div>
            </SettingsGroup>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}

function SettingsGroup({
  children,
  onReset,
  resetLabel,
  title,
}: {
  children: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  title: string;
}) {
  return (
    <fieldset className="fm-viewport-3d-settings__group">
      <legend className="fm-viewport-3d-settings__legend">{title}</legend>
      <div className="fm-viewport-3d-settings__field-list">{children}</div>
      {onReset && resetLabel ? (
        <div className="fm-viewport-3d-settings__actions">
          <Button onClick={onReset} size="sm" variant="secondary">
            {resetLabel}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

function Choice({
  disabled = false,
  id,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <div className="fm-viewport-3d-settings__field">
      <label className="fm-viewport-3d-settings__label" htmlFor={id}>
        {label}
      </label>
      <Select
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== undefined) onChange(next);
        }}
        value={value}
      >
        <SelectTrigger
          aria-label={label}
          className="fm-viewport-3d-settings__select"
          id={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TogglePreference({
  checked,
  description,
  disabled = false,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <div className="fm-viewport-3d-settings__toggle">
      <div className="fm-viewport-3d-settings__toggle-copy">
        <span className="fm-viewport-3d-settings__label" id={labelId}>
          {label}
        </span>
        <span className="fm-viewport-3d-settings__help" id={descriptionId}>
          {description}
        </span>
      </div>
      <Switch
        aria-describedby={descriptionId}
        aria-label={label}
        aria-labelledby={labelId}
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function EffectStatus({
  diagnostic,
  effective,
  label,
  reason,
  requested,
}: {
  diagnostic?: { effective: boolean; reason: string | null; requested: boolean };
  effective?: boolean;
  label: string;
  reason?: string | null;
  requested?: boolean;
}) {
  const resolvedRequested = diagnostic?.requested ?? requested ?? false;
  const resolvedEffective = diagnostic?.effective ?? effective ?? false;
  const resolvedReason = diagnostic?.reason ?? reason ?? null;
  const requestState = resolvedRequested ? "requested" : "not requested";
  const effectState = resolvedEffective ? "effective" : "inactive";
  return (
    <p className="fm-viewport-3d-settings__status" role="status">
      {label}: {requestState}, {effectState}{resolvedReason ? ` — ${resolvedReason}` : ""}.
    </p>
  );
}

function RangePreference({
  disabled = false,
  id,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  disabled?: boolean;
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const numberId = `${id}-number`;
  const labelId = `${id}-label`;
  const helpId = `${id}-range-help`;
  const errorId = `${id}-range-error`;
  const [draftOverride, setDraftOverride] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const draft = draftOverride ?? formatPreferenceNumber(value);

  const commitDraft = (nextDraft: string) => {
    const trimmed = nextDraft.trim();
    const parsed = trimmed ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setValidationError(`Enter a value from ${formatPreferenceNumber(min)} to ${formatPreferenceNumber(max)}.`);
      return;
    }
    setValidationError(null);
    setDraftOverride(null);
    onChange(parsed);
  };

  return (
    <div className="fm-viewport-3d-settings__range-field">
      <div className="fm-viewport-3d-settings__range-heading">
        <label className="fm-viewport-3d-settings__label" htmlFor={numberId} id={labelId}>
          {label}
        </label>
        <Input
          aria-describedby={validationError ? `${helpId} ${errorId}` : helpId}
          aria-invalid={validationError !== null}
          className="fm-viewport-3d-settings__number"
          disabled={disabled}
          id={numberId}
          inputMode="decimal"
          max={max}
          min={min}
          onBlur={(event) => {
            commitDraft(event.currentTarget.value);
          }}
          onChange={(event) => {
            setDraftOverride(event.currentTarget.value);
            setValidationError(null);
          }}
          onFocus={() => {
            setDraftOverride(formatPreferenceNumber(value));
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraftOverride(null);
              setValidationError(null);
            }
          }}
          step={step}
          type="number"
          value={draft}
        />
      </div>
      <Slider
        aria-labelledby={labelId}
        className="fm-viewport-3d-settings__slider"
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onValueChange={(values) => {
          const nextValue = values[0];
          if (nextValue === undefined || !Number.isFinite(nextValue) || nextValue < min || nextValue > max) return;
          setValidationError(null);
          setDraftOverride(null);
          onChange(nextValue);
        }}
        step={step}
        value={[value]}
        valueText={(nextValue) => formatPreferenceNumber(nextValue)}
      />
      <span className="fm-viewport-3d-settings__range-help" id={helpId}>
        {`Range ${formatPreferenceNumber(min)} to ${formatPreferenceNumber(max)}.`}
      </span>
      {validationError ? (
        <span className="fm-viewport-3d-settings__error" id={errorId} role="alert">
          {validationError}
        </span>
      ) : null}
    </div>
  );
}

function isViewport3DSettingsSection(value: string): value is Viewport3DSettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

function formatPreferenceNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}
