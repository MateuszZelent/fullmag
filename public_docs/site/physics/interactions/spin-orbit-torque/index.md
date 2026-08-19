---
title: Spin-orbit torque
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md
---

(public-docs-physics-interactions-sot)=
# Prescribed spin-orbit torque

`PrescribedSpinOrbitTorque` is Fullmag's canonical local damping-like and
field-like spin-orbit-torque source. It consumes a signed prescribed drive and
adds a direct Gilbert-source torque to the LLG equation. It is not a charge/spin
transport solve, does not establish direct or inverse spin Hall capability, and
has no conservative energy observable. The old `SpinOrbitTorque` constructor is
deprecated compatibility input; canonical export uses
`PrescribedSpinOrbitTorque`.

| Solver | Device | Current status | Exact evidence boundary |
|---|---|---|---|
| FDM | CPU | `reference_executable` | Independent FP64 algebra, target-mask handling, and bounded trajectory/current-scaling oracles exist; this is not production qualification. |
| FDM | GPU | `production_executable` | The native CUDA production lane has bounded managed FP64 trajectory and current-scaling evidence; FP32 and broad physical qualification remain open. |
| FEM | CPU | `reference_executable` | Native MFEM and Rust reference evaluators have bounded managed SI-oracle, stage-time, mask, rollback, and trajectory checks. |
| FEM | GPU | `reference_executable` | A device-resident CUDA direct-torque path has bounded FP64 SI-oracle and CPU/GPU parity checks; it is not a production or validated lane. |

(sot-problem-statement)=
## Physical problem

For reduced magnetization $\mathbf m=\mathbf M/M_s$, the author supplies either
a signed scalar current density and spin-polarization direction or a binding to
a vector current source plus fixed drive and interface axes. The current is
conventional charge current. Its sign is retained: neither the scalar drive nor
the projection of a vector source is replaced by an absolute value.

For a vector source, $\hat{\mathbf t}$ is the fixed drive direction and
$\hat{\mathbf n}_{NF}$ is oriented from nonmagnet/heavy metal to ferromagnet.
The spin axis is derived once from those fixed axes. Reversing the current
changes the signed scalar only; it does not silently reverse either authored
axis.

(sot-governing-equations)=
## Governing equations

```{math}
:label: eq-prescribed-sot-drive
J_{\mathrm{signed}}=\mathbf J_c\cdot\hat{\mathbf t},\qquad
\hat{\boldsymbol\sigma}=\frac{\hat{\mathbf n}_{NF}\times\hat{\mathbf t}}
{\lVert\hat{\mathbf n}_{NF}\times\hat{\mathbf t}\rVert}.
```

The alternative `SignedScalarDrive` authors $J_{\mathrm{signed}}$ and
$\hat{\boldsymbol\sigma}$ directly. The two drive forms are mutually exclusive.
With positive angular gyromagnetic magnitude $\gamma_e$, positive elementary
charge $e$, free-layer thickness $t_F$, and signed efficiencies
$\xi_{\mathrm{DL}}$ and $\xi_{\mathrm{FL}}$:

```{math}
:label: eq-prescribed-sot-gilbert
\begin{aligned}
\Omega_{\mathrm{DL}}&=\frac{\gamma_e\hbar\xi_{\mathrm{DL}}J_{\mathrm{signed}}}
{2eM_st_F},\\
\Omega_{\mathrm{FL}}&=\frac{\gamma_e\hbar\xi_{\mathrm{FL}}J_{\mathrm{signed}}}
{2eM_st_F},\\
\mathbf T_{\mathrm{{SOT}},G}&=
\Omega_{\mathrm{DL}}\,\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)
+\Omega_{\mathrm{FL}}\,\mathbf m\times\hat{\boldsymbol\sigma}.
\end{aligned}
```

`PrescribedSpinOrbitTorque` is authored as a Gilbert source. Fullmag performs
the Gilbert-to-explicit conversion exactly once:

