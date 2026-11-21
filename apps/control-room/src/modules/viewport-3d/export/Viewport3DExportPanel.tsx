"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import type { Export3DFormat } from "@/shared/export-3d/export3dTypes";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui/Tabs";

import {
  Choice,
  SettingsGroup,
  TogglePreference,
} from "../components/Viewport3DSettingsPrimitives";
import type { Viewport3DExportMode } from "../viewport3dInspectorState";
import { useViewport3DCommandState, viewport3dStore } from "../viewport3dStore";
import {
  computeViewportModelExportCapabilities,
  defaultIncludeVectorsForSource,
  downloadExport3DModel,
  executeViewportModelExport,
  EXPORT_3D_FORMAT_OPTIONS,
  formatViewportModelSourceSummary,
  type ViewportModelSource,
} from "./viewportModelExportAction";

export interface Viewport3DExportPanelProps {
  activeMode: Viewport3DExportMode;
  getSource: () => Promise<ViewportModelSource>;
  onCommand: (id: string) => void;
  onExportPng?: () => Promise<void> | void;
  onModeChange: (mode: Viewport3DExportMode) => void;
  sourceRevisionKey?: string;
  visible?: boolean;
}

const EXPORT_MODES: readonly {
  id: Viewport3DExportMode;
  label: string;
}[] = [
  { id: "png", label: "PNG" },
  { id: "3d", label: "3D model" },
];

