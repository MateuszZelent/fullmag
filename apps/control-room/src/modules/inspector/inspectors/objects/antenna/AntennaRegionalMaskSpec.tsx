"use client";

import { Radio } from "lucide-react";
import {
  useMemo,
  type ReactNode,
} from "react";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { FieldDriveCreateRequest, FieldDriveReplaceRequest, JsonObject, MaskFieldDriveCreateRequest, MaskFieldDriveReplaceRequest, MaskFieldDriveResource, ReadyAntennaTermsRequest, RegionalFieldDriveResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { antennaRegionalSources } from "@/shared/domain/physics/antennaRegionalSource";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../../template";
import {
  antennaWaveformDefaults,
  buildAntennaLegacyMigrationPatch,
  resolveAntennaObjectDraft,
} from "../../../panels/AntennaObjectPanelModel";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  type AntennaRegionalMaskDraft,
  asNumber,
  asRecord,
  asString,
  buildPolarizedGaussianMaskTerms,
  executeAntennaMergePatchTransaction,
  extractMaskDrivesFromScene,
  extractMaskTermParameter,
  extractRegionalFieldDrivesFromScene,
  FIELD_MT_UNITS,
  FREQUENCY_UNITS,
  resolveSelectedObjectId,
  TIME_UNITS,
} from "./antennaExcitationShared";

