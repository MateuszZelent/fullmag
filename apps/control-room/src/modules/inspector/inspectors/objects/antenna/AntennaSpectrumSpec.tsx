"use client";

import {
  Link2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  useMemo,
  type ReactNode,
} from "react";
import type { JsonObject } from "@/kernel/api/apiTypes";
import { antennaSpectrumPayloadByteLengths } from "@/kernel/api/codecs/antennaSpectrumManifestCodec";
import { useKernel } from "@/kernel/KernelContext";
import {
  antennaSpectrumPayloadEtag,
  useAntennaSourceSpectrumPayloadResource,
  useAntennaSourceSpectrumResource,
} from "@/kernel/resources/antennaResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { antennaResourceOwner } from "@/shared/domain/physics/antennaResourceOwner";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FeedbackBanner } from "../../../primitives/FeedbackBanner";
import type { InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  RadixRelatedResources,
  RadixSamplingPlaneFields,
  RadixSamplingResolution,
} from "../../../panels/antenna/AntennaExcitationComposers";
import { buildAntennaResourceTransaction } from "../../../panels/antenna/AntennaResourceEditorModel";
import {
  antennaSolveTargetKey,
  antennaSolveTargetOptions,
} from "../../../panels/antenna/AntennaSolveTargetsEditorModel";
import { AntennaWavevectorHeatmap } from "../../../panels/antenna/AntennaWavevectorHeatmap";
import { useAntennaSpectrumGridCompatibility } from "../../../panels/antenna/useAntennaSpectrumGridCompatibility";
import {
  type AntennaSpectrumSpecDraft,
  asNumber,
  asRecord,
  asString,
  canonicalResourceSelection,
  decodeFloat64LEArray,
  executeAntennaMergePatchTransaction,
  formatLengthSmart,
  LENGTH_UNITS,
  resolveSelectedAntennaResourceId,
  resolveSelectedObjectId,
  type SpectrumComponentKind,
} from "./antennaExcitationShared";

