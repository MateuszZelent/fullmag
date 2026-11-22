"use client";

import {
  Activity,
  Layers,
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
import { antennaNavigationLinks } from "@/modules/explorer/public";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  asNumber,
  asRecord,
  asString,
  buildAntennaOriginSelection,
  executeAntennaMergePatchTransaction,
  normalizeSceneForAntennaNavigation,
  openAntennaNavigationLink,
  sanitizeDisplayMessage,
  TerminalLeadPreparationEditor,
  TerminalSourceReadoutView,
} from "../../../panels/antenna/AntennaCoreHelpers";
import {
  antennaTerminalGeometryBinding,
  antennaTerminalPreparationErrors,
  buildAntennaTerminalPreparationTransaction,
  createAntennaTerminalPreparationDraft,
  type AntennaTerminalLeadRow,
  type AntennaTerminalPreparationDraft,
} from "../../../panels/antenna/AntennaTerminalPreparationModel";
import { antennaTerminalSourceState } from "../../../panels/antenna/AntennaTerminalSourceModel";

interface AntennaTerminalsSpecDraft {
  portId: string;
  driveId: string;
  revision: string;
  geometryBinding: string;
  rows: readonly AntennaTerminalLeadRow[];
}

function hydrateTerminalPreparationBaseline(
  sceneData: SceneResource | null | undefined,
  objectId: string,
  sourceMode: string,
  ports: readonly { current_transport_id: string; id: string }[],
  prepKey: string,
): AntennaTerminalsSpecDraft {
  const geomBinding = sceneData
    ? antennaTerminalGeometryBinding(sceneData, objectId)
    : "";
  if (sourceMode === "preparation" && sceneData) {
    for (const port of ports) {
      const transport = (sceneData.current_transports ?? []).find(
        (t) => t.name === port.current_transport_id,
      );
      if (transport?.external_lead_preparation) {
        try {
          const loaded = createAntennaTerminalPreparationDraft(
            sceneData,
            objectId,
            port.id,
            prepKey,
          );
          return {
            driveId: loaded.driveId,
            geometryBinding: loaded.geometryBinding,
            portId: loaded.portId,
            revision: loaded.revision,
            rows: loaded.rows,
          };
        } catch {
          // Fall through to unhydrated default when existing preparation is custom
        }
      }
    }
  }
  return {
    driveId: "",
    geometryBinding: geomBinding,
    portId: "",
    revision: "",
    rows: [],
  };
}

