import { describe, expect, it } from "vitest";

import {
  parsePreparationFailurePredicates,
  resolvePreparationFailureCauses,
} from "./simulationPreparationModel";

describe("simulation preparation failure predicates", () => {
  it("explains the mixed-P1 GPU DMI predicate with an actionable CPU alternative", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[gpu_dmi_kernel_not_mixed_p1]",
    );

    expect(causes).toEqual([
      expect.objectContaining({
        action: expect.stringContaining("FEM CPU"),
        known: true,
        label: expect.stringContaining("GPU"),
        predicate: "gpu_dmi_kernel_not_mixed_p1",
      }),
    ]);
  });

  it("explains the known material-field predicate", () => {
    const causes = resolvePreparationFailureCauses(
      "fem_mixed_p1_scope_rejected: failed_predicates=[unsupported_material_field_or_dmi]",
    );

    expect(causes[0]).toEqual(
      expect.objectContaining({
        action: expect.stringContaining("uniform"),
        known: true,
        predicate: "unsupported_material_field_or_dmi",
      }),
    );
  });

  it.each([
    [
      "requires FEM as the requested backend",
      "Choose FEM as the explicit backend for this mixed-P1 run.",
      "The requested backend is not FEM",
      ["backend_not_explicit_fem", "backend_not_fem"],
    ],
    [
      "requires strict execution mode",
      "Select strict execution mode for this mixed-P1 FEM run.",
      "The execution mode is not strict",
      ["execution_mode_not_strict"],
    ],
    [
      "requires double precision",
      "Select double precision for this mixed-P1 FEM lane.",
      "The requested precision is unsupported",
      [
        "precision_not_double",
        "execution_precision_not_double",
        "fem_precision_not_double",
        "double_precision",
      ],
    ],
    [
      "requires an explicit CPU or GPU device",
      "Choose an explicit CPU or GPU device for this FEM mixed-P1 run.",
      "The FEM device is not explicit",
      [
        "device_not_explicit_cpu_or_gpu",
        "explicit_device_cpu_or_gpu_required",
        "explicit_cpu_or_cuda_device",
      ],
    ],
    [
      "requires first-order finite elements",
      "Use first-order (P1) elements for the mixed-prism lane.",
      "The requested finite-element order is unsupported",
      ["fem_order_not_p1", "fem_fe_order_not_p1", "p1"],
    ],
    [
      "requires exactly one enabled exchange term",
      "Remove disable_exchange() and duplicate explicit Exchange terms; exchange is enabled by default when Aex is present.",
      "Exchange must be enabled exactly once",
      [
        "missing_exchange",
        "exchange_term_count_not_one",
        "exchange_count_not_one",
        "fem_exchange_disabled",
        "exchange",
      ],
    ],
    [
      "requires exactly one supported demagnetization term",
      "Remove disable_demag() and duplicate explicit Demag terms; demagnetization defaults to Auto and must resolve to Poisson Robin or Poisson Dirichlet.",
      "Demagnetization must be enabled exactly once with a supported open-boundary realization",
      [
        "missing_qualified_demag",
        "demag_term_count_not_one",
        "demag_count_not_one",
        "fem_demag_disabled",
      ],
    ],
    [
      "requires a supported demagnetization realization",
      "Resolve Demag to Poisson Robin or Poisson Dirichlet before starting the mixed-P1 run.",
      "The demagnetization realization is unsupported",
      [
        "demag_realization_not_poisson_robin_or_dirichlet",
        "fem_demag_realization_not_poisson_robin_or_dirichlet",
        "poisson_robin_or_dirichlet",
      ],
    ],
    [
      "requires an allowed relaxation study",
      "Use a relaxation study with Projected Gradient BB, Nonlinear CG, or overdamped LLG.",
      "The requested relaxation study is unsupported",
      [
        "unsupported_study",
        "study_not_relaxation",
        "study_relaxation_algorithm_unsupported",
        "fem_relaxation_algorithm_unsupported",
      ],
    ],
    [
      "requires a resolved FEM relaxation plan",
      "Create a FEM relaxation plan before running this mixed-P1 case.",
      "The FEM relaxation plan is missing",
      ["fem_relaxation_plan_missing"],
    ],
    [
      "requires one axis-aligned Box geometry",
      "Use exactly one axis-aligned Box geometry for this mixed-P1 case.",
      "The geometry is outside the mixed-P1 scope",
      [
        "geometry_not_exactly_one_axis_aligned_box",
        "geometry_count_not_one",
        "geometry_not_box",
      ],
    ],
    [
      "requires one region",
      "Use exactly one magnetic region in this mixed-P1 case.",
      "The region count is outside the mixed-P1 scope",
      ["region_count_not_one"],
    ],
    [
      "requires one magnet",
      "Use exactly one magnet in this mixed-P1 case.",
      "The magnet count is outside the mixed-P1 scope",
      ["magnet_count_not_one"],
    ],
    [
      "requires one material",
      "Use exactly one magnetic material in the bounded mixed-P1 lane.",
      "The material count is outside the mixed-P1 scope",
      ["material_count_not_one"],
    ],
    [
      "requires no object-region overrides",
      "Remove object-region overrides from this mixed-P1 case.",
      "Object-region overrides are outside the mixed-P1 scope",
      ["object_region_count_not_zero"],
    ],
    [
      "requires uniform Ms",
      "Use a spatially uniform saturation magnetization (Ms).",
      "The saturation magnetization field is unsupported",
      ["ms_field_not_uniform"],
    ],
    [
      "requires uniform exchange stiffness",
      "Use a spatially uniform exchange stiffness (Aex).",
      "The exchange-stiffness field is unsupported",
      ["a_field_not_uniform"],
    ],
    [
      "requires uniform damping",
      "Use a spatially uniform damping constant (alpha).",
      "The damping field is unsupported",
      ["alpha_field_not_uniform"],
    ],
    [
      "requires supported material fields and DMI",
      "Use uniform Ms/Aex/alpha; nodal Ku/Kc and CPU DMI fields are supported in the corresponding lanes.",
      "A material field or DMI route is outside this mixed-P1 scope",
      ["unsupported_material_field_or_dmi"],
    ],
    [
      "requires no material parameter fields",
      "Remove material parameter fields and keep Ms, Aex, and alpha uniform.",
      "Material parameter fields are outside the mixed-P1 scope",
      ["material_parameter_fields_present"],
    ],
    [
      "requires no model couplings",
      "Remove model couplings from this mixed-P1 case.",
      "Model couplings are outside the mixed-P1 scope",
      ["couplings_present"],
    ],
    [
      "requires no current modules",
      "Remove current modules from this mixed-P1 case.",
      "Current modules are outside the mixed-P1 scope",
      ["current_modules_present", "fem_current_modules_present"],
    ],
    [
      "requires no field drives",
      "Remove field drives from this mixed-P1 case.",
      "Field drives are outside the mixed-P1 scope",
      ["field_drives_present", "fem_field_drives_present"],
    ],
    [
      "requires no spin-transfer torque configuration",
      "Remove spin-transfer-torque modules and parameters from this mixed-P1 case.",
      "Spin-transfer torque is outside the mixed-P1 scope",
      [
        "spin_torque_modules_present",
        "current_density_present",
        "stt_degree_present",
        "stt_beta_present",
        "stt_spin_polarization_present",
        "stt_lambda_present",
        "stt_epsilon_prime_present",
        "stt_thickness_present",
        "stt_fixed_layer_position_present",
      ],
    ],
    [
      "requires no thermal model",
      "Remove the temperature model from this mixed-P1 case.",
      "Thermal physics is outside the mixed-P1 scope",
      ["temperature_present", "fem_temperature_present"],
    ],
    [
      "requires no magnetoelastic or mechanics model",
      "Remove magnetoelastic and mechanics models from this mixed-P1 case.",
      "Magnetoelastic or mechanics physics is outside the mixed-P1 scope",
      [
        "fem_magnetoelastic_present",
        "fem_mechanics_present",
        "elastic_materials_present",
        "elastic_bodies_present",
        "magnetostriction_laws_present",
        "mechanical_bcs_present",
        "mechanical_loads_present",
      ],
    ],
    [
      "requires no periodic boundary conditions",
      "Remove periodic boundary conditions from this mixed-P1 case.",
      "Periodic boundary conditions are outside the mixed-P1 scope",
      ["periodic_boundary_conditions_present"],
    ],
    [
      "requires no unsupported extended module",
      "Remove unsupported extended modules from this mixed-P1 case.",
      "An extended module is outside the mixed-P1 scope",
      ["unsupported_extended_module"],
    ],
    [
      "requires no unsupported energy term",
      "Remove the unsupported interaction or choose a lane whose capability report includes it.",
      "An active energy term is outside the mixed-P1 scope",
      ["unsupported_energy_term"],
    ],
    [
      "requires CPU for DMI on mixed-P1",
      "Run this mixed-P1 case on FEM CPU or remove DMI; the current CUDA DMI kernel is tetrahedral-only.",
      "DMI is unavailable on the FEM mixed-P1 GPU lane",
      ["gpu_dmi_kernel_not_mixed_p1"],
    ],
    [
      "requires an explicit CPU route for DMI",
      "Run DMI on FEM CPU and select CPU explicitly for this mixed-P1 case.",
      "DMI requires an explicit FEM CPU device",
      ["dmi_requires_explicit_cpu"],
    ],
    [
      "requires one to three certified layers",
      "Choose exactly 1, 2, or 3 magnetic prism layers.",
      "The requested layer count is outside the certified range",
      [
        "requested_layer_count_outside_1_to_3",
        "certificate_requested_layer_count_not_supported",
      ],
    ],
    [
      "requires matching requested and realized layers",
      "Regenerate the mesh so the realized layer count matches the requested layer count.",
      "The realized layer count does not match the request",
      [
        "realized_layer_count_mismatch",
        "certificate_realized_layer_count_mismatch",
      ],
    ],
    [
      "requires a complete magnetic-plane certificate",
      "Regenerate the mesh so its magnetic-plane coordinates match the requested layer count.",
      "The magnetic-plane certificate is inconsistent",
      [
        "magnetic_plane_count_mismatch",
        "certificate_magnetic_plane_count_mismatch",
      ],
    ],
    [
      "requires a mesh without fallbacks",
      "Regenerate the mesh without topology fallbacks for this mixed-P1 case.",
      "The mesh certificate records a fallback",
      ["mesh_fallback_triggered", "certificate_fallbacks_triggered"],
    ],
    [
      "requires mixed prism, pyramid, and tetrahedron cell families",
      "Regenerate the mixed-P1 mesh with Prism6 magnetic cells, Pyramid5/Tet4 air cells, and no other cell families.",
      "The native mesh cell families are unsupported",
      ["mixed_cell_families"],
    ],
    [
      "requires triangular and quadrilateral facet families",
      "Regenerate the mixed-P1 mesh with Tri3 and Quad4 facets only.",
      "The native mesh facet families are unsupported",
      ["mixed_facet_families"],
    ],
    [
      "requires Prism6 magnetic markers",
      "Regenerate the mesh so magnetic cells are marked Prism6 cells.",
      "The native magnetic-cell markers are inconsistent",
      ["magnetic_prism6_markers"],
    ],
    [
      "requires imported topology to match the plan",
      "Regenerate or re-import the mesh so its topology matches the FEM plan.",
      "The imported mesh topology does not match the FEM plan",
      ["plan_topology_matches_import"],
    ],
    [
      "requires no unrelated native extended physics",
      "Remove extended native physics outside uniform Ms, Aex, alpha, local anisotropy, and CPU-only DMI.",
      "Native extended physics is outside the mixed-P1 scope",
      ["unrelated_extended_physics_scope"],
    ],
  ].flatMap(([description, action, label, predicates]) =>
    (predicates as readonly string[]).map((predicate) => [
      description,
      predicate,
      label,
      action,
    ]),
  ))(
    "maps every stable mixed-P1 %s predicate %s to its exact cause and action",
    (_description, predicate, label, action) => {
    const [cause] = resolvePreparationFailureCauses(
      `failed_predicates=[${predicate}]`,
    );

      expect(cause).toEqual({ action, known: true, label, predicate });
    },
  );

  it("does not treat the unproduced FEM order key as known", () => {
    const [cause] = resolvePreparationFailureCauses(
      "failed_predicates=[fem_order_not_one]",
    );

    expect(cause).toEqual(
      expect.objectContaining({
        known: false,
        predicate: "fem_order_not_one",
      }),
    );
  });

  it("keeps all predicates from a bounded multi-predicate list", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[unsupported_material_field_or_dmi,gpu_dmi_kernel_not_mixed_p1]",
    );

    expect(causes.map((cause) => cause.predicate)).toEqual([
      "unsupported_material_field_or_dmi",
      "gpu_dmi_kernel_not_mixed_p1",
    ]);
  });

  it("keeps an unknown predicate visible with a safe fallback explanation", () => {
    const causes = resolvePreparationFailureCauses(
      "failed_predicates=[future_mixed_p1_constraint]",
    );

    expect(causes[0]).toEqual({
      action: expect.stringContaining("raw diagnostic"),
      known: false,
      label: "Unknown preparation constraint",
      predicate: "future_mixed_p1_constraint",
    });
  });

  it("counts only complete list entries omitted by the item limit", () => {
    const detail = `failed_predicates=[${Array.from(
      { length: 40 },
      (_, index) => `predicate_${index}`,
    ).join(",")}]`;

    const parsed = parsePreparationFailurePredicates(detail);

    expect(parsed.predicates).toHaveLength(32);
    expect(parsed.omittedCount).toBe(8);
    expect(parsed.analysisTruncated).toBe(true);
  });

  it("does not report omitted predicates for a complete list before an unrelated suffix", () => {
    const parsed = parsePreparationFailurePredicates(
      `failed_predicates=[gpu_dmi_kernel_not_mixed_p1]${" unrelated runtime detail".repeat(200)}`,
    );

    expect(parsed).toEqual({
      analysisTruncated: false,
      omittedCount: 0,
      predicates: ["gpu_dmi_kernel_not_mixed_p1"],
    });
  });

  it.each([
    [
      "a bounded segment cuts the failed-predicates marker",
      `${"x".repeat(4_080)}failed_predicates=[gpu_dmi_kernel_not_mixed_p1]`,
    ],
    [
      "a bounded segment cuts the predicate list",
      `failed_predicates=[${"future_constraint,".repeat(300)}future_constraint]`,
    ],
  ])("marks analysis incomplete when %s", (_description, detail) => {
    expect(parsePreparationFailurePredicates(detail)).toEqual({
      analysisTruncated: true,
      omittedCount: 0,
      predicates: [],
    });
  });

  it("marks a predicate clipped to the per-item limit as incomplete without inventing omissions", () => {
    const predicate = "a".repeat(161);

    expect(parsePreparationFailurePredicates(`failed_predicates=[${predicate}]`)).toEqual({
      analysisTruncated: true,
      omittedCount: 0,
      predicates: [`${"a".repeat(159)}…`],
    });
  });
});
