---
title: Zeeman interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0401-zeeman-external-field.md
---

(public-docs-physics-interactions-zeeman)=
# Zeeman interaction

The Zeeman interaction couples the magnetization to a prescribed external magnetic field. The
public contract is deliberately precise: `fullmag.Zeeman(B)` accepts one uniform magnetic flux
density vector $\mathbf B_{\mathrm{ext}}$ in tesla. The planner resolves it to
$\mathbf H_{\mathrm{ext}}=\mathbf B_{\mathrm{ext}}/\mu_0$ in $\mathrm{A\,m^{-1}}$ and every backend
lane consumes that resolved field. No implementation may silently treat the Python input as an
H-field.

This page owns the physical interaction and its four numerical lanes. The Python constructor,
validation, canonical serialization, and copyable authoring examples are documented separately in
{doc}`../../../python-api/interactions/zeeman`.

:::{admonition} Scope boundary
:class: note

`Zeeman(B)` is the uniform, time-independent external field term. Regional fields, antenna
masks, Oersted fields, and time-dependent drives are separate field-source contracts. They may
contribute to the effective field and energy, but they are not hidden parameters of `Zeeman`.
:::

## Solver and backend realizations

| Solver | Device | Status | What this means |
|---|---|---|---|
| FDM | CPU | reference | Double-precision reference implementation with explicit active-cell masking and cell-volume energy reduction. |
| FDM | GPU | implemented | CUDA field and energy paths consume the resolved uniform field; current-device qualification must be reported separately from source availability. |
| FEM | CPU | implemented | MFEM/native FEM nodal field with lumped-mass or saturation-weighted quadrature energy. |
| FEM | GPU | implemented | Device-resident RK accumulation and CUDA block/reduction energy path; executed-device parity remains a qualification gate. |

The statuses describe implementation evidence, not a blanket guarantee that every mesh,
precision, runtime, or requested output is qualified. A resolved execution record must preserve
the requested $\mathbf B_{\mathrm{ext}}$, resolved $\mathbf H_{\mathrm{ext}}$, solver, device,
precision, and output legality result.

(zeeman-problem-statement)=
## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf M$ the magnetization, and
$\mathbf m=\mathbf M/M_s$ the reduced magnetization. A prescribed external flux density
$\mathbf B_{\mathrm{ext}}$ produces the magnetic field

```{math}
:label: eq-zeeman-resolved-field
\mathbf H_{\mathrm{ext}}
=
\frac{\mathbf B_{\mathrm{ext}}}{\mu_0}.
```

The current public API supplies a spatially uniform vector. The numerical realization may store a
copy at every FDM cell or FEM node, but that replication is storage, not a change in the physical
model.

(zeeman-governing-equations)=
## Governing equations

The Zeeman functional used by FullMag is

```{math}
:label: eq-zeeman-energy
E_Z[\mathbf m]
=
-\mu_0\int_{\Omega_m}
M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ext}}(\mathbf x)
\,\mathrm dV
=
-\int_{\Omega_m}
M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf B_{\mathrm{ext}}(\mathbf x)
\,\mathrm dV.
```

For the public uniform input, the field is independent of position. The functional derivative is

```{math}
:label: eq-zeeman-effective-field
\mathbf H_Z
=
-\frac{1}{\mu_0 M_s}
\frac{\delta E_Z}{\delta\mathbf m}
=
\mathbf H_{\mathrm{ext}}
=
\frac{\mathbf B_{\mathrm{ext}}}{\mu_0}.
```

The corresponding energy density and directional derivative are

```{math}
:label: eq-zeeman-energy-density
w_Z(\mathbf x)
=
-\mu_0 M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ext}}(\mathbf x)
=
-M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf B_{\mathrm{ext}}(\mathbf x),
\qquad
[w_Z]=\mathrm{J\,m^{-3}}.
```

```{math}
:label: eq-zeeman-directional-derivative
\delta E_Z[\mathbf m;\boldsymbol\eta]
=
-\mu_0\int_{\Omega_m}
M_s\,\mathbf H_{\mathrm{ext}}\cdot\boldsymbol\eta\,\mathrm dV
=
-\int_{\Omega_m}
M_s\,\mathbf B_{\mathrm{ext}}\cdot\boldsymbol\eta\,\mathrm dV.
```

