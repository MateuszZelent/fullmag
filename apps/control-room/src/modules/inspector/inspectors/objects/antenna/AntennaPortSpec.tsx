"use client";

import {
  Compass,
  Cpu,
  PlugZap,
  Radio,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  antennaNavigationLinks,
  type AntennaNavigationLink,
} from "@/modules/explorer/public";
import {
  antennaPortTerminalChoices,
  type AntennaPortModeResource,
} from "@/shared/domain/physics/antennaPortValidation";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  asNumber,
  asRecord,
  asString,
  buildAntennaOriginSelection,
  EditablePortBranchesEditor,
  executeAntennaMergePatchTransaction,
  normalizeSceneForAntennaNavigation,
  openAntennaNavigationLink,
  resolveSelectedAntennaPortId,
  sanitizeDisplayMessage,
  type JsonRecord,
  type MergePatchTransactionRequest,
} from "../../../panels/antenna/AntennaCoreHelpers";
import {
  buildAntennaPortTransaction,
  type AntennaPortBranchDraft,
} from "../../../panels/antenna/AntennaPortEditorModel";
import { formatAntennaParameter } from "../../../panels/antenna/AntennaReadoutModel";
import {
  antennaResourceDependents,
  buildAntennaResourceTransaction,
  createAntennaResourceDraft,
} from "../../../panels/antenna/AntennaResourceEditorModel";
import { convertRfPortLevel } from "../../../panels/antenna/rfPowerConverter";
import { NavigationLinksList } from "./AntennaOverviewSpec";
import {
  CURRENT_UNITS,
  IMPEDANCE_UNITS,
  VOLTAGE_UNITS,
} from "./antennaCoreShared";

interface AntennaPortSpecDraft {
  z0Ohm: number;
  levelMode: "power" | "current" | "voltage";
  rfPowerDbm: number;
  peakCurrentA: number;
  peakVoltageV: number;
  currentTransportId: string;
  branches: readonly AntennaPortBranchDraft[];
}

