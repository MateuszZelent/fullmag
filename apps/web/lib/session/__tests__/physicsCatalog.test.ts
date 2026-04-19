import { describe, expect, it } from "vitest";

import {
  buildPhysicsCapabilityView,
  mapBackendTermToCatalogId,
} from "../physicsCatalog";
import type { BackendCapabilities } from "../types";

const CUDA_CAPABILITIES: BackendCapabilities = {
  engine_id: "fdm_cuda",
  capability_profile_version: "2026-04-04",
  supported_terms: [
    "exchange",
    "demag_tensor_fft_newell",
    "zeeman",
    "interfacial_dmi",
    "bulk_dmi",
    "uniaxial_anisotropy",
    "cubic_anisotropy",
    "thermal",
    "oersted",
    "stt",
    "sot",
    "boundary_correction",
  ],
  supported_demag_realizations: ["tensor_fft_newell"],
  preview_quantities: [],
  snapshot_quantities: [],
  scalar_outputs: [],
  approximate_operators: [],
  supports_lossy_fallback_override: false,
};

describe("physicsCatalog", () => {
  it("maps backend runtime tags to canonical UI catalog ids", () => {
    expect(mapBackendTermToCatalogId("demag_tensor_fft_newell")).toBe("demag");
    expect(mapBackendTermToCatalogId("thermal")).toBe("thermal_noise");
    expect(mapBackendTermToCatalogId("stt")).toBe("spin_transfer_torque");
  });

  it("builds a mixed active/available/backend-only capability view", () => {
    const entries = buildPhysicsCapabilityView(CUDA_CAPABILITIES, [
      { kind: "exchange", enabled: true, params: null },
      { kind: "demag", enabled: true, params: null },
      { kind: "interfacial_dmi", enabled: true, params: { dind: 1e-3 } },
    ]);

    expect(entries.find((entry) => entry.id === "exchange")).toMatchObject({
      available: true,
      active: true,
      required: true,
      authorableInObjectPanel: true,
    });

    expect(entries.find((entry) => entry.id === "bulk_dmi")).toMatchObject({
      available: true,
      active: false,
      authorableInObjectPanel: false,
    });

    expect(entries.find((entry) => entry.id === "spin_orbit_torque")).toMatchObject({
      available: true,
      active: false,
      authorableInObjectPanel: false,
    });
  });

  it("treats demag as available when only demag realizations are reported", () => {
    const entries = buildPhysicsCapabilityView(
      {
        ...CUDA_CAPABILITIES,
        supported_terms: [],
        supported_demag_realizations: ["poisson_robin"],
      },
      [],
    );

    expect(entries.find((entry) => entry.id === "demag")).toMatchObject({
      available: true,
    });
  });

  it("does not mark required terms unsupported when capability profile is missing", () => {
    const entries = buildPhysicsCapabilityView(
      {
        ...CUDA_CAPABILITIES,
        supported_terms: [],
        supported_demag_realizations: [],
      },
      [],
    );

    expect(entries.find((entry) => entry.id === "exchange")).toMatchObject({
      required: true,
      active: true,
      available: true,
    });
    expect(entries.find((entry) => entry.id === "demag")).toMatchObject({
      required: true,
      active: true,
      available: true,
    });
  });
});