export function Viewport3DExportPanel({
  activeMode,
  getSource,
  onCommand,
  onExportPng,
  onModeChange,
  sourceRevisionKey,
  visible = true,
}: Viewport3DExportPanelProps) {
  const state = useViewport3DCommandState();
  const appearance = state.appearance;
  const isCapturingPng =
    state.visualProfileId === "capture" && state.captureReturnProfileId !== null;

  const latestGetSource = useRef(getSource);
  useEffect(() => {
    latestGetSource.current = getSource;
  }, [getSource]);

  const [reloadNonce, setReloadNonce] = useState(0);
  const requestKey = `${sourceRevisionKey ?? "default"}:${reloadNonce}`;
  const shouldLoad3D = visible && activeMode === "3d";
  const [sourceState, setSourceState] = useState<{
    error: string | null;
    key: string;
    source: ViewportModelSource | null;
  }>({ error: null, key: "", source: null });

  useEffect(() => {
    if (!shouldLoad3D) return;
    let active = true;
    void latestGetSource
      .current()
      .then((next) => {
        if (!active) return;
        setSourceState({ error: null, key: requestKey, source: next });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSourceState({
          error:
            cause instanceof Error
              ? cause.message
              : "Could not read the current 3D view.",
          key: requestKey,
          source: null,
        });
      });
    return () => {
      active = false;
    };
  }, [requestKey, shouldLoad3D]);

  const [format, setFormat] = useState<Export3DFormat>("glb");
  const [customFilename, setCustomFilename] = useState<string | null>(null);
  const [includeVectorsOverride, setIncludeVectorsOverride] = useState<boolean | null>(null);
  const [includeAirbox, setIncludeAirbox] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const job = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      const controller = job.current;
      job.current = null;
      controller?.abort();
    };
  }, []);

  const source = sourceState.source;
  const sourceError = sourceState.error;
  const loadingSource =
    shouldLoad3D &&
    sourceState.key !== requestKey &&
    source === null &&
    sourceError === null;
  const includeVectors =
    includeVectorsOverride ?? defaultIncludeVectorsForSource(source);
  const filename = customFilename ?? source?.suggestedFilenameStem ?? "";

  const {
    canAnimate,
    hasAirbox,
    hasVectors,
    missingAirboxVectors,
    targets,
    vtk,
  } = computeViewportModelExportCapabilities(source, format, includeAirbox);

  async function handleExport3D() {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setExportError(null);
    setExporting(true);
    try {
      const freshSource = await latestGetSource.current();
      if (controller.signal.aborted) return;
      setSourceState({ error: null, key: requestKey, source: freshSource });
      const effectiveVectors =
        includeVectorsOverride ?? defaultIncludeVectorsForSource(freshSource);
      const effectiveFilename =
        (customFilename ?? freshSource.suggestedFilenameStem).trim() ||
        freshSource.suggestedFilenameStem;
      const result = await executeViewportModelExport({
        animate,
        filename: effectiveFilename,
        format,
        includeAirbox,
        includeVectors: effectiveVectors,
        signal: controller.signal,
        source: freshSource,
      });
      if (!controller.signal.aborted) {
        downloadExport3DModel(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setExportError(
          cause instanceof Error
            ? cause.message
            : "Could not export the 3D model.",
        );
      }
    } finally {
      if (job.current === controller) {
        job.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <section
      aria-label="3D Export"
      className="fm-viewport-3d-settings fm-viewport-3d-export"
    >
      <header className="fm-viewport-3d-settings__header">
        <span aria-hidden="true" className="fm-viewport-3d-settings__header-icon">
          <Download size={18} strokeWidth={1.75} />
        </span>
        <span className="fm-viewport-3d-settings__header-copy">
          <h2 className="fm-viewport-3d-settings__title">Export</h2>
          <span className="fm-viewport-3d-settings__subtitle">
            PNG image and 3D model (GLB, glTF, VTK)
          </span>
        </span>
      </header>
      <Tabs
        className="fm-viewport-3d-settings__tabs"
        onValueChange={(value) => {
          if (value === "png" || value === "3d") onModeChange(value);
        }}
        value={activeMode}
      >
        <div className="fm-viewport-3d-settings__field-list">
          <TabsList
            aria-label="Export format"
            className="fm-viewport-3d-settings__tab-list fm-viewport-3d-settings__tab-list--two"
            presentation="segmented"
          >
            {EXPORT_MODES.map((mode) => (
              <TabsTrigger
                className="fm-viewport-3d-settings__tab"
                key={mode.id}
                value={mode.id}
              >
                {mode.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="fm-viewport-3d-settings__panels">
          <TabsContent
            className="fm-viewport-3d-settings__panel"
            forceMount
            hidden={activeMode !== "png"}
            value="png"
          >
            <SettingsGroup title="PNG export">
              <Choice
                id="fm-view-export-background"
                label="PNG background"
                onChange={(value) =>
                  viewport3dStore.setAppearance({
                    exportBackground: value as typeof appearance.exportBackground,
                  })
                }
                options={[
                  ["view", "Match viewport"],
                  ["transparent", "Transparent"],
                ]}
                value={appearance.exportBackground}
              />
              <Choice
                id="fm-view-export-scale"
                label="PNG resolution"
                onChange={(value) =>
                  viewport3dStore.setAppearance({
                    exportScale: Number(value) as 1 | 2 | 4,
                  })
                }
                options={[
                  ["1", "1× viewport"],
                  ["2", "2× viewport"],
                  ["4", "4× viewport"],
                ]}
                value={String(appearance.exportScale)}
              />
              <p className="fm-viewport-3d-settings__help">
                PNG uses the active geometry effects. Large captures may need a lower scale on this device.
              </p>
              <TogglePreference
                checked={appearance.exportAnnotations}
                description="Include the reference scale, legend and orientation in the captured image."
                id="fm-view-export-annotations"
                label="Include annotations"
                onCheckedChange={(exportAnnotations) =>
                  viewport3dStore.setAppearance({ exportAnnotations })
                }
              />
              {state.captureError ? (
                <p className="fm-viewport-3d-settings__error" role="alert">
                  {state.captureError}
                </p>
              ) : null}
              <div className="fm-viewport-3d-settings__actions">
                <Button
                  disabled={isCapturingPng}
                  onClick={() => {
                    if (onExportPng) void onExportPng();
                    else onCommand("viewport-3d.capture-frame");
                  }}
                  variant="primary"
                >
                  {isCapturingPng ? "Exporting…" : "Export PNG"}
                </Button>
              </div>
            </SettingsGroup>
          </TabsContent>

          <TabsContent
            className="fm-viewport-3d-settings__panel"
            forceMount
            hidden={activeMode !== "3d"}
            value="3d"
          >
            <SettingsGroup title="3D model export">
              <div className="fm-viewport-3d-settings__status-row">
                <p className="fm-viewport-3d-settings__status" role="status">
                  {loadingSource
                    ? "Preparing the current 3D view…"
                    : formatViewportModelSourceSummary(source)}
                </p>
                <Button
                  aria-label="Refresh 3D export source"
                  disabled={exporting || loadingSource}
                  onClick={() => {
                    setExportError(null);
                    setReloadNonce((current) => current + 1);
                  }}
                  size="icon"
                  title="Refresh from current 3D view"
                  variant="ghost"
                >
                  <RefreshCw aria-hidden="true" size={14} />
                </Button>
              </div>

              <Choice
                disabled={exporting || !source}
                id="fm-view-export-3d-format"
                label="Format"
                onChange={(value) => setFormat(value as Export3DFormat)}
                options={EXPORT_3D_FORMAT_OPTIONS}
                value={format}
              />

              <div className="fm-viewport-3d-settings__field">
                <label
                  className="fm-viewport-3d-settings__label"
                  htmlFor="fm-view-export-3d-filename"
                >
                  File name
                </label>
                <Input
                  className="fm-viewport-3d-settings__text-input"
                  disabled={exporting || !source}
                  id="fm-view-export-3d-filename"
                  onChange={(event) => setCustomFilename(event.currentTarget.value)}
                  onInput={(event) => setCustomFilename(event.currentTarget.value)}
                  type="text"
                  value={filename}
                />
              </div>

              <TogglePreference
                checked={hasVectors && includeVectors}
                description={
                  vtk
                    ? "Write 3-component vector arrays to the VTK dataset."
                    : "Embed 3D arrow glyphs for the active vector field."
                }
                disabled={exporting || !source || !hasVectors}
                id="fm-view-export-3d-vectors"
                label={vtk ? "Include vector field data" : "Include vector arrows"}
                onCheckedChange={(checked) => setIncludeVectorsOverride(checked)}
              />

              <TogglePreference
                checked={hasAirbox && includeAirbox}
                description={
                  hasAirbox
                    ? "Include the surrounding Airbox domain in the exported file."
                    : "Airbox geometry is unavailable in the current view."
                }
                disabled={exporting || !source || !hasAirbox}
                id="fm-view-export-3d-airbox"
                label="Include Airbox"
                onCheckedChange={setIncludeAirbox}
              />

              {canAnimate ? (
                <TogglePreference
                  checked={animate}
                  description="Export a full harmonic phase cycle animation."
                  disabled={exporting}
                  id="fm-view-export-3d-animate"
                  label="Animate mode phase"
                  onCheckedChange={setAnimate}
                />
              ) : null}

              {source && targets.length === 0 ? (
                <p className="fm-viewport-3d-settings__help" role="status">
                  No exportable geometry is selected.
                </p>
              ) : null}

              {source && includeVectors && missingAirboxVectors ? (
                <p className="fm-viewport-3d-settings__help">
                  Airbox vector data is unavailable.
                </p>
              ) : null}

              {source?.warnings.length ? (
                <ul className="fm-viewport-3d-settings__warnings">
                  {source.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}

              {sourceError || exportError ? (
                <p className="fm-viewport-3d-settings__error" role="alert">
                  {sourceError ?? exportError}
                </p>
              ) : null}

              <div className="fm-viewport-3d-settings__actions">
                {exporting ? (
                  <Button
                    onClick={() => job.current?.abort()}
                    size="sm"
                    variant="secondary"
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button
                  disabled={
                    exporting ||
                    !source ||
                    targets.length === 0 ||
                    Boolean(sourceError)
                  }
                  onClick={() => void handleExport3D()}
                  variant="primary"
                >
                  {exporting ? "Exporting…" : "Export 3D"}
                </Button>
              </div>
            </SettingsGroup>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
