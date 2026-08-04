import { describe, expect, it } from "vitest";

import {
  BACKEND_INTERACTION_IDS,
  buildObjectInteractionPatchFromDraft,
  buildStudyInteractionPatchFromDraft,
  defaultDraftForInteraction,
  findInteractionSpec,
  interactionAvailabilityForDiscretization,
  interactionSpecsForDiscretization,
  normalizeInteractionDiscretization,
  validateInteractionDraftForDiscretization,
  writableObjectInteractionIds,
} from "./interactions";

describe("physics interaction catalog", () => {
  it("lists backend interactions with explicit authoring availability", () => {
    expect(BACKEND_INTERACTION_IDS).toEqual([
      "exchange",
      "demag",
      "zeeman",
      "current_transport",
      "spin_torque",
      "interfacial_dmi",
      "bulk_dmi",
      "uniaxial_anisotropy",
      "cubic_anisotropy",
      "oersted_field",
      "magnetoelastic",
    ]);
    expect(writableObjectInteractionIds()).toEqual([
      "interfacial_dmi",
      "uniaxial_anisotropy",
    ]);
    expect(findInteractionSpec("bulk_dmi")?.availability).toBe("study");
    expect(findInteractionSpec("current_transport")?.availability).toBe("study");
    expect(findInteractionSpec("spin_torque")?.availability).toBe("study");
  });

  it("keeps exchange and demag as global effective-field switches", () => {
    expect(findInteractionSpec("exchange")).toMatchObject({
      availability: "study",
      id: "exchange",
      scope: "global",
      storage: "study",
    });
    expect(findInteractionSpec("demag")).toMatchObject({
      availability: "study",
      id: "demag",
      scope: "global",
      storage: "study",
    });
  });

  it("keeps demag global and exposes the implemented and planned demag methods", () => {
    const demag = findInteractionSpec("demag");

    expect(demag).toMatchObject({
      availability: "study",
      id: "demag",
      scope: "global",
    });
    expect(demag?.fields.find((field) => field.id === "method")).toMatchObject({
      options: [
        { label: "Auto", value: "auto" },
        { label: "FEM Poisson Robin airbox", value: "poisson_robin" },
        { label: "FEM Poisson Dirichlet airbox", value: "poisson_dirichlet" },
        { label: "FEM BEM", value: "bem" },
        { label: "FEM/BEM Fredkin-Koehler (no airbox)", value: "fredkin_koehler" },
        { label: "FEM FMM", value: "fmm" },
        { label: "FDM multilayer convolution", value: "multilayer_convolution" },
      ],
      unit: null,
    });
  });

  it("filters demag methods by the resolved discretization lane", () => {
    const fdmDemag = interactionSpecsForDiscretization("fdm").find(
      (spec) => spec.id === "demag",
    );
    const femDemag = interactionSpecsForDiscretization("fem").find(
      (spec) => spec.id === "demag",
    );

    expect(fdmDemag?.fields[0]?.options?.map((option) => option.value)).toEqual([
      "auto",
      "single_grid",
      "multilayer_convolution",
    ]);
    expect(femDemag?.fields[0]?.options?.map((option) => option.value)).toEqual([
      "auto",
      "poisson_robin",
      "poisson_dirichlet",
      "bem",
      "fredkin_koehler",
      "fmm",
    ]);
    expect(interactionSpecsForDiscretization("unknown")).toEqual([]);
  });

  it("fails closed for unresolved lanes and rejects cross-lane demag patches", () => {
    expect(normalizeInteractionDiscretization("FDM")).toBe("fdm");
    expect(normalizeInteractionDiscretization("fem")).toBe("fem");
    expect(normalizeInteractionDiscretization(undefined)).toBe("unknown");
    expect(interactionAvailabilityForDiscretization("demag", "unknown")).toMatchObject({
      status: "unresolved",
    });
    expect(
      validateInteractionDraftForDiscretization(
        {
          enabled: true,
          id: "demag",
          present: true,
          values: { method: "poisson_robin" },
        },
        "fdm",
      ),
    ).toEqual({
      error:
        "Demagnetization method 'poisson_robin' is not applicable to FDM; choose auto, single_grid, or multilayer_convolution.",
    });
    expect(
      validateInteractionDraftForDiscretization(
        {
          enabled: true,
          id: "demag",
          present: true,
          values: { method: "multilayer_convolution" },
        },
        "fdm",
      ),
    ).toBeNull();
  });

  it("builds typed object interaction patches without JSON parameter text", () => {
    expect(
      buildObjectInteractionPatchFromDraft({
        enabled: true,
        id: "interfacial_dmi",
        present: true,
        values: { dind: "2.5e-3" },
      }),
    ).toEqual({
      patch: {
        enabled: true,
        params: { dind: 2.5e-3 },
        present: true,
      },
    });

    expect(
      buildObjectInteractionPatchFromDraft({
        enabled: true,
        id: "uniaxial_anisotropy",
        present: true,
        values: { axis: ["0", "0", "1"], ku1: "4e4", ku2: "2e3" },
      }),
    ).toEqual({
      patch: {
        enabled: true,
        params: { axis: [0, 0, 1], ku1: 4e4, ku2: 2e3 },
        present: true,
      },
    });
  });

  it("builds study patches for global demag and Zeeman field settings", () => {
    expect(
      buildStudyInteractionPatchFromDraft({
        enabled: false,
        id: "exchange",
        present: true,
        values: {},
      }),
    ).toEqual({
      patch: { study: { exchange_enabled: false } },
    });
    expect(
      buildStudyInteractionPatchFromDraft({
        enabled: false,
        id: "demag",
        present: true,
        values: { method: "poisson_robin" },
      }),
    ).toEqual({
      patch: { study: { demag_enabled: false, demag_realization: "poisson_robin" } },
    });
    expect(
      buildStudyInteractionPatchFromDraft({
        enabled: true,
        id: "zeeman",
        present: true,
        values: { field: ["0.01", "0", "-0.002"] },
      }),
    ).toEqual({
      patch: { study: { external_field: [0.01, 0, -0.002] } },
    });
  });

  it("rejects invalid typed drafts before hitting the API", () => {
    expect(
      buildObjectInteractionPatchFromDraft({
        enabled: true,
        id: "uniaxial_anisotropy",
        present: true,
        values: { axis: ["0", "0"], ku1: "1" },
      }),
    ).toEqual({ error: "Axis must contain exactly 3 numeric values." });
    expect(
      buildObjectInteractionPatchFromDraft({
        enabled: true,
        id: "bulk_dmi",
        present: true,
        values: { d_bulk: "1e-3" },
      }),
    ).toEqual({
      error: "Bulk DMI is backend-supported but not yet writable from the control room.",
    });
  });

  it("creates default drafts with documented units", () => {
    expect(defaultDraftForInteraction("zeeman")).toMatchObject({
      id: "zeeman",
      values: { field: ["0", "0", "0"] },
    });
    expect(findInteractionSpec("zeeman")?.fields[0]).toMatchObject({
      label: "B_ext",
      unit: "T",
    });
  });

  it("separates global uniform external field from regional field sources", () => {
    expect(findInteractionSpec("zeeman")).toMatchObject({
      availability: "study",
      id: "zeeman",
      scope: "global",
    });

    const oersted = findInteractionSpec("oersted_field");

    expect(oersted).toMatchObject({
      availability: "study",
      id: "oersted_field",
      scope: "global_or_region",
    });
    expect(oersted?.fields.find((field) => field.id === "source_mode")).toMatchObject({
      options: [
        { label: "Current transport solve region", value: "current_transport" },
        { label: "Antenna field source", value: "antenna_field_source" },
        { label: "Point source", value: "point_source" },
      ],
    });
    expect(oersted?.fields.find((field) => field.id === "region_id")).toMatchObject({
      label: "Region ID",
      unit: null,
    });
  });

  it("documents electric current and STT backend families as source-bound authoring", () => {
    const current = findInteractionSpec("current_transport");
    const stt = findInteractionSpec("spin_torque");

    expect(current).toMatchObject({
      availability: "study",
      id: "current_transport",
      scope: "global_or_region",
    });
    expect(current?.fields.find((field) => field.id === "model")).toMatchObject({
      options: [
        { label: "Prescribed current density", value: "prescribed_density" },
        { label: "Ohmic Poisson", value: "ohmic_poisson" },
      ],
    });
    expect(stt).toMatchObject({
      availability: "study",
      id: "spin_torque",
      scope: "object_or_region",
    });
    expect(stt?.fields.find((field) => field.id === "model")).toMatchObject({
      options: [
        { label: "Slonczewski STT", value: "slonczewski" },
        { label: "Zhang-Li STT", value: "zhang_li" },
        { label: "Interface CPP", value: "interface_cpp" },
        { label: "Drift diffusion", value: "drift_diffusion" },
        { label: "Spin-orbit torque", value: "spin_orbit_torque" },
      ],
    });
  });
});
