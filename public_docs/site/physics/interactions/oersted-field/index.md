---
title: Oersted field
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0980-dynamic-current-and-oersted-coupling.md
---

(public-docs-physics-interactions-oersted-field-root)=
# Solved-current Oersted field

`OerstedField(source=...)` binds the magnetic field to one named solved
`CurrentTransport`. The canonical source is signed conventional current with a
complete circuit closure. FEM consumes an immutable conservative RT0/H(div)
view; it must not reconstruct current from a nodal display field or from
$-\sigma\nabla V$ inside the Oersted operator.

This page covers the canonical solved-current FEM methods:

- **OE-F1**: direct tetrahedral Biot--Savart quadrature from the RT0 view;
- **OE-F2**: an $H(\mathrm{curl})\times H^1$ vector-potential solve on a
  conductor-plus-airbox domain, followed by a compatible field projection.

The current capability matrix remains conservative. Bounded native and runner
execution evidence does not by itself promote either method to production or a
validated workload.

| Method | Solver | Device | Capability status | Method-specific boundary |
|---|---|---|---|---|
| OE-F1 direct tetrahedral quadrature | FDM | CPU | `unsupported` | OE-F1 consumes a tetrahedral FEM RT0/H(div) current view; it is not an FDM operator. |
| OE-F1 direct tetrahedral quadrature | FDM | GPU | `unsupported` | No FDM or CUDA realization of the OE-F1 tetrahedral operator exists. |
| OE-F1 direct tetrahedral quadrature | FEM | CPU | `semantic_only` with bounded executable implementation slices | OE-T0/OE-F1 closed-geometry, external-lead adapter, and callback fixtures execute in FP64, but public method selection and production qualification remain open. |
| OE-F1 direct tetrahedral quadrature | FEM | GPU | `unsupported` | There is no device-resident OE-F1 realization; strict GPU requests fail closed. |
| OE-F2 mixed vector potential | FDM | CPU | `unsupported` | The $H(\mathrm{curl})\times H^1$ exact-sequence formulation is FEM-only. |
| OE-F2 mixed vector potential | FDM | GPU | `unsupported` | No FDM realization or fallback is defined. |
| OE-F2 mixed vector potential | FEM | CPU | `semantic_only` with bounded executable implementation slices | The append-only mixed-solve fixture executes in FP64, but airbox/convergence, explicit public selection, and production gates remain open. |
| OE-F2 mixed vector potential | FEM | GPU | `semantic_only` | Target vocabulary exists, but no executable or qualified device-resident solved-current implementation exists. |

The future cell-integrated open-boundary **FDM FFT** family is a different
operator. Its CPU and GPU statuses are both `semantic_only`; those statuses do
not apply to OE-F1 or OE-F2. Legacy analytic-cylinder and midpoint paths are
also separate formula families and cannot promote any row above.

(oersted-problem-statement)=
## Physical problem

A local current solve is insufficient unless the global circuit is closed.
`closed_geometry` uses a volumetrically meshed closed conductor/return.
`external_lead` uses `ConservativeCurrentExternalLead`: a tetrahedral lead
mesh, per-element conductivity, stable vertex identities, oriented
device--lead face pairs, and disjoint outer electrodes participate in one
coupled minimum-dissipation solve. It is not an analytic wire correction.

An open two-electrode bar without a return path is rejected for canonical
general Oersted evaluation. An analytic return can augment OE-F1 only under its
separate realization; it cannot create an RT0 closure or satisfy OE-F2.

(oersted-governing-equations)=
## Governing equations

The conducting domain obeys charge continuity:

```{math}
:label: eq-oersted-current
\mathbf E=-\nabla V,\qquad
\mathbf J_c=\sigma\mathbf E,\qquad
\nabla\cdot\mathbf J_c=0.
```

OE-F1 evaluates the magnetic field directly from the same accepted RT0 source:

```{math}
:label: eq-oersted-biot-savart
\mathbf H_{\mathrm{oe}}(\mathbf x,t)=\frac{1}{4\pi}
\int_{\Omega_c}\frac{\mathbf J_c(\mathbf x',t)\times
(\mathbf x-\mathbf x')}{\lVert\mathbf x-\mathbf x'\rVert^3}\,\mathrm dV'.
```

There is no $\mu_0$ in Biot--Savart for $\mathbf H$. In vacuum,
$\mathbf B_{\mathrm{oe}}=\mu_0\mathbf H_{\mathrm{oe}}$.

OE-F2 solves the baseline mixed problem

```{math}
:label: eq-oersted-vector-potential
\begin{aligned}
(\mu_0^{-1}\nabla\times\mathbf A,\nabla\times\mathbf v)
+(\nabla p,\mathbf v)&=(\mathbf J_c,\mathbf v),\\
(\mathbf A,\nabla q)&=0,\\
\mathbf B_{\mathrm{oe}}&=\nabla\times\mathbf A,\qquad
\mathbf H_{\mathrm{oe}}=\mu_0^{-1}\mathbf B_{\mathrm{oe}}.
\end{aligned}
```

The baseline uses $\mathbf A\in H_0(\mathrm{curl})$ and $p\in H^1_0$, not a
zero-mean scalar gauge. The zero-mean/natural-boundary variant is a distinct
operator and cannot be substituted silently.

(oersted-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $V$ | electric potential | $\mathrm{V}$ |
| $\mathbf E$ | electric field | $\mathrm{V\,m^{-1}}$ |
| $\sigma$ | charge conductivity | $\mathrm{S\,m^{-1}}$ |
| $\mathbf J_c$ | signed conventional current density | $\mathrm{A\,m^{-2}}$ |
| $\Omega_c$ | closed conductor and volumetric lead domain | $1$ |
| $\mathbf x$ | observation position | $\mathrm{m}$ |
| $\mathbf x'$ | source position | $\mathrm{m}$ |
| $\mathbf H_{\mathrm{oe}}$ | Oersted magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{oe}}$ | Oersted magnetic flux density | $\mathrm{T}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{H\,m^{-1}}$ |
| $\mathbf A$ | magnetic vector potential | $\mathrm{T\,m}$ |
| $p$ | OE-F2 gauge multiplier | $\mathrm{A\,m^{-1}}$ |
| $\mathbf v$ | H(curl) test function | $\mathrm{T\,m}$ |
| $q$ | scalar gauge test function | $\mathrm{A\,m^{-1}}$ |
| $t$ | source evaluation time | $\mathrm{s}$ |

(oersted-assumptions-and-validity)=
## Assumptions and validity limits

The model is magnetoquasistatic. It excludes displacement current, propagation
delay, unresolved skin/eddy-current redistribution, and magnetic material
response inside the Oersted operator. The airbox uses vacuum $\mu_0$; magnetic
response remains owned by demagnetization.

The current RT0 view is restricted to affine nondegenerate tetrahedra with
stable positive vertex identities. Its balance certificate, source/mesh/
topology/envelope/closure revisions, canonical face digest, and stage identity
must match. An unpaired terminal flux, stale revision, incomplete external
lead, analytic return presented as RT0, reciprocal M2 plus closure-aware RT0,
or strict GPU request fails closed.

(oersted-python-api)=
## Python API and exact public boundary

The complete external-lead payload is accepted by the stage-first builder. The
compact fixture below demonstrates the authoring boundary; it is not a physical
convergence case. The public `OerstedField` object has no `method` parameter.
Its `to_ir()` result therefore proves the current API boundary instead of
inventing a selector or a top-level `fm.Problem`.

```python
# %% Explicit tetrahedral external-lead closure data
import fullmag as fm

lead_mesh = {
    "mesh_name": "lead",
    "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0],
              [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    "cells": {
        "types": ["tet4"], "offsets": [0, 4],
        "nodes": [0, 1, 2, 3], "global_ordinals": [0],
    },
    "element_markers": [1],
    "facets": {
        "types": ["tri3", "tri3", "tri3", "tri3"],
        "roles": ["closure_interface", "exterior", "exterior", "exterior"],
        "offsets": [0, 3, 6, 9, 12],
        "nodes": [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
        "global_ordinals": [0, 1, 2, 3],
    },
    "boundary_markers": [10, 11, 12, 13],
}
lead = fm.ConservativeCurrentExternalLead(
    operator_version="fem_closed_current_extension.v1",
    revision="lead-r1",
    digest="lead-digest-r1",
    drive_id="lead-voltage",
    outer_electrode_potential_drop_v=0.1,
    lead_mesh=lead_mesh,
    lead_conductivity_spm_per_element=[5.8e7],
    lead_stable_vertex_ids=[101, 102, 103, 104],
    interface_pairs=[
        fm.ConservativeCurrentLeadInterfacePair([1, 2, 3], [101, 102, 103])
    ],
    minus_outer_electrode_face_vertex_ids=[[101, 102, 104]],
    plus_outer_electrode_face_vertex_ids=[[101, 103, 104]],
    lead_conductivity_digest="lead-sigma-r1",
)

# %% Immutable accepted-source identity and RT0 request
identity = fm.ConservativeCurrentIdentity(
    source_module_id="drive",
    source_state_revision="state-r1",
    source_field_digest="field-r1",
    conductivity_digest="device-sigma-r1",
    mesh_revision="mesh-r1",
    topology_revision="topology-r1",
    geometry_digest="geometry-r1",
    envelope_revision="envelope-r1",
    envelope_digest="envelope-digest-r1",
    evaluated_envelope_multiplier=1.0,
    evaluation_time_s=0.0,
    stage_identity=1,
)
view = fm.ConservativeCurrentView(
    stable_vertex_ids=[1, 2, 3, 4],
    boundary_faces=[
        fm.ConservativeCurrentBoundaryFace(
            [1, 2, 3], "closure_interface", "lead-interface"
        ),
        fm.ConservativeCurrentBoundaryFace([1, 2, 4], "insulating_outer"),
        fm.ConservativeCurrentBoundaryFace([1, 3, 4], "insulating_outer"),
        fm.ConservativeCurrentBoundaryFace([2, 3, 4], "insulating_outer"),
    ],
    identity=identity,
    pins=fm.ConservativeCurrentPins(
        required_source_state_revision="state-r1",
        required_source_field_digest="field-r1",
        required_mesh_revision="mesh-r1",
        required_topology_revision="topology-r1",
    ),
    closure=lead,
    algebraic_relative_tolerance=1.0e-10,
    physical_relative_gate=1.0e-8,
    physical_absolute_gate_a=1.0e-12,
)

# %% Stage-first registration
study = fm.study("external-lead-oersted-boundary")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(1.0, 1.0, 1.0), name="device")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(0.0, 0.0, 1.0)
region = fm.RegionRef("device")
outer = fm.SurfaceRef("device", "outer", (1.0, 0.0, 0.0))
charge = study.current_transport(
    name="drive",
    model="ohmic_poisson",
    coupling="one_way",
    domain=[region],
    materials=[
        fm.ChargeTransportMaterialAssignment(
            region, fm.ChargeTransportMaterial(1.0)
        )
    ],
    boundaries=[fm.ChargeInsulating("outer", [outer])],
    gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(),
    conservative_current_view=view,
)
study.spin_transport(
    fm.SpinDriftDiffusion(
        id="spin",
        current_source_id=charge.name,
        domain=[region],
        materials=[
            fm.SpinTransportMaterialAssignment(
                region,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=1.0,
                    polarization_p=0.0,
                    theta_sh=0.0,
                    lambda_sf_m=1.0,
                ),
            )
        ],
        requested_execution=fm.TransportExecution(
            discretization="fem", device="cpu",
            precision="double", execution_mode="strict",
        ),
    )
)
term = study.oersted(fm.OerstedField(source=charge.name))
assert term.to_ir() == {
    "kind": "oersted_field",
    "id": "oersted:drive",
    "model": "from_current_solution",
    "source": "drive",
}
study.stages.add_run(1.0e-15, stage_id="oersted_run")
```

