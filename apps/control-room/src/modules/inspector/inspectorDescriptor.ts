import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveInspectorRoute } from "./inspectorRouteCatalog";

export type InspectorStatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface InspectorBreadcrumb {
  id: string;
  label: string;
  selection?: Partial<Omit<Selection, "moduleSource">>;
}

export interface InspectorMetadataItem {
  label: string;
  value: string;
}

export interface InspectorTabDescriptor {
  id: string;
  label: string;
}

export type InspectorDescriptorIcon =
  | "airbox"
  | "analysis"
  | "diagnostics"
  | "mesh"
  | "mode"
  | "object"
  | "study"
  | "visualization";

export interface InspectorDescriptor {
  breadcrumbs: InspectorBreadcrumb[];
  icon: InspectorDescriptorIcon;
  metadata: InspectorMetadataItem[];
  ownerId: string;
  status: {
    label: string;
    tone: InspectorStatusTone;
  } | null;
  tabs: InspectorTabDescriptor[];
  title: string;
  typeLabel: string;
}

const MESH_TABS: InspectorTabDescriptor[] = [
  { id: "policy", label: "Policy" },
  { id: "quality", label: "Quality" },
  { id: "history", label: "History" },
];

const RESULT_TABS: InspectorTabDescriptor[] = [
  { id: "overview", label: "Overview" },
  { id: "data", label: "Data" },
  { id: "provenance", label: "Provenance" },
  { id: "diagnostics", label: "Diagnostics" },
];

interface FamilyDescriptor {
  tabs: InspectorTabDescriptor[];
  typeLabel: string;
}

const EXACT_FAMILIES: Record<string, FamilyDescriptor> = {
  "object.geometry": { tabs: [], typeLabel: "Geometry" },
  "object.material": { tabs: [], typeLabel: "Material" },
  "object.mesh": { tabs: MESH_TABS, typeLabel: "Mesh policy" },
  "object.physics": { tabs: [], typeLabel: "Physics" },
  "object.regions": { tabs: [], typeLabel: "Regions" },
};

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function resolveFamily(kind: string): FamilyDescriptor {
  if (kind === "airbox.visualization") {
    return { tabs: [], typeLabel: "Airbox display" };
  }
  if (kind === "object.visualization") {
    return { tabs: [], typeLabel: "Object display" };
  }
  if (kind === "mesh-part-airbox") {
    return { tabs: [], typeLabel: "Airbox mesh-part display" };
  }
  if (kind === "mesh-part") {
    return { tabs: [], typeLabel: "Mesh-part display" };
  }
  if (kind === "object.mode_visualization") {
    return { tabs: [], typeLabel: "Mode visualization overview" };
  }
  if (kind === "airbox.visualization.debug") {
    return { tabs: [], typeLabel: "Airbox visualization debug" };
  }
  if (kind === "object.visualization.debug") {
    return { tabs: [], typeLabel: "Object visualization debug" };
  }
  if (kind === "object.region.visualization.debug") {
    return { tabs: [], typeLabel: "Region visualization debug" };
  }
  if (kind === "airbox.multilayer.target") {
    return { tabs: [], typeLabel: "Multilayer Airbox target" };
  }
  if (kind === "fdm.cell" || kind === "mesh.grid" || kind.startsWith("mesh.grid.")) {
    return { tabs: [], typeLabel: "FDM mesh" };
  }
  if (kind.endsWith(".visualization") || kind.includes(".visualization.")) {
    return { tabs: [], typeLabel: "Display" };
  }
  if (kind.startsWith("diagnostics.")) {
    return {
      tabs: [
        { id: "overview", label: "Overview" },
        { id: "evidence", label: "Evidence" },
        { id: "diagnostics", label: "Diagnostics" },
      ],
      typeLabel: "Diagnostics",
    };
  }
  if (kind.startsWith("results.") || kind.startsWith("resources.")) {
    return { tabs: RESULT_TABS, typeLabel: "Result" };
  }
  if (kind.startsWith("study.")) {
    return { tabs: [], typeLabel: "Study" };
  }
  if (kind.startsWith("object.region")) {
    return { tabs: [], typeLabel: "Region" };
  }
  return (
    EXACT_FAMILIES[kind] ?? {
      tabs: [],
      typeLabel: titleCase(kind.split(".").at(-1) ?? "Selection"),
    }
  );
}

