import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MeshQualityGatesSection,
  resolveMixedCertificateQualityPresentation,
} from "./MeshQualityGatesSection";

describe("MeshQualityGatesSection mixed certificate evidence", () => {
  it("renders complete revision-bound family quality and positive-Jacobian gates", () => {
    const mixedCertificate = resolveMixedCertificateQualityPresentation({
      certificate_fingerprint: "sha256:mixed",
      certificate_schema_version: "mixed_layer_topology_certificate.v1",
      certificate_status: "accepted",
      family_gates: [
        {
          family: "prism6",
          metric: "mixed_topology_scaled_jacobian.v1",
          minimum_jacobian_m3: 2.5e-22,
          p05: 0.34,
          passed: true,
          positive_jacobian: true,
          threshold: 0.1,
        },
      ],
      mesh_revision: 91,
      status: "valid",
      topology_fingerprint: "sha256:mixed",
    });

    const html = renderToStaticMarkup(
      <MeshQualityGatesSection
        badge="ready"
        gateRows={[]}
        mixedCertificate={mixedCertificate}
      />,
    );

    expect(html).toContain("Mixed certificate quality");
    expect(html).toContain("sha256:mixed");
    expect(html).toContain("Mesh revision");
    expect(html).toContain("91");
    expect(html).toContain("prism6");
    expect(html).toContain("mixed_topology_scaled_jacobian.v1");
    expect(html).toContain("0.34");
    expect(html).toContain("0.1");
    expect(html).toContain("positive");
    expect(html).toContain('role="table"');
    expect(html).toContain('id="fm-mixed-certificate-quality-heading"');
    expect(html).toContain('aria-labelledby="fm-mixed-certificate-quality-heading"');
    expect(html.match(/role="columnheader"/g)).toHaveLength(3);
    expect(html.match(/role="cell"/g)).toHaveLength(3);
  });

  it("fails closed without rendering family values for stale evidence", () => {
    const mixedCertificate = resolveMixedCertificateQualityPresentation({
      certificate_fingerprint: "sha256:old",
      certificate_schema_version: "mixed_layer_topology_certificate.v1",
      certificate_status: "accepted",
      family_gates: [],
      mesh_revision: 92,
      reason: "certificate fingerprint does not match live topology fingerprint",
      status: "stale",
      topology_fingerprint: "sha256:current",
    });

    const html = renderToStaticMarkup(
      <MeshQualityGatesSection
        badge="ready"
        gateRows={[]}
        mixedCertificate={mixedCertificate}
      />,
    );

    expect(html).toContain("stale");
    expect(html).toContain("does not match");
    expect(html).not.toContain("prism6");
  });

  it("presents absent evidence as unavailable instead of deriving values", () => {
    const mixedCertificate = resolveMixedCertificateQualityPresentation({
      family_gates: [],
      mesh_revision: 93,
      reason: "accepted mixed-layer topology certificate is unavailable",
      status: "unavailable",
    });

    expect(mixedCertificate.status).toBe("unavailable");
    expect(mixedCertificate.familyGates).toEqual([]);
  });
});
