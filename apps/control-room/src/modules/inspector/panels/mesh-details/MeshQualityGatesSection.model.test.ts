import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeshQualityGatesSection } from "./MeshQualityGatesSection";
import { resolveMixedCertificateQualityPresentation } from "./MeshQualityGatesSection.model";

describe("MeshQualityGatesSection.model", () => {
  it("retains_and_sorts_failed_family_gates_first_when_certificate_is_rejected", () => {
    const presentation = resolveMixedCertificateQualityPresentation({
      certificate_fingerprint: "sha256:mixed-cert-7",
      certificate_schema_version: "mixed_layer_topology_certificate.v1",
      certificate_status: "rejected",
      family_gates: [
        {
          family: "prism6",
          metric: "mixed_topology_scaled_jacobian.v1",
          minimum_jacobian_m3: 8.2e-27,
          p05: 0.641,
          passed: true,
          positive_jacobian: true,
          status: "pass",
          threshold: 0.25,
        },
        {
          family: "tet4",
          metric: "gamma_radius_ratio.v1",
          minimum_jacobian_m3: 3.9e-27,
          p05: 0.215,
          passed: true,
          positive_jacobian: true,
          status: "warn",
          threshold: 0.2,
        },
        {
          family: "pyramid5",
          metric: "mixed_topology_scaled_jacobian.v1",
          minimum_jacobian_m3: -1.4e-29,
          p05: 0.182,
          passed: false,
          positive_jacobian: false,
          status: "failed",
          threshold: 0.25,
        },
      ],
      mesh_revision: 14,
      reason: "pyramid5 failed Jacobian positivity and SICN p05 threshold",
      status: "rejected",
      topology_fingerprint: "sha256:mixed-cert-7",
      valid: false,
    });

    expect(presentation.status).toBe("rejected");
    expect(presentation.familyGates).toHaveLength(3);
    expect(presentation.familyGates[0]?.family).toBe("pyramid5");
    expect(presentation.familyGates[0]?.status).toBe("failed");
    expect(presentation.familyGates[1]?.family).toBe("tet4");
    expect(presentation.familyGates[1]?.status).toBe("warn");
    expect(presentation.familyGates[2]?.family).toBe("prism6");
    expect(presentation.familyGates[2]?.status).toBe("pass");

    const html = renderToStaticMarkup(
      createElement(MeshQualityGatesSection, {
        badge: "rejected",
        gateRows: [],
        mixedCertificate: presentation,
      }),
    );

    expect(html).toContain('data-status="failed"');
    expect(html).not.toContain('data-status="fail"');
  });
});
