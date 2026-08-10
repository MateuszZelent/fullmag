import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export interface FdmMultilayerInspectorModel {
  title: string;
  status: "ready" | "loading" | "stale" | "unavailable";
  notice: string | null;
  rows: readonly { label: string; value: string; mono?: boolean }[];
}

function tuple(values: readonly number[] | null | undefined): string {
  return values ? `[${values.join(", ")}]` : "not available";
}

export function isFdmMultilayerSelection(selection: Selection): boolean {
  const kind = selection.ref?.type === "fdm-domain" ? selection.ref.kind : null;
  return Boolean(kind && (kind === "mesh.grid.common" || kind.startsWith("mesh.grid.layer")));
}

export function resolveFdmMultilayerInspectorModel(
  layout: FdmMultilayerLayoutResource | null | undefined,
  selection: Selection,
): FdmMultilayerInspectorModel | null {
  const airboxSelection =
    selection.kind === "airbox.root" &&
    selection.ref?.type === "airbox" &&
    selection.ref.visualizationTargetId === "airbox";
  if (!isFdmMultilayerSelection(selection) && !airboxSelection) return null;
  // FEM and single-grid FDM retain their existing Airbox inspector.  Only a
  // published multilayer layout may claim the shared Explorer Airbox node.
  if (airboxSelection && !layout?.available) return null;
  if (!layout || !layout.available) {
    return {
      title: "FDM Multilayer Layout",
      status: "unavailable",
      notice: layout?.unavailable_reason ?? "Native multilayer layout is not available.",
      rows: [],
    };
  }
  if (airboxSelection) {
    const airbox = layout.airbox;
    if (!airbox.carrier_available) {
      return {
        title: "Multilayer Airbox",
        status: "unavailable",
        notice: airbox.unavailable_reason ?? "Target-only Airbox carrier is not available.",
        rows: [],
      };
    }
    return {
      title: "Multilayer Airbox",
      status: "ready",
      notice: "Target-only observation carrier; the common convolution grid remains FFT scratch only.",
      rows: [
        { label: "Target-only", value: airbox.target_only ? "yes" : "no" },
        { label: "H_demag", value: airbox.h_demag_available ? "available" : "unavailable" },
        {
          label: "H_eff",
          value: airbox.h_eff_available
            ? "available"
            : `unavailable (${airbox.h_eff_unavailable_reason ?? "not published"})`,
        },
        { label: "Cells", value: tuple(airbox.cells) },
        { label: "Cell size [m]", value: tuple(airbox.cell_size_m) },
        { label: "Origin [m]", value: tuple(airbox.origin_m) },
        { label: "Samples", value: String(airbox.sample_count ?? "not published") },
        { label: "Values", value: String(airbox.value_count ?? "not published") },
        { label: "Carrier fingerprint", value: airbox.carrier_fingerprint ?? "not published", mono: true },
        { label: "Source policy", value: airbox.source_policy ?? "not published", mono: true },
        {
          label: "Source grids",
          value: (airbox.source_grid_fingerprints ?? []).join(", ") || "not published",
          mono: true,
        },
        { label: "Layout revision", value: String(layout.layout_revision) },
        { label: "Observation revision", value: String(layout.observation_revision) },
      ],
    };
  }
  const ref = selection.ref?.type === "fdm-domain" ? selection.ref : null;
  const kind = ref?.kind;
  if (kind === "mesh.grid.common") {
    const common = layout.common_transform_layout;
    return {
      title: "Common Convolution Grid",
      status: common ? "ready" : "unavailable",
      notice: common ? "Diagnostic FFT scratch layout; not a physical mesh." : "Common transform layout was not published.",
      rows: common
        ? [
            { label: "Shape", value: tuple(common.shape) },
            { label: "Cell size [m]", value: tuple(common.cell_size) },
            { label: "Origin [m]", value: tuple(common.origin) },
            { label: "FFT shape", value: tuple(common.fft_shape) },
            { label: "Physical mesh", value: "no" },
            { label: "Provenance", value: common.provenance, mono: true },
          ]
        : [],
    };
  }
  const layer = ref?.layerId ? layout.layers.find((item) => item.layer_id === ref.layerId) : null;
  if (!layer) {
    return {
      title: "Native Layers",
      status: "ready",
      notice: layout.layers.length ? "Select a native layer to inspect its carrier." : "No native layers were published.",
      rows: [{ label: "Layers", value: String(layout.layers.length) }],
    };
  }
  const title =
    kind === "mesh.grid.layer.mask"
      ? "Active Mask"
      : kind === "mesh.grid.layer.transfer"
        ? "Transfer"
        : kind === "mesh.grid.layer.provenance"
          ? "Layer Provenance"
          : "Native Grid";
  const rows =
    kind === "mesh.grid.layer.mask"
      ? [
          { label: "Mask present", value: layer.active_mask_present ? "yes" : "no (dense)" },
          { label: "Active cells", value: String(layer.active_cell_count) },
          { label: "Inactive cells", value: String(layer.inactive_cell_count) },
          { label: "Mask provenance", value: layer.mask_provenance ?? "implicit dense carrier", mono: true },
        ]
      : kind === "mesh.grid.layer.transfer"
        ? [
            { label: "Transfer", value: layer.transfer_kind, mono: true },
            { label: "Convolution grid", value: tuple(layer.convolution_grid) },
            { label: "Convolution cell size [m]", value: tuple(layer.convolution_cell_size) },
          ]
        : kind === "mesh.grid.layer.provenance"
          ? [
              { label: "Layer ID", value: layer.layer_id, mono: true },
              { label: "Object ID", value: layer.object_id, mono: true },
              { label: "Layout fingerprint", value: layout.layout_fingerprint ?? "not published", mono: true },
              { label: "Native grid fingerprint", value: layer.native_grid_fingerprint ?? "not published", mono: true },
              { label: "Layout revision", value: String(layout.layout_revision) },
            ]
          : [
              { label: "Layer", value: layer.magnet_name },
              { label: "Layer ID", value: layer.layer_id, mono: true },
              { label: "Object ID", value: layer.object_id, mono: true },
              { label: "Shape", value: tuple(layer.native_grid) },
              { label: "Cell size [m]", value: tuple(layer.native_cell_size) },
              { label: "Origin [m]", value: tuple(layer.native_origin) },
              { label: "Transfer", value: layer.transfer_kind, mono: true },
            ];
  return {
    title: `${layer.magnet_name} · ${title}`,
    status: "ready",
    notice: null,
    rows,
  };
}
