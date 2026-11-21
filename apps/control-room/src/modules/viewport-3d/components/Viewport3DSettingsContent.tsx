"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/shared/ui/Accordion";
import { Input } from "@/shared/ui/Input";
import { Slider } from "@/shared/ui/Slider";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui/Tabs";
import {
  VIEWPORT_3D_CAPTURE_PROFILE_DESCRIPTION,
  VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS,
  VIEWPORT_3D_QUALITY_PROFILE_LABELS,
  VIEWPORT_3D_QUALITY_PROFILE_OPTIONS,
  type Viewport3DQualityProfileId,
} from "@/shared/viewport3dQualityLabels";

import {
  Choice,
  SettingsGroup,
  TogglePreference,
} from "./Viewport3DSettingsPrimitives";
import { Viewport3DVisualizationModeControl } from "./Viewport3DVisualizationModeControl";
import { viewport3dStore, useViewport3DCommandState } from "../viewport3dStore";

export type Viewport3DSettingsSection = "view" | "appearance" | "quality";

type Viewport3DSettingsContentProps = {
  activeSection: Viewport3DSettingsSection;
  onSectionChange: (section: Viewport3DSettingsSection) => void;
  onCommand: (id: string) => void;
  cameraContent: ReactNode;
};

const SETTINGS_SECTIONS: readonly {
  id: Viewport3DSettingsSection;
  label: string;
}[] = [
  { id: "view", label: "View" },
  { id: "appearance", label: "Appearance" },
  { id: "quality", label: "Quality" },
];

export function Viewport3DSettingsContent({
  activeSection,
  onCommand,
  onSectionChange,
  cameraContent,
}: Viewport3DSettingsContentProps) {
  const state = useViewport3DCommandState();
  const appearance = state.appearance;
  const isTemporaryCapture = state.visualProfileId === "capture" &&
    state.captureReturnProfileId !== null;
  const selectedQuality = state.visualProfileId === "capture" &&
    state.captureReturnProfileId !== null
    ? state.captureReturnProfileId
    : state.visualProfileId;
  const currentQualityLabel = selectedQuality === "capture"
    ? "Capture"
    : VIEWPORT_3D_QUALITY_PROFILE_LABELS[selectedQuality];
  const qualityDescription = selectedQuality === "capture"
    ? VIEWPORT_3D_CAPTURE_PROFILE_DESCRIPTION
    : VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS[selectedQuality as Viewport3DQualityProfileId];
  const qualityOptions = selectedQuality === "capture"
    ? [...VIEWPORT_3D_QUALITY_PROFILE_OPTIONS, ["capture", "Capture"] as const]
    : VIEWPORT_3D_QUALITY_PROFILE_OPTIONS;

  return (
    <section
      aria-label="3D View Settings"
      className="fm-viewport-3d-settings"
    >
      {/* Identity header shared with the Inspector template (specs/frontend-v2/13 §1a). */}
      <header className="fm-viewport-3d-settings__header">
        <span aria-hidden="true" className="fm-viewport-3d-settings__header-icon">
          <SlidersHorizontal size={18} strokeWidth={1.75} />
        </span>
        <span className="fm-viewport-3d-settings__header-copy">
          <h2 className="fm-viewport-3d-settings__title">3D View</h2>
          <span className="fm-viewport-3d-settings__subtitle">Camera, appearance and render quality</span>
        </span>
      </header>
      <Tabs
        className="fm-viewport-3d-settings__tabs"
        onValueChange={(value) => {
          if (isViewport3DSettingsSection(value)) onSectionChange(value);
        }}
        value={activeSection}
      >
        <div className="fm-viewport-3d-settings__field-list">
          <Viewport3DVisualizationModeControl />
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
        </div>

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
            <SettingsGroup title="Quality and effects">
              <Choice
                describedBy="fm-view-quality-help fm-view-quality-description"
                id="fm-view-quality"
                label="Quality profile"
                onChange={(value) => viewport3dStore.setVisualProfile(value as typeof selectedQuality)}
                options={qualityOptions}
                value={selectedQuality}
              />
              <p className="fm-viewport-3d-settings__help" id="fm-view-quality-help">
                Quality controls render detail and GPU cost. Scientific preserves exact field colors.
              </p>
              <p className="fm-viewport-3d-settings__help" id="fm-view-quality-description">
                {qualityDescription}
              </p>
              <p className="fm-viewport-3d-settings__status" id="fm-view-quality-status" role="status">
                {isTemporaryCapture
                  ? `Active quality: ${currentQualityLabel}. Exporting PNG.`
                  : `Active quality: ${currentQualityLabel}.`}
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
                description="Contact and crevice shading, including on field-colored surfaces in Presentation."
                id="fm-viewport-3d-effect-ambient-occlusion"
                label="Ambient occlusion"
                onCheckedChange={(enabled) => viewport3dStore.setEffectAmbientOcclusion(enabled)}
                checked={state.widgets.effectAmbientOcclusion}
              />
              <EffectStatus label="Ambient occlusion" diagnostic={state.appearanceDiagnostics.ambientOcclusion} />

              <TogglePreference
                description="Glow for Presentation geometry and field-colored surfaces. Scientific preserves exact field colors."
                id="fm-viewport-3d-effect-bloom"
                label="Bloom (Glow)"
                onCheckedChange={(enabled) => viewport3dStore.setEffectBloom(enabled)}
                checked={state.widgets.effectBloom}
              />
              <EffectStatus label="Bloom" diagnostic={state.appearanceDiagnostics.bloom} />

              <TogglePreference
                description={`Filtered shadows for Presentation geometry and field-colored surfaces. ${VIEWPORT_3D_QUALITY_PROFILE_LABELS["interactive-lite"]} does not render shadows.`}
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
                      ? `Unavailable in ${VIEWPORT_3D_QUALITY_PROFILE_LABELS["interactive-lite"]} quality`
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
        </div>
      </Tabs>
    </section>
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
