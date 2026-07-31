---
title: Bulk DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0405-bulk-dmi.md
---

(public-docs-python-api-interactions-bulk-dmi)=
# Bulk DMI Python API

This page documents the public Python authoring and lowering contract for
isotropic bulk Dzyaloshinskii–Moriya interaction.

(bulk-dmi-api-problem-statement)=
## 1. Problem statement

Bulk DMI is represented by an explicit fullmag.BulkDMI term or by
material-owned Material.Dbulk and Material.Dbulk_field values.

(bulk-dmi-api-governing-equations)=
## 2. Governing equations

```{math}
:label: eq-python-bulk-dmi-density
w_b=D_b\,\mathbf m\cdot(\nabla\times\mathbf m),
\qquad
\mathbf H_b=-\frac{2D_b}{\mu_0M_s}(\nabla\times\mathbf m).
```

The coefficient has units $\mathrm{J\,m^{-2}}$ and the energy density has
units $\mathrm{J\,m^{-3}}$.

(bulk-dmi-api-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $D_b$ | public bulk DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_b$ | bulk DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $w_b$ | bulk DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $E_b$ | bulk DMI energy | $\mathrm{J}$ |
| $i$ | discrete cell index | $1$ |
| $\mathcal A$ | active cell set | $1$ |
| $V_i$ | cell volume | $\mathrm{m^3}$ |
| $\nabla_h\times$ | discrete curl | $\mathrm{m^{-1}}$ |

(bulk-dmi-api-assumptions-and-validity)=
## 4. Assumptions and validity

- D is finite and may have either sign.
- Material fields are finite; cardinality is checked against the resolved mesh.
- Explicit FDM execution currently requires all three axes periodic.
- Construction and serialization do not execute a solver or prove GPU parity.

(bulk-dmi-api-python-api)=
## 5. Python API


| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| BulkDMI.D | float | required | $\mathrm{J\,m^{-2}}$ | finite; either sign | explicit coefficient and chirality | FDM/FEM CPU/GPU subject to gates | energy_terms[].D for kind=bulk_dmi |
| Material.Dbulk | float or None | None | $\mathrm{J\,m^{-2}}$ | finite when supplied | material scalar coefficient | FEM CPU/GPU; FDM planner-dependent | materials[].bulk_dmi |
| Material.Dbulk_field | list[float] or None | None | $\mathrm{J\,m^{-2}}$ | finite; resolved cardinality | spatial nodal coefficient | FEM CPU/GPU | materials[].dbulk_field |

The other required Material parameters (name, Ms, A, alpha) are documented
by the canonical Material API page.

(bulk-dmi-api-problem-ir)=
## 6. ProblemIR

```json
{"kind": "bulk_dmi", "D": 0.003}
```

```json
{"bulk_dmi": 0.003, "dbulk_field": null}
```

| Python authoring | Normalized IR | Resolution |
|---|---|---|
| BulkDMI(D) | energy_terms[].kind=bulk_dmi and energy_terms[].D | explicit interaction term |
| Material(Dbulk=D) | materials[].bulk_dmi | material scalar fallback when explicit scalar is absent |
| Material(Dbulk_field=values) | materials[].dbulk_field | FEM spatial coefficient field |

The serializer preserves requested intent. Planner provenance records resolved
solver, device, precision, coefficient route, mesh cardinality, and
qualification status separately.

(bulk-dmi-api-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Canonical export preserves explicit versus material authoring. The IR validator
rejects non-finite explicit or material coefficients. The planner rejects
non-periodic explicit FDM Bulk DMI and all multilayer FDM Bulk DMI.

Validation errors are surfaced as errors. Unsupported combinations are not
silently removed, converted to interfacial DMI, or executed on CPU as hidden
fallback. Requested intent and resolved execution remain distinct.

(bulk-dmi-api-discrete-realization)=
## 8. Discrete realization

```{math}
:label: eq-python-bulk-dmi-fdm
\mathbf H_{b,i}=-\frac{2D_b}{\mu_0M_{s,i}}
(\nabla_h\times\mathbf m)_i,
\qquad
E_b=\sum_{i\in\mathcal A}
D_b[\mathbf m_i\cdot(\nabla_h\times\mathbf m)_i]V_i.
```

FEM lowers the same coefficient into the weak residual and lumped projection;
the native element coefficient is the arithmetic mean of nodal Dbulk_field
values. CPU/GPU share semantics but differ in execution, residency, reduction
order, and qualification evidence.

(bulk-dmi-api-implementation-mapping)=
## 9. Implementation mapping

| API route | FDM CPU/GPU | FEM CPU/GPU | Failure/provenance |
|---|---|---|---|
| BulkDMI.D | explicit scalar, all-axis periodic gate | explicit scalar weak residual | requested term and resolved lane are separate |
| Material.Dbulk | planner-dependent material route | scalar fallback coefficient | no silent summation |
| Material.Dbulk_field | no promise of FDM interpolation | nodal field, arithmetic element mean | resolved mesh cardinality required |

(bulk-dmi-api-validation)=
## 10. Validation

| Test | Expected result | Evidence |
|---|---|---|
| BulkDMI(D).to_ir | exact bulk_dmi term | Python contract test |
| material serialization | bulk_dmi and dbulk_field retained | Python contract test |
| non-finite values | constructor/IR rejection | validation test |
| non-periodic FDM | planner failure | planner test |
| constant magnetization | zero bulk response | analytical test |
| FEM weak residual | reference agreement | native weak-residual test |
| GPU lane | parity only with device run | managed runtime evidence |

(bulk-dmi-api-limitations)=
## 11. Limitations

- The public constructor has one scalar D; tensorial lower-symmetry DMI is not
  represented.
- FDM natural non-periodic boundary execution is not exposed.
- Material field cardinality depends on the resolved mesh.
- The constructor serializes intent; it does not execute a solver.

(bulk-dmi-api-scientific-bibliography)=
## 12. Scientific bibliography

1. A. N. Bogdanov and D. A. Yablonskii, “Thermodynamically stable vortices
   in magnetically ordered crystals,” *Soviet Physics JETP* 68, 101 (1989).
2. A. N. Bogdanov and U. K. Rößler, “Chiral symmetry breaking in magnetic
   thin films and multilayers,” *Physical Review Letters* 87, 037203 (2001),
   [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203).

(bulk-dmi-api-source-code-index)=
## 13. Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| explicit API | `packages/fullmag-py/src/fullmag/model/energy.py` | `class BulkDMI` | finite D and explicit IR | Python contract |
| material API | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Dbulk and Dbulk_field | Python contract |
| FDM boundary API | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | axis/policy validation | Python contract |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | explicit finite check | IR contract |
| material validation | `crates/fullmag-ir/src/validation.rs` | `validate_material_dmi_values` | material finite check | IR contract |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | periodic legality | planner |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | coefficient resolution | planner |
| FDM CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `bulk_dmi_field` | field realization | FDM CPU |
| FDM CPU energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `dmi_energy_from_soa` | energy reduction | FDM CPU |
| FEM CPU | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp` | `compute_bulk_dmi_field` | weak residual/projection/energy | FEM CPU |
| FEM weak algebra | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_bulk_residual` | residual algebra | FEM CPU/GPU |
| FEM GPU | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | element residual/energy | FEM GPU |
