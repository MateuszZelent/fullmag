import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MixedTopologyProvenanceSection,
  resolveMixedTopologyPresentation,
} from "./MixedTopologyProvenanceSection";

describe("MixedTopologyProvenanceSection", () => {
  it("treats an unknown certificate status as unavailable", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: { mixed_layer_topology_certificate_v2: {
        certificate_status: "pending", accepted: true, magnetic_regions: [],
      } },
      manifest: null,
    });
    expect(model.certificateStatus).toBe("unavailable");
    const html = renderToStaticMarkup(<MixedTopologyProvenanceSection model={model} />);
    expect(html).toContain("unrecognized status");
    expect(html).toContain('data-kind="warning"');
  });

  it("keeps v2 swept-layer evidence local to its magnetic body", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: {
        mixed_layer_topology_certificate_v2: {
          schema_version: "mixed_layer_topology_certificate.v2",
          certificate_status: "accepted",
          topology_fingerprint: "sha256:regions",
          magnetic_regions: [
            { object_id: "layer", body_marker: 1, material_marker: 1,
              cell_family_counts: { prism6: 12 },
              exact_sweep: { requested_layer_count: 1, realized_layer_count: 1,
                actual_node_plane_count: 2 } },
            { object_id: "ring", body_marker: 2, material_marker: 2,
              cell_family_counts: { tet4: 48 } },
          ],
        },
      },
      manifest: null,
    });
    expect(model.certificateStatus).toBe("accepted");
    expect(model.hasSingleLayer).toBe(true);
    expect(model.certificateFingerprint).toBe("sha256:regions");
    expect(model.requestedLayers).toBeNull();
    expect(model.resolvedLayers).toBeNull();
    expect(model.nodePlanes).toBeNull();
    expect(model.regionFields).toContainEqual({ label: "layer exact layers",
      value: "1 requested / 1 realized; 2 node planes" });
    expect(model.regionFields).toContainEqual({ label: "ring exact layers", value: "not swept" });
    const markup = renderToStaticMarkup(<MixedTopologyProvenanceSection model={model} />);
    expect(markup).toContain("Body ring");
    expect(markup).toContain("tet4: 48");
  });

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

  it("fails closed and exposes typed orphan entities in the inspector", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: {
        mixed_layer_topology_certificate: { status: "accepted" },
        mixed_topology_provenance: {
          requested_topology: "mixed_p1",
          resolved_topology: "mixed_p1",
        },
        orphan_entities: [{ dimension: 2, tag: 41 }],
      },
      manifest: null,
    });

    expect(model.orphanEntities).toEqual([{ dimension: 2, tag: 41 }]);
    expect(model.topologyIntegrity).toBe("rejected");

    const html = renderToStaticMarkup(<MixedTopologyProvenanceSection model={model} />);
    expect(html).toContain("Orphan topology entities invalidate this mixed mesh");
    expect(html).toContain("dimension 2, tag 41");
  });

  it("does not show mixed topology provenance for an otherwise empty report with no orphans", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: { orphan_entities: [] },
      manifest: null,
    });

    expect(model.visible).toBe(false);
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

  it("renders structured mixed-P1 rejection evidence without inferring a fallback", () => {
    const model = resolveMixedTopologyPresentation({
      buildReport: null,
      manifest: null,
      rejectionEvidence: {
        certificate_status: "rejected",
        fallback: "none",
        free_tetrahedral_alternative: "Select free_tetrahedral explicitly.",
        missing_capabilities: ["fem.gpu.exchange_demag.mixed_p1"],
        rejection_category: "missing_capability",
        rejection_reason: "mixed-P1 GPU operators are unavailable",
        requested_execution: {
          backend: "fem",
          device: "gpu",
          mode: "strict",
          precision: "double",
          study: "relaxation",
        },
        resolved_execution: null,
      },
    });

    expect(model.rejection).toMatchObject({
      category: "missing_capability",
      fallback: "none",
      missingCapabilities: ["fem.gpu.exchange_demag.mixed_p1"],
      requestedExecution: "fem / gpu / double / strict / relaxation",
      resolvedExecution: "not resolved",
    });

    const html = renderToStaticMarkup(<MixedTopologyProvenanceSection model={model} />);
    expect(html).toContain("Mixed-P1 request rejected");
    expect(html).toContain("missing_capability");
    expect(html).toContain("fem.gpu.exchange_demag.mixed_p1");
    expect(html).toContain("fem / gpu / double / strict / relaxation");
    expect(html).toContain("not resolved");
    expect(html).toContain("Fallback");
    expect(html).toContain("none");
    expect(html).toContain("Select free_tetrahedral explicitly.");
  });
});