This stage registration expresses the source, closure, and Oersted binding.
It does **not** expose an OE-F1/OE-F2 selector. Current solved-current FEM
planning selects `FemVectorPotential` (OE-F2). OE-F1 is a bounded append-only
RT0 runtime adapter and callback fallback, not a separately selectable public
Python method. `term.to_ir()` is the exact public boundary.

Script capture of that exact block followed by
`LoadedProblem.to_ir(..., include_geometry_assets=False)` produces the complete
canonical ProblemIR document below. The no-asset mode nulls only optional
generated geometry assets; the external-lead mesh remains serialized in full
because its topology is requested intent.

```json
{
  "ir_version": "0.3.0",
  "problem_meta": {
    "name": "external-lead-oersted-boundary",
    "description": null,
    "script_language": "python",
    "script_source": "# %% Explicit tetrahedral external-lead closure data\nimport fullmag as fm\n\nlead_mesh = {\n    \"mesh_name\": \"lead\",\n    \"nodes\": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0],\n              [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],\n    \"cells\": {\n        \"types\": [\"tet4\"], \"offsets\": [0, 4],\n        \"nodes\": [0, 1, 2, 3], \"global_ordinals\": [0],\n    },\n    \"element_markers\": [1],\n    \"facets\": {\n        \"types\": [\"tri3\", \"tri3\", \"tri3\", \"tri3\"],\n        \"roles\": [\"closure_interface\", \"exterior\", \"exterior\", \"exterior\"],\n        \"offsets\": [0, 3, 6, 9, 12],\n        \"nodes\": [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],\n        \"global_ordinals\": [0, 1, 2, 3],\n    },\n    \"boundary_markers\": [10, 11, 12, 13],\n}\nlead = fm.ConservativeCurrentExternalLead(\n    operator_version=\"fem_closed_current_extension.v1\",\n    revision=\"lead-r1\",\n    digest=\"lead-digest-r1\",\n    drive_id=\"lead-voltage\",\n    outer_electrode_potential_drop_v=0.1,\n    lead_mesh=lead_mesh,\n    lead_conductivity_spm_per_element=[5.8e7],\n    lead_stable_vertex_ids=[101, 102, 103, 104],\n    interface_pairs=[\n        fm.ConservativeCurrentLeadInterfacePair([1, 2, 3], [101, 102, 103])\n    ],\n    minus_outer_electrode_face_vertex_ids=[[101, 102, 104]],\n    plus_outer_electrode_face_vertex_ids=[[101, 103, 104]],\n    lead_conductivity_digest=\"lead-sigma-r1\",\n)\n\n# %% Immutable accepted-source identity and RT0 request\nidentity = fm.ConservativeCurrentIdentity(\n    source_module_id=\"drive\",\n    source_state_revision=\"state-r1\",\n    source_field_digest=\"field-r1\",\n    conductivity_digest=\"device-sigma-r1\",\n    mesh_revision=\"mesh-r1\",\n    topology_revision=\"topology-r1\",\n    geometry_digest=\"geometry-r1\",\n    envelope_revision=\"envelope-r1\",\n    envelope_digest=\"envelope-digest-r1\",\n    evaluated_envelope_multiplier=1.0,\n    evaluation_time_s=0.0,\n    stage_identity=1,\n)\nview = fm.ConservativeCurrentView(\n    stable_vertex_ids=[1, 2, 3, 4],\n    boundary_faces=[\n        fm.ConservativeCurrentBoundaryFace(\n            [1, 2, 3], \"closure_interface\", \"lead-interface\"\n        ),\n        fm.ConservativeCurrentBoundaryFace([1, 2, 4], \"insulating_outer\"),\n        fm.ConservativeCurrentBoundaryFace([1, 3, 4], \"insulating_outer\"),\n        fm.ConservativeCurrentBoundaryFace([2, 3, 4], \"insulating_outer\"),\n    ],\n    identity=identity,\n    pins=fm.ConservativeCurrentPins(\n        required_source_state_revision=\"state-r1\",\n        required_source_field_digest=\"field-r1\",\n        required_mesh_revision=\"mesh-r1\",\n        required_topology_revision=\"topology-r1\",\n    ),\n    closure=lead,\n    algebraic_relative_tolerance=1.0e-10,\n    physical_relative_gate=1.0e-8,\n    physical_absolute_gate_a=1.0e-12,\n)\n\n# %% Stage-first registration\nstudy = fm.study(\"external-lead-oersted-boundary\")\nstudy.engine(\"fem\")\nstudy.device(\"cpu\", precision=\"double\")\nstudy.mode(\"strict\")\nbody = study.geometry(fm.Box(1.0, 1.0, 1.0), name=\"device\")\nbody.Ms = 8.0e5\nbody.Aex = 13.0e-12\nbody.alpha = 0.02\nbody.m = fm.texture.uniform(0.0, 0.0, 1.0)\nregion = fm.RegionRef(\"device\")\nouter = fm.SurfaceRef(\"device\", \"outer\", (1.0, 0.0, 0.0))\ncharge = study.current_transport(\n    name=\"drive\",\n    model=\"ohmic_poisson\",\n    coupling=\"one_way\",\n    domain=[region],\n    materials=[\n        fm.ChargeTransportMaterialAssignment(\n            region, fm.ChargeTransportMaterial(1.0)\n        )\n    ],\n    boundaries=[fm.ChargeInsulating(\"outer\", [outer])],\n    gauge=fm.ChargePotentialGauge(\"zero_mean\"),\n    solver=fm.ChargeSolverPolicy(),\n    conservative_current_view=view,\n)\nstudy.spin_transport(\n    fm.SpinDriftDiffusion(\n        id=\"spin\",\n        current_source_id=charge.name,\n        domain=[region],\n        materials=[\n            fm.SpinTransportMaterialAssignment(\n                region,\n                fm.SpinTransportMaterial(\n                    sigma_s_Spm=1.0,\n                    polarization_p=0.0,\n                    theta_sh=0.0,\n                    lambda_sf_m=1.0,\n                ),\n            )\n        ],\n        requested_execution=fm.TransportExecution(\n            discretization=\"fem\", device=\"cpu\",\n            precision=\"double\", execution_mode=\"strict\",\n        ),\n    )\n)\nterm = study.oersted(fm.OerstedField(source=charge.name))\nassert term.to_ir() == {\n    \"kind\": \"oersted_field\",\n    \"id\": \"oersted:drive\",\n    \"model\": \"from_current_solution\",\n    \"source\": \"drive\",\n}\nstudy.stages.add_run(1.0e-15, stage_id=\"oersted_run\")\n",
    "script_api_version": "0.3.0",
    "serializer_version": "0.3.0",
    "entrypoint_kind": "flat_workspace",
    "source_hash": "3a2e85f99a70769b5562435955640cb5e505b23a7a310b06b87f7290ea71b7c6",
    "runtime_metadata": {
      "interactive_session_requested": true,
      "script_api_surface": "study",
      "runtime_selection": {
        "backend": "fem",
        "device": "cpu",
        "gpu_count": 0,
        "device_index": null,
        "cpu_threads": null,
        "execution_mode": "strict",
        "execution_precision": "double"
      },
      "study_pipeline": {
        "version": "study_pipeline.v1",
        "nodes": [
          {
            "id": "oersted_run",
            "label": "",
            "enabled": true,
            "source": "script_imported",
            "node_kind": "primitive",
            "stage_kind": "run",
            "payload": {
              "kind": "run",
              "entrypoint_kind": "flat_run",
              "stage_id": "oersted_run",
              "until_seconds": "1e-15"
            }
          }
        ]
      },
      "domain_frame": {
        "declared_universe": null,
        "object_bounds_min": [
          -0.5,
          -0.5,
          -0.5
        ],
        "object_bounds_max": [
          0.5,
          0.5,
          0.5
        ],
        "mesh_bounds_min": null,
        "mesh_bounds_max": null,
        "effective_extent": [
          1.0,
          1.0,
          1.0
        ],
        "effective_center": [
          0.0,
          0.0,
          0.0
        ],
        "effective_source": "object_union_bounds"
      },
      "model_builder": {
        "schema_version": "model_builder.v1",
        "source_kind": "flat_script",
        "entrypoint_kind": "flat_workspace",
        "script_api_surface": "study",
        "editable_via_ui": true,
        "editable_scopes": [
          "runtime",
          "geometry",
          "materials",
          "energies",
          "study",
          "outputs",
          "current_transport",
          "spin_transport",
          "meshing",
          "oersted"
        ],
        "canonical_script_strategy": "canonical_rewrite",
        "problem": {
          "name": "external-lead-oersted-boundary",
          "description": null,
          "runtime": {
            "backend": "fem",
            "device": "cpu",
            "gpu_count": 0,
            "device_index": null,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
          },
          "universe": null,
          "domain_frame": {
            "declared_universe": null,
            "object_bounds_min": [
              -0.5,
              -0.5,
              -0.5
            ],
            "object_bounds_max": [
              0.5,
              0.5,
              0.5
            ],
            "mesh_bounds_min": null,
            "mesh_bounds_max": null,
            "effective_extent": [
              1.0,
              1.0,
              1.0
            ],
            "effective_center": [
              0.0,
              0.0,
              0.0
            ],
            "effective_source": "object_union_bounds"
          },
          "geometry": [
            {
              "name": "device_geom",
              "kind": "box",
              "size": [
                1.0,
                1.0,
                1.0
              ]
            }
          ],
          "regions": [
            {
              "name": "device",
              "geometry": "device_geom"
            }
          ],
          "materials": [
            {
              "name": "mat_device",
              "saturation_magnetisation": 800000.0,
              "exchange_stiffness": 1.3e-11,
              "damping": 0.02,
              "uniaxial_anisotropy": null,
              "uniaxial_anisotropy_k2": null,
              "anisotropy_axis": null,
              "cubic_anisotropy_kc1": null,
              "cubic_anisotropy_kc2": null,
              "cubic_anisotropy_kc3": null,
              "cubic_anisotropy_axis1": null,
              "cubic_anisotropy_axis2": null,
              "interfacial_dmi": null,
              "bulk_dmi": null,
              "ms_field": null,
              "a_field": null,
              "alpha_field": null,
              "ku_field": null,
              "ku2_field": null,
              "kc1_field": null,
              "kc2_field": null,
              "kc3_field": null,
              "dind_field": null,
              "dbulk_field": null
            }
          ],
          "magnets": [
            {
              "name": "device",
              "region": "device",
              "material": "mat_device",
              "initial_magnetization": {
                "kind": "preset_texture",
                "preset_kind": "uniform",
                "preset_params": {
                  "direction": [
                    0.0,
                    0.0,
                    1.0
                  ]
                },
                "mapping": {
                  "space": "object",
                  "projection": "object_local",
                  "clamp_mode": "none"
                },
                "texture_transform": {
                  "translation": [
                    0.0,
                    0.0,
                    0.0
                  ],
                  "rotation_quat": [
                    0.0,
                    0.0,
                    0.0,
                    1.0
                  ],
                  "scale": [
                    1.0,
                    1.0,
                    1.0
                  ],
                  "pivot": [
                    0.0,
                    0.0,
                    0.0
                  ]
                },
                "ui_label": null,
                "preview_proxy": "none"
              },
              "mesh_recipe": null,
              "absorbing_boundary": null
            }
          ],
          "energy_terms": [
            {
              "kind": "exchange"
            },
            {
              "kind": "demag",
              "realization": "auto"
            },
            {
              "kind": "oersted_field",
              "id": "oersted:drive",
              "model": "from_current_solution",
              "source": "drive"
            }
          ],
          "current_modules": [
            {
              "kind": "current_transport",
              "name": "drive",
              "model": "ohmic_poisson",
              "coupling": "one_way",
              "domain": [
                {
                  "object_id": "device"
                }
              ],
              "materials": [
                {
                  "region": {
                    "object_id": "device"
                  },
                  "material": {
                    "sigma_Spm": 1.0
                  }
                }
              ],
              "boundaries": [
                {
                  "kind": "insulating",
                  "id": "outer",
                  "surfaces": [
                    {
                      "object_id": "device",
                      "surface_id": "outer",
                      "orientation": [
                        1.0,
                        0.0,
                        0.0
                      ]
                    }
                  ]
                }
              ],
              "gauge": "zero_mean",
              "solver": {
                "engine": "cg",
                "linear": {
                  "relative_tolerance": 1e-10,
                  "absolute_tolerance": 0.0,
                  "max_iterations": 10000
                },
                "physical_residual_version": "charge_balance_integrated_l2.v1",
                "operator_version": "fv_charge_harmonic_v1"
              },
              "conservative_current_view": {
                "stable_vertex_ids": [
                  1,
                  2,
                  3,
                  4
                ],
                "boundary_faces": [
                  {
                    "face_vertex_ids": [
                      1,
                      2,
                      3
                    ],
                    "role": "closure_interface",
                    "circuit_id": "lead-interface"
                  },
                  {
                    "face_vertex_ids": [
                      1,
                      2,
                      4
                    ],
                    "role": "insulating_outer"
                  },
                  {
                    "face_vertex_ids": [
                      1,
                      3,
                      4
                    ],
                    "role": "insulating_outer"
                  },
                  {
                    "face_vertex_ids": [
                      2,
                      3,
                      4
                    ],
                    "role": "insulating_outer"
                  }
                ],
                "identity": {
                  "source_module_id": "drive",
                  "source_state_revision": "state-r1",
                  "source_field_digest": "field-r1",
                  "conductivity_digest": "device-sigma-r1",
                  "mesh_revision": "mesh-r1",
                  "topology_revision": "topology-r1",
                  "geometry_digest": "geometry-r1",
                  "envelope_revision": "envelope-r1",
                  "envelope_digest": "envelope-digest-r1",
                  "evaluated_envelope_multiplier": 1.0,
                  "evaluation_time_s": 0.0,
                  "stage_identity": 1
                },
                "pins": {
                  "required_source_state_revision": "state-r1",
                  "required_source_field_digest": "field-r1",
                  "required_mesh_revision": "mesh-r1",
                  "required_topology_revision": "topology-r1"
                },
                "closure": {
                  "kind": "external_lead",
                  "operator_version": "fem_closed_current_extension.v1",
                  "revision": "lead-r1",
                  "digest": "lead-digest-r1",
                  "drive_id": "lead-voltage",
                  "outer_electrode_potential_drop_v": 0.1,
                  "lead_mesh": {
                    "mesh_name": "lead",
                    "nodes": [
                      [
                        0.0,
                        0.0,
                        0.0
                      ],
                      [
                        1.0,
                        0.0,
                        0.0
                      ],
                      [
                        0.0,
                        1.0,
                        0.0
                      ],
                      [
                        0.0,
                        0.0,
                        1.0
                      ]
                    ],
                    "cells": {
                      "types": [
                        "tet4"
                      ],
                      "offsets": [
                        0,
                        4
                      ],
                      "nodes": [
                        0,
                        1,
                        2,
                        3
                      ],
                      "global_ordinals": [
                        0
                      ]
                    },
                    "element_markers": [
                      1
                    ],
                    "facets": {
                      "types": [
                        "tri3",
                        "tri3",
                        "tri3",
                        "tri3"
                      ],
                      "roles": [
                        "closure_interface",
                        "exterior",
                        "exterior",
                        "exterior"
                      ],
                      "offsets": [
                        0,
                        3,
                        6,
                        9,
                        12
                      ],
                      "nodes": [
                        0,
                        1,
                        2,
                        0,
                        1,
                        3,
                        0,
                        2,
                        3,
                        1,
                        2,
                        3
                      ],
                      "global_ordinals": [
                        0,
                        1,
                        2,
                        3
                      ]
                    },
                    "boundary_markers": [
                      10,
                      11,
                      12,
                      13
                    ]
                  },
                  "lead_conductivity_spm_per_element": [
                    58000000.0
                  ],
                  "lead_stable_vertex_ids": [
                    101,
                    102,
                    103,
                    104
                  ],
                  "interface_pairs": [
                    [
                      [
                        1,
                        2,
                        3
                      ],
                      [
                        101,
                        102,
                        103
                      ]
                    ]
                  ],
                  "minus_outer_electrode_face_vertex_ids": [
                    [
                      101,
                      102,
                      104
                    ]
                  ],
                  "plus_outer_electrode_face_vertex_ids": [
                    [
                      101,
                      103,
                      104
                    ]
                  ],
                  "lead_conductivity_digest": "lead-sigma-r1"
                },
                "algebraic_relative_tolerance": 1e-10,
                "physical_relative_gate": 1e-08,
                "physical_absolute_gate_a": 1e-12,
                "reference_mpi_gather_broadcast": false
              }
            }
          ],
          "field_drives": [],
          "planar_monitors": [],
          "excitation_analysis": null,
          "study": {
            "kind": "time_evolution",
            "dynamics": {
              "kind": "llg",
              "gyromagnetic_ratio": 221100.0,
              "integrator": "auto",
              "fixed_timestep": null
            },
            "sampling": {
              "outputs": []
            }
          },
          "discretization": {
            "fdm": null,
            "fem": {
              "order": 1,
              "hmax": 5.6858023018340375e-09,
              "mesh": null
            },
            "hybrid": null
          },
          "mesh_workflow": null,
          "spin_torque": null,
          "spin_torque_modules": [],
          "temperature": null
        },
        "study_pipeline": {
          "version": "study_pipeline.v1",
          "nodes": [
            {
              "id": "oersted_run",
              "label": "",
              "enabled": true,
              "source": "script_imported",
              "node_kind": "primitive",
              "stage_kind": "run",
              "payload": {
                "kind": "run",
                "entrypoint_kind": "flat_run",
                "stage_id": "oersted_run",
                "until_seconds": "1e-15"
              }
            }
          ]
        }
      },
      "script_sync": {
        "schema_version": "script_sync.v1",
        "source_kind": "flat_script",
        "entrypoint_kind": "flat_workspace",
        "source_of_truth": "model_builder",
        "rewrite_strategy": "canonical_rewrite",
        "editable_scopes": [
          "runtime",
          "geometry",
          "materials",
          "energies",
          "study",
          "outputs",
          "current_transport",
          "spin_transport",
          "meshing",
          "oersted"
        ],
        "phase": "round_trip_canonical_sync",
        "study_pipeline_version": "study_pipeline.v1",
        "study_pipeline_node_count": 1
      }
    },
    "backend_revision": null,
    "seeds": []
  },
  "geometry": {
    "entries": [
      {
        "name": "device_geom",
        "kind": "box",
        "size": [
          1.0,
          1.0,
          1.0
        ]
      }
    ]
  },
  "geometry_assets": null,
  "regions": [
    {
      "name": "device",
      "geometry": "device_geom"
    }
  ],
  "object_regions": [],
  "materials": [
    {
      "name": "mat_device",
      "saturation_magnetisation": 800000.0,
      "exchange_stiffness": 1.3e-11,
      "damping": 0.02,
      "uniaxial_anisotropy": null,
      "uniaxial_anisotropy_k2": null,
      "anisotropy_axis": null,
      "cubic_anisotropy_kc1": null,
      "cubic_anisotropy_kc2": null,
      "cubic_anisotropy_kc3": null,
      "cubic_anisotropy_axis1": null,
      "cubic_anisotropy_axis2": null,
      "interfacial_dmi": null,
      "bulk_dmi": null,
      "ms_field": null,
      "a_field": null,
      "alpha_field": null,
      "ku_field": null,
      "ku2_field": null,
      "kc1_field": null,
      "kc2_field": null,
      "kc3_field": null,
      "dind_field": null,
      "dbulk_field": null
    }
  ],
  "material_parameter_fields": [],
  "couplings": [],
  "planar_monitors": [],
  "field_drives": [],
  "magnets": [
    {
      "name": "device",
      "region": "device",
      "material": "mat_device",
      "initial_magnetization": {
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "preset_params": {
          "direction": [
            0.0,
            0.0,
            1.0
          ]
        },
        "mapping": {
          "space": "object",
          "projection": "object_local",
          "clamp_mode": "none"
        },
        "texture_transform": {
          "translation": [
            0.0,
            0.0,
            0.0
          ],
          "rotation_quat": [
            0.0,
            0.0,
            0.0,
            1.0
          ],
          "scale": [
            1.0,
            1.0,
            1.0
          ],
          "pivot": [
            0.0,
            0.0,
            0.0
          ]
        },
        "ui_label": null,
        "preview_proxy": "none"
      },
      "mesh_recipe": null,
      "absorbing_boundary": null
    }
  ],
  "energy_terms": [
    {
      "kind": "exchange"
    },
    {
      "kind": "demag",
      "realization": "auto"
    },
    {
      "kind": "oersted_field",
      "id": "oersted:drive",
      "model": "from_current_solution",
      "source": "drive"
    }
  ],
  "current_modules": [
    {
      "kind": "current_transport",
      "name": "drive",
      "model": "ohmic_poisson",
      "coupling": "one_way",
      "domain": [
        {
          "object_id": "device"
        }
      ],
      "materials": [
        {
          "region": {
            "object_id": "device"
          },
          "material": {
            "sigma_Spm": 1.0
          }
        }
      ],
      "boundaries": [
        {
          "kind": "insulating",
          "id": "outer",
          "surfaces": [
            {
              "object_id": "device",
              "surface_id": "outer",
              "orientation": [
                1.0,
                0.0,
                0.0
              ]
            }
          ]
        }
      ],
      "gauge": "zero_mean",
      "solver": {
        "engine": "cg",
        "linear": {
          "relative_tolerance": 1e-10,
          "absolute_tolerance": 0.0,
          "max_iterations": 10000
        },
        "physical_residual_version": "charge_balance_integrated_l2.v1",
        "operator_version": "fv_charge_harmonic_v1"
      },
      "conservative_current_view": {
        "stable_vertex_ids": [
          1,
          2,
          3,
          4
        ],
        "boundary_faces": [
          {
            "face_vertex_ids": [
              1,
              2,
              3
            ],
            "role": "closure_interface",
            "circuit_id": "lead-interface"
          },
          {
            "face_vertex_ids": [
              1,
              2,
              4
            ],
            "role": "insulating_outer"
          },
          {
            "face_vertex_ids": [
              1,
              3,
              4
            ],
            "role": "insulating_outer"
          },
          {
            "face_vertex_ids": [
              2,
              3,
              4
            ],
            "role": "insulating_outer"
          }
        ],
        "identity": {
          "source_module_id": "drive",
          "source_state_revision": "state-r1",
          "source_field_digest": "field-r1",
          "conductivity_digest": "device-sigma-r1",
          "mesh_revision": "mesh-r1",
          "topology_revision": "topology-r1",
          "geometry_digest": "geometry-r1",
          "envelope_revision": "envelope-r1",
          "envelope_digest": "envelope-digest-r1",
          "evaluated_envelope_multiplier": 1.0,
          "evaluation_time_s": 0.0,
          "stage_identity": 1
        },
        "pins": {
          "required_source_state_revision": "state-r1",
          "required_source_field_digest": "field-r1",
          "required_mesh_revision": "mesh-r1",
          "required_topology_revision": "topology-r1"
        },
        "closure": {
          "kind": "external_lead",
          "operator_version": "fem_closed_current_extension.v1",
          "revision": "lead-r1",
          "digest": "lead-digest-r1",
          "drive_id": "lead-voltage",
          "outer_electrode_potential_drop_v": 0.1,
          "lead_mesh": {
            "mesh_name": "lead",
            "nodes": [
              [
                0.0,
                0.0,
                0.0
              ],
              [
                1.0,
                0.0,
                0.0
              ],
              [
                0.0,
                1.0,
                0.0
              ],
              [
                0.0,
                0.0,
                1.0
              ]
            ],
            "cells": {
              "types": [
                "tet4"
              ],
              "offsets": [
                0,
                4
              ],
              "nodes": [
                0,
                1,
                2,
                3
              ],
              "global_ordinals": [
                0
              ]
            },
            "element_markers": [
              1
            ],
            "facets": {
              "types": [
                "tri3",
                "tri3",
                "tri3",
                "tri3"
              ],
              "roles": [
                "closure_interface",
                "exterior",
                "exterior",
                "exterior"
              ],
              "offsets": [
                0,
                3,
                6,
                9,
                12
              ],
              "nodes": [
                0,
                1,
                2,
                0,
                1,
                3,
                0,
                2,
                3,
                1,
                2,
                3
              ],
              "global_ordinals": [
                0,
                1,
                2,
                3
              ]
            },
            "boundary_markers": [
              10,
              11,
              12,
              13
            ]
          },
          "lead_conductivity_spm_per_element": [
            58000000.0
          ],
          "lead_stable_vertex_ids": [
            101,
            102,
            103,
            104
          ],
          "interface_pairs": [
            [
              [
                1,
                2,
                3
              ],
              [
                101,
                102,
                103
              ]
            ]
          ],
          "minus_outer_electrode_face_vertex_ids": [
            [
              101,
              102,
              104
            ]
          ],
          "plus_outer_electrode_face_vertex_ids": [
            [
              101,
              103,
              104
            ]
          ],
          "lead_conductivity_digest": "lead-sigma-r1"
        },
        "algebraic_relative_tolerance": 1e-10,
        "physical_relative_gate": 1e-08,
        "physical_absolute_gate_a": 1e-12,
        "reference_mpi_gather_broadcast": false
      }
    }
  ],
  "spin_transport_modules": [
    {
      "schema_version": "spin_transport.v1",
      "id": "spin",
      "current_source_id": "drive",
      "domain": [
        {
          "object_id": "device"
        }
      ],
      "mode": "steady",
      "materials": [
        {
          "region": {
            "object_id": "device"
          },
          "material": {
            "sigma_s_Spm": 1.0,
            "polarization_p": 0.0,
            "theta_sh": 0.0,
            "lambda_sf_m": 1.0,
            "lambda_j_m": "disabled",
            "lambda_phi_m": "disabled"
          }
        }
      ],
      "interfaces": [],
      "boundaries": [],
      "solver": {
        "engine": "auto",
        "linear": {
          "relative_tolerance": 1e-08,
          "absolute_tolerance": 0.0,
          "max_iterations": 500
        },
        "physical_residual_version": "transport_balance_integrated_l2.v1",
        "operator_version": "fv_spin_upwind_v1",
        "default_external_boundary": "spin_insulating"
      },
      "requested_execution": {
        "discretization": "fem",
        "device": "cpu",
        "precision": "double",
        "execution_mode": "strict"
      },
      "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
    }
  ],
  "physics_graph": {
    "schema_version": "physics_graph.v1",
    "scene_revision": 0,
    "modules": [
      {
        "id": "drive",
        "kind": "current_transport",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "device"
          }
        ],
        "solve_domain": [
          {
            "object_id": "device"
          }
        ],
        "depends_on": [],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/current_modules/0",
        "family_payload": {
          "kind": "current_transport",
          "name": "drive",
          "model": "ohmic_poisson",
          "coupling": "one_way",
          "domain": [
            {
              "object_id": "device"
            }
          ],
          "materials": [
            {
              "region": {
                "object_id": "device"
              },
              "material": {
                "sigma_Spm": 1.0
              }
            }
          ],
          "boundaries": [
            {
              "kind": "insulating",
              "id": "outer",
              "surfaces": [
                {
                  "object_id": "device",
                  "surface_id": "outer",
                  "orientation": [
                    1.0,
                    0.0,
                    0.0
                  ]
                }
              ]
            }
          ],
          "gauge": "zero_mean",
          "solver": {
            "engine": "cg",
            "linear": {
              "relative_tolerance": 1e-10,
              "absolute_tolerance": 0.0,
              "max_iterations": 10000
            },
            "physical_residual_version": "charge_balance_integrated_l2.v1",
            "operator_version": "fv_charge_harmonic_v1"
          },
          "conservative_current_view": {
            "stable_vertex_ids": [
              1,
              2,
              3,
              4
            ],
            "boundary_faces": [
              {
                "face_vertex_ids": [
                  1,
                  2,
                  3
                ],
                "role": "closure_interface",
                "circuit_id": "lead-interface"
              },
              {
                "face_vertex_ids": [
                  1,
                  2,
                  4
                ],
                "role": "insulating_outer"
              },
              {
                "face_vertex_ids": [
                  1,
                  3,
                  4
                ],
                "role": "insulating_outer"
              },
              {
                "face_vertex_ids": [
                  2,
                  3,
                  4
                ],
                "role": "insulating_outer"
              }
            ],
            "identity": {
              "source_module_id": "drive",
              "source_state_revision": "state-r1",
              "source_field_digest": "field-r1",
              "conductivity_digest": "device-sigma-r1",
              "mesh_revision": "mesh-r1",
              "topology_revision": "topology-r1",
              "geometry_digest": "geometry-r1",
              "envelope_revision": "envelope-r1",
              "envelope_digest": "envelope-digest-r1",
              "evaluated_envelope_multiplier": 1.0,
              "evaluation_time_s": 0.0,
              "stage_identity": 1
            },
            "pins": {
              "required_source_state_revision": "state-r1",
              "required_source_field_digest": "field-r1",
              "required_mesh_revision": "mesh-r1",
              "required_topology_revision": "topology-r1"
            },
            "closure": {
              "kind": "external_lead",
              "operator_version": "fem_closed_current_extension.v1",
              "revision": "lead-r1",
              "digest": "lead-digest-r1",
              "drive_id": "lead-voltage",
              "outer_electrode_potential_drop_v": 0.1,
              "lead_mesh": {
                "mesh_name": "lead",
                "nodes": [
                  [
                    0.0,
                    0.0,
                    0.0
                  ],
                  [
                    1.0,
                    0.0,
                    0.0
                  ],
                  [
                    0.0,
                    1.0,
                    0.0
                  ],
                  [
                    0.0,
                    0.0,
                    1.0
                  ]
                ],
                "cells": {
                  "types": [
                    "tet4"
                  ],
                  "offsets": [
                    0,
                    4
                  ],
                  "nodes": [
                    0,
                    1,
                    2,
                    3
                  ],
                  "global_ordinals": [
                    0
                  ]
                },
                "element_markers": [
                  1
                ],
                "facets": {
                  "types": [
                    "tri3",
                    "tri3",
                    "tri3",
                    "tri3"
                  ],
                  "roles": [
                    "closure_interface",
                    "exterior",
                    "exterior",
                    "exterior"
                  ],
                  "offsets": [
                    0,
                    3,
                    6,
                    9,
                    12
                  ],
                  "nodes": [
                    0,
                    1,
                    2,
                    0,
                    1,
                    3,
                    0,
                    2,
                    3,
                    1,
                    2,
                    3
                  ],
                  "global_ordinals": [
                    0,
                    1,
                    2,
                    3
                  ]
                },
                "boundary_markers": [
                  10,
                  11,
                  12,
                  13
                ]
              },
              "lead_conductivity_spm_per_element": [
                58000000.0
              ],
              "lead_stable_vertex_ids": [
                101,
                102,
                103,
                104
              ],
              "interface_pairs": [
                [
                  [
                    1,
                    2,
                    3
                  ],
                  [
                    101,
                    102,
                    103
                  ]
                ]
              ],
              "minus_outer_electrode_face_vertex_ids": [
                [
                  101,
                  102,
                  104
                ]
              ],
              "plus_outer_electrode_face_vertex_ids": [
                [
                  101,
                  103,
                  104
                ]
              ],
              "lead_conductivity_digest": "lead-sigma-r1"
            },
            "algebraic_relative_tolerance": 1e-10,
            "physical_relative_gate": 1e-08,
            "physical_absolute_gate_a": 1e-12,
            "reference_mpi_gather_broadcast": false
          }
        }
      },
      {
        "id": "spin",
        "kind": "spin_transport",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "device"
          }
        ],
        "solve_domain": [
          {
            "object_id": "device"
          }
        ],
        "depends_on": [
          "drive"
        ],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/spin_transports/0",
        "family_payload": {
          "schema_version": "spin_transport.v1",
          "id": "spin",
          "current_source_id": "drive",
          "domain": [
            {
              "object_id": "device"
            }
          ],
          "mode": "steady",
          "materials": [
            {
              "region": {
                "object_id": "device"
              },
              "material": {
                "sigma_s_Spm": 1.0,
                "polarization_p": 0.0,
                "theta_sh": 0.0,
                "lambda_sf_m": 1.0,
                "lambda_j_m": "disabled",
                "lambda_phi_m": "disabled"
              }
            }
          ],
          "interfaces": [],
          "boundaries": [],
          "solver": {
            "engine": "auto",
            "linear": {
              "relative_tolerance": 1e-08,
              "absolute_tolerance": 0.0,
              "max_iterations": 500
            },
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "operator_version": "fv_spin_upwind_v1",
            "default_external_boundary": "spin_insulating"
          },
          "requested_execution": {
            "discretization": "fem",
            "device": "cpu",
            "precision": "double",
            "execution_mode": "strict"
          },
          "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
        }
      },
      {
        "id": "oersted:drive",
        "kind": "oersted_field",
        "applies_to": [
          {
            "kind": "global"
          }
        ],
        "solve_domain": [],
        "depends_on": [
          "drive"
        ],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/energy/2",
        "family_payload": {
          "kind": "oersted_field",
          "id": "oersted:drive",
          "model": "from_current_solution",
          "source": "drive"
        }
      }
    ],
    "edges": [
      {
        "kind": "current_to_oersted",
        "source_id": "drive",
        "target_id": "oersted:drive",
        "status": "active"
      },
      {
        "kind": "current_to_spin_transport",
        "source_id": "drive",
        "target_id": "spin",
        "status": "active"
      }
    ]
  },
  "excitation_analysis": null,
  "study": {
    "kind": "time_evolution",
    "dynamics": {
      "kind": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "auto",
      "fixed_timestep": null
    },
    "sampling": {
      "outputs": []
    }
  },
  "backend_policy": {
    "requested_backend": "fem",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": null,
      "fem": {
        "order": 1,
        "hmax": 5.6858023018340375e-09,
        "mesh": null
      },
      "hybrid": null
    }
  },
  "validation_profile": {
    "execution_mode": "strict"
  },
  "elastic_materials": [],
  "elastic_bodies": [],
  "magnetostriction_laws": [],
  "mechanical_bcs": [],
  "mechanical_loads": []
}
```