export function AntennaRegionalMaskInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const regionalSources = useMemo(
    () => antennaRegionalSources(scene.data ?? null, objectId),
    [objectId, scene.data],
  );

  const existingMaskDrive = useMemo(() => {
    const maskDrives = extractMaskDrivesFromScene(sceneRec);
    return (
      maskDrives.find((d) => {
        const target = asRecord(d.target);
        return (
          asString(target?.object_id) === objectId ||
          asString(asRecord(d.spatial_profile)?.object_id) === objectId ||
          asString(d.source_object_id) === objectId
        );
      }) ?? null
    );
  }, [objectId, sceneRec]);

  const existingFieldDrive = useMemo(() => {
    if (regionalSources.canonical) return regionalSources.canonical;
    const drives = extractRegionalFieldDrivesFromScene(sceneRec);
    return (
      drives.find(
        (d) => asString(asRecord(d.spatial_profile)?.object_id) === objectId,
      ) ?? null
    );
  }, [objectId, regionalSources.canonical, sceneRec]);

  const legacySource = regionalSources.legacy;

  const mode: "missing" | "canonical" | "legacy" = existingMaskDrive || existingFieldDrive
    ? "canonical"
    : legacySource
      ? "legacy"
      : "missing";

  const baseline = useMemo<AntennaRegionalMaskDraft>(() => {
    const active = existingMaskDrive ?? existingFieldDrive ?? legacySource;
    const sp = asRecord(active?.spatial_profile);
    const envelope = asRecord(sp?.envelope) ?? sp;
    const waveform = asRecord(active?.waveform);
    const rawKind = asString(sp?.kind);
    const envelopeKind = asString(envelope?.kind);
    const spatialProfileKind: AntennaRegionalMaskDraft["spatialProfileKind"] =
      existingMaskDrive || rawKind === "gaussian_k_source"
        ? "gaussian_k_source"
        : rawKind === "spatial_sinc_grating" || envelopeKind === "sinc"
          ? "spatial_sinc_grating"
          : "uniform_mask";

    const maskPx = extractMaskTermParameter(existingMaskDrive, "px");
    const maskPy = extractMaskTermParameter(existingMaskDrive, "py");
    const maskPz = extractMaskTermParameter(existingMaskDrive, "pz");
    const rawDir =
      maskPx !== null && maskPy !== null && maskPz !== null
        ? [maskPx, maskPy, maskPz]
        : Array.isArray(active?.direction)
          ? active.direction
          : Array.isArray(asRecord(active?.field)?.direction)
            ? (asRecord(active?.field)?.direction as unknown[])
            : Array.isArray(active?.polarization)
              ? active.polarization
              : null;
    const polarization: readonly [number, number, number] =
      rawDir &&
      rawDir.length === 3 &&
      rawDir.every((v): v is number => typeof v === "number" && Number.isFinite(v))
        ? [rawDir[0]!, rawDir[1]!, rawDir[2]!]
        : [0, 1, 0];

    const rawWfKind = asString(waveform?.kind);
    const waveformKind: AntennaRegionalMaskDraft["waveformKind"] =
      mode === "missing"
        ? "sinusoidal"
        : rawWfKind === "constant"
          ? "constant"
          : rawWfKind === "sinc_pulse"
            ? "sinc_pulse"
            : rawWfKind === "sinusoidal"
              ? "sinusoidal"
              : existingMaskDrive
                ? "sinusoidal"
                : "constant";

    const sincPeriodM = asNumber(envelope?.period_m);
    const maskWavelengthM = extractMaskTermParameter(
      existingMaskDrive,
      "wavelength",
    );
    const maskSigmaXM = extractMaskTermParameter(existingMaskDrive, "sigma_x");
    const k0FromScene =
      asNumber(sp?.k0_rad_per_um) ??
      (sincPeriodM && sincPeriodM > 0
        ? (2 * Math.PI) / (sincPeriodM * 1e6)
        : maskWavelengthM && maskWavelengthM > 0
          ? (2 * Math.PI) / (maskWavelengthM * 1e6)
          : 12.5);
    const spreadFromScene =
      asNumber(sp?.sigma_k_rad_per_um) ??
      (maskSigmaXM && maskSigmaXM > 0 ? 1 / (maskSigmaXM * 1e6) : 3.0);

    const legacyResolved =
      mode === "legacy" ? resolveAntennaObjectDraft(selection, scene.data) : null;

    return {
      centerWavevectorRadPerUm: k0FromScene,
      enabled: active ? active.enabled !== false : true,
      frequencyHz:
        asNumber(waveform?.frequency_hz) ??
        asNumber(active?.frequency_hz) ??
        (legacyResolved ? Number(legacyResolved.sinusoidalFrequencyHz) : null) ??
        6e9,
      peakFieldT:
        asNumber(active?.amplitude_B_T) ??
        asNumber(active?.B) ??
        asNumber(asRecord(active?.field)?.amplitude_B_T) ??
        asNumber(active?.amplitude_t) ??
        extractMaskTermParameter(existingMaskDrive, "amplitude") ??
        2e-3,
      polarization,
      sincAmplitude:
        asNumber(waveform?.amplitude) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincAmplitude),
      sincCutoffHz:
        asNumber(waveform?.cutoff_hz) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincCutoffHz),
      sincT0:
        asNumber(waveform?.t0) ??
        Number(antennaWaveformDefaults.sinc_pulse.sincT0),
      sinusoidalOffset: asNumber(waveform?.offset) ?? 0,
      sinusoidalPhaseRad: asNumber(waveform?.phase_rad) ?? 0,
      spatialProfileKind,
      waveformKind,
      wavevectorSpreadRadPerUm: spreadFromScene,
    };
  }, [
    existingFieldDrive,
    existingMaskDrive,
    legacySource,
    mode,
    scene.data,
    selection,
  ]);

  const spec = useMemo<InspectorSpec<AntennaRegionalMaskDraft>>(
    () => ({
      id: "object.antenna.regional",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "regional", label: "Regional Field Drive" },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `regional:${objectId}`,
        icon: Radio,
        kindLabel: "Analytical regional mask & k-space source",
        statePill: () =>
          mode === "legacy"
            ? { label: "Migration required", tone: "warn" }
            : mode === "missing"
              ? { label: "New mask drive", tone: "info" }
              : { label: "Configured", tone: "ok" },
        title: () => "Regional Field Drive",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Drive state",
          value:
            mode === "legacy"
              ? "Legacy Zeeman mask"
              : mode === "missing"
                ? "Ready to create"
                : "Committed",
        },
        {
          id: "profile",
          label: "Profile",
          value: d.spatialProfileKind.replaceAll("_", " "),
        },
        {
          id: "wf",
          label: "Waveform",
          value: d.waveformKind.replaceAll("_", " "),
        },
        {
          id: "b0",
          label: "Peak B₀",
          value: `${(d.peakFieldT * 1e3).toFixed(2)} mT`,
        },
      ],
      notices: (): readonly InspectorNotice<AntennaRegionalMaskDraft>[] =>
        mode === "legacy"
          ? [
              {
                id: "legacy-zeeman-migration",
                text: "Deprecated prescribed_zeeman_mask source detected in current_modules. Applying migrates it atomically to a canonical RegionalFieldDrive.",
                title: "Legacy source migration required",
                tone: "warn",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: Radio,
          id: "mask-profile",
          rows: [
            {
              key: "enabled",
              label: "Enable regional excitation drive",
              type: "switch",
            },
            {
              key: "spatialProfileKind",
              label: "Spatial mask profile",
              options: [
                { label: "Uniform Mask", value: "uniform_mask" },
                { label: "Sinc Grating", value: "spatial_sinc_grating" },
                { label: "Gaussian k-Source", value: "gaussian_k_source" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "mT",
              key: "peakFieldT",
              label: "Peak excitation field",
              min: 1e-12,
              minExclusive: true,
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FIELD_MT_UNITS,
            },
            {
              axisPresets: true,
              key: "polarization",
              label: "Field polarization vector",
              normalizeAction: true,
              symbol: <>{"e\u0302"}</>,
              type: "vector3",
            },
            {
              key: "centerWavevectorRadPerUm",
              label: "Center wavevector k₀",
              min: 0.05,
              showWhen: (d) =>
                d.spatialProfileKind === "gaussian_k_source" ||
                d.spatialProfileKind === "spatial_sinc_grating",
              step: 0.5,
              symbol: (
                <>
                  k<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
            {
              key: "wavevectorSpreadRadPerUm",
              label: "Gaussian spread σ_k",
              min: 0.05,
              showWhen: (d) => d.spatialProfileKind === "gaussian_k_source",
              step: 0.25,
              symbol: (
                <>
                  &sigma;<sub>k</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad/µm",
            },
            {
              key: "waveformKind",
              label: "Waveform",
              options: [
                { label: "Constant", value: "constant" },
                { label: "Sinc pulse", value: "sinc_pulse" },
                { label: "Sinusoidal", value: "sinusoidal" },
              ],
              showWhen: (d) => d.spatialProfileKind !== "gaussian_k_source",
              structural: true,
              type: "segmented",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "frequencyHz",
              label: "Excitation frequency",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfileKind === "gaussian_k_source" ||
                d.waveformKind === "sinusoidal",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              key: "sinusoidalPhaseRad",
              label: "Phase",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinusoidal",
              step: 0.1,
              symbol: (
                <>
                  &phi;<sub>0</sub>
                </>
              ),
              type: "number",
              unitSuffix: "rad",
            },
            {
              key: "sinusoidalOffset",
              label: "Offset",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinusoidal",
              step: 0.05,
              type: "number",
            },
            {
              key: "sincAmplitude",
              label: "Waveform amplitude",
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              step: 0.1,
              type: "number",
            },
            {
              defaultDisplayUnit: "GHz",
              key: "sincCutoffHz",
              label: "Sinc cutoff",
              min: 1e3,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              defaultDisplayUnit: "ps",
              key: "sincT0",
              label: "Center time t₀",
              min: 0,
              showWhen: (d) =>
                d.spatialProfileKind !== "gaussian_k_source" &&
                d.waveformKind === "sinc_pulse",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS,
            },
          ],
          title: "Analytical regional mask & k-source",
        },
      ],
      commitBar: {
        allowCleanApply: mode === "missing" || mode === "legacy",
        applyLabel: () =>
          mode === "legacy" ? "Migrate and Apply" : "Apply",
        cleanMessage: () =>
          mode === "missing"
            ? "Click Apply to create regional drive"
            : mode === "legacy"
              ? "Click Migrate and Apply to convert legacy Zeeman mask"
              : "Regional mask drive matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;

          if (
            mode === "legacy" &&
            draft.spatialProfileKind !== "gaussian_k_source"
          ) {
            const legacySelection: Selection =
              selection.ref?.type === "scene-object"
                ? selection
                : { ...selection, objectId };
            const migration = buildAntennaLegacyMigrationPatch(
              legacySelection,
              scene.data ?? null,
              {
                amplitudeB: String(draft.peakFieldT),
                direction: draft.polarization.join(", "),
                sincAmplitude: String(draft.sincAmplitude),
                sincCutoffHz: String(draft.sincCutoffHz),
                sincT0: String(draft.sincT0),
                sinusoidalFrequencyHz: String(draft.frequencyHz),
                sinusoidalOffset: String(draft.sinusoidalOffset),
                sinusoidalPhaseRad: String(draft.sinusoidalPhaseRad),
                waveformKind: draft.waveformKind,
              },
            );
            if (migration.error || !migration.drives || !migration.modules) {
              throw new Error(
                migration.error ?? "Invalid legacy antenna migration.",
              );
            }
            await executeAntennaMergePatchTransaction({
              baseRevision: baseRev,
              kernel,
              label: `Migrate legacy antenna drive ${objectId}`,
              mergePatch: {
                current_modules: {
                  modules: migration.modules as JsonObject[],
                },
                field_drives: {
                  drives: migration.drives as JsonObject[],
                },
              },
              scene: scene.data ?? null,
              sessionScopeKey,
            });
            return true;
          }

          if (draft.spatialProfileKind === "gaussian_k_source") {
            const maskDriveId =
              asString(existingMaskDrive?.id) ?? `mask-drive-${objectId}`;
            const wavelengthM =
              (2 * Math.PI) /
              Math.max(1e-3, draft.centerWavevectorRadPerUm * 1e6);
            const sigmaXM =
              1 / Math.max(1e3, draft.wavevectorSpreadRadPerUm * 1e6);
            const termsRequest: ReadyAntennaTermsRequest = {
              arguments: {
                amplitude: draft.peakFieldT,
                frequency: draft.frequencyHz,
                sigma_x: sigmaXM,
                wavelength: wavelengthM,
              },
              function: "fullmag.antennas.gaussian_k_source",
            };
            const synthesized = await kernel.api.model.readyAntennaTerms(
              termsRequest,
              sessionScopeKey ? { sessionScopeKey } : undefined,
            );
            const polarizedTerms = buildPolarizedGaussianMaskTerms(
              synthesized.terms ?? [],
              draft,
              wavelengthM,
              sigmaXM,
            );
            const existingTyped =
              existingMaskDrive as Partial<MaskFieldDriveResource> | null;
            const maskDrivePayload: MaskFieldDriveResource = {
              activation: existingTyped?.activation ?? {
                kind: "all_time_evolution",
              },
              enabled: draft.enabled,
              frame: existingTyped?.frame ?? "local",
              id: maskDriveId,
              name: existingTyped?.name || maskDriveId,
              position_m: existingTyped?.position_m ?? [0, 0, 0],
              schema_version: "mask_field_drive.v1",
              shape: existingTyped?.shape ?? {
                center: [0, 0, 0],
                kind: "box",
                size: [1e-6, 1e-6, 1e-7],
              },
              target: existingTyped?.target ?? {
                kind: "object",
                object_id: objectId,
              },
              terms: polarizedTerms,
              time_origin: existingTyped?.time_origin ?? "stage_local",
            };
            await runAuthoringMutationWithHistory(
              {
                api: kernel.api,
                authoringHistory: kernel.authoringHistory,
                resourceData: scene.data
                  ? { [MODEL_SCENE_PATH]: scene.data }
                  : undefined,
                selection: kernel.selection,
                sessionScopeKey,
              },
              `${existingMaskDrive ? "Update" : "Create"} Gaussian k-source ${maskDriveId}`,
              async () => {
                if (existingMaskDrive) {
                  const replaceReq: MaskFieldDriveReplaceRequest = {
                    base_revision: baseRev,
                    drive: maskDrivePayload,
                  };
                  return kernel.api.model.replaceMaskFieldDrive(
                    maskDriveId,
                    replaceReq,
                    sessionScopeKey ? { sessionScopeKey } : undefined,
                  );
                }
                const createReq: MaskFieldDriveCreateRequest = {
                  base_revision: baseRev,
                  drive: maskDrivePayload,
                };
                return kernel.api.model.createMaskFieldDrive(
                  createReq,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
              },
            );
          } else {
            const regionalDriveId =
              asString(existingFieldDrive?.id) ?? `${objectId}:H_ant`;
            const existingRegional =
              existingFieldDrive as Partial<RegionalFieldDriveResource> | null;
            const envelope: Extract<
              RegionalFieldDriveResource["spatial_profile"],
              { kind: "geometry_mask" }
            >["envelope"] =
              draft.spatialProfileKind === "spatial_sinc_grating"
                ? {
                    axis: [1, 0, 0],
                    kind: "sinc",
                    period_m:
                      (2 * Math.PI) /
                      Math.max(1e3, draft.centerWavevectorRadPerUm * 1e6),
                  }
                : { kind: "uniform" };

            let waveform: RegionalFieldDriveResource["waveform"];
            if (draft.waveformKind === "constant") {
              waveform = { kind: "constant" };
            } else if (draft.waveformKind === "sinc_pulse") {
              waveform = {
                amplitude: draft.sincAmplitude,
                cutoff_hz: draft.sincCutoffHz,
                kind: "sinc_pulse",
                t0: draft.sincT0,
              };
            } else {
              waveform = {
                frequency_hz: draft.frequencyHz,
                kind: "sinusoidal",
                offset: draft.sinusoidalOffset,
                phase_rad: draft.sinusoidalPhaseRad,
              };
            }

            const fieldDrivePayload: RegionalFieldDriveResource = {
              activation: existingRegional?.activation ?? {
                kind: "all_time_evolution",
              },
              amplitude_B_T: draft.peakFieldT,
              direction: [...draft.polarization],
              enabled: draft.enabled,
              id: regionalDriveId,
              kind: "regional",
              ...(existingRegional?.migration !== undefined
                ? { migration: existingRegional.migration }
                : {}),
              name: existingRegional?.name || regionalDriveId,
              spatial_profile: {
                envelope,
                kind: "geometry_mask",
                object_id: objectId,
              },
              target: existingRegional?.target ?? { kind: "global" },
              time_origin: existingRegional?.time_origin ?? "stage_local",
              waveform,
            };
            await runAuthoringMutationWithHistory(
              {
                api: kernel.api,
                authoringHistory: kernel.authoringHistory,
                resourceData: scene.data
                  ? { [MODEL_SCENE_PATH]: scene.data }
                  : undefined,
                selection: kernel.selection,
                sessionScopeKey,
              },
              `${existingFieldDrive ? "Update" : "Create"} regional field drive ${regionalDriveId}`,
              async () => {
                if (existingFieldDrive) {
                  const replaceReq: FieldDriveReplaceRequest = {
                    base_revision: baseRev,
                    drive: fieldDrivePayload,
                  };
                  return kernel.api.model.replaceFieldDrive(
                    regionalDriveId,
                    replaceReq,
                    sessionScopeKey ? { sessionScopeKey } : undefined,
                  );
                }
                const createReq: FieldDriveCreateRequest = {
                  base_revision: baseRev,
                  drive: fieldDrivePayload,
                };
                return kernel.api.model.createFieldDrive(
                  createReq,
                  sessionScopeKey ? { sessionScopeKey } : undefined,
                );
              },
            );
          }

          invalidateAuthoringMutationDependents(
            kernel.resources,
            "interaction",
            baseRev + 1,
          );
          return true;
        },
      },
    }),
    [
      existingFieldDrive,
      existingMaskDrive,
      kernel,
      mode,
      objectId,
      scene.data,
      sceneRec,
      selection,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