Here $\boldsymbol\eta$ is an admissible variation of the reduced magnetization. The Zeeman field
is added linearly to the effective field; the LLG equation, constraints on $|\mathbf m|$, and
time integration are owned by the dynamics and integrator contracts, not by this interaction.

(zeeman-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf B_{\mathrm{ext}}$ | prescribed external magnetic flux density supplied by `Zeeman(B)` | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{ext}}$ | resolved external magnetic field used by the native planners and solvers | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_Z$ | Zeeman contribution to the effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\boldsymbol\eta$ | admissible reduced-magnetization variation | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $E_Z$ | total Zeeman energy | $\mathrm{J}$ |
| $w_Z$ | local Zeeman energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf m\cdot\mathbf H_{\mathrm{ext}}$ | scalar field contraction used by the energy integrand | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM nodal lumped integration weight | $\mathrm{m^3}$ |
| $i$ | discrete FDM cell or FEM node index | $1$ |
| $N$ | number of active storage locations considered by a kernel or reduction | $1$ |
| $\mu_0M_s\mathbf m\cdot\mathbf H_{\mathrm{ext}}$ | positive-unit form of the energy-density integrand before the Zeeman minus sign | $\mathrm{J\,m^{-3}}$ |

(zeeman-assumptions-and-validity)=
## Assumptions and validity

- `B` is a finite length-three SI vector in tesla. The constructor does not normalize it and does
  not convert user-provided numbers from another unit system.
- $\mu_0$ is the FullMag SI vacuum permeability used by both FDM and FEM planners. The conversion
  is performed exactly once during planning.
- The public term is uniform and time independent. A spatial or time-dependent drive must use its
  own documented field-source contract.
- $M_s>0$ is required by the surrounding material contract. Spatial $M_s$ affects energy
  quadrature/weights but does not alter the resolved external field.
- A normalized reduced magnetization is expected by the dynamics contract. This page does not
  renormalize $\mathbf m$.
- A zero vector is valid and produces a disabled physical contribution only if the Zeeman term is
  still present; planner output legality is determined by term presence, not vector magnitude.
- The four backend lanes must agree on the physical units and sign. They may differ in storage,
  reduction order, precision, and quadrature realization.

(zeeman-python-api)=
## Python authoring and canonical ProblemIR

The complete constructor, validation, all object parameters, output names, and Jupyter-compatible
examples are owned by {doc}`../../../python-api/interactions/zeeman`. The essential lowering is

```json
{"kind": "zeeman", "B": [0.0, 0.0, 0.1]}
```