A publication validator compares the displayed JSON with a fresh complete
no-asset serialization.
`test_external_lead_round_trips_through_script_and_scene_document` separately
exercises Python -> ProblemIR -> canonical Python -> reloaded ProblemIR semantics.
The current-view identity and closure remain authored intent; accepted RT0 and
OE-F1/OE-F2 observations remain resolved provenance.

### Parameter reference

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `OerstedField.source` | `str` | required | $1$ | non-empty and names one `CurrentTransport` | solved-current source binding | planner-scoped; canonical OE-F1/OE-F2 are FEM CPU bounded slices | `energy_terms[].source` |
| `OerstedField.model` | `from_current_solution` | `from_current_solution` | $1$ | no alternate canonical model accepted | solved-source semantic identity | FDM/FEM authoring; realization is planner-scoped | `energy_terms[].model` |
| `OerstedField.id` | `str or None` | `oersted:{source}` | $1$ | non-empty after normalization | stable energy-term identity | all authoring lanes | `energy_terms[].id` |
| `CurrentTransport.model` | `prescribed_density or ohmic_poisson` | `prescribed_density` | $1$ | solved-current FEM requires `ohmic_poisson` | charge-source model | bounded FEM CPU solved-current slice | `current_modules[].model` |
| `CurrentTransport.coupling` | `one_way or bidirectional` | `one_way` | $1$ | closure-aware RT0 external lead currently requires one-way | source coupling | FEM CPU one-way bounded; reciprocal closure-aware RT0 fails closed | `current_modules[].coupling` |
| `CurrentTransport.time_envelope` | `TimeEnvelope or None` | `None` | $1$ | canonical finite envelope; unresolved tabulated artifact fails closed | exact-stage source multiplier | bounded CPU callback for supported non-tabulated envelopes | `current_modules[].time_envelope` |
| `CurrentTransport.conservative_current_view` | `ConservativeCurrentView or None` | `None` | $1$ | one-way Ohmic FEM, complete stable IDs, faces, pins, closure, and positive gates | immutable RT0/H(div) source request | FEM CPU bounded; no GPU or reciprocal closure lane | `current_modules[].conservative_current_view` |
| `ConservativeCurrentClosedGeometry.operator_version` | `str` | required | $1$ | exactly `fem_closed_current_geometry.v1` | closed-geometry operator identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.operator_version` |
| `ConservativeCurrentClosedGeometry.revision` | `str` | required | $1$ | non-empty | closed-geometry revision | FEM CPU bounded | `current_modules[].conservative_current_view.closure.revision` |
| `ConservativeCurrentClosedGeometry.digest` | `str` | required | $1$ | non-empty and provenance-matched | closed-geometry identity digest | FEM CPU bounded | `current_modules[].conservative_current_view.closure.digest` |
| `ConservativeCurrentClosedGeometry.source_cuts` | `Sequence[ConservativeCurrentSourceCut]` | required | $1$ | non-empty typed sequence | periodic source-cut definitions | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts` |
| `ConservativeCurrentSourceCut.id` | `str` | required | $1$ | non-empty | source-cut circuit identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].id` |
| `ConservativeCurrentSourceCut.translation_m` | `Sequence[float]` | required | $\mathrm{m}$ | finite nonzero three-vector | periodic translation vector | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].translation_m` |
| `ConservativeCurrentSourceCut.potential_drop_v` | `float` | required | $\mathrm{V}$ | finite and signed; zero is permitted | signed periodic potential drop | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].potential_drop_v` |
| `ConservativeCurrentSourceCut.face_pairs` | `Sequence[ConservativeCurrentSourceCutFacePair]` | required | $1$ | non-empty typed sequence | minus/plus periodic face pairing | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].face_pairs` |
| `ConservativeCurrentSourceCutFacePair.minus_face_vertex_ids` | `Sequence[int]` | required | $1$ | exactly three distinct positive ids, canonicalized | minus-side source-cut face | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].face_pairs[].minus_face_vertex_ids` |
| `ConservativeCurrentSourceCutFacePair.plus_face_vertex_ids` | `Sequence[int]` | required | $1$ | exactly three distinct positive ids, canonicalized and different from minus | plus-side source-cut face | FEM CPU bounded | `current_modules[].conservative_current_view.closure.source_cuts[].face_pairs[].plus_face_vertex_ids` |
| `ConservativeCurrentExternalLead.operator_version` | `str` | required | $1$ | exactly `fem_closed_current_extension.v1` | closure operator identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.operator_version` |
| `ConservativeCurrentExternalLead.revision` | `str` | required | $1$ | non-empty | lead closure revision | FEM CPU bounded | `current_modules[].conservative_current_view.closure.revision` |
| `ConservativeCurrentExternalLead.digest` | `str` | required | $1$ | non-empty and matched by runtime provenance | lead geometry/closure digest | FEM CPU bounded | `current_modules[].conservative_current_view.closure.digest` |
| `ConservativeCurrentExternalLead.drive_id` | `str` | required | $1$ | non-empty | external voltage-drive identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.drive_id` |
| `ConservativeCurrentExternalLead.outer_electrode_potential_drop_v` | `float` | required | $\mathrm{V}$ | finite and nonzero | signed outer-electrode drop | FEM CPU bounded | `current_modules[].conservative_current_view.closure.outer_electrode_potential_drop_v` |
| `ConservativeCurrentExternalLead.lead_mesh` | `MeshIR-compatible object` | required | $\mathrm{m}$ for nodes | non-empty affine tet4 mesh with tri3 boundary | volumetric lead geometry | FEM CPU bounded | `current_modules[].conservative_current_view.closure.lead_mesh` |
| `ConservativeCurrentExternalLead.lead_conductivity_spm_per_element` | `Sequence[float]` | required | $\mathrm{S\,m^{-1}}$ | one finite positive value per lead tet4 | lead material conductivity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.lead_conductivity_spm_per_element` |
| `ConservativeCurrentExternalLead.lead_stable_vertex_ids` | `Sequence[int]` | required | $1$ | one unique positive id per lead node | numbering-independent lead identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.lead_stable_vertex_ids` |
| `ConservativeCurrentExternalLead.interface_pairs` | `Sequence[ConservativeCurrentLeadInterfacePair]` | required | $1$ | non-empty, unique, canonical tri3 face pairs | conservative device--lead trace pairing | FEM CPU bounded | `current_modules[].conservative_current_view.closure.interface_pairs` |
| `ConservativeCurrentExternalLead.minus_outer_electrode_face_vertex_ids` | `Sequence[tri3 ids]` | required | $1$ | non-empty canonical lead boundary faces | negative-side outer electrode | FEM CPU bounded | `current_modules[].conservative_current_view.closure.minus_outer_electrode_face_vertex_ids` |
| `ConservativeCurrentExternalLead.plus_outer_electrode_face_vertex_ids` | `Sequence[tri3 ids]` | required | $1$ | non-empty, disjoint canonical lead boundary faces | positive-side outer electrode | FEM CPU bounded | `current_modules[].conservative_current_view.closure.plus_outer_electrode_face_vertex_ids` |
| `ConservativeCurrentExternalLead.lead_conductivity_digest` | `str` | required | $1$ | non-empty and provenance-matched | conductivity-field identity | FEM CPU bounded | `current_modules[].conservative_current_view.closure.lead_conductivity_digest` |
| `ConservativeCurrentLeadInterfacePair.transport_face_vertex_ids` | `Sequence[int]` | required | $1$ | three distinct positive canonical device ids | device-side interface face | FEM CPU bounded | `current_modules[].conservative_current_view.closure.interface_pairs[][0]` |
| `ConservativeCurrentLeadInterfacePair.lead_face_vertex_ids` | `Sequence[int]` | required | $1$ | three distinct positive canonical lead ids | lead-side interface face | FEM CPU bounded | `current_modules[].conservative_current_view.closure.interface_pairs[][1]` |

The remaining rows complete the charge solve, immutable view, identity, pins,
and boundary-face records instantiated by the example.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | required | $1$ | non-empty and unique | current-module identity | all authoring lanes | `current_modules[].name` |
| `CurrentTransport.domain` | `Sequence[RegionRef]` | `()` | $1$ | non-empty for solved current | conducting domain | bounded FEM CPU | `current_modules[].domain` |
| `CurrentTransport.materials` | `Sequence[ChargeTransportMaterialAssignment]` | `()` | $1$ | complete typed region coverage | conductivity assignments | bounded FEM CPU | `current_modules[].materials` |
| `CurrentTransport.boundaries` | `Sequence[ChargeBoundary]` | `()` | $1$ | typed, non-overlapping surface ownership | charge boundary set | bounded FEM CPU | `current_modules[].boundaries` |
| `CurrentTransport.gauge` | `ChargePotentialGauge or None` | `None` | $1$ | mandatory and compatible with closure | potential gauge | bounded FEM CPU | `current_modules[].gauge` |
| `CurrentTransport.solver` | `ChargeSolverPolicy or None` | `None` | $1$ | engine/operator/residual versions must agree | current solver policy | bounded FEM CPU | `current_modules[].solver` |
| `ChargeTransportMaterialAssignment.region` | `RegionRef` | required | $1$ | resolvable conducting region | assignment target | bounded FEM CPU | `current_modules[].materials[].region` |
| `ChargeTransportMaterialAssignment.material` | `ChargeTransportMaterial` | required | $1$ | typed material | assigned conductivity | bounded FEM CPU | `current_modules[].materials[].material` |
| `ChargeTransportMaterial.sigma_Spm` | `float` | required | $\mathrm{S\,m^{-1}}$ | finite and positive | scalar charge conductivity | bounded FEM CPU | `current_modules[].materials[].material.sigma_Spm` |
| `ChargeInsulating.id` | `str` | required | $1$ | non-empty and unique | insulating-boundary identity | bounded FEM CPU | `current_modules[].boundaries[].id` |
| `ChargeInsulating.surfaces` | `Sequence[SurfaceRef]` | required | $1$ | non-empty typed surfaces | zero-normal-current support | bounded FEM CPU | `current_modules[].boundaries[].surfaces` |
| `ChargePotentialGauge.kind` | `str` | required | $1$ | `dirichlet_reference` or `zero_mean` | charge-potential null-space policy | bounded FEM CPU | `current_modules[].gauge` |
| `ChargeSolverPolicy.engine` | `str` | `cg` | $1$ | `cg` or `block_gmres`; must match operator | linear engine | bounded FEM CPU | `current_modules[].solver.engine` |
| `ChargeSolverPolicy.relative_tolerance` | `float` | `1e-10` | $1$ | finite and positive | relative tolerance | bounded FEM CPU | `current_modules[].solver.linear.relative_tolerance` |
| `ChargeSolverPolicy.absolute_tolerance` | `float` | `0.0` | $1$ | finite and non-negative | absolute tolerance | bounded FEM CPU | `current_modules[].solver.linear.absolute_tolerance` |
| `ChargeSolverPolicy.max_iterations` | `int` | `10000` | $1$ | positive integer | iteration cap | bounded FEM CPU | `current_modules[].solver.linear.max_iterations` |
| `ChargeSolverPolicy.physical_residual_version` | `str` | `charge_balance_integrated_l2.v1` | $1$ | exact supported charge-balance version | physical residual contract | bounded FEM CPU | `current_modules[].solver.physical_residual_version` |
| `ChargeSolverPolicy.operator_version` | `str` | `fv_charge_harmonic_v1` | $1$ | exact lane-compatible version | current operator | bounded FEM CPU | `current_modules[].solver.operator_version` |
| `ConservativeCurrentView.stable_vertex_ids` | `Sequence[int]` | required | $1$ | non-empty unique positive ids | numbering-independent device vertices | bounded FEM CPU | `current_modules[].conservative_current_view.stable_vertex_ids` |
| `ConservativeCurrentView.boundary_faces` | `Sequence[ConservativeCurrentBoundaryFace]` | required | $1$ | non-empty complete canonical face classification | closure/outer-face ownership | bounded FEM CPU | `current_modules[].conservative_current_view.boundary_faces` |
| `ConservativeCurrentView.identity` | `ConservativeCurrentIdentity` | required | $1$ | typed immutable identity | accepted source identity | bounded FEM CPU | `current_modules[].conservative_current_view.identity` |
| `ConservativeCurrentView.pins` | `ConservativeCurrentPins` | required | $1$ | typed required revisions/digests | preflight pins | bounded FEM CPU | `current_modules[].conservative_current_view.pins` |
| `ConservativeCurrentView.closure` | `ConservativeCurrentClosedGeometry or ConservativeCurrentExternalLead` | required | $1$ | typed complete circuit closure | closure realization | bounded FEM CPU | `current_modules[].conservative_current_view.closure` |
| `ConservativeCurrentView.algebraic_relative_tolerance` | `float` | required | $1$ | finite and positive | algebraic RT0 acceptance tolerance | bounded FEM CPU | `current_modules[].conservative_current_view.algebraic_relative_tolerance` |
| `ConservativeCurrentView.physical_relative_gate` | `float` | required | $1$ | finite and positive | relative physical-balance gate | bounded FEM CPU | `current_modules[].conservative_current_view.physical_relative_gate` |
| `ConservativeCurrentView.physical_absolute_gate_a` | `float` | required | $\mathrm{A}$ | finite and positive | absolute current-balance gate | bounded FEM CPU | `current_modules[].conservative_current_view.physical_absolute_gate_a` |
| `ConservativeCurrentView.reference_mpi_gather_broadcast` | `bool` | `False` | $1$ | boolean | bounded reference MPI assembly switch | bounded FEM CPU only | `current_modules[].conservative_current_view.reference_mpi_gather_broadcast` |
| `ConservativeCurrentIdentity.source_module_id` | `str` | required | $1$ | non-empty | accepted current module | bounded FEM CPU | `current_modules[].conservative_current_view.identity.source_module_id` |
| `ConservativeCurrentIdentity.source_state_revision` | `str` | required | $1$ | non-empty | accepted state revision | bounded FEM CPU | `current_modules[].conservative_current_view.identity.source_state_revision` |
| `ConservativeCurrentIdentity.source_field_digest` | `str` | required | $1$ | non-empty | accepted current-field digest | bounded FEM CPU | `current_modules[].conservative_current_view.identity.source_field_digest` |
| `ConservativeCurrentIdentity.conductivity_digest` | `str` | required | $1$ | non-empty | accepted conductivity digest | bounded FEM CPU | `current_modules[].conservative_current_view.identity.conductivity_digest` |
| `ConservativeCurrentIdentity.mesh_revision` | `str` | required | $1$ | non-empty | accepted mesh revision | bounded FEM CPU | `current_modules[].conservative_current_view.identity.mesh_revision` |
| `ConservativeCurrentIdentity.topology_revision` | `str` | required | $1$ | non-empty | accepted topology revision | bounded FEM CPU | `current_modules[].conservative_current_view.identity.topology_revision` |
| `ConservativeCurrentIdentity.geometry_digest` | `str` | required | $1$ | non-empty | accepted geometry digest | bounded FEM CPU | `current_modules[].conservative_current_view.identity.geometry_digest` |
| `ConservativeCurrentIdentity.envelope_revision` | `str` | required | $1$ | non-empty | envelope revision | bounded FEM CPU | `current_modules[].conservative_current_view.identity.envelope_revision` |
| `ConservativeCurrentIdentity.envelope_digest` | `str` | required | $1$ | non-empty | envelope digest | bounded FEM CPU | `current_modules[].conservative_current_view.identity.envelope_digest` |
| `ConservativeCurrentIdentity.evaluated_envelope_multiplier` | `float` | required | $1$ | finite and signed | evaluated source multiplier | bounded FEM CPU | `current_modules[].conservative_current_view.identity.evaluated_envelope_multiplier` |
| `ConservativeCurrentIdentity.evaluation_time_s` | `float` | required | $\mathrm{s}$ | finite | source observation time | bounded FEM CPU | `current_modules[].conservative_current_view.identity.evaluation_time_s` |
| `ConservativeCurrentIdentity.stage_identity` | `int` | required | $1$ | positive integer | accepted stage identity | bounded FEM CPU | `current_modules[].conservative_current_view.identity.stage_identity` |
| `ConservativeCurrentPins.required_source_state_revision` | `str` | required | $1$ | non-empty | required state revision | bounded FEM CPU | `current_modules[].conservative_current_view.pins.required_source_state_revision` |
| `ConservativeCurrentPins.required_source_field_digest` | `str` | required | $1$ | non-empty | required field digest | bounded FEM CPU | `current_modules[].conservative_current_view.pins.required_source_field_digest` |
| `ConservativeCurrentPins.required_mesh_revision` | `str` | required | $1$ | non-empty | required mesh revision | bounded FEM CPU | `current_modules[].conservative_current_view.pins.required_mesh_revision` |
| `ConservativeCurrentPins.required_topology_revision` | `str` | required | $1$ | non-empty | required topology revision | bounded FEM CPU | `current_modules[].conservative_current_view.pins.required_topology_revision` |
| `ConservativeCurrentBoundaryFace.face_vertex_ids` | `Sequence[int]` | required | $1$ | exactly three distinct positive ids, canonicalized | device boundary face | bounded FEM CPU | `current_modules[].conservative_current_view.boundary_faces[].face_vertex_ids` |
| `ConservativeCurrentBoundaryFace.role` | `str` | required | $1$ | `insulating_outer`, `source_cut`, or `closure_interface` | boundary role | bounded FEM CPU | `current_modules[].conservative_current_view.boundary_faces[].role` |
| `ConservativeCurrentBoundaryFace.circuit_id` | `str or None` | `None` | $1$ | required except for insulating outer faces | closure circuit identity | bounded FEM CPU | `current_modules[].conservative_current_view.boundary_faces[].circuit_id` |

(oersted-problem-ir)=
## ProblemIR and normalization

`OerstedField.to_ir()` stores only the requested source binding, model, and
stable id. `CurrentTransport.to_ir()` stores the one-way Ohmic definition and
the complete `conservative_current_view`, including the typed external-lead
closure. The planner verifies those authored records against the realized FEM
mesh and produces a separate resolved current/Oersted descriptor.

Canonical RT0 face records and balance-certificate bytes remain data-plane
artifacts, not hand-shaped JSON. Their digests, source/mesh/topology/closure/
envelope revisions, evaluation time, and stage identity are resolved runtime
provenance.

(oersted-round-trip-and-failure-semantics)=
## Requested intent, resolved execution, and failures

The **requested intent** preserves current module, coupling, envelope,
conservative-view pins, external-lead mesh/conductivity/face pairs/electrodes,
Oersted source id, and requested lane. The **resolved execution** separately
records RT0 operator and view digest, closure revision, stage callback policy,
OE-F1 or OE-F2 realization, projection/gauge profile, actual lane, and
accepted source observation.

**Validation errors** reject incomplete faces, repeated/zero stable ids,
mismatched pins or digests, missing/nonzero closure balance, unsupported
geometry, reciprocal closure-aware RT0, missing spin solve for a solved current,
or unavailable device execution. **Unsupported combinations** never fall back
to a nodal H1 current, analytic wire, open bar, CPU, or different Oersted
method without an explicit resolved record.

(oersted-discrete-realization)=
## Discrete realization

### FDM CPU and GPU

OE-F1 and OE-F2 are not FDM operators. The canonical FDM target is the
separate cell-integrated open-boundary FFT realization; it remains
`semantic_only`. Legacy analytic-cylinder/midpoint paths do not satisfy the
canonical solved-current closure or FFT contract.

### FEM CPU: OE-T0 and external lead

The current workflow constructs one immutable RT0 view by a constrained
conservative reconstruction. `ConservativeCurrentExternalLead` joins the
device and volumetric lead in one coupled solve, so lead impedance changes the
device current. Bounded managed adapter and stage-callback fixtures exercise
this path, but full public end-to-end runtime and convergence qualification are
open.

### FEM CPU: OE-F1

The append-only OE-F1 ABI evaluates cutoff-free direct tetrahedral quadrature
on the exact immutable RT0 view. Near/singular source--target pairs use the
versioned adaptive quadrature path. Stage callbacks can use this adapter, but
the public `OerstedField` class has no OE-F1 selector. The capability row
therefore remains `semantic_only` despite bounded native execution tests.

### FEM CPU: OE-F2

Solved-current FEM planning currently selects `FemVectorPotential`. The
append-only OE-F2 ABI solves the mixed exact-sequence system on the same RT0
view and projects compatible $\mathbf H$ to the nodal LLG field. Bounded CPU
fixtures and stage integration exist. Airbox sequence, convergence, scalable
projection, exact public selector/provenance surface, and production
qualification remain open, so the capability remains `semantic_only`.

### FEM GPU

No device-resident OE-F1 or OE-F2 solved-current implementation is executable
or qualified. Strict GPU fails closed; CPU execution cannot be relabelled as
GPU provenance.

(oersted-implementation-mapping)=
## Implementation mapping

| Claim | Path | Stable symbol | Responsibility |
|---|---|---|---|
| Public field binding | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | stores canonical solved-current source binding |
| Public current source | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | owns one-way/bidirectional charge definition and RT0 view |
| External lead | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentExternalLead` | validates volumetric lead closure data |
| Interface pair | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentLeadInterfacePair` | canonicalizes device--lead face pairing |
| RT0 authoring view | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentView` | pins immutable source/mesh/closure identity and gates |
| Solved-source planning | `crates/fullmag-plan/src/oersted.rs` | `resolve_solved_current_source` | binds Oersted to an actual solved spin/current module |
| Closure preflight | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | validates one-way FEM RT0/external-lead scope and callback policy |
| RT0 runner adapter | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | materializes append-only RT0/OE-F1/OE-F2 requests |
| Native current solve | `backends/fem/cpu/mfem/transport/steady_transport.hpp` | `class SteadyTransportOracle` | owns the potential/current solve consumed by RT0 |
| Native RT0 view | `backends/fem/cpu/mfem/transport/conservative_current_view.hpp` | `class ConservativeCurrentView` | owns the immutable conservative H(div) representation |
| OE-F1 operator | `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp` | `class DirectTetraQuadrature` | evaluates direct tetrahedral field from the exact RT0 view |
| OE-F2 operator | `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp` | `class VectorPotentialSolver` | solves the mixed vector-potential system and projects compatible fields |
| OE-F1 ABI | `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_v1` | append-only request/result boundary for OE-F1 |
| OE-F2 ABI | `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1` | append-only request/result boundary for OE-F2 |
| External-lead adapter test | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded Rust-to-ABI-to-MFEM external-lead execution evidence |
| External-lead callback test | `crates/fullmag-runner/src/native_fem/stage_oersted.rs` | `external_lead_stage_callback_solves_oersted_and_commits_observation` | bounded transactional OE-F1 stage evidence |