export function AntennaTerminalsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const [navError, setNavError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const prepKey = useMemo(
    () => JSON.stringify([sessionScopeKey ?? "local", objectId]),
    [objectId, sessionScopeKey],
  );

  const sourceModel = useMemo(
    () => antennaTerminalSourceState(scene.data ?? null, objectId),
    [objectId, scene.data],
  );

  const ports = useMemo(
    () =>
      (scene.data?.antenna_port_modes ?? []).filter(
        (port) => port.source_object_id === objectId,
      ),
    [objectId, scene.data],
  );

  const terminalsOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.terminals",
        "terminals",
        objectId,
      ),
    [objectId, selection],
  );

  const terminalNavLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      terminalsOriginSelection,
    );
  }, [objectId, scene.data, terminalsOriginSelection]);

  const handleOpenGeometry = useCallback(() => {
    const geomLink = terminalNavLinks.find((l) => l.key === "geometry");
    if (geomLink) {
      openAntennaNavigationLink({
        kernel,
        link: geomLink,
        objectId,
        onError: setNavError,
        originSelection: terminalsOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.antenna.geometry",
        label: "Geometry",
        nodeId: `model:object:${objectId}:geometry`,
        objectId,
        ref: {
          kind: "object.antenna.geometry",
          nodeId: `model:object:${objectId}:geometry`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [kernel, objectId, sessionScopeKey, terminalNavLinks, terminalsOriginSelection]);

  const handleOpenPort = useCallback(
    (portId: string) => {
      const portLink = terminalNavLinks.find((l) => l.key === `port:${portId}`);
      if (portLink) {
        openAntennaNavigationLink({
          kernel,
          link: portLink,
          objectId,
          onError: setNavError,
          originSelection: terminalsOriginSelection,
          sessionScopeKey,
        });
        return;
      }
      const nodeId = `model:object:${objectId}:antenna:port:${encodeURIComponent(portId)}`;
      kernel.selection.set(
        {
          kind: "object.antenna.port",
          label: `Port ${portId}`,
          nodeId,
          objectId,
          ref: {
            antennaResourceId: portId,
            antennaResourceKind: "port",
            kind: "object.antenna.port",
            nodeId,
            objectId,
            type: "scene-object",
            visualizationTargetId: `object:${objectId}`,
          },
        },
        "inspector",
      );
    },
    [kernel, objectId, sessionScopeKey, terminalNavLinks, terminalsOriginSelection],
  );

  const baseline = useMemo<AntennaTerminalsSpecDraft>(
    () =>
      hydrateTerminalPreparationBaseline(
        scene.data,
        objectId,
        sourceModel.mode,
        ports,
        prepKey,
      ),
    [objectId, ports, prepKey, scene.data, sourceModel.mode],
  );

  const toModelPrepDraft = useCallback(
    (draft: AntennaTerminalsSpecDraft): AntennaTerminalPreparationDraft => {
      const baseRev =
        scene.data?.revision ?? asNumber(asRecord(scene.data)?.scene_revision) ?? 0;
      return {
        baseRevision: baseRev,
        dirty: true,
        driveId: draft.driveId,
        geometryBinding:
          draft.geometryBinding ||
          (scene.data ? antennaTerminalGeometryBinding(scene.data, objectId) : ""),
        key: prepKey,
        portId: draft.portId,
        revision: draft.revision,
        rows: [...draft.rows],
      };
    },
    [objectId, prepKey, scene.data],
  );

  const isPrepEditable = sourceModel.mode === "preparation";

  const spec = useMemo<InspectorSpec<AntennaTerminalsSpecDraft>>(
    () => ({
      id: "object.antenna.terminals",
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
          { id: "terminals", label: "Terminals" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "physics",
        entityId: `terminals:${objectId}`,
        icon: Activity,
        kindLabel: "Current closure, source cuts & electrode extensions",
        statePill: () =>
          sourceModel.sources.some((s) => s.kind === "authored")
            ? { label: "Closed circuit", tone: "ok" }
            : sourceModel.sources.some((s) => s.kind === "prepared")
              ? { label: "Prepared mesh", tone: "info" }
              : sourceModel.mode === "preparation"
                ? { label: "Inspection leads", tone: "info" }
                : { label: "Review required", tone: "warn" },
        title: () => "Current Terminals & Electrodes",
      },
      facts: () => [
        {
          id: "mode",
          label: "Source mode",
          value: sourceModel.sources.some((s) => s.kind === "authored")
            ? "Closed-loop cut"
            : sourceModel.sources.some((s) => s.kind === "prepared")
              ? "Prepared source"
              : sourceModel.mode === "preparation"
                ? "Electrode leads"
                : "Unconfigured",
        },
        {
          id: "transports",
          label: "Transports",
          value: String(sourceModel.sources.length),
        },
        { id: "ports", label: "RF ports", value: String(ports.length) },
      ],
      notices: (d) => {
        const list: InspectorNotice<AntennaTerminalsSpecDraft>[] = [];
        if (navError) {
          list.push({
            id: "term-nav-err",
            text: navError,
            title: "Navigation target changed",
            tone: "warn",
          });
        }
        if (loadError) {
          list.push({
            id: "term-load-err",
            text: sanitizeDisplayMessage(loadError),
            title: "Cannot load port end caps",
            tone: "err",
          });
        }
        if (isPrepEditable && d.portId && scene.data) {
          const errs = antennaTerminalPreparationErrors(
            scene.data,
            objectId,
            toModelPrepDraft(d),
          );
          for (let i = 0; i < errs.length; i++) {
            list.push({
              id: `prep-err-${i}`,
              text: sanitizeDisplayMessage(errs[i]!),
              title: "Lead preparation validation",
              tone: "warn",
            });
          }
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Activity,
          id: "terminal-source-observations",
          rows: [
            {
              render: () => (
                <TerminalSourceReadoutView
                  canNavigate={scene.status === "ready"}
                  model={sourceModel}
                  onOpenGeometry={handleOpenGeometry}
                  onOpenPort={handleOpenPort}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Circuit source and port observations",
        },
        ...(isPrepEditable
          ? [
              {
                defaultOpen: true,
                icon: Layers,
                id: "lead-preparation",
                rows: [
                  {
                    key: "rows" as const,
                    label: "Terminal lead extensions",
                    render: (ctx: {
                      draft: AntennaTerminalsSpecDraft;
                      setField: <K extends keyof AntennaTerminalsSpecDraft>(
                        key: K,
                        val: AntennaTerminalsSpecDraft[K],
                      ) => void;
                    }) => (
                      <TerminalLeadPreparationEditor
                        disabled={scene.status !== "ready"}
                        driveId={ctx.draft.driveId}
                        objectId={objectId}
                        portId={ctx.draft.portId}
                        ports={ports}
                        revision={ctx.draft.revision}
                        rows={ctx.draft.rows}
                        scene={scene.data ?? null}
                        onChangeMeta={(patch) => {
                          if (patch.driveId !== undefined) {
                            ctx.setField("driveId", patch.driveId);
                          }
                          if (patch.revision !== undefined) {
                            ctx.setField("revision", patch.revision);
                          }
                        }}
                        onChangeRow={(index, patch) => {
                          ctx.setField(
                            "rows",
                            ctx.draft.rows.map((r, idx) =>
                              idx === index ? { ...r, ...patch } : r,
                            ),
                          );
                        }}
                        onSelectPort={(nextPortId) => {
                          if (!scene.data) return;
                          try {
                            const loaded = createAntennaTerminalPreparationDraft(
                              scene.data,
                              objectId,
                              nextPortId,
                              prepKey,
                            );
                            setLoadError(null);
                            ctx.setField("portId", loaded.portId);
                            ctx.setField("driveId", loaded.driveId);
                            ctx.setField("revision", loaded.revision);
                            ctx.setField("geometryBinding", loaded.geometryBinding);
                            ctx.setField("rows", loaded.rows);
                          } catch (err) {
                            setLoadError(
                              err instanceof Error ? err.message : String(err),
                            );
                          }
                        }}
                      />
                    ),
                    type: "custom" as const,
                    validate: (_val: unknown, d: AntennaTerminalsSpecDraft) => {
                      if (!d.portId) {
                        return "Select a port to load and configure external electrode lead preparation.";
                      }
                      if (!scene.data) return "Waiting for scene resource.";
                      const errs = antennaTerminalPreparationErrors(
                        scene.data,
                        objectId,
                        toModelPrepDraft(d),
                      );
                      return errs.length > 0
                        ? sanitizeDisplayMessage(errs[0]!)
                        : null;
                    },
                    wide: true,
                  },
                ],
                title: "External electrode lead preparation",
              },
            ]
          : []),
      ],
      commitBar: isPrepEditable
        ? {
            applyLabel: "Apply inspection preparation",
            cleanMessage: () =>
              "Select a port and author explicit straight-stub electrode leads",
            mode: "staged",
            onApply: async (draft) => {
              if (!scene.data) {
                throw new Error("Scene resource is not ready.");
              }
              const baseRev =
                scene.data.revision ??
                asNumber(asRecord(scene.data)?.scene_revision) ??
                0;
              const sceneWithRev: SceneResource = {
                ...scene.data,
                revision: baseRev,
              };
              const prepDraft: AntennaTerminalPreparationDraft = {
                ...toModelPrepDraft(draft),
                baseRevision: baseRev,
              };
              const request = await buildAntennaTerminalPreparationTransaction(
                sceneWithRev,
                objectId,
                prepDraft,
              );
              await executeAntennaMergePatchTransaction({
                kernel,
                label: `Edit antenna terminal preparation ${objectId}`,
                mutationKind: "interaction",
                request,
                scene: sceneWithRev,
                sessionScopeKey,
                validateAck: true,
              });
              return true;
            },
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Closed-geometry or prepared source — inspect cuts and port observations above",
          },
    }),
    [
      handleOpenGeometry,
      handleOpenPort,
      isPrepEditable,
      kernel,
      loadError,
      navError,
      objectId,
      ports,
      prepKey,
      scene.data,
      scene.status,
      sessionScopeKey,
      sourceModel,
      toModelPrepDraft,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