### Physical constructor parameter

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Zeeman.B` | `Sequence[float]` | `required` | $\mathrm{T}$ | `length 3; all components finite` | `uniform external magnetic flux density` | `FDM/FEM CPU/GPU` | `energy[].B` (serialized key `B`) |

The key is uppercase `B` in the canonical serialized representation. The planner then resolves
the native field as `[B_x / MU0, B_y / MU0, B_z / MU0]` in A/m. This preserves requested intent
and resolved execution as two distinct provenance records.

(zeeman-problem-ir)=
## ProblemIR and planner contract

`EnergyTermIR::Zeeman` contains exactly one three-component `B` vector. The FDM and FEM planners:

1. reject a second Zeeman term with a validation error;
2. divide each component by the same `MU0` constant;
3. store the resolved vector in the native plan as `external_field` in A/m;
4. pass the resolved vector to backend initialization; and
5. use term presence when validating `H_ext`, `E_ext`, and `eden_ext` outputs.

The planner does not select a different physical equation for CPU or GPU. Unsupported
combinations and unavailable output materialization are validation errors, not silent fallbacks.

(zeeman-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical export preserves the requested intent: `B` remains a tesla vector and is not replaced
by the resolved A/m vector. Resolved execution metadata must separately record the native field,
solver, device, precision, and runtime capability decision.

The following are validation errors: a vector with the wrong length, a non-finite component,
duplicate Zeeman terms, an output that is not materializable by the selected executable lane, or a
backend request that cannot satisfy the complete problem. Unsupported combinations are reported
by the planner; they are never silently converted to another interaction or backend.

(zeeman-discrete-realization)=
## Discrete realization

### FDM CPU reference

For cell $i$, the reference lane uses

```{math}
:label: eq-zeeman-fdm-cpu
E_Z^{\mathrm{FDM}}
=
-\mu_0\sum_{i=1}^{N}
M_{s,i}\,\mathbf m_i\cdot\mathbf H_{\mathrm{ext},i}\,V_i,
\qquad
\mathbf H_{\mathrm{ext},i}=\frac{\mathbf B_{\mathrm{ext}}}{\mu_0}
\quad\text{for active cells}.
```

The field contribution is added componentwise to `H_eff` only for active cells. The energy
routine evaluates the same external field and multiplies each density by the Cartesian cell
volume. A per-node or Oersted field may be added by a different field source; it is not a new
parameter of `Zeeman(B)`.

### FDM GPU

The CUDA lane receives the resolved H vector and performs the same additive field operation in
device storage. Its energy path reduces the local Zeeman contribution with the CUDA reduction
policy. FP32 and FP64 are different numerical realizations; they must be reported separately.
Source presence is not executed-device qualification. A parity claim requires a current device,
the same input and tolerance policy, and an observed field/energy comparison.

### FEM CPU

The FEM lane first broadcasts the resolved vector to the nodal field `h_ext_xyz`, then adds it to
the effective field. With scalar $M_s$ and lumped nodal weights, the implemented reduction is

```{math}
:label: eq-zeeman-fem-cpu-lumped
E_Z^{\mathrm{FEM,lump}}
=
-\mu_0\sum_{i=1}^{N}
M_{s,i}\,\mathbf m_i\cdot\mathbf H_{\mathrm{ext},i}\,w_i^{\mathrm{lump}}.
```

When a spatial element $M_s$ field is active, the CPU path uses the saturation-weighted
element-quadrature mass bilinear rather than pretending that a scalar nodal fallback is exact.
This distinction must be present in provenance and validation reports.

### FEM GPU

The FEM GPU lane uploads the nodal field, magnetization, saturation magnetization, lumped mass,
and magnetic-node mask. The RK effective-field stage accumulates the field on device. The final
external-energy stage launches a per-block Zeeman kernel and then reduces block sums on device:

```{math}
:label: eq-zeeman-fem-gpu
E_Z^{\mathrm{FEM,GPU}}
=
-\mu_0\sum_{i\in\mathcal M}
M_{s,i}\,\mathbf m_i\cdot\mathbf H_{\mathrm{ext},i}\,w_i^{\mathrm{lump}},
```

where $\mathcal M$ is the magnetic-node mask. Missing device-resident `Ms`, lumped mass, or
`H_ext` is a fail-closed runtime error. The implementation does not silently read host arrays or
fall back to CPU for the device lane.

### Composition with other interactions

The total effective field is additive, schematically

```{math}
:label: eq-zeeman-effective-field-composition
\mathbf H_{\mathrm{eff}}
=
\mathbf H_{\mathrm{ex}}
+\mathbf H_{\mathrm{demag}}
+\mathbf H_Z
+\mathbf H_{\mathrm{other}}.
```

The total energy is likewise a sum of separately owned interaction energies. A regional drive,
Oersted field, or antenna source must retain its own output identity and source mapping even when
its field is added in the same effective-field stage.

(zeeman-implementation-mapping)=
## Implementation mapping

The public constructor and native code are mapped by stable symbols in the adjacent
`index.source-map.json`. The important ownership boundaries are:

- Python `Zeeman` validates the input and lowers `B` without backend selection.
- `plan_fdm` and `plan_fem` resolve `B / MU0`, reject duplicates, and validate requested outputs.
- FDM CPU expands/adds the field and computes external energy.
- FEM CPU separates plan import, field-buffer initialization, field addition, and energy reduction.
- FEM GPU separates device-state upload, RK effective-field accumulation, Zeeman kernel execution,
  and final scalar reduction.

The source index at the end of this page is the human-readable version of the machine-checked
path-plus-symbol map. Line numbers are intentionally omitted because they drift as implementation
changes; stable symbols are the citation identity.

(zeeman-validation)=
## Validation and qualification

### Algebraic checks

For a uniformly magnetized body and uniform input, verify the sign and scale against
$E_Z=-V M_s\mathbf m\cdot\mathbf B_{\mathrm{ext}}$. Reversing $\mathbf B$ must reverse both
$\mathbf H_Z$ and the energy sign. A zero vector must produce zero field and zero energy while
retaining the declared term semantics.

### Cross-lane checks

Use the same mesh/geometry, material, B vector, magnetization, and output request. Compare FDM CPU
against qualified FDM CUDA, and FEM CPU against FEM CUDA, with precision-specific tolerances and
reported reduction order. Compare both field samples and total/spatial energy, not only a final
trajectory.

### Fail-closed checks

Test duplicate declarations, malformed vectors, non-finite components, missing device buffers,
inactive masks, and illegal output requests. A successful source build is not evidence that a
device lane executed or that CPU/GPU parity was demonstrated.

(zeeman-limitations)=
## Limitations and deferred work

- The public uniform constructor does not express regional, spatially varying, or time-dependent
  fields.
- FEM energy can use different exactness paths for scalar versus spatial $M_s$; reports must state
  which path was used.
- CUDA implementation is present, but current revision qualification remains an executed-device
  evidence question.
- Hybrid workflows have no independent physical Zeeman equation; they require explicit provenance
  for each contributing field source.

(zeeman-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- Abert, A., “A self-consistent and complete micromagnetic model of the spin-transfer torque,”
  *Applied Physics Letters* 99, 052505 (2011), for the SI effective-field convention.
- FullMag internal source of truth: `docs/physics/0401-zeeman-external-field.md`.

(zeeman-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Zeeman` | Public `B` validation and `EnergyTermIR` lowering. |
| `crates/fullmag-ir/src/study.rs` | `EnergyTermIR` | Canonical tagged IR family containing the Zeeman variant. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM conversion, duplicate detection, and output legality. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM conversion, duplicate detection, and output legality. |
| `crates/fullmag-plan/src/validate.rs` | `validate_executable_outputs` | Fail-closed materialization checks for external-field outputs. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `external_field_add_into_soa` | Active-cell FDM CPU effective-field addition. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `external_energy_from_fields` | FDM CPU Zeeman energy integration. |
| `backends/fem/cpu/mfem/interactions/zeeman.cpp` | `initialize_zeeman_plan_fields` | Import of resolved FEM plan fields. |
| `backends/fem/cpu/mfem/interactions/zeeman_uniform_field.cpp` | `initialize_uniform_zeeman_field` | Nodal uniform-field buffer initialization. |
| `backends/fem/cpu/mfem/interactions/zeeman_field.cpp` | `add_zeeman_field` | FEM CPU additive effective-field composition. |
| `backends/fem/cpu/mfem/interactions/zeeman_energy.cpp` | `zeeman_energy_from_field` | FEM CPU lumped/quadrature Zeeman energy. |
| `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp` | `initialize_context_gpu_state` | GPU-state and runtime coefficient upload path. |
| `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu` | `gpu_rk_accumulate_effective_field` | Device RK effective-field accumulation including H_ext. |
| `backends/fem/gpu/cuda/interactions/zeeman/zeeman_kernels.cu` | `external_energy_blocks_kernel` | Device Zeeman energy block contributions. |
| `backends/fem/gpu/cuda/integrators/rk/rk_external_energy_reductions.cu` | `gpu_rk_reduce_final_external_energy_terms` | Device final external-energy reduction and fail-closed checks. |
| `crates/fullmag-quantities/src/id.rs` | `QuantityId` | Canonical `H_ext`, `E_ext`, and `eden_ext` identifiers. |