(oersted-validation)=
## Validation and evidence

The repository contains bounded native/managed contracts for OE-T0,
direct-tetra OE-F1, mixed OE-F2, public external-lead descriptor lowering,
external-lead adapter execution, stage callback commit/rollback, and selected
explicit RK trajectories. These are implementation and named-fixture evidence.
They do not close a public-method selector, full Python-to-artifact runtime
proof, three-airbox OE-F2 truncation study, p/h convergence envelope,
production-scale preconditioner, FDM--FEM solved-current agreement, GPU
residency, or production qualification.

(oersted-limitations)=
## Limitations

- Public `OerstedField` cannot explicitly select OE-F1 or OE-F2; solved-current
  FEM planning currently selects OE-F2.
- Canonical FDM FFT remains separate and `semantic_only`.
- Closure-aware reciprocal M2 plus RT0/external lead is fail-closed.
- OE-F1 and OE-F2 have no executable solved-current GPU lane.
- An analytic return is OE-F1-only additive data, never RT0 closure.
- Capability status remains below production/validated despite bounded native
  execution tests.

(oersted-scientific-bibliography)=
## Scientific bibliography

1. R. Hiptmair, “Finite elements in computational electromagnetism,”
   *Acta Numerica* 11, 237--339 (2002),
   [doi:10.1017/S0962492902000041](https://doi.org/10.1017/S0962492902000041).
2. MFEM, [Maxwell discretization notes](https://mfem.org/maxwell-notes/),
   de Rham-compatible $H(\mathrm{curl})$/$H(\mathrm{div})$ spaces.
3. “Evaluation of Biot--Savart integrals on tetrahedral meshes,”
   [arXiv:0712.1695](https://arxiv.org/abs/0712.1695), comparative quadrature
   evidence only.

(oersted-source-code-index)=
## Source-code index

| Claim | Source path | Stable symbol / owner | Responsibility | Lane | Exact test | Evidence status | Source anchor | Test anchor |
|---|---|---|---|---|---|---|---|---|
| Public field binding | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | Validate and lower the exact public source, model, and stable id boundary. | API/IR | `packages/fullmag-py/tests/test_external_lead_roundtrip.py::test_external_lead_round_trips_through_script_and_scene_document` | source mapped; focused public round-trip; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/energy.py) | `worktree/uncommitted`; path + symbol only |
| Public current source | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | Own the solved-current source, coupling, envelope, and conservative RT0 view request. | API/IR | `packages/fullmag-py/tests/test_external_lead_roundtrip.py::test_public_external_lead_example_lowers_complete_stage_contract` | source mapped; focused public round-trip; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | `worktree/uncommitted`; path + symbol only |
| Closed-geometry closure | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentClosedGeometry` | Validate and lower the periodic closed-conductor identity and source-cut collection. | API/IR | `packages/fullmag-py/tests/test_current_transport.py::test_closed_conservative_current_view_round_trips_public_surfaces` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_current_transport.py) |
| Closed source cut | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentSourceCut` | Preserve one nonzero translation, signed potential drop, and paired cut faces. | API/IR | `packages/fullmag-py/tests/test_current_transport.py::test_closed_conservative_current_view_round_trips_public_surfaces` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_current_transport.py) |
| Source-cut face pair | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentSourceCutFacePair` | Canonicalize distinct minus/plus source-cut boundary faces. | API/IR | `packages/fullmag-py/tests/test_current_transport.py::test_closed_conservative_current_view_round_trips_public_surfaces` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_current_transport.py) |
| External lead | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentExternalLead` | Preserve the typed volumetric external-lead closure. | API/IR | `packages/fullmag-py/tests/test_external_lead_roundtrip.py::test_external_lead_is_typed_and_serializes_complete_mesh_contract` | source mapped; focused public round-trip; source/test worktree-uncommitted; immutable publication anchor unavailable | `worktree/uncommitted`; path + symbol only | `worktree/uncommitted`; path + symbol only |
| Interface pair | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentLeadInterfacePair` | Canonicalize oriented device-to-lead interface face pairs. | API/IR | `packages/fullmag-py/tests/test_external_lead_roundtrip.py::test_external_lead_is_typed_and_serializes_complete_mesh_contract` | source mapped; focused public round-trip; source/test worktree-uncommitted; immutable publication anchor unavailable | `worktree/uncommitted`; path + symbol only | `worktree/uncommitted`; path + symbol only |
| RT0 authoring view | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ConservativeCurrentView` | Preserve immutable accepted-current identity, pins, closure, and physical gates. | API/IR | `packages/fullmag-py/tests/test_external_lead_roundtrip.py::test_external_lead_round_trips_through_script_and_scene_document` | source mapped; focused public round-trip; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | `worktree/uncommitted`; path + symbol only |
| Solved-source planning | `crates/fullmag-plan/src/oersted.rs` | `resolve_solved_current_source` | Resolve the named solved-current source and fail closed on incompatible requests. | planner | `crates/fullmag-plan/src/spin_transport.rs::fem_ohmic_oersted_binds_the_solved_charge_field` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/oersted.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) |
| Closure preflight | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | Preflight the bounded FEM current and closure contract. | FEM CPU planner | `crates/fullmag-plan/src/spin_transport.rs::planner_rejects_duplicate_boundary_and_accepts_complete_external_lead_view` | source mapped; focused planner contract; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) | `worktree/uncommitted`; path + symbol only |
| RT0 runner adapter | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport_rt0` | Construct and verify the bounded immutable RT0 current view. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded native CPU contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/native_fem/steady_transport.rs) | `worktree/uncommitted`; path + symbol only |
| Native current solve | `backends/fem/cpu/mfem/transport/steady_transport.hpp` | `class SteadyTransportOracle` | Own the FEM potential solve and charge-current constitutive response consumed by RT0. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded native CPU contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/transport/steady_transport.hpp) | `worktree/uncommitted`; path + symbol only |
| Native RT0 view | `backends/fem/cpu/mfem/transport/conservative_current_view.hpp` | `class ConservativeCurrentView` | Own the immutable conservative RT0/H(div) current representation. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded native CPU contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/transport/conservative_current_view.hpp) | `worktree/uncommitted`; path + symbol only |
| OE-F1 operator | `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp` | `class DirectTetraQuadrature` | Evaluate bounded cutoff-free direct tetrahedral OE-F1 quadrature. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded native CPU contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp) | `worktree/uncommitted`; path + symbol only |
| OE-F2 operator | `backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp` | `class VectorPotentialSolver` | Evaluate the bounded mixed vector-potential OE-F2 realization. | FEM CPU | `backends/fem/tests/oersted_vector_potential_contract.cpp::vector_potential_exact_sequence_contract` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/oersted_vector_potential_contract.cpp) |
| OE-F1 ABI | `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_v1` | Expose the append-only native OE-F1 request/result ABI. | FEM CPU ABI | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded append-only ABI contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/native/include/fullmag_fem.h) | `worktree/uncommitted`; path + symbol only |
| OE-F2 ABI | `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_vector_potential_v1` | Expose the append-only native OE-F2 request/result ABI. | FEM CPU ABI | `backends/fem/tests/steady_transport_rt0_contract.cpp::run_closed_geometry_rt0_contract` | bounded append-only ABI contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/native/include/fullmag_fem.h) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/steady_transport_rt0_contract.cpp) |
| External-lead adapter test | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | Provide bounded managed external-lead adapter execution evidence. | FEM CPU evidence | `crates/fullmag-runner/src/native_fem/steady_transport.rs::external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit` | bounded managed adapter evidence; not production qualification; source/test worktree-uncommitted; immutable publication anchor unavailable | `worktree/uncommitted`; path + symbol only | `worktree/uncommitted`; path + symbol only |
| External-lead callback test | `crates/fullmag-runner/src/native_fem/stage_oersted.rs` | `external_lead_stage_callback_solves_oersted_and_commits_observation` | Provide bounded stage-callback transaction evidence. | FEM CPU evidence | `crates/fullmag-runner/src/native_fem/stage_oersted.rs::external_lead_stage_callback_solves_oersted_and_commits_observation` | bounded managed callback evidence; not production qualification; source/test worktree-uncommitted; immutable publication anchor unavailable | `worktree/uncommitted`; path + symbol only | `worktree/uncommitted`; path + symbol only |

Immutable tracked baseline:
[Fullmag `220262df5d84fa04b842c414e3e5868444b356e5`](https://github.com/MateuszZelent/fullmag/tree/220262df5d84fa04b842c414e3e5868444b356e5).
Every linked cell above was dereferenced with `git show SHA:path` and its exact
symbol was found in that blob. A `worktree/uncommitted` cell intentionally has
no immutable URL: its current `path + symbol` identity is verifiable locally,
but publication remains blocked until a controlled commit supplies the anchor.
