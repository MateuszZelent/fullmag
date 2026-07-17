import type { Selection } from "@/kernel/selection/selectionTypes";

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

export interface InspectorDescriptor {
  breadcrumbs: InspectorBreadcrumb[];
  metadata: InspectorMetadataItem[];
  status: {
    label: string;
    tone: InspectorStatusTone;
  } | null;
  tabs: InspectorTabDescriptor[];
  title: string;
  typeLabel: string;
}

const MESH_TABS: InspectorTabDescriptor[] = [
  { id: "overview", label: "Overview" },
  { id: "properties", label: "Properties" },
  { id: "diagnostics", label: "Diagnostics" },
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
        kind: "object",
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
      metadata: [],
      status: null,
      tabs: [],
      title: "Nothing selected",
      typeLabel: "Selection",
    };
  }

  const family = resolveFamily(selection.kind);
  const title = selection.label ?? selection.objectId ?? family.typeLabel;
  const metadata: InspectorMetadataItem[] = [
    { label: "Kind", value: selection.kind },
  ];
  if (selection.objectId) {
    metadata.push({ label: "Object", value: selection.objectId });
  }
  if (selection.nodeId) {
    metadata.push({ label: "Node", value: selection.nodeId });
  }

  return {
    breadcrumbs: resolveBreadcrumbs(selection, family.typeLabel),
    metadata: metadata.slice(0, 4),
    status: null,
    tabs: family.tabs.slice(0, 4),
    title,
    typeLabel: family.typeLabel,
  };
}