function inspectorIconForKind(kind: string): InspectorDescriptorIcon {
  if (
    kind === "airbox.root" ||
    kind.startsWith("airbox.") ||
    kind === "mesh-part-airbox"
  ) {
    return "airbox";
  }
  if (kind === "fdm.cell" || kind.startsWith("mesh.") || kind.startsWith("mesh-part")) {
    return "mesh";
  }
  if (kind.startsWith("object.mode_visualization")) return "mode";
  if (kind.includes("visualization")) return "visualization";
  if (kind.startsWith("diagnostics.")) return "diagnostics";
  if (kind.startsWith("results.") || kind.startsWith("resources.")) return "analysis";
  if (kind.startsWith("study.") || kind.startsWith("jobs.")) return "study";
  return "object";
}

function inspectorIdentity(kind: string): {
  icon: InspectorDescriptorIcon;
  ownerId: string;
} {
  return {
    icon: inspectorIconForKind(kind),
    ownerId: resolveInspectorRoute(kind)?.id ?? kind,
  };
}

function resolveBreadcrumbs(
  selection: Selection,
  typeLabel: string,
): InspectorBreadcrumb[] {
  const crumbs: InspectorBreadcrumb[] = [];
  const objectLabel = selection.objectId
    ? titleCase(decodeURIComponent(selection.objectId))
    : null;
  const title = selection.label ?? objectLabel;

  if (selection.ref?.type === "airbox" && selection.kind !== "airbox.root") {
    crumbs.push({
      id: "model:airbox:breadcrumb",
      label: "Airbox",
      selection: {
        kind: "airbox.root",
        label: "Airbox",
        nodeId: "model:airbox",
        objectId: null,
        ref: null,
      },
    });
  } else if (objectLabel) {
    crumbs.push({
      id: `${selection.objectId}:object`,
      label: objectLabel,
      selection: {
        kind: "object.root",
        label: objectLabel,
        nodeId: `model:object:${selection.objectId}`,
        objectId: selection.objectId,
        ref: null,
      },
    });
  } else if (title) {
    crumbs.push({ id: `${selection.nodeId ?? "selection"}:root`, label: title });
  }
  if (typeLabel && typeLabel !== title) {
    crumbs.push({
      id: `${selection.nodeId ?? "selection"}:current`,
      label: typeLabel,
      selection,
    });
  }
  return crumbs.slice(0, 4);
}

export function resolveInspectorDescriptor(
  selection: Selection,
): InspectorDescriptor {
  if (!selection.kind) {
    return {
      breadcrumbs: [],
      icon: "object",
      metadata: [],
      ownerId: "empty-selection",
      status: null,
      tabs: [],
      title: "Nothing selected",
      typeLabel: "Selection",
    };
  }

  const family = resolveFamily(selection.kind);
  const identity = inspectorIdentity(selection.kind);
  const title = selection.label ?? selection.objectId ?? family.typeLabel;
  const metadata: InspectorMetadataItem[] = [
    { label: "Kind", value: selection.kind },
  ];
  const fdmCellRef =
    selection.ref?.type === "fdm-cell" ? selection.ref : null;
  if (fdmCellRef) {
    return {
      breadcrumbs: resolveBreadcrumbs(selection, family.typeLabel),
      icon: identity.icon,
      metadata: [
        { label: "Selected IJK snapshot", value: `[${fdmCellRef.ijk.join(", ")}]` },
        { label: "Selected mask snapshot", value: fdmCellRef.maskState },
        { label: "Selected grid fingerprint", value: fdmCellRef.gridFingerprint },
        {
          label: "Selected membership revision",
          value: fdmCellRef.membershipRevision,
        },
      ],
      ownerId: identity.ownerId,
      status: null,
      tabs: family.tabs.slice(0, 4),
      title,
      typeLabel: family.typeLabel,
    };
  }
  const meshCellRef = selection.ref && "elementFamily" in selection.ref
    ? selection.ref
    : null;
  if (meshCellRef?.elementFamily) {
    metadata.push({
      label: "Element family",
      value: meshCellRef.elementFamily,
    });
  }
  if (meshCellRef?.globalCellOrdinal) {
    metadata.push({
      label: "Global cell ordinal",
      value: meshCellRef.globalCellOrdinal,
    });
  }
  if (selection.objectId) {
    metadata.push({ label: "Object", value: selection.objectId });
  }
  if (selection.nodeId) {
    metadata.push({ label: "Node", value: selection.nodeId });
  }

  return {
    breadcrumbs: resolveBreadcrumbs(selection, family.typeLabel),
    icon: identity.icon,
    metadata: metadata.slice(0, 4),
    ownerId: identity.ownerId,
    status: null,
    tabs: family.tabs.slice(0, 4),
    title,
    typeLabel: family.typeLabel,
  };
}