export function AntennaSpectrumInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionScopeKey = scope ?? undefined;
  const objectId = resolveSelectedObjectId(selection);
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const requestedSpecId = resolveSelectedAntennaResourceId(
    selection,
    "spectrumId",
    ":spectrum:",
  );

  const spectrumReqRec = useMemo(() => {
    const list = Array.isArray(sceneRec?.antenna_spectrum_requests)
      ? sceneRec.antenna_spectrum_requests.map(asRecord).filter(Boolean)
      : [];
    if (requestedSpecId) {
      return list.find((r) => asString(r?.id) === requestedSpecId) ?? null;
    }
    return (
      list.find((r) => {
        const id = asString(r?.id);
        return (
          Boolean(id) &&
          Boolean(scene.data) &&
          antennaResourceOwner(scene.data!, "spectrum", id!) === objectId
        );
      }) ??
      list[0] ??
      null
    );
  }, [objectId, requestedSpecId, scene.data, sceneRec]);

  const reqId =
    asString(spectrumReqRec?.id) ?? requestedSpecId ?? "spec_1";
  const outputId = asString(spectrumReqRec?.output_id);

  const spectrumRes = useAntennaSourceSpectrumResource(outputId, {
    enabled: Boolean(outputId),
  });

  const manifestInfo = useMemo(() => {
    if (!spectrumRes.data) return { fullManifest: false as const };
    try {
      const lengths = antennaSpectrumPayloadByteLengths(spectrumRes.data);
      return {
        etags: {
          amplitudes_re_im: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "amplitudes_re_im",
          ),
          k_u_rad_per_m: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "k_u_rad_per_m",
          ),
          k_v_rad_per_m: antennaSpectrumPayloadEtag(
            spectrumRes.data,
            "k_v_rad_per_m",
          ),
          power: antennaSpectrumPayloadEtag(spectrumRes.data, "power"),
        },
        fullManifest: true as const,
        lengths,
      };
    } catch {
      let powerEtag: string | undefined;
      try {
        powerEtag = antennaSpectrumPayloadEtag(spectrumRes.data, "power");
      } catch {
        powerEtag = undefined;
      }
      return { fullManifest: false as const, powerEtag };
    }
  }, [spectrumRes.data]);

  const typedSpectrumReq = useMemo(
    () =>
      (scene.data?.antenna_spectrum_requests ?? []).find(
        (r) => r.id === reqId,
      ) ?? null,
    [reqId, scene.data],
  );

  const gridCompatibility = useAntennaSpectrumGridCompatibility(
    spectrumRes.data ?? undefined,
    typedSpectrumReq?.nonuniform_k_grid,
    manifestInfo.fullManifest,
  );

  const fetchFullPayloads =
    Boolean(outputId && spectrumRes.data) &&
    manifestInfo.fullManifest &&
    gridCompatibility.kind === "ready";

  const kUPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "k_u_rad_per_m",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.k_u_rad_per_m
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.k_u_rad_per_m
        : undefined,
    },
  );
  const kVPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "k_v_rad_per_m",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.k_v_rad_per_m
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.k_v_rad_per_m
        : undefined,
    },
  );
  const amplitudesPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "amplitudes_re_im",
    {
      enabled: fetchFullPayloads,
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.amplitudes_re_im
        : undefined,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.amplitudes_re_im
        : undefined,
    },
  );
  const powerPayload = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "power",
    {
      enabled: Boolean(outputId && spectrumRes.data),
      expectedEtag: manifestInfo.fullManifest
        ? manifestInfo.etags.power
        : manifestInfo.powerEtag,
      maxResponseBytes: manifestInfo.fullManifest
        ? manifestInfo.lengths.payloads.power
        : undefined,
    },
  );

  const samplingPlane =
    asRecord(spectrumRes.data?.sampling) ??
    asRecord(spectrumReqRec?.sampling_plane);
  const nu = Math.max(
    2,
    Math.round(
      asNumber(spectrumRes.data?.k_u_count) ??
        asNumber(samplingPlane?.sample_count_u) ??
        64,
    ),
  );
  const nv = Math.max(
    2,
    Math.round(
      asNumber(spectrumRes.data?.k_v_count) ??
        asNumber(samplingPlane?.sample_count_v) ??
        64,
    ),
  );
  const extentUM = asNumber(samplingPlane?.extent_u_m) ?? 3.2e-6;
  const extentVM = asNumber(samplingPlane?.extent_v_m) ?? 3.2e-6;

  const decodedSpectrum = useMemo(() => {
    const powerArr = decodeFloat64LEArray(powerPayload.data);
    if (!powerArr || powerArr.length === 0) {
      return { kind: "empty" as const };
    }
    const kUArr = decodeFloat64LEArray(kUPayload.data);
    const kVArr = decodeFloat64LEArray(kVPayload.data);
    const ampArr = decodeFloat64LEArray(amplitudesPayload.data);
    return {
      amplitudes: ampArr ?? undefined,
      kU: kUArr && kUArr.length === nu ? kUArr : undefined,
      kV: kVArr && kVArr.length === nv ? kVArr : undefined,
      kind: "ready" as const,
      power: powerArr,
    };
  }, [
    amplitudesPayload.data,
    kUPayload.data,
    kVPayload.data,
    nu,
    nv,
    powerPayload.data,
  ]);

  const targetOptions = useMemo(
    () =>
      antennaSolveTargetOptions(scene.data).filter(
        (o) => o.target.kind === "object",
      ),
    [scene.data],
  );
  const stageOptions = useMemo(
    () => [
      {
        label: "Keep exact current reference and asset pins",
        value: "__keep__",
      },
      ...(scene.data?.antenna_field_solve_stages ?? []).map((stage) => ({
        label: `Rebind explicitly to stage output: ${stage.id}`,
        value: stage.id,
      })),
    ],
    [scene.data],
  );

  const baseline = useMemo<AntennaSpectrumSpecDraft>(() => {
    const reqPlane = asRecord(spectrumReqRec?.sampling_plane);
    const originArr = Array.isArray(reqPlane?.origin_m)
      ? reqPlane.origin_m.join(", ")
      : "0, 0, 0";
    const axisUArr = Array.isArray(reqPlane?.axis_u)
      ? reqPlane.axis_u.join(", ")
      : "1, 0, 0";
    const axisVArr = Array.isArray(reqPlane?.axis_v)
      ? reqPlane.axis_v.join(", ")
      : "0, 1, 0";
    const rawComp = asString(spectrumReqRec?.component);
    const validComps: readonly SpectrumComponentKind[] = [
      "x",
      "y",
      "z",
      "u",
      "v",
      "normal",
      "vector_power",
      "transverse",
    ];
    const component: SpectrumComponentKind = validComps.includes(
      rawComp as SpectrumComponentKind,
    )
      ? (rawComp as SpectrumComponentKind)
      : "x";
    const rawNorm = asString(spectrumReqRec?.normalization);
    const rawOutside = asString(reqPlane?.outside_policy);
    const rawWindow = asString(spectrumReqRec?.window);
    const targetKey = typedSpectrumReq?.target
      ? antennaSolveTargetKey(typedSpectrumReq.target)
      : (targetOptions.find(
          (o) => o.target.kind === "object" && o.target.object_id !== objectId,
        )?.key ??
        targetOptions[0]?.key ??
        "");

    return {
      axisU: axisUArr,
      axisV: axisVArr,
      component,
      extentUM,
      extentVM,
      normalization:
        rawNorm === "unitary_discrete" ? "unitary_discrete" : "integral_si",
      originM: originArr,
      outsidePolicy: rawOutside === "zero" ? "zero" : "error",
      rebindStageId: "__keep__",
      sampleCountU: nu,
      sampleCountV: nv,
      scaleMode: "linear",
      targetKey,
      windowKind:
        rawWindow === "rectangular" ||
        rawWindow === "hamming" ||
        rawWindow === "blackman"
          ? rawWindow
          : "hann",
    };
  }, [
    extentUM,
    extentVM,
    nu,
    nv,
    objectId,
    spectrumReqRec,
    targetOptions,
    typedSpectrumReq,
  ]);

  const componentOptions = useMemo(() => {
    const base: Array<{ label: string; value: SpectrumComponentKind }> = [
      { label: "Hx (x)", value: "x" },
      { label: "Hy (y)", value: "y" },
      { label: "Hz (z)", value: "z" },
      { label: "Hu (plane u)", value: "u" },
      { label: "Hv (plane v)", value: "v" },
      { label: "H_normal (u × v)", value: "normal" },
      { label: "|H|² vector power", value: "vector_power" },
    ];
    if (baseline.component === "transverse") {
      base.push({
        label: "Transverse (equilibrium projection)",
        value: "transverse",
      });
    }
    return base;
  }, [baseline.component]);

  const relatedSelection = useMemo(
    () => canonicalResourceSelection(selection, objectId, "spectrum", reqId),
    [objectId, reqId, selection],
  );

  const spec = useMemo<InspectorSpec<AntennaSpectrumSpecDraft>>(
    () => ({
      id: "object.antenna.spectrum",
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
          { id: "spectrum", label: `Spectrum (${reqId})` },
        ],
        deleteAction: spectrumReqRec
          ? {
              confirmDescription:
                "Removes this spatial FFT spectrum request without deleting its source field solve.",
              confirmTitle: () => `Remove spectrum request ${reqId}?`,
              label: "Remove spectrum (no cascade)",
              onDelete: async () => {
                const baseRev =
                  asNumber(sceneRec?.revision) ??
                  asNumber(sceneRec?.scene_revision) ??
                  0;
                const remaining = (
                  Array.isArray(sceneRec?.antenna_spectrum_requests)
                    ? sceneRec.antenna_spectrum_requests
                    : []
                ).filter((r) => asString(asRecord(r)?.id) !== reqId);
                await executeAntennaMergePatchTransaction({
                  baseRevision: baseRev,
                  kernel,
                  label: `Remove antenna spectrum ${reqId}`,
                  mergePatch: {
                    antenna_spectrum_requests: remaining as JsonObject[],
                  },
                  scene: scene.data ?? null,
                  sessionScopeKey,
                });
              },
            }
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `spec:${reqId}`,
        icon: Sparkles,
        kindLabel: "2D spatial wavevector FFT |b̃(k_u, k_v)|",
        statePill: () =>
          decodedSpectrum.kind === "ready"
            ? { label: "Materialized", tone: "ok" }
            : { label: "Awaiting FFT", tone: "info" },
        title: () => `Wavevector Spectrum (${reqId})`,
      },
      facts: (d) => [
        {
          id: "grid",
          label: "k-grid",
          value: `${d.sampleCountU} × ${d.sampleCountV}`,
        },
        { id: "comp", label: "Component", value: `H_${d.component}` },
        {
          id: "ext",
          label: "Span u×v",
          value: `${formatLengthSmart(d.extentUM)} × ${formatLengthSmart(d.extentVM)}`,
        },
      ],
      modeTabs: [
        { id: "heatmap", label: "2D k-Space Map & Cuts" },
        { id: "sampling", label: "FFT Sampling Setup" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Sparkles,
          id: "k-heatmap",
          live: true,
          modeTabId: "heatmap",
          rows: [
            {
              key: "scaleMode",
              label: "Amplitude scale",
              options: [
                { label: "Linear |H̃|²", value: "linear" },
                { label: "Logarithmic [dB]", value: "db" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => {
                if (decodedSpectrum.kind !== "ready") {
                  return (
                    <FeedbackBanner
                      kind="warning"
                      message={
                        powerPayload.error?.message ??
                        "No published binary FFT payload is materialized for this spectrum request yet."
                      }
                    />
                  );
                }
                const specData = spectrumRes.data;
                return (
                  <AntennaWavevectorHeatmap
                    amplitudeUnit={specData?.amplitude_unit ?? "A"}
                    amplitudes={decodedSpectrum.amplitudes}
                    componentLabel={`|H̃_${ctx.draft.component}(ku, kv)|²`}
                    componentLabels={specData?.component_labels}
                    extentUM={ctx.draft.extentUM}
                    extentVM={ctx.draft.extentVM}
                    kU={decodedSpectrum.kU}
                    kV={decodedSpectrum.kV}
                    nu={nu}
                    nv={nv}
                    powerUnit={
                      specData?.payloads?.power?.unit ??
                      (specData?.amplitude_unit
                        ? `(${specData.amplitude_unit})²`
                        : "A²")
                    }
                    scaleMode={ctx.draft.scaleMode}
                    spectrum={specData}
                    values={decodedSpectrum.power}
                    waveVectorUnit={specData?.wave_vector_unit ?? "rad/m"}
                  />
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "2D wavevector excitation map (k_u, k_v)",
        },
        {
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "fft-sampling",
          modeTabId: "sampling",
          rows: [
            {
              key: "targetKey",
              label: "Target",
              options:
                targetOptions.length > 0
                  ? targetOptions.map((o) => ({ label: o.label, value: o.key }))
                  : [{ label: objectId, value: "" }],
              type: "select",
            },
            {
              key: "rebindStageId",
              label: "Source binding",
              options: stageOptions,
              type: "select",
            },
            {
              render: (ctx) => (
                <RadixSamplingPlaneFields
                  values={{
                    axisU: ctx.draft.axisU,
                    axisV: ctx.draft.axisV,
                    originM: ctx.draft.originM,
                  }}
                  onChange={(frame) => ctx.patchDraft(frame)}
                />
              ),
              type: "custom",
              wide: true,
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentUM",
              label: "Extent u",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "µm",
              key: "extentVM",
              label: "Extent v",
              min: 1e-9,
              minExclusive: true,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "sampleCountU",
              label: "Samples u",
              max: 512,
              min: 3,
              type: "number",
            },
            {
              integer: true,
              key: "sampleCountV",
              label: "Samples v",
              max: 512,
              min: 3,
              type: "number",
            },
            {
              render: (ctx) => (
                <RadixSamplingResolution
                  transform={
                    asString(spectrumReqRec?.transform) ?? "spatial_fft"
                  }
                  values={{
                    extentUM: String(ctx.draft.extentUM),
                    extentVM: String(ctx.draft.extentVM),
                    samplesU: String(ctx.draft.sampleCountU),
                    samplesV: String(ctx.draft.sampleCountV),
                  }}
                />
              ),
              type: "custom",
              wide: true,
            },
            {
              key: "component",
              label: "Component",
              options: componentOptions,
              type: "select",
            },
            {
              key: "windowKind",
              label: "Apodization window",
              options: [
                { label: "Rectangular", value: "rectangular" },
                { label: "Hann", value: "hann" },
                { label: "Hamming", value: "hamming" },
                { label: "Blackman", value: "blackman" },
              ],
              type: "select",
            },
            {
              key: "normalization",
              label: "Normalization",
              options: [
                { label: "Integral SI", value: "integral_si" },
                { label: "Unitary discrete", value: "unitary_discrete" },
              ],
              type: "segmented",
            },
            {
              key: "outsidePolicy",
              label: "Outside domain",
              options: [
                { label: "Fail request (error)", value: "error" },
                { label: "Explicit zero outside (zero)", value: "zero" },
              ],
              type: "segmented",
            },
          ],
          title: "Spatial FFT plane, normalization & apodization",
        },
        {
          defaultOpen: false,
          icon: Link2,
          id: "related-resources",
          live: true,
          rows: [
            {
              render: () => (
                <RadixRelatedResources
                  available={scene.status === "ready"}
                  scene={scene.data ?? null}
                  scope={scene.sessionScopeKey ?? scope}
                  selection={relatedSelection}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related antenna resources",
        },
      ],
      commitBar: {
        cleanMessage: () => "Spatial FFT request matches scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ??
            asNumber(sceneRec?.scene_revision) ??
            0;
          const rebind =
            draft.rebindStageId === "__keep__" ? "" : draft.rebindStageId;
          if (
            scene.data &&
            typedSpectrumReq &&
            typeof scene.data.revision === "number" &&
            typedSpectrumReq.sampling_plane?.origin_m &&
            draft.component !== "transverse"
          ) {
            try {
              const resourceDraft = {
                baseRevision: scene.data.revision,
                branches: [],
                key: `edit:${reqId}`,
                values: {
                  axisU: draft.axisU,
                  axisV: draft.axisV,
                  component: draft.component,
                  extentUM: String(draft.extentUM),
                  extentVM: String(draft.extentVM),
                  normalization: draft.normalization,
                  originM: draft.originM,
                  outsidePolicy: draft.outsidePolicy,
                  rebind,
                  samplesU: String(draft.sampleCountU),
                  samplesV: String(draft.sampleCountV),
                  target: draft.targetKey,
                  windowKind: draft.windowKind,
                },
              };
              const tx = buildAntennaResourceTransaction(
                scene.data,
                "spectrum",
                reqId,
                resourceDraft,
                false,
              );
              await executeAntennaMergePatchTransaction({
                baseRevision: tx.base_revision ?? baseRev,
                kernel,
                label: `Edit antenna spectrum ${reqId}`,
                mergePatch: tx.merge_patch as JsonObject,
                scene: scene.data,
                sessionScopeKey,
              });
              return true;
            } catch {
              // Fall through to structured merge_patch when minimal fixture lacks full solve stage metadata
            }
          }

          const parseVec3 = (
            str: string,
            fallback: [number, number, number],
          ): [number, number, number] => {
            const parts = str
              .split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isFinite(n));
            return parts.length === 3
              ? [parts[0]!, parts[1]!, parts[2]!]
              : fallback;
          };
          const resolvedTarget =
            targetOptions.find((o) => o.key === draft.targetKey)?.target ??
            (asRecord(spectrumReqRec?.target) as JsonObject | null) ?? {
              kind: "object",
              object_id: objectId,
            };
          const prevPlane = asRecord(spectrumReqRec?.sampling_plane) ?? {};
          const rebindStage = rebind
            ? (scene.data?.antenna_field_solve_stages ?? []).find(
                (s) => s.id === rebind,
              )
            : null;
          const rebindOut = rebindStage?.outputs.find(
            (o) => o.quantity === "H_ant_basis",
          );
          const nextSolutionRef =
            rebindStage && rebindOut
              ? {
                  kind: "stage_output",
                  output_id: rebindOut.id,
                  stage_id: rebindStage.id,
                }
              : (spectrumReqRec?.solution_ref ?? {
                  kind: "stage_output",
                  output_id: `${objectId}:field-solution`,
                  stage_id: `${objectId}:solve-field`,
                });

          const existing = Array.isArray(sceneRec?.antenna_spectrum_requests)
            ? sceneRec.antenna_spectrum_requests
            : [];
          const nextReq: JsonObject = {
            ...(spectrumReqRec ?? {}),
            component: draft.component,
            id: reqId,
            normalization: draft.normalization,
            sampling_plane: {
              ...prevPlane,
              axis_u: parseVec3(draft.axisU, [1, 0, 0]),
              axis_v: parseVec3(draft.axisV, [0, 1, 0]),
              extent_u_m: draft.extentUM,
              extent_v_m: draft.extentVM,
              interpolation:
                asString(prevPlane.interpolation) ?? "fem_element",
              origin_m: parseVec3(draft.originM, [0, 0, 0]),
              outside_policy: draft.outsidePolicy,
              sample_count_u: draft.sampleCountU,
              sample_count_v: draft.sampleCountV,
            },
            solution_ref: nextSolutionRef as JsonObject,
            target: resolvedTarget as JsonObject,
            transform: asString(spectrumReqRec?.transform) ?? "spatial_fft",
            window: draft.windowKind,
          } as JsonObject;
          const patched = spectrumReqRec
            ? existing.map((r) =>
                asString(asRecord(r)?.id) === reqId ? nextReq : r,
              )
            : [...existing, nextReq];

          await executeAntennaMergePatchTransaction({
            baseRevision: baseRev,
            kernel,
            label: `Edit antenna spectrum ${reqId}`,
            mergePatch: {
              antenna_spectrum_requests: patched as JsonObject[],
            },
            scene: scene.data ?? null,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      componentOptions,
      decodedSpectrum,
      kernel,
      nu,
      nv,
      objectId,
      powerPayload.error?.message,
      relatedSelection,
      reqId,
      scene.data,
      scene.sessionScopeKey,
      scene.status,
      sceneRec,
      scope,
      sessionScopeKey,
      spectrumReqRec,
      spectrumRes.data,
      stageOptions,
      targetOptions,
      typedSpectrumReq,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
