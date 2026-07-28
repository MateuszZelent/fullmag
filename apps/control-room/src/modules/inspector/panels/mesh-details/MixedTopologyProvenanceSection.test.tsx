import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MixedTopologyProvenanceSection,
  resolveMixedTopologyPresentation,
} from "./MixedTopologyProvenanceSection";

describe("MixedTopologyProvenanceSection", () => {
  it("presents requested and resolved topology, family counts, and accepted certificate", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: {
        element_counts_by_type: { prism6: 120, pyramid5: 32, tet4: 440 },
        facet_counts_by_type_and_role: {
          magnet_air_interface: { quad4: 48 },
          outer_boundary: { tri3: 200 },
        },
        fallbacks_triggered: [],
        mixed_layer_topology_certificate: {
          actual_node_plane_count: 2,
          status: "accepted",
          topology_fingerprint: "sha256:mixed",
        },
        mixed_topology_provenance: {
          requested_topology: "mixed_p1",
          resolved_topology: "mixed_p1",
        },
        requested_layered_policy: {
          exact_layer_count: true,
          layers: 1,
          transition_policy: "pyramid_to_tetrahedra",
        },
        resolved_layered_policy: {
          exact_layer_count: true,
          layers: 1,
          transition_policy: "pyramid_to_tetrahedra",
        },
        gmsh_version: "4.15.2",
      },
      manifest: { topology_schema_version: 2 },
    });

    expect(model).toMatchObject({
      certificateStatus: "accepted",
      fallback: "none (strict)",
      nodePlanes: 2,
      requestedExactLayers: true,
      requestedLayers: 1,
      requestedTopology: "mixed_p1",
      resolvedExactLayers: true,
      resolvedLayers: 1,
      resolvedTopology: "mixed_p1",
      transitionPolicy: "pyramid_to_tetrahedra",
    });

    const html = renderToStaticMarkup(<MixedTopologyProvenanceSection model={model} />);
    expect(html).toContain("prism6");
    expect(html).toContain("120");
    expect(html).toContain("pyramid5");
    expect(html).toContain("tet4");
    expect(html).toContain("magnet_air_interface:quad4");
    expect(html).toContain("4.15.2");
    expect(html).toContain("Certificate");
    expect(html).toContain("accepted");
    expect(html).toContain("layer-convergence evidence");
  });

  it("uses typed provenance published only by the shared-domain manifest", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: null,
      manifest: {
        element_counts_by_type: { prism6: 12, pyramid5: 4, tet4: 28 },
        facet_counts_by_type_and_role: { exterior: { tri3: 18 } },
        fallbacks_triggered: [],
        gmsh_version: "4.15.2",
        mixed_layer_topology_certificate: {
          actual_node_plane_count: 3,
          certificate_status: "accepted",
          topology_fingerprint: "sha256:manifest",
        },
        mixed_topology_provenance: {
          requested_topology: "mixed_p1",
          resolved_topology: "mixed_p1",
        },
        requested_layered_policy: {
          exact_layer_count: true,
          layers: 2,
          transition_policy: "pyramid_to_tetrahedra",
        },
        resolved_layered_policy: {
          exact_layer_count: true,
          layers: 2,
          transition_policy: "pyramid_to_tetrahedra",
        },
        topology_schema_version: 2,
      },
    });

    expect(model).toMatchObject({
      certificateFingerprint: "sha256:manifest",
      certificateStatus: "accepted",
      fallback: "none (strict)",
      gmshVersion: "4.15.2",
      nodePlanes: 3,
      requestedLayers: 2,
      resolvedLayers: 2,
      topologySchemaVersion: "2",
    });
    expect(model.elementCounts).toContainEqual({ count: 12, family: "prism6" });
    expect(model.facetCounts).toContainEqual({
      count: 18,
      familyAndRole: "exterior:tri3",
    });
  });

  it("distinguishes unpublished fallback evidence from an explicit strict empty list", () => {
    const unpublished = resolveMixedTopologyPresentation({
      buildReport: {
        mixed_topology_provenance: {
          requested_topology: "mixed_p1",
          resolved_topology: "mixed_p1",
        },
      },
      manifest: null,
    });
    const explicit = resolveMixedTopologyPresentation({
      buildReport: {
        fallbacks_triggered: [],
        mixed_topology_provenance: {
          requested_topology: "mixed_p1",
          resolved_topology: "mixed_p1",
        },
      },
      manifest: null,
    });

    expect(unpublished.fallback).toBe("not published");
    expect(explicit.fallback).toBe("none (strict)");
  });

  it("preserves a rejected certificate reason and triggered fallback diagnostics", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: {
        fallbacks_triggered: ["free_tetrahedral"],
        mixed_layer_topology_certificate: {
          certificate_status: "accepted",
          topology_fingerprint: "sha256:previous-success",
        },
      },
      manifest: null,
      rejectionEvidence: {
        rejection_reason: "node plane count mismatch",
        certificate_status: "rejected",
      },
    });

    expect(model.certificateStatus).toBe("rejected");
    expect(model.certificateReason).toBe("node plane count mismatch");
    expect(model.fallback).toBe("free_tetrahedral");
  });
});