```{math}
:label: eq-prescribed-sot-explicit
\mathbf T_{\mathrm{SOT,explicit}}=
\frac{\mathbf T_{\mathrm{SOT},G}+\alpha\,\mathbf m\times
\mathbf T_{\mathrm{SOT},G}}{1+\alpha^2}.
```

(sot-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization on the target | $\mathrm{A\,m^{-1}}$ |
| $\mathbf J_c$ | conventional charge-current density | $\mathrm{A\,m^{-2}}$ |
| $J_{\mathrm{signed}}$ | signed drive-projected current density | $\mathrm{A\,m^{-2}}$ |
| $\hat{\mathbf t}$ | fixed drive direction | $1$ |
| $\hat{\mathbf n}_{NF}$ | oriented nonmagnet-to-ferromagnet normal | $1$ |
| $\hat{\boldsymbol\sigma}$ | normalized spin-polarization direction | $1$ |
| $\xi_{\mathrm{DL}}$ | signed damping-like efficiency | $1$ |
| $\xi_{\mathrm{FL}}$ | signed field-like efficiency | $1$ |
| $t_F$ | free-layer thickness in the local prefactor | $\mathrm{m}$ |
| $\gamma_e$ | positive angular gyromagnetic magnitude | $\mathrm{s^{-1}\,T^{-1}}$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | positive elementary charge | $\mathrm{C}$ |
| $\Omega_{\mathrm{DL}}$ | damping-like angular rate | $\mathrm{s^{-1}}$ |
| $\Omega_{\mathrm{FL}}$ | field-like angular rate | $\mathrm{s^{-1}}$ |
| $\mathbf T_{\mathrm{SOT},G}$ | Gilbert-source SOT rate | $\mathrm{s^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |

(sot-assumptions-and-validity)=
## Assumptions and validity limits

This is a local, prescribed-source model for a resolved or explicitly
homogenized ferromagnetic target. It does not solve spin diffusion, backflow,
spin-memory loss, inverse SHE, Rashba--Edelstein physics, or a conducting return
circuit. `DriftDiffusionSpinTorque` owns torque derived from a solved
`SpinDriftDiffusion` balance and must not be replaced by this local source.

Validation rejects non-finite coefficients, a non-positive thickness, an empty
target, a zero spin/drive/normal axis, parallel vector-drive axes, and a target
that cannot be materialized in the requested discretization. FEM region-level
targets currently fail closed; the bounded FEM lane resolves whole-object
targets only. A tabulated envelope fails closed until its artifact is
materialized by the selected runtime.

(sot-python-api)=
## Python API

The interaction is registerable in the normal stage-first workflow. This cell
was executed with `PYTHONPATH=packages/fullmag-py/src`; it constructs the study
and stage without invoking a solver.

```python
# %% Study, backend, geometry, and material
import fullmag as fm

study = fm.study("prescribed-sot-doc")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 1e-9))

body = study.geometry(fm.Box(40e-9, 20e-9, 1e-9), name="free_layer")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Canonical prescribed SOT registration
sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=fm.RegionRef("free_layer"),
    drive=fm.SignedScalarDrive(
        current_density_Apm2=-4.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5e-9,
)
study.spin_torque(sot)

# %% Ordered stage
study.stages.add_run(2.0e-12, stage_id="sot_run")
```

### Parameter reference

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `PrescribedSpinOrbitTorque.name` | `str` | required | $1$ | non-empty | stable torque-module identity | all four lanes; execution is capability-gated | `spin_torque_modules[].id` |
| `PrescribedSpinOrbitTorque.target` | `RegionRef` | required | $1$ | non-empty and resolvable magnetic object; FEM region subtargets fail closed | magnetic torque target | FDM CPU/GPU and bounded FEM CPU/GPU | `spin_torque_modules[].target` |
| `PrescribedSpinOrbitTorque.drive` | `SignedScalarDrive or VectorCurrentDrive` | required | $\mathrm{A\,m^{-2}}$ or source binding | exactly one tagged drive; vector axes must be finite, nonzero, and nonparallel | signed current and polarization source | all four lanes with lane-specific envelope/source limits | `spin_torque_modules[].drive` |
| `PrescribedSpinOrbitTorque.xi_dl` | `float` | required | $1$ | finite and signed | damping-like efficiency | all four lanes | `spin_torque_modules[].xi_dl` |
| `PrescribedSpinOrbitTorque.xi_fl` | `float` | `0.0` | $1$ | finite and signed | field-like efficiency | all four lanes | `spin_torque_modules[].xi_fl` |
| `PrescribedSpinOrbitTorque.free_layer_thickness_m` | `float` | required | $\mathrm{m}$ | finite and strictly positive | homogenized ferromagnet thickness | all four lanes | `spin_torque_modules[].free_layer_thickness_m` |
| `SignedScalarDrive.current_density_Apm2` | `float` | required | $\mathrm{A\,m^{-2}}$ | finite; zero is legal and produces zero signed source | signed prescribed current density | all four lanes | `spin_torque_modules[].drive.current_density_Apm2` |
| `SignedScalarDrive.sigma` | `Sequence[float]` | required | $1$ | three finite components and norm above `1e-12`; normalized once | authored spin axis | all four lanes | `spin_torque_modules[].drive.sigma_hat` |
| `SignedScalarDrive.envelope` | `TimeEnvelope or None` | `None` | $1$ | canonical envelope; tabulated artifacts are runtime-gated | stage-time multiplier | FDM bounded constant slice; FEM bounded non-tabulated slice | `spin_torque_modules[].drive.envelope` |
| `VectorCurrentDrive.current_source` | `str` | required | $1$ | non-empty current-source id | vector current binding | planner/runtime source availability is lane-gated | `spin_torque_modules[].drive.current_source_id` |
| `VectorCurrentDrive.drive_direction` | `Sequence[float]` | required | $1$ | finite, nonzero, and not parallel to interface normal | fixed current projection axis | all four authoring lanes | `spin_torque_modules[].drive.drive_direction` |
| `VectorCurrentDrive.interface_normal` | `Sequence[float]` | required | $1$ | finite, nonzero, and not parallel to drive direction | oriented HM-to-FM normal | all four authoring lanes | `spin_torque_modules[].drive.interface_normal` |

(sot-problem-ir)=
## Python to ProblemIR lowering

The exact stage-first block is captured and serialized with
`LoadedProblem.to_ir(..., include_geometry_assets=False)`. This canonical
no-asset mode emits the complete ProblemIR document: only optional generated
geometry assets are `null`, while geometry, material, magnet, stage, provenance,
and module records remain present. `sot.to_ir_module()` appears verbatim under
`spin_torque_modules[]` without rewriting the signed drive.

```json
{
  "ir_version": "0.3.0",
  "problem_meta": {
    "name": "prescribed-sot-doc",
    "description": null,
    "script_language": "python",
    "script_source": "# %% Study, backend, geometry, and material\nimport fullmag as fm\n\nstudy = fm.study(\"prescribed-sot-doc\")\nstudy.engine(\"fdm\")\nstudy.device(\"cpu\", precision=\"double\")\nstudy.mode(\"strict\")\nstudy.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 1e-9))\n\nbody = study.geometry(fm.Box(40e-9, 20e-9, 1e-9), name=\"free_layer\")\nbody.Ms = 8.0e5\nbody.Aex = 13.0e-12\nbody.alpha = 0.02\nbody.m = fm.texture.uniform(1.0, 0.0, 0.0)\n\n# %% Canonical prescribed SOT registration\nsot = fm.PrescribedSpinOrbitTorque(\n    name=\"hm_sot\",\n    target=fm.RegionRef(\"free_layer\"),\n    drive=fm.SignedScalarDrive(\n        current_density_Apm2=-4.0e11,\n        sigma=(0.0, 1.0, 0.0),\n    ),\n    xi_dl=0.12,\n    xi_fl=-0.03,\n    free_layer_thickness_m=1.5e-9,\n)\nstudy.spin_torque(sot)\n\n# %% Ordered stage\nstudy.stages.add_run(2.0e-12, stage_id=\"sot_run\")\n",
    "script_api_version": "0.3.0",
    "serializer_version": "0.3.0",
    "entrypoint_kind": "flat_workspace",
    "source_hash": "11aadb7b00c122c5df46957956e7f4436711de55423cde708bb675e4497c9557",
    "runtime_metadata": {
      "interactive_session_requested": true,
      "script_api_surface": "study",
      "runtime_selection": {
        "backend": "fdm",
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
            "id": "sot_run",
            "label": "",
            "enabled": true,
            "source": "script_imported",
            "node_kind": "primitive",
            "stage_kind": "run",
            "payload": {
              "kind": "run",
              "entrypoint_kind": "flat_run",
              "stage_id": "sot_run",
              "until_seconds": "2e-12"
            }
          }
        ]
      },
      "domain_frame": {
        "declared_universe": null,
        "object_bounds_min": [
          -2e-08,
          -1e-08,
          -5e-10
        ],
        "object_bounds_max": [
          2e-08,
          1e-08,
          5e-10
        ],
        "mesh_bounds_min": null,
        "mesh_bounds_max": null,
        "effective_extent": [
          4e-08,
          2e-08,
          1e-09
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
          "spin_torque"
        ],
        "canonical_script_strategy": "canonical_rewrite",
        "problem": {
          "name": "prescribed-sot-doc",
          "description": null,
          "runtime": {
            "backend": "fdm",
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
              -2e-08,
              -1e-08,
              -5e-10
            ],
            "object_bounds_max": [
              2e-08,
              1e-08,
              5e-10
            ],
            "mesh_bounds_min": null,
            "mesh_bounds_max": null,
            "effective_extent": [
              4e-08,
              2e-08,
              1e-09
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
              "name": "free_layer_geom",
              "kind": "box",
              "size": [
                4e-08,
                2e-08,
                1e-09
              ]
            }
          ],
          "regions": [
            {
              "name": "free_layer",
              "geometry": "free_layer_geom"
            }
          ],
          "materials": [
            {
              "name": "mat_free_layer",
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
              "name": "free_layer",
              "region": "free_layer",
              "material": "mat_free_layer",
              "initial_magnetization": {
                "kind": "preset_texture",
                "preset_kind": "uniform",
                "preset_params": {
                  "direction": [
                    1.0,
                    0.0,
                    0.0
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
            }
          ],
          "current_modules": [],
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
            "fdm": {
              "cell": [
                2e-09,
                2e-09,
                1e-09
              ],
              "default_cell": [
                2e-09,
                2e-09,
                1e-09
              ]
            },
            "fem": null,
            "hybrid": null
          },
          "mesh_workflow": null,
          "spin_torque": null,
          "spin_torque_modules": [
            {
              "kind": "prescribed_sot",
              "schema_version": "prescribed_sot.v1",
              "id": "hm_sot",
              "target": {
                "object_id": "free_layer"
              },
              "formula_version": "prescribed_sot.fullmag.v1",
              "drive": {
                "kind": "signed_scalar",
                "current_density_Apm2": -400000000000.0,
                "sigma_hat": [
                  0.0,
                  1.0,
                  0.0
                ]
              },
              "xi_dl": 0.12,
              "xi_fl": -0.03,
              "free_layer_thickness_m": 1.5e-09
            }
          ],
          "temperature": null
        },
        "study_pipeline": {
          "version": "study_pipeline.v1",
          "nodes": [
            {
              "id": "sot_run",
              "label": "",
              "enabled": true,
              "source": "script_imported",
              "node_kind": "primitive",
              "stage_kind": "run",
              "payload": {
                "kind": "run",
                "entrypoint_kind": "flat_run",
                "stage_id": "sot_run",
                "until_seconds": "2e-12"
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
          "spin_torque"
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
        "name": "free_layer_geom",
        "kind": "box",
        "size": [
          4e-08,
          2e-08,
          1e-09
        ]
      }
    ]
  },
  "geometry_assets": null,
  "regions": [
    {
      "name": "free_layer",
      "geometry": "free_layer_geom"
    }
  ],
  "object_regions": [],
  "materials": [
    {
      "name": "mat_free_layer",
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
      "name": "free_layer",
      "region": "free_layer",
      "material": "mat_free_layer",
      "initial_magnetization": {
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "preset_params": {
          "direction": [
            1.0,
            0.0,
            0.0
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
    }
  ],
  "current_modules": [],
  "spin_transport_modules": [],
  "physics_graph": {
    "schema_version": "physics_graph.v1",
    "scene_revision": 0,
    "modules": [
      {
        "id": "hm_sot",
        "kind": "spin_torque",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "free_layer"
          }
        ],
        "solve_domain": [
          {
            "object_id": "free_layer"
          }
        ],
        "depends_on": [],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/spin_torques/0",
        "family_payload": {
          "kind": "prescribed_sot",
          "schema_version": "prescribed_sot.v1",
          "id": "hm_sot",
          "target": {
            "object_id": "free_layer"
          },
          "formula_version": "prescribed_sot.fullmag.v1",
          "drive": {
            "kind": "signed_scalar",
            "current_density_Apm2": -400000000000.0,
            "sigma_hat": [
              0.0,
              1.0,
              0.0
            ]
          },
          "xi_dl": 0.12,
          "xi_fl": -0.03,
          "free_layer_thickness_m": 1.5e-09
        }
      }
    ],
    "edges": []
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
    "requested_backend": "fdm",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {
        "cell": [
          2e-09,
          2e-09,
          1e-09
        ],
        "default_cell": [
          2e-09,
          2e-09,
          1e-09
        ]
      },
      "fem": null,
      "hybrid": null
    }
  },
  "validation_profile": {
    "execution_mode": "strict"
  },
  "spin_torque_modules": [
    {
      "kind": "prescribed_sot",
      "schema_version": "prescribed_sot.v1",
      "id": "hm_sot",
      "target": {
        "object_id": "free_layer"
      },
      "formula_version": "prescribed_sot.fullmag.v1",
      "drive": {
        "kind": "signed_scalar",
        "current_density_Apm2": -400000000000.0,
        "sigma_hat": [
          0.0,
          1.0,
          0.0
        ]
      },
      "xi_dl": 0.12,
      "xi_fl": -0.03,
      "free_layer_thickness_m": 1.5e-09
    }
  ],
  "elastic_materials": [],
  "elastic_bodies": [],
  "magnetostriction_laws": [],
  "mechanical_bcs": [],
  "mechanical_loads": []
}
```

This is the full script-captured ProblemIR document of the exact example,
including geometry, material, magnet, module, provenance, and ordered stage. A
publication validator compares the displayed JSON byte-for-structure with a fresh
no-asset serialization. Repository round-trip tests exercise canonical
rendering/reload of the module and stage semantics; they do not independently
claim full-document source-format identity.

(sot-round-trip-and-failure-semantics)=
## Requested intent, resolved execution, and failures

The **requested intent** retains the canonical class, module id, target,
formula version, tagged drive, signed current, axes, envelope, efficiencies,
thickness, and requested backend/device/precision/mode. The planner records
the **resolved execution** separately: selected lane, normalized axes,
materialized mask, envelope realization, precision, and runtime provenance.

**Validation errors** are returned before native execution. They do not convert
a vector drive to a scalar norm, broaden an unresolved target, substitute
legacy `SpinOrbitTorque`, or drop a time envelope. **Unsupported combinations**
remain explicit: strict GPU never falls back to CPU, tabulated data is not
invented, and a FEM region subtarget is not broadened to its containing object.

(sot-discrete-realization)=
## Discrete realization

### FDM CPU

The FP64 reference evaluates the local SI/Gilbert algebra in active target
cells. The cell mask is derived from the canonical target and intersected with
the magnetic active mask. Bounded fixed-trajectory and signed-current-scaling
checks exist, but no continuum or production qualification follows.

### FDM GPU

The native CUDA lane consumes the same immutable descriptor and target mask in
device-resident LLG stages. Managed FP64 trajectory/scaling checks support the
`production_executable` implementation status. They do not qualify FP32,
nonlinear sweeps, all envelopes, or cross-discretization agreement.

### FEM CPU

The native MFEM evaluator and the independent Rust FEM reference apply the same
local source on resolved target nodes. Bounded managed tests cover SI scale,
mask, current reversal, constant/sinusoidal stage timing, pulse/PWL event
handling, and selected rollback/trajectory cases. Whole-object target
resolution is executable; region-level target resolution fails closed.

### FEM GPU

The CUDA direct-torque kernel keeps magnetization, mask, materials, and RHS on
device and receives a stage-time scalar. Bounded FP64 CPU/GPU parity exists for
constant/sinusoidal sources and supported explicit RK tableaus. The lane
remains `reference_executable`, not production-qualified.

(sot-implementation-mapping)=
## Implementation mapping

| Claim | Path | Stable symbol | Responsibility |
|---|---|---|---|
| Canonical Python class | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | validates and lowers target, drive, efficiencies, and thickness |
| Signed scalar drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SignedScalarDrive` | preserves signed current, normalized axis, and optional envelope |
| Vector source drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class VectorCurrentDrive` | preserves source identity and oriented fixed axes |
| Vector drive resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | computes $\mathbf J_c\cdot\hat{\mathbf t}$ and $\hat{\mathbf n}_{NF}\times\hat{\mathbf t}$ |
| FDM target | `crates/fullmag-plan/src/fdm.rs` | `materialize_prescribed_sot_target_mask` | resolves object/region cells without broadening |
| FEM target | `crates/fullmag-plan/src/fem.rs` | `materialize_fem_spin_torque_target_masks` | resolves whole-object node/element masks and rejects region subtargets |
| FDM CPU algebra | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `prescribed_sot_torque_from_config` | independent SI/Gilbert reference evaluation |
| FDM CUDA algebra | `backends/fdm/include/spin_torque.hpp` | `prescribed_sot_explicit_rhs` | native CUDA precision-lane direct torque |
| FEM CPU algebra | `backends/fem/cpu/mfem/interactions/sot.cpp` | `add_sot_rhs_aos` | native MFEM CPU source evaluation |
| FEM GPU algebra | `backends/fem/gpu/cuda/interactions/sot/sot_kernels.cu` | `prescribed_sot_rhs_kernel` | device-resident direct-torque kernel |

(sot-validation)=
## Validation and evidence

Current evidence is bounded and lane-specific. FDM CUDA has small FP64
trajectory and current-scaling contracts. FEM CPU/GPU have one-step SI oracles,
stage-time checks, target-mask/current-reversal checks, and bounded selected
trajectory/tableau contracts. These results establish execution for the named
fixtures only. They do not establish FP32 accuracy, arbitrary envelopes,
long-time switching accuracy, mesh convergence, FEM--FDM continuum agreement,
direct/inverse SHE, or production qualification of either FEM lane.

(sot-limitations)=
## Limitations

- Solved spin transport belongs to `SpinDriftDiffusion` and
  `DriftDiffusionSpinTorque`.
- Tabulated envelopes require an owned artifact buffer and otherwise fail
  closed.
- FEM region-level targets are not executable; only resolved whole-object
  targets are admitted.
- GPU event-aware rollback and FP32 have not been generally qualified.
- No SOT energy term exists.

(sot-scientific-bibliography)=
## Scientific bibliography

1. A. Manchon et al., *Rev. Mod. Phys.* 91, 035004 (2019),
   [doi:10.1103/RevModPhys.91.035004](https://doi.org/10.1103/RevModPhys.91.035004).
2. J. C. Slonczewski, *J. Magn. Magn. Mater.* 159, L1--L7 (1996),
   [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).

(sot-source-code-index)=
## Source-code index

| Claim | Source path | Stable symbol / owner | Responsibility | Lane | Exact test | Evidence status | Source anchor | Test anchor |
|---|---|---|---|---|---|---|---|---|
| Canonical Python class | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | Validate and lower the canonical target, drive, efficiencies, and thickness. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_prescribed_scalar_all_envelopes_render_canonically_without_loss` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_torque.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Signed scalar drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SignedScalarDrive` | Preserve signed scalar current, normalized spin axis, and optional envelope. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_prescribed_scalar_all_envelopes_render_canonically_without_loss` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_torque.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Vector source drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class VectorCurrentDrive` | Preserve vector source identity and oriented fixed axes. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_vector_and_legacy_prescribed_sot_render_canonically_without_loss` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_torque.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Vector drive resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | Evaluate the signed current projection and the oriented interface-normal cross product. | planner | `crates/fullmag-plan/src/spin_torque.rs::canonical_prescribed_sot_vector_binding_preserves_axes_and_reverses_signed_projection` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_torque.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_torque.rs) |
| FDM target | `crates/fullmag-plan/src/fdm.rs` | `materialize_prescribed_sot_target_mask` | Resolve FDM object or region targets without broadening. | FDM CPU/GPU planner | `crates/fullmag-plan/src/fdm.rs::prescribed_sot_region_target_materializes_cell_mask` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/fdm.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/fdm.rs) |
| FEM target | `crates/fullmag-plan/src/fem.rs` | `materialize_fem_spin_torque_target_masks` | Resolve FEM whole-object masks and reject unsupported region subtargets. | FEM CPU/GPU planner | `crates/fullmag-plan/src/fem.rs::fem_spin_torque_object_target_materializes_node_and_element_masks` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/fem.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/fem.rs) |
| FDM CPU algebra | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `prescribed_sot_torque_from_config` | Evaluate the independent FDM CPU SI and Gilbert reference algebra. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs::prescribed_sot_matches_signed_si_gilbert_source_oracle` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/fields.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/fields.rs) |
| FDM CUDA algebra | `backends/fdm/include/spin_torque.hpp` | `prescribed_sot_explicit_rhs` | Evaluate native CUDA precision-lane prescribed SOT. | FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available` | bounded CUDA parity contract; hardware-gated; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fdm/include/spin_torque.hpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/fdm/gpu/cuda/native.rs) |
| FEM CPU algebra | `backends/fem/cpu/mfem/interactions/sot.cpp` | `add_sot_rhs_aos` | Evaluate native MFEM CPU prescribed SOT. | FEM CPU | `backends/fem/tests/stt_contract.cpp::prescribed_sot_rhs_matches_si_oracle_and_current_reversal` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/interactions/sot.cpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/stt_contract.cpp) |
| FEM GPU algebra | `backends/fem/gpu/cuda/interactions/sot/sot_kernels.cu` | `prescribed_sot_rhs_kernel` | Evaluate device-resident FEM GPU prescribed SOT. | FEM GPU | `backends/fem/tests/cuda_sot_contract.cpp::canonical_prescribed_sot_matches_cpu_and_independent_oracle` | bounded CUDA contract; hardware-gated; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/gpu/cuda/interactions/sot/sot_kernels.cu) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/cuda_sot_contract.cpp) |

Immutable tracked baseline:
[Fullmag `220262df5d84fa04b842c414e3e5868444b356e5`](https://github.com/MateuszZelent/fullmag/tree/220262df5d84fa04b842c414e3e5868444b356e5).
Every linked cell above was dereferenced with `git show SHA:path` and its exact
symbol was found in that blob. A `worktree/uncommitted` cell intentionally has
no immutable URL: its current `path + symbol` identity is verifiable locally,
but publication remains blocked until a controlled commit supplies the anchor.
