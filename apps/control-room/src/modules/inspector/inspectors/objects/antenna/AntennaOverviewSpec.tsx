"use client";

import {
  Activity,
  Compass,
  Cpu,
  Layers,
  PlugZap,
  Radio,
  Ruler,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useKernel } from "@/kernel/KernelContext";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  antennaNavigationLinks,
  type AntennaNavigationLink,
} from "@/modules/explorer/public";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../../template";
import { SpecInspectorHost } from "../../../panels/mesh-details/SpecInspectorHost";
import {
  asRecord,
  asString,
  buildAntennaOriginSelection,
  normalizeSceneForAntennaNavigation,
  openAntennaNavigationLink,
  sanitizeDisplayMessage,
} from "../../../panels/antenna/AntennaCoreHelpers";

interface AntennaOverviewDraft {
  readonly viewMode: "composition";
}

export function NavigationLinksList({
  links,
  emptyHint,
  onOpenLink,
}: {
  links: readonly AntennaNavigationLink[];
  emptyHint: string;
  onOpenLink: (link: AntennaNavigationLink) => void;
}): ReactNode {
  if (links.length === 0) {
    return <p className="fm-inspector-hint">{emptyHint}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="antenna-navigation-links">
      {links.map((link) => {
        const selLabel = link.selection?.label ? sanitizeDisplayMessage(link.selection.label) : null;
        const baseLabel = sanitizeDisplayMessage(link.label);
        const fullLabel =
          selLabel && selLabel !== baseLabel ? `${baseLabel} · ${selLabel}` : baseLabel;
        const resourceId =
          link.selection?.ref?.type === "scene-object"
            ? asString(link.selection.ref.antennaResourceId)
            : null;
        return (
          <div
            key={link.key}
            className="flex flex-col gap-1.5 rounded-md border border-fm-subtle p-2.5"
            data-nav-key={link.key}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-fm-primary">
                  {fullLabel}
                </span>
                {resourceId && link.key !== "conductor" && link.key !== "terminals" ? (
                  <span className="font-mono text-xs text-fm-muted">({resourceId})</span>
                ) : null}
                <Badge variant={link.selection ? "success" : "warning"}>
                  {link.selection ? "configured" : "unresolved"}
                </Badge>
              </div>
              <Button
                disabled={!link.selection}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => onOpenLink(link)}
              >
                Open {fullLabel}
              </Button>
            </div>
            {link.reason ? (
              <span className="text-xs text-fm-secondary">
                {sanitizeDisplayMessage(link.reason)}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AntennaOverviewInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "antenna";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const [navError, setNavError] = useState<string | null>(null);

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const antennaObj = useMemo(() => {
    const objs = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
    return objs.map(asRecord).find((o) => asString(o?.id) === objectId) ?? null;
  }, [objectId, sceneRec]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const originSelection = useMemo(
    () => buildAntennaOriginSelection(selection, objectId, "object.antenna"),
    [objectId, selection],
  );

  const navLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      originSelection,
    );
  }, [objectId, originSelection, scene.data]);

  const handleOpenLink = useCallback(
    (link: AntennaNavigationLink) => {
      openAntennaNavigationLink({
        kernel,
        link,
        objectId,
        onError: setNavError,
        originSelection,
        sessionScopeKey,
      });
    },
    [kernel, objectId, originSelection, sessionScopeKey],
  );

  const conductorLinks = useMemo(
    () => navLinks.filter((l) => l.key === "conductor"),
    [navLinks],
  );
  const portLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("port:")),
    [navLinks],
  );
  const solutionLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("solution:")),
    [navLinks],
  );
  const projectionLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("projection:")),
    [navLinks],
  );
  const driveLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("drive:")),
    [navLinks],
  );
  const spectrumLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("spectrum:")),
    [navLinks],
  );
  const geometryAndTerminalLinks = useMemo(
    () => navLinks.filter((l) => l.key === "geometry" || l.key === "terminals"),
    [navLinks],
  );
  const regionalLinks = useMemo(
    () => navLinks.filter((l) => l.key === "regional"),
    [navLinks],
  );

  const baseline = useMemo<AntennaOverviewDraft>(
    () => ({ viewMode: "composition" }),
    [],
  );

  const spec = useMemo<InspectorSpec<AntennaOverviewDraft>>(
    () => ({
      id: "object.antenna",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: {
              kind: "objects.root",
              label: "Objects",
              nodeId: "model:objects",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "obj",
            label: antennaName,
            selection: {
              kind: "object.root",
              label: antennaName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "antenna", label: "Antenna" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "physics",
        entityId: `antenna:${objectId}`,
        icon: Radio,
        kindLabel: "Spin-wave RF excitation composition",
        statePill: () =>
          solutionLinks.length > 0
            ? { label: "Configured", tone: "ok" }
            : portLinks.length > 0
              ? { label: "Ports authored", tone: "info" }
              : { label: "Setup required", tone: "warn" },
        title: () => `${antennaName} Antenna`,
      },
      facts: () => [
        { id: "ports", label: "RF ports", value: String(portLinks.length) },
        { id: "solves", label: "Field solves", value: String(solutionLinks.length) },
        {
          id: "projections",
          label: "Projections",
          value: String(projectionLinks.length),
        },
        {
          id: "drives",
          label: "Drives / FFT",
          value: `${driveLinks.length} / ${spectrumLinks.length}`,
        },
      ],
      notices: () => {
        const list: InspectorNotice<AntennaOverviewDraft>[] = [];
        if (navError) {
          list.push({
            id: "nav-stale-err",
            text: navError,
            title: "Navigation target changed",
            tone: "warn",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Zap,
          id: "conductor",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No conductor node is configured on this object."
                  links={conductorLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Conductor & charge transport",
        },
        {
          defaultOpen: true,
          icon: PlugZap,
          id: "ports",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No RF ports configured — open Conductor to add a port."
                  links={portLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${portLinks.length} ports`,
          title: "RF ports",
        },
        {
          defaultOpen: true,
          icon: Cpu,
          id: "solutions",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No quasi-static field solve stages configured for this antenna."
                  links={solutionLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${solutionLinks.length} solves`,
          title: "Field solves",
        },
        {
          defaultOpen: projectionLinks.length > 0,
          icon: Layers,
          id: "projections",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No target projections configured yet — create one from a Field solve."
                  links={projectionLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${projectionLinks.length} projections`,
          title: "Target projections",
        },
        {
          defaultOpen: driveLinks.length > 0,
          icon: Activity,
          id: "drives",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No solved current drives configured yet."
                  links={driveLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${driveLinks.length} drives`,
          title: "Solved current drives",
        },
        {
          defaultOpen: spectrumLinks.length > 0,
          icon: SlidersHorizontal,
          id: "spectra",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No source k-space spectrum requests configured yet."
                  links={spectrumLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${spectrumLinks.length} spectra`,
          title: "Source k-space spectra",
        },
        {
          defaultOpen: true,
          icon: Ruler,
          id: "geometry-terminals",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="Geometry and terminal nodes are not available for this object."
                  links={geometryAndTerminalLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Geometry & terminal preparation",
        },
        {
          defaultOpen: false,
          icon: Compass,
          id: "regional",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No regional field drive node available."
                  links={regionalLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Prescribed regional field drive",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Composition navigation — edit each resource in its own Inspector",
      },
    }),
    [
      antennaName,
      conductorLinks,
      driveLinks,
      geometryAndTerminalLinks,
      handleOpenLink,
      navError,
      objectId,
      portLinks,
      projectionLinks,
      regionalLinks,
      solutionLinks,
      spectrumLinks,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
