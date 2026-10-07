import { describe, expect, it } from "vitest";

import { selectionRefFromNode } from "../explorerSelection";

import { buildObjectExplorerNode } from "./objectExplorerNodes";

describe("antenna composition explorer nodes", () => {
  it("marks a solve-stage draft without its mesh-exact current view invalid", () => {
    const node = buildObjectExplorerNode(
      { id: "antenna", label: "Microstrip", objectRole: "antenna" } as never,
      { scene: {
        current_transports: [{ name: "transport-1", kind: "current_transport", model: "ohmic_poisson" }],
        antenna_port_modes: [{ id: "port-1", source_object_id: "antenna", current_transport_id: "transport-1", branches: [] }],
        antenna_field_solve_stages: [{
          id: "solve-1", source_object_id: "antenna", current_transport_id: "transport-1",
          conservative_current_view_ref: "transport-1:rt0", port_mode_ids: ["port-1"],
          outputs: [{ id: "basis-1", quantity: "H_ant_basis" }],
        }],
      } } as never,
    );
    const solve = node.children?.find((child) => child.kind === "object.antenna")
      ?.children?.find((child) => child.kind === "object.antenna.solution");
    expect(solve).toMatchObject({ badge: "1 outputs · invalid", status: "warning" });
  });

  it("marks an incomplete port as warning instead of ready", () => {
    const node = buildObjectExplorerNode(
      { id: "antenna", label: "Microstrip", objectRole: "antenna" } as never,
      {
        scene: {
          antenna_port_modes: [{
            id: "invalid-port",
            schema_version: "antenna_port_mode.v2",
            source_object_id: "antenna",
            current_transport_id: "transport-1",
            normalization_current_a: 1,
            branches: [{
              id: "signal",
              inlet_terminal_ref: "signal_in",
              outlet_terminal_ref: "signal_out",
              signed_weight: 1,
            }],
          }],
        },
      } as never,
    );

    const port = node.children
      ?.find((child) => child.kind === "object.antenna")
      ?.children?.find((child) => child.kind === "object.antenna.port");
    expect(port).toMatchObject({ status: "warning", badge: "1 branches · invalid" });
  });

  it("publishes dedicated typed children with stable resource identities", () => {
    const node = buildObjectExplorerNode(
      { id: "antenna", label: "CPW", objectRole: "antenna" } as never,
      {
        scene: {
          antenna_port_modes: [{
            id: "mode-1",
            schema_version: "antenna_port_mode.v2",
            source_object_id: "antenna",
            current_transport_id: "transport-1",
            normalization_current_a: 1,
            branches: [{
              id: "branch-1",
              inlet_terminal_ref: "inlet",
              outlet_terminal_ref: "outlet",
              signed_weight: 1,
            }, {
              id: "branch-2",
              inlet_terminal_ref: "return-inlet",
              outlet_terminal_ref: "return-outlet",
              signed_weight: -1,
            }],
          }],
          antenna_field_solve_stages: [{
            id: "solve-1",
            source_object_id: "antenna",
            current_transport_id: "transport-1",
            port_mode_ids: ["mode-1"],
            conservative_current_view_ref: "current-1",
            model: "quasistatic_conduction_biot_savart3d",
            oersted_realization: "direct_tetra_quadrature",
            conductor_mesh_policy: "quadrature",
            field_sampling_domain: { kind: "global" },
            target_refs: [{ kind: "global" }],
            solver_policy: "direct",
            outputs: [{ id: "H_ant", quantity: "H" }],
          }],
          antenna_target_projections: [{
            id: "projection-1",
            output_id: "H_ant",
            solution: {
              stage_id: "solve-1",
              output_id: "H_ant",
              asset_id: "asset-1",
              content_digest: "sha256:asset-1",
            },
            target: { kind: "global" },
          }],
          solved_antenna_drives: [{
            id: "drive-1",
            name: "RF drive",
            projection_ref: "projection-1",
            port_mode_id: "mode-1",
            peak_current_a: 1e-3,
            waveform: { kind: "constant" },
            time_origin: "stage_local",
            activation: { kind: "all_time_evolution" },
          }],
          antenna_spectrum_requests: [{
            id: "spectrum-1",
            solution_ref: {
              stage_id: "solve-1",
              output_id: "H_ant",
              asset_id: "asset-1",
              content_digest: "sha256:asset-1",
            },
            target: { kind: "global" },
            transform: "spatial_fft",
            sampling_plane: {
              origin_m: [0, 0, 0],
              axis_u: [1, 0, 0],
              axis_v: [0, 1, 0],
              extent_u_m: 1e-6,
              extent_v_m: 1e-6,
              sample_count_u: 16,
              sample_count_v: 16,
              interpolation: "bilinear",
              outside_policy: "error",
            },
            window: "hann",
            normalization: "integral_si",
            component: "z",
            output_id: "H_ant_fft",
          }],
        },
      } as never,
    );

    const antenna = node.children?.find((child) => child.kind === "object.antenna");
    expect(antenna?.children?.map((child) => child.kind)).toEqual([
      "object.antenna.regional",
      "object.antenna.conductor",
      "object.antenna.port",
      "object.antenna.solution",
      "object.antenna.projection",
      "object.antenna.drive",
      "object.antenna.spectrum",
    ]);

    const port = antenna?.children?.find((child) => child.kind === "object.antenna.port");
    expect(port).toMatchObject({ status: "ready", badge: "2 branches" });
    expect(selectionRefFromNode(port!)).toMatchObject({
      type: "scene-object",
      kind: "object.antenna.port",
      objectId: "antenna",
      antennaResourceId: "mode-1",
      antennaResourceKind: "port",
    });

    const solve = antenna?.children?.find((child) => child.kind === "object.antenna.solution");
    expect(solve).toMatchObject({ status: "warning", antennaResourceId: "solve-1" });
  });
});