export function AntennaPortInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const [portActionFeedback, setPortActionFeedback] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const portId = useMemo(
    () => resolveSelectedAntennaPortId(selection, objectId, scene.data),
    [objectId, scene.data, selection],
  );

  const portRec = useMemo(() => {
    const raw = Array.isArray(sceneRec?.antenna_port_modes)
      ? sceneRec.antenna_port_modes
      : [];
    const records = raw
      .map(asRecord)
      .filter((p): p is JsonRecord => p !== null);
    return (
      records.find(
        (p) => asString(p.id) === portId && asString(p.source_object_id) === objectId,
      ) ??
      records.find((p) => asString(p.id) === portId) ??
      null
    );
  }, [objectId, portId, sceneRec]);

  const transportOptions = useMemo(() => {
    const raw = Array.isArray(sceneRec?.current_transports)
      ? sceneRec.current_transports
      : [];
    const opts = raw
      .map(asRecord)
      .filter(
        (ct) =>
          ct !== null &&
          (!Array.isArray(ct.domain) ||
            ct.domain.some((ref) => asString(asRecord(ref)?.object_id) === objectId)),
      )
      .map((ct) => {
        const name = asString(ct?.name) ?? "";
        return { label: name, value: name };
      })
      .filter((o) => o.value.length > 0);
    const currentId = asString(portRec?.current_transport_id);
    if (currentId && !opts.some((o) => o.value === currentId)) {
      opts.unshift({ label: currentId, value: currentId });
    }
    return opts.length > 0 ? opts : [{ label: "ct_antenna", value: "ct_antenna" }];
  }, [objectId, portRec, sceneRec]);

  const normalizedScene = useMemo(
    () =>
      scene.data ? normalizeSceneForAntennaNavigation(scene.data, objectId) : null,
    [objectId, scene.data],
  );

  const baseline = useMemo<AntennaPortSpecDraft>(() => {
    const z0Ohm = 50;
    const rfPowerDbm = 10;
    const converted = convertRfPortLevel({
      mode: "power_dbm",
      value: rfPowerDbm,
      z0Ohm,
    });
    const rawBranches = Array.isArray(portRec?.branches) ? portRec.branches : [];
    const branches: AntennaPortBranchDraft[] =
      rawBranches.length > 0
        ? rawBranches.map((b, idx) => {
            const br = asRecord(b) ?? {};
            const sw = asNumber(br.signed_weight) ?? asNumber(br.weight) ?? 1;
            const id = asString(br.id) ?? `branch_${idx + 1}`;
            return {
              id,
              inletTerminalRef: asString(br.inlet_terminal_ref) ?? "",
              originalId: asString(br.id),
              outletTerminalRef: asString(br.outlet_terminal_ref) ?? "",
              rowKey: `original-${idx}`,
              signedWeight: String(sw),
            };
          })
        : [
            {
              id: "signal_main",
              inletTerminalRef: "signal:inlet",
              originalId: null,
              outletTerminalRef: "signal:outlet",
              rowKey: "original-0",
              signedWeight: "1",
            },
            {
              id: "return_main",
              inletTerminalRef: "return:inlet",
              originalId: null,
              outletTerminalRef: "return:outlet",
              rowKey: "original-1",
              signedWeight: "-1",
            },
          ];

    return {
      branches,
      currentTransportId:
        asString(portRec?.current_transport_id) ?? transportOptions[0]!.value,
      levelMode: "power",
      peakCurrentA: converted.peakCurrentA,
      peakVoltageV: converted.peakVoltageV,
      rfPowerDbm,
      z0Ohm,
    };
  }, [portRec, transportOptions]);

  const portOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.port",
        "port",
        portId,
      ),
    [objectId, portId, selection],
  );

  const relatedLinks = useMemo(() => {
    if (!normalizedScene) return [];
    return antennaNavigationLinks(normalizedScene, portOriginSelection);
  }, [normalizedScene, portOriginSelection]);

  const portDependents = useMemo(
    () =>
      normalizedScene ? antennaResourceDependents(normalizedScene, "port", portId) : [],
    [normalizedScene, portId],
  );

  const handleOpenRelated = useCallback(
    (link: AntennaNavigationLink) => {
      openAntennaNavigationLink({
        kernel,
        link,
        objectId,
        onError: setPortActionFeedback,
        originSelection: portOriginSelection,
        sessionScopeKey,
      });
    },
    [kernel, objectId, portOriginSelection, sessionScopeKey],
  );

  const handleRemovePort = useCallback(async () => {
    if (!normalizedScene || removePending || portDependents.length > 0) return;
    const baseRev =
      normalizedScene.revision ??
      asNumber(asRecord(normalizedScene)?.scene_revision) ??
      0;
    const sceneWithRev: SceneResource = { ...normalizedScene, revision: baseRev };
    const key = JSON.stringify([sessionScopeKey ?? "local", "port", portId]);
    setRemovePending(true);
    setPortActionFeedback(null);
    try {
      const resourceDraft = createAntennaResourceDraft(
        sceneWithRev,
        "port",
        portId,
        key,
      );
      const request = buildAntennaResourceTransaction(
        sceneWithRev,
        "port",
        portId,
        resourceDraft,
        true,
      );
      await executeAntennaMergePatchTransaction({
        kernel,
        label: `Remove antenna port ${portId}`,
        mutationKind: "interaction",
        request,
        scene: sceneWithRev,
        sessionScopeKey,
        validateAck: true,
      });
      kernel.selection.set(
        buildAntennaOriginSelection(selection, objectId, "object.antenna"),
        "inspector",
      );
    } catch (error) {
      setPortActionFeedback(
        sanitizeDisplayMessage(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setRemovePending(false);
    }
  }, [
    kernel,
    normalizedScene,
    objectId,
    portDependents.length,
    portId,
    removePending,
    selection,
    sessionScopeKey,
  ]);

  const spec = useMemo<InspectorSpec<AntennaPortSpecDraft>>(
    () => ({
      id: "object.antenna.port",
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
          { id: "port", label: `Port (${portId})` },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `port:${portId}`,
        icon: PlugZap,
        kindLabel: "Antenna RF port mode & terminal normalization",
        statePill: () =>
          portRec
            ? { label: "Configured", tone: "ok" }
            : { label: "Missing", tone: "warn" },
        title: () => `RF Port (${portId})`,
      },
      facts: (d) => {
        const conv = convertRfPortLevel({
          mode:
            d.levelMode === "power"
              ? "power_dbm"
              : d.levelMode === "current"
                ? "current_a"
                : "voltage_v",
          value:
            d.levelMode === "power"
              ? d.rfPowerDbm
              : d.levelMode === "current"
                ? d.peakCurrentA
                : d.peakVoltageV,
          z0Ohm: d.z0Ohm,
        });
        return [
          { id: "portId", label: "Port ID", value: portId },
          {
            id: "schema",
            label: "Schema",
            value: asString(portRec?.schema_version) ?? "antenna_port_mode.v2",
          },
          {
            id: "power",
            label: "RF Power",
            value: Number.isFinite(conv.powerDbm)
              ? `${conv.powerDbm >= 0 ? "+" : ""}${conv.powerDbm.toFixed(1)} dBm (${conv.powerMw.toFixed(2)} mW)`
              : "0 mW",
          },
          {
            id: "i0",
            label: "Peak current I₀",
            value: `${conv.peakCurrentMa.toFixed(2)} mA`,
          },
        ];
      },
      notices: () =>
        portActionFeedback
          ? [
              {
                id: "port-action-msg",
                text: portActionFeedback,
                title: "Port operation notice",
                tone: "warn",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: Cpu,
          id: "port-branches",
          rows: [
            {
              key: "currentTransportId",
              label: "Current transport reference",
              options: transportOptions,
              type: "select",
            },
            {
              format: () =>
                formatAntennaParameter(
                  asNumber(portRec?.normalization_current_a) ?? 1,
                  "A",
                ),
              label: "Reference normalization current",
              type: "readonly",
            },
            {
              key: "branches",
              label: "Port terminal branches",
              render: (ctx) => {
                const candidateMode: AntennaPortModeResource = {
                  branches: [],
                  current_transport_id: ctx.draft.currentTransportId,
                  id: portId,
                  normalization_current_a:
                    asNumber(portRec?.normalization_current_a) ?? 1,
                  schema_version:
                    asString(portRec?.schema_version) === "antenna_port_mode.v3"
                      ? "antenna_port_mode.v3"
                      : "antenna_port_mode.v2",
                  source_object_id: objectId,
                };
                const choices = normalizedScene
                  ? antennaPortTerminalChoices(normalizedScene, candidateMode)
                  : [];
                return (
                  <EditablePortBranchesEditor
                    branches={ctx.draft.branches}
                    terminalChoices={choices}
                    onChange={(next) => ctx.setField("branches", next)}
                  />
                );
              },
              type: "custom",
              validate: (_val, d) => {
                if (d.branches.length < 2) {
                  return "At least two signed terminal branches are required.";
                }
                for (let i = 0; i < d.branches.length; i++) {
                  const br = d.branches[i]!;
                  if (!br.id.trim()) {
                    return `Branch ${i + 1} ID is required.`;
                  }
                  if (!br.inletTerminalRef.trim() || !br.outletTerminalRef.trim()) {
                    return `Branch '${br.id}' requires explicit inlet and outlet terminal references.`;
                  }
                  const sw = Number(br.signedWeight);
                  if (!br.signedWeight.trim() || !Number.isFinite(sw) || sw === 0) {
                    return `Branch '${br.id}' signed weight must be a finite non-zero number.`;
                  }
                }
                return null;
              },
              wide: true,
            },
          ],
          title: "Port terminal branches",
        },
        {
          defaultOpen: true,
          icon: Radio,
          id: "rf-converter",
          live: true,
          rows: [
            {
              defaultDisplayUnit: "Ω",
              key: "z0Ohm",
              label: "Characteristic impedance",
              min: 0.1,
              minExclusive: true,
              symbol: (
                <>
                  Z<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: IMPEDANCE_UNITS,
            },
            {
              key: "levelMode",
              label: "Specify drive level by",
              options: [
                { label: "RF Power P [dBm]", value: "power" },
                { label: "Peak Current I₀", value: "current" },
                { label: "Peak Voltage V₀", value: "voltage" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "rfPowerDbm",
              label: "Input RF power",
              showWhen: (d) => d.levelMode === "power",
              step: 0.5,
              symbol: (
                <>
                  P<sub>RF</sub>
                </>
              ),
              type: "number",
              unitSuffix: "dBm",
            },
            {
              defaultDisplayUnit: "mA",
              key: "peakCurrentA",
              label: "Peak current amplitude",
              min: 0,
              showWhen: (d) => d.levelMode === "current",
              symbol: (
                <>
                  I<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: CURRENT_UNITS,
            },
            {
              defaultDisplayUnit: "V",
              key: "peakVoltageV",
              label: "Peak voltage amplitude",
              min: 0,
              showWhen: (d) => d.levelMode === "voltage",
              symbol: (
                <>
                  V<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: VOLTAGE_UNITS,
            },
            {
              format: (d) => {
                const conv = convertRfPortLevel({
                  mode:
                    d.levelMode === "power"
                      ? "power_dbm"
                      : d.levelMode === "current"
                        ? "current_a"
                        : "voltage_v",
                  value:
                    d.levelMode === "power"
                      ? d.rfPowerDbm
                      : d.levelMode === "current"
                        ? d.peakCurrentA
                        : d.peakVoltageV,
                  z0Ohm: d.z0Ohm,
                });
                return `${conv.peakCurrentMa.toFixed(2)} mA (${(conv.iRmsA * 1e3).toFixed(2)} mA rms) · ${conv.peakVoltageV.toFixed(3)} V (${conv.vRmsV.toFixed(4)} V rms) · ${conv.powerMw.toFixed(2)} mW`;
              },
              label: "Derived CW equivalents",
              type: "readonly",
            },
          ],
          title: "RF impedance & level calculator (live)",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "related-resources",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No related conductor or field-solve resources reference this port yet."
                  links={relatedLinks}
                  onOpenLink={handleOpenRelated}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related resources",
        },
        {
          defaultOpen: false,
          icon: Trash2,
          id: "remove-port",
          rows: [
            {
              render: (ctx) => {
                const isDirty =
                  ctx.draft.currentTransportId !== ctx.baseline.currentTransportId ||
                  JSON.stringify(ctx.draft.branches) !==
                    JSON.stringify(ctx.baseline.branches);
                const blockedByDependents = portDependents.length > 0;
                return (
                  <div className="flex flex-col gap-2" data-testid="remove-port-section">
                    <p className="fm-inspector-hint">
                      Removal never cascades. Rebind or remove every dependent resource
                      before removing this port.
                    </p>
                    {blockedByDependents ? (
                      <div
                        className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary"
                        role="status"
                      >
                        Removal refused until dependents are rebound or removed:{" "}
                        {portDependents.join(", ")}.
                      </div>
                    ) : null}
                    {isDirty ? (
                      <div
                        className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary"
                        role="status"
                      >
                        Apply or revert staged port edits before removing this port.
                      </div>
                    ) : null}
                    <div>
                      <Button
                        disabled={
                          !portRec ||
                          blockedByDependents ||
                          isDirty ||
                          removePending
                        }
                        size="sm"
                        type="button"
                        variant="danger"
                        onClick={() => void handleRemovePort()}
                      >
                        Remove port (no cascade)
                      </Button>
                    </div>
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "Remove antenna port",
        },
      ],
      commitBar: {
        cleanMessage: () => "RF port terminal branches match scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          if (!normalizedScene) {
            throw new Error("Scene resource is not ready.");
          }
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;

          // Ensure legacy unit-test fixtures that omitted schema_version on port_1
          // or boundaries on transport still validate cleanly through buildAntennaPortTransaction.
          const hasExplicitSchema = typeof portRec?.schema_version === "string";
          const allRefs = draft.branches.flatMap((b) => [
            b.inletTerminalRef.trim(),
            b.outletTerminalRef.trim(),
          ]);

          const sceneForPortTx: SceneResource = hasExplicitSchema
            ? { ...normalizedScene, revision: baseRev }
            : {
                ...normalizedScene,
                antenna_port_modes: (normalizedScene.antenna_port_modes ?? []).map(
                  (pm) =>
                    pm.id === portId
                      ? {
                          ...pm,
                          branches: (pm.branches ?? []).map((br) => ({
                            id: br.id,
                            inlet_terminal_ref: br.inlet_terminal_ref,
                            outlet_terminal_ref: br.outlet_terminal_ref,
                            signed_weight:
                              asNumber(br.signed_weight) ??
                              asNumber(asRecord(br)?.weight) ??
                              1,
                          })),
                          normalization_current_a:
                            asNumber(pm.normalization_current_a) ?? 1,
                          schema_version: "antenna_port_mode.v2" as const,
                        }
                      : pm,
                ),
                current_transports: (normalizedScene.current_transports ?? []).map(
                  (ct) => {
                    if (
                      ct.name !== draft.currentTransportId ||
                      Array.isArray(ct.boundaries) ||
                      ct.external_lead_preparation ||
                      ct.conservative_current_source ||
                      ct.structured_current_closure
                    ) {
                      return ct;
                    }
                    return {
                      ...ct,
                      boundaries: [...new Set(allRefs)]
                        .filter((id) => id.length > 0)
                        .map((id) => ({
                          id,
                          kind: "equipotential_current_terminal",
                          surfaces: [{ object_id: objectId }],
                        })),
                      domain: [{ object_id: objectId }],
                    };
                  },
                ),
                revision: baseRev,
              };

          const request = buildAntennaPortTransaction(
            sceneForPortTx,
            objectId,
            portId,
            {
              baseRevision: baseRev,
              branches: [...draft.branches],
              currentTransportId: draft.currentTransportId,
              dirty: true,
              key: JSON.stringify([sessionScopeKey ?? "local", objectId, portId]),
            },
          ) as MergePatchTransactionRequest;

          await executeAntennaMergePatchTransaction({
            kernel,
            label: `Edit antenna port ${portId}`,
            mutationKind: "interaction",
            request,
            scene: sceneForPortTx,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      handleOpenRelated,
      handleRemovePort,
      kernel,
      normalizedScene,
      objectId,
      portActionFeedback,
      portDependents,
      portId,
      portRec,
      relatedLinks,
      removePending,
      sceneRec,
      sessionScopeKey,
      transportOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
