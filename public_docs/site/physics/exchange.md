---
title: Exchange interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0400-fdm-exchange-demag-zeeman.md
---

(public-docs-physics-exchange)=
# Exchange interaction

:::{admonition} Review candidate
:class: note

This is the first FullMag interaction page written against the implementation hierarchy. It is
ready for scientific and editorial review, but it does **not** claim that every backend is
qualified. In particular, current-revision executed-device proof is missing for FDM CUDA Exchange
and for the newest mixed-element FEM CUDA path.
:::

(problem-statement)=
## Physical problem

The exchange interaction penalizes spatial variation of the reduced magnetization
$\mathbf m=\mathbf M/M_s$. In the bulk micromagnetic model used by FullMag, the exchange
stiffness $A>0$ favors parallel neighboring magnetization and contributes both an energy
$E_{\mathrm{ex}}$ and an effective field $\mathbf H_{\mathrm{ex}}$. The physical contract is
shared, but its finite-difference and finite-element realizations are not interchangeable
implementation details.

This page describes only bulk exchange on conforming magnetic domains. It does not silently fold
surface exchange, RKKY/interlayer exchange, atomistic exchange, or nonconforming contact coupling
into the bulk coefficient $A$.

(governing-equations)=
## Governing equations

For magnetic domain $\Omega_m$, the implemented continuum energy is

```{math}
:label: eq-exchange-energy
E_{\mathrm{ex}}[\mathbf m]
=
\int_{\Omega_m} A(\mathbf x)\,\nabla\mathbf m:\nabla\mathbf m\,\mathrm dV
=
\int_{\Omega_m} A(\mathbf x)\sum_{q\in\{x,y,z\}}|\nabla m_q|^2\,\mathrm dV.
```

The effective field follows the FullMag SI convention

```{math}
:label: eq-exchange-effective-field-definition
\mathbf H_{\mathrm{ex}}
=
-\frac{1}{\mu_0M_s}\frac{\delta E_{\mathrm{ex}}}{\delta\mathbf m}
=
\frac{2}{\mu_0M_s}\nabla\!\cdot\!\left(A\nabla\mathbf m\right).
```

For constant $A$, this becomes

```{math}
:label: eq-exchange-constant-a
\mathbf H_{\mathrm{ex}}
=
\frac{2A}{\mu_0M_s}\nabla^2\mathbf m.
```

The energy derivative and field must satisfy

```{math}
:label: eq-exchange-directional-derivative
\delta E_{\mathrm{ex}}[\mathbf m;\boldsymbol\eta]
=
-\mu_0\int_{\Omega_m}M_s\mathbf H_{\mathrm{ex}}\cdot\boldsymbol\eta\,\mathrm dV
=
2\int_{\Omega_m}A\nabla\mathbf m:\nabla\boldsymbol\eta\,\mathrm dV.
```

The free-surface condition used by the implemented bulk operator is the natural zero-flux
condition

```{math}
:label: eq-exchange-neumann
A\,\partial_n\mathbf m
=
A(\nabla\mathbf m)\mathbf n
=
\mathbf 0
\qquad\text{on }\partial\Omega_m.
```

(symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $m_q$ | Cartesian component of $\mathbf m$ | $1$ |
| $A(\mathbf x)$ | bulk exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $E_{\mathrm{ex}}$ | exchange energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{ex}}$ | exchange effective field | $\mathrm{A\,m^{-1}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\partial\Omega_m$ | magnetic integration boundary | $\mathrm{m^2}$ |
| $\mathbf n$ | outward unit normal | $1$ |
| $\boldsymbol\eta$ | admissible magnetization variation | $1$ |
| $i,j$ | discrete cell or node indices | $1$ |
| $N_6(i)$ | six Cartesian neighbors of FDM cell $i$ | $1$ |
| $r_i$ | material-region index of cell $i$ | $1$ |
| $A_{r_ir_j}$ | realized exchange coefficient of FDM link $i\!\leftrightarrow\!j$ | $\mathrm{J\,m^{-1}}$ |
| $\Delta_{ij}$ | center-to-center grid spacing along link $i\!\leftrightarrow\!j$ | $\mathrm{m}$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $\varphi_i$ | magnetic volume fraction of cell $i$ | $1$ |
| $f_{i\to j}$ | directed magnetic face fraction | $1$ |
| $\delta_{i,d}$ | T1 boundary distance correction on side $d$ | $\mathrm{m}$ |
| $\delta_{\min}$ | positive lower bound applied to T1 boundary distances | $\mathrm{m}$ |
| $\varphi_{\mathrm{floor}}$ | positive lower bound applied to magnetic volume fraction | $1$ |
| $\phi_i$ | scalar FEM basis function | $1$ |
| $K_A$ | exchange stiffness matrix | $\mathrm{J}$ |
| $M_V$ | geometric FEM mass matrix | $\mathrm{m^3}$ |
| $M_{M_s}$ | saturation-weighted FEM mass matrix | $\mathrm{A\,m^2}$ |
| $\mathbf q$ | consistent-mass projected exchange residual | $\mathrm{T}$ |
| $V_i^{\mathrm{lump}}$ | lumped nodal FEM volume | $\mathrm{m^3}$ |

(assumptions-and-validity)=
## Assumptions and validity

- Continuum micromagnetics is assumed; the mesh must resolve the relevant exchange length and
  magnetization variation.
- Geometry coordinates are interpreted in metres. The Python authoring path emits SI geometry, but
  the native FEM mesh importer does not independently attach a unit tag to coordinates.
- The reduced magnetization is expected to remain normalized by the surrounding solver contract.
- The bulk free boundary is homogeneous Neumann. User-selected exchange Dirichlet data are not part
  of the current public `Exchange()` term.
- A conforming FEM H1 space makes $\mathbf m$ continuous across conforming material interfaces;
  the weak form implies normal flux continuity. This is not a model for discontinuous inter-body
  contact exchange.
- FDM sub-cell corrections T0 and T1 are separate FP64 CUDA realizations. They must not be inferred
  for the CPU reference lane or FP32 CUDA lane.

(python-authoring)=
(python-api)=
## Python authoring and canonical ProblemIR

Exchange has no numerical parameter on `Exchange()` itself. The physical coefficient belongs to
the material: `Material.A` is the bulk exchange stiffness in
$\mathrm{J\,m^{-1}}$, while `Material.Ms` is the saturation magnetization in
$\mathrm{A\,m^{-1}}$. This separation is intentional: the energy-term list enables the
interaction, and each magnetic material supplies the coefficient used on its domain.

### Complete, copyable example

The following block is both a regular Python script and a Jupyter-compatible sequence of `# %%`
cells. It builds an exchange-only problem, requests the exchange field and energy, and prints the
canonical IR without launching a solver.

```python
# %% Imports and SI constants
import json
import fullmag as fm

nm = 1.0e-9
ps = 1.0e-12

# %% Geometry and material
geometry = fm.Box(size=(40 * nm, 20 * nm, 5 * nm), name="film")
material = fm.Material(
    name="Permalloy",
    Ms=800.0e3,       # A/m
    A=13.0e-12,       # J/m
    alpha=0.01,       # dimensionless
)
magnet = fm.Ferromagnet(
    name="film",
    geometry=geometry,
    material=material,
    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
)

# %% Exchange, outputs, and both discretization hints
study = fm.TimeEvolution(
    dynamics=fm.LLG(),
    outputs=[
        fm.SaveField("H_ex", every=1 * ps),
        fm.SaveScalar("E_ex", every=1 * ps),
    ],
)
problem = fm.Problem(
    name="exchange_only",
    magnets=[magnet],
    energy=[fm.Exchange()],
    study=study,
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2 * nm, 2 * nm, 1 * nm)),
        fem=fm.FEM(order=1, maximum_element_size=2 * nm),
    ),
)

# %% Canonical, runtime-independent lowering
problem_ir = problem.to_ir(include_geometry_assets=False)
print(json.dumps(problem_ir, indent=2))
```

`problem.to_ir(...)` validates and lowers authoring objects; it does not select a concrete CPU or
GPU runtime. The planner resolves that later from `backend_policy`, installed capabilities, and
the requested execution context.

### Exchange-facing parameter reference

#### `Exchange()`

| Parameter | Type | Default | SI unit | Validation and meaning | Backend support |
|---|---|---|---|---|---|
| *(none)* | — | — | — | Enables bulk exchange and lowers exactly to `{"kind": "exchange"}`. Supplying any argument is a Python `TypeError`. | FDM CPU reference, FDM CUDA, FEM CPU, and FEM CUDA, subject to the lane qualifications below. |

#### `Material(...)` parameters relevant to Exchange

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Ms` | `float` | `required` | $\mathrm{A\,m^{-1}}$ | `finite and > 0` | Saturation magnetization; exchange field scales through $1/M_s$. | `all lanes; spatial realization differs` | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | `required` | $\mathrm{J\,m^{-1}}$ | `finite and > 0; unusual-SI warning outside [1e-14, 1e-8]` | Bulk exchange stiffness; no silent unit conversion. | `all lanes; heterogeneous realization differs` | `materials[].exchange_stiffness` |
| `Material.Ms_field` | `list[float] \| None` | `None` | $\mathrm{A\,m^{-1}}$ | `mesh cardinality and lane legality validated downstream` | Optional spatial values overriding scalar `Ms`. | `FEM lanes and allocating FDM CPU reference; persistent FDM SoA/native CUDA do not realize it` | `materials[].ms_field` |
| `Material.A_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-1}}$ | `mesh cardinality and lane legality validated downstream` | Optional spatial values overriding scalar `A`; not an FDM pair-coefficient LUT. | `FEM lanes and allocating FDM CPU reference; persistent FDM SoA/native CUDA do not realize it` | `materials[].a_field` |

### Exchange observables

| Observable | Kind | SI unit | Legality |
|---|---|---|---|
| `H_ex` | field | $\mathrm{A\,m^{-1}}$ | Requires `Exchange()` and an executable path that can materialize the field. |
| `E_ex` | scalar | $\mathrm{J}$ | Requires `Exchange()` and an executable path that can materialize the scalar. |

### FDM boundary controls relevant to Exchange

| Python | Type | Default | SI unit | Meaning and validation |
|---|---|---|---|---|
| `FDM.boundary_correction` | `str \mid None` | `None` | $1$ | Optional `T0`/`T1`-family sub-cell policy. Support differs by precision and device as documented below. |
| `FDM.boundary_phi_floor` | `float \mid None` | `None` | $1$ | Optional lower bound $\varphi_{\mathrm{floor}}$ with strict domain $0<\varphi_{\mathrm{floor}}<1$. |
| `FDM.boundary_delta_min` | `float \mid None` | `None` | $\mathrm{m}$ | Optional T1 distance floor $\delta_{\min}\geq0$; zero is accepted. |

### Supporting Python API

The constructors used by the executable example are documented in their canonical owner pages:
{doc}`../python-api/materials/material`, {doc}`../python-api/geometry/primitives`,
{doc}`../python-api/magnets-and-textures/ferromagnet`,
{doc}`../python-api/magnets-and-textures/uniform-texture`,
{doc}`../python-api/studies/time-evolution`, {doc}`../python-api/dynamics/llg`,
{doc}`../python-api/outputs/fields-and-scalars`,
{doc}`../python-api/discretization/discretization-hints`,
{doc}`../python-api/discretization/fdm`, {doc}`../python-api/discretization/fem`, and
{doc}`../python-api/problem/problem`. General lowering and canonical-model framing live in
{doc}`../python-api/problem/problem-ir`.

(problem-ir)=
### Canonical ProblemIR excerpt

The example lowers the Exchange-relevant sections exactly as follows (JSON numbers are SI):

```json
{
  "materials": [
    {
      "name": "Permalloy",
      "saturation_magnetisation": 800000.0,
      "exchange_stiffness": 1.3e-11,
      "damping": 0.01,
      "ms_field": null,
      "a_field": null
    }
  ],
  "energy_terms": [
    {"kind": "exchange"}
  ],
  "study": {
    "kind": "time_evolution",
    "dynamics": {
      "kind": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "auto",
      "fixed_timestep": null
    },
    "sampling": {
      "outputs": [
        {"kind": "field", "name": "H_ex", "every_seconds": 1e-12},
        {"kind": "scalar", "name": "E_ex", "every_seconds": 1e-12}
      ]
    }
  },
  "backend_policy": {
    "requested_backend": "auto",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {"cell": [2e-9, 2e-9, 1e-9], "default_cell": [2e-9, 2e-9, 1e-9]},
      "fem": {"order": 1, "hmax": 2e-9, "mesh": null},
      "hybrid": null
    }
  },
  "validation_profile": {"execution_mode": "strict"}
}
```

The excerpt intentionally omits unrelated `null` material fields and geometry detail; it is not a
replacement schema. The complete object printed by the Python block is the authoritative payload.

(round-trip-and-failure-semantics)=
### Python-to-IR mapping and failure semantics

| Python authoring value | Canonical IR location | Planner/runtime consequence |
|---|---|---|
| `fm.Exchange()` | `energy_terms[].kind = "exchange"` | Lowering preserves every authored term; FDM and FEM planners reject a second Exchange declaration with `Exchange is declared more than once`. |
| `Material.A` | `materials[].exchange_stiffness` | Supplies $A$ in $\mathrm{J\,m^{-1}}$; no unit conversion or harmonic-mean promise is added by lowering. |
| `Material.Ms` | `materials[].saturation_magnetisation` | Supplies $M_s$ in $\mathrm{A\,m^{-1}}$. |
| `Material.A_field` | `materials[].a_field` | Requests spatial exchange stiffness; unsupported lane combinations fail capability/validation checks. |
| `Material.Ms_field` | `materials[].ms_field` | Requests spatial saturation magnetization; mesh cardinality and lane support remain explicit. |
| `SaveField("H_ex", ...)` | `study.sampling.outputs[]` field record | Rejected if Exchange is absent or the selected executable path cannot materialize the field. |
| `SaveScalar("E_ex", ...)` | `study.sampling.outputs[]` scalar record | Rejected if Exchange is absent or the selected executable path cannot materialize the scalar. |
| FDM/FEM hints | `backend_policy.discretization_hints` | Preserve both authored hints. They do not claim which backend actually ran. |

Python normalization preserves requested intent in `ProblemIR`. Backend, device, precision, and
the concrete exchange realization are resolved later and must appear as resolved execution in
provenance. Constructor and lowering validation errors are raised before planning; capability
validation then rejects unsupported combinations instead of rewriting the authored model.
There is no silent CPU fallback promised by `Exchange()`: an unsupported requested combination is
an error. Likewise, adding `A` without `Exchange()` stores a material property but does not enable
or output exchange physics.

(discrete-realization)=
## Discrete realization by solver and device

### FDM / CPU — double-precision reference lane

This lane is `CpuReference`; it is executable and useful as an oracle, but it is not FullMag's
production FDM backend. The persistent runtime path uses a structure-of-arrays, six-neighbor,
uniform-material stencil:

```{math}
:label: eq-fdm-cpu-exchange-field
\mathbf H_{\mathrm{ex},i}
=
\frac{2A}{\mu_0M_s}
\sum_{d\in\{x,y,z\}}
\frac{\mathbf m_{i+d}-2\mathbf m_i+\mathbf m_{i-d}}{\Delta d^2}.
```

Open or inactive neighbors are replaced by the center magnetization, which yields zero normal
exchange flux. Enabled periodic axes wrap the neighbor index. The hot runtime stencil uses `f64`.
The production reference path is
`crates/fullmag-engine/src/fdm/cpu/fields.rs` —
`exchange_field_add_into_soa`; the richer allocating comparison path is the
same file — `cell_exchange_field`.

The allocating reference accessor also contains a heterogeneous link form

```{math}
:label: eq-fdm-cpu-heterogeneous-link
\mathbf H_{\mathrm{ex},i}
=
\sum_{j\in N_6(i)}
\frac{2A_{ij}}{\mu_0M_{s,i}\Delta_{ij}^{2}}
(\mathbf m_j-\mathbf m_i),
\qquad
A_{ij}=\begin{cases}
\dfrac{2A_iA_j}{A_i+A_j},&A_iA_j>0,\\[4pt]
0,&A_iA_j=0.
\end{cases}
```

That accessor does **not** establish heterogeneous production stepping: the persistent SoA path
uses the scalar material values and does not consume explicit inter-region pair overrides. This is
a documented implementation limitation, not a promised fallback.

### FDM / GPU — native CUDA production implementation

The standard FP64 and FP32 kernels implement

```{math}
:label: eq-fdm-gpu-exchange-field
H_{\mathrm{ex},i}^{q}
=
\frac{2}{\mu_0M_s}
\sum_{j\in N_6(i)}
A_{r_ir_j}\frac{m_j^q-m_i^q}{\Delta_{ij}^{2}},
\qquad q\in\{x,y,z\}.
```

The realized pair coefficient comes from the native exchange lookup table. A caller-supplied table
is copied as supplied; FullMag does not infer a heterogeneous harmonic mean from per-region values
inside the CUDA kernel. Open boundaries clamp to the center; periodic axes wrap for the standard
stencil. FP64 uses double state and arithmetic. FP32 uses float state/field arithmetic while the
energy reduction accumulates in FP64.

Each positive Cartesian link is counted once in the standard discrete energy:

```{math}
:label: eq-fdm-gpu-exchange-energy
E_{\mathrm{ex},h}
=
\sum_i\sum_{d\in\{+x,+y,+z\}}
A_{r_ir_j}\,\varphi_iV_i
\frac{\|\mathbf m_j-\mathbf m_i\|^2}{\Delta d^2}.
```

#### FDM GPU T0 sub-cell correction — FP64 only

```{math}
:label: eq-fdm-gpu-t0-field
\mathbf H_{\mathrm{ex},i}^{T0}
=
\frac{2}{\mu_0M_s\max(\varphi_i,\varphi_{\mathrm{floor}})}
\sum_j A_{ij}f_{i\to j}
\frac{\mathbf m_j-\mathbf m_i}{\Delta_{ij}^{2}}.
```

#### FDM GPU T1 sub-cell correction — FP64 only

For the positive-side link on axis $d$, the exact implemented contribution is

```{math}
:label: eq-fdm-gpu-t1-field
\mathbf H_{i\leftarrow j}^{T1}
=
\frac{2A_{ij}}{\mu_0M_s\max(\varphi_i,\varphi_{\mathrm{floor}})}
\frac{2(\mathbf m_j-\mathbf m_i)}
{\Delta d\,[\Delta d+\max(\delta_{i,-d},\delta_{\min})]}.
```

T0/T1 do not consume periodic flags. FP32 rejects sub-cell correction rather than silently using a
different model. The staged multilayer CUDA path is layer-local, supports FP64 and FP32 entry
points, and presently has no cross-layer exchange, region LUT, or periodic exchange.
The standard device kernels are
`backends/fdm/gpu/cuda/interactions/exchange_fp64.cu` —
`exchange_field_fp64_kernel` and
`backends/fdm/gpu/cuda/interactions/exchange_fp32.cu` —
`exchange_field_fp32_kernel`; T0 and T1 are separate symbols in `exchange_t0_fp64.cu` and
`exchange_t1_fp64.cu`.

### FEM / CPU — native MFEM implementation

FullMag uses one scalar continuous P1 H1 space for each Cartesian component and assembles the
positive-semidefinite diffusion operator

```{math}
:label: eq-fem-exchange-stiffness
(K_A)_{ij}
=
\int_{\Omega_m}A\nabla\phi_i\cdot\nabla\phi_j\,\mathrm dV.
```

Current production assembly is MFEM `AssemblyLevel::LEGACY`: a fully assembled sparse matrix, not
partial assembly and not a libCEED exchange operator. The default lumped projection is

```{math}
:label: eq-fem-cpu-lumped-field
H_{\mathrm{ex},i}^{q}
=
-\frac{2(K_Am_q)_i}
{\mu_0M_{s,i}(M_V\mathbf 1)_i}.
```

The CPU-only consistent-mass option solves

```{math}
:label: eq-fem-cpu-consistent-field
M_{M_s}\mathbf q_q=K_A\mathbf m_q,
\qquad
\mathbf H_{\mathrm{ex},q}=-\frac{2}{\mu_0}\mathbf q_q,
\qquad
(M_{M_s})_{ij}=\int_{\Omega_m}M_s\phi_i\phi_j\,\mathrm dV.
```

The consistent solve uses MFEM conjugate gradients with relative tolerance $10^{-10}$, zero
absolute tolerance, and at most 200 iterations. Forms are restricted to magnetic elements;
air-only nodes are zeroed. Periodicity is imposed by aggregating residual and mass over reduced-node
equivalence classes and lifting the field back to full nodes.
Assembly is implemented by
`backends/fem/cpu/mfem/interactions/exchange_operator.cpp` —
`initialize_exchange_operator_mfem`; field/energy evaluation is in `exchange_field.cpp` —
`compute_exchange_for_magnetization`, and the optional consistent projection is in
`exchange_mass_projection.cpp` — `apply_exchange_component_mass_projection`.

### FEM / GPU — MFEM assembly plus FullMag CUDA CSR kernels

FEM GPU Exchange is FP64. Setup assembles the legacy sparse operator through MFEM on the host,
canonicalizes it as a symmetric graph Laplacian, and uploads CSR and mass data once. Accepted RK
stages apply the operator with FullMag CUDA kernels:

```{math}
:label: eq-fem-gpu-lumped-field
H_{\mathrm{ex},i}^{q}
=
-\frac{2}{\mu_0M_{s,i}V_i^{\mathrm{lump}}}
\sum_j(K_A)_{ij}m_j^q.
```

The device energy is equivalent to the assembled quadratic form

```{math}
:label: eq-fem-gpu-exchange-energy
E_{\mathrm{ex},h}
=
\sum_{q\in\{x,y,z\}}\mathbf m_q^{\mathsf T}K_A\mathbf m_q.
```

The stage path is device-resident after setup and records exchange-specific transfer counters.
Consistent-mass projection is not a GPU realization. libCEED can be present in the runtime bundle,
but it is not the Exchange hot path.
The CUDA operator is
`backends/fem/gpu/cuda/exchange/exchange_kernels.cu` —
`legacy_sparse_exchange_kernel`; RK-stage dispatch is
`backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.cu` —
`gpu_rk_compute_legacy_sparse_exchange`.

(implementation-mapping)=
## Implementation mapping

The stable identity of each citation is repository path plus symbol. Links below are pinned to the
reviewed source revision `a1f4dc0be9f53ece258b881d756db6f727ad5ecc`; displayed line numbers may
be regenerated from the symbol when the code moves.

| Lane | Responsibility | Source identity |
|---|---|---|
| Public API | canonical term | [`packages/fullmag-py/src/fullmag/model/energy.py` — `class Exchange`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/packages/fullmag-py/src/fullmag/model/energy.py#L11) |
| Public API | material-to-IR lowering | `packages/fullmag-py/src/fullmag/model/structure.py` — `class Material` |
| Planner | fail-closed output validation | `crates/fullmag-plan/src/validate.rs` — `validate_executable_outputs` |
| ProblemIR | material coefficient | [`crates/fullmag-ir/src/model.rs` — `MaterialIR::exchange_stiffness`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/crates/fullmag-ir/src/model.rs#L413) |
| FDM CPU | runtime field stencil | [`crates/fullmag-engine/src/fdm/cpu/fields.rs` — `exchange_field_add_into_soa`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/crates/fullmag-engine/src/fdm/cpu/fields.rs#L959) |
| FDM CPU | heterogeneous reference accessor | [`crates/fullmag-engine/src/fdm/cpu/fields.rs` — `cell_exchange_field`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/crates/fullmag-engine/src/fdm/cpu/fields.rs#L171) |
| FDM GPU FP64 | standard field | [`backends/fdm/gpu/cuda/interactions/exchange_fp64.cu` — `exchange_field_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fdm/gpu/cuda/interactions/exchange_fp64.cu#L36) |
| FDM GPU FP32 | standard field | [`backends/fdm/gpu/cuda/interactions/exchange_fp32.cu` — `exchange_field_fp32_kernel`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fdm/gpu/cuda/interactions/exchange_fp32.cu#L32) |
| FDM GPU FP64 | T0 field | [`backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu` — `exchange_field_t0_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu#L28) |
| FDM GPU FP64 | T1 field | [`backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu` — `exchange_field_t1_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu#L39) |
| FDM GPU | energy reductions | [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` — `reduce_exchange_energy_dispatch`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L967) |
| FEM CPU | MFEM operator assembly | [`backends/fem/cpu/mfem/interactions/exchange_operator.cpp` — `initialize_exchange_operator_mfem`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/cpu/mfem/interactions/exchange_operator.cpp#L28) |
| FEM CPU | mass projection | [`backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp` — `apply_exchange_component_mass_projection`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp#L169) |
| FEM CPU | field and energy | [`backends/fem/cpu/mfem/interactions/exchange_field.cpp` — `compute_exchange_for_magnetization`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/cpu/mfem/interactions/exchange_field.cpp#L44) |
| FEM GPU | CSR field kernel | [`backends/fem/gpu/cuda/exchange/exchange_kernels.cu` — `legacy_sparse_exchange_kernel`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/gpu/cuda/exchange/exchange_kernels.cu#L115) |
| FEM GPU | RK dispatch | [`backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.cu` — `gpu_rk_compute_legacy_sparse_exchange`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.cu#L40) |
| FEM GPU | execution plan | [`backends/fem/gpu/cuda/exchange/exchange_plan.cpp` — `gpu_exchange_plan_stage_exchange`](https://github.com/MateuszZelent/fullmag/blob/a1f4dc0be9f53ece258b881d756db6f727ad5ecc/backends/fem/gpu/cuda/exchange/exchange_plan.cpp#L16) |

(validation)=
## Validation status

| Lane | Evidence present in repository | Honest status for this revision |
|---|---|---|
| FDM CPU reference | zero-field, second-difference, inactive-neighbor, periodic stencil, energy decrease and refinement tests | Source/test mapped; no fresh run was performed for this review candidate. Heterogeneous allocating tests do not qualify heterogeneous SoA stepping. |
| FDM GPU CUDA | device-capable FP64 field/energy, CPU–GPU Tier A, FP64–FP32 Tier B and Heun parity tests | Implemented; current-revision executed-device result and device identity were not found. Skip-success tests are not device proof. |
| FEM CPU MFEM | operator symmetry/PSD/nullspace, mixed P1 elements, magnetic-air masking, energy derivatives, spatial coefficients; managed sinusoidal energy-convergence CSV | Strong historical energy/sign evidence; no fresh managed run tied to this review revision. Existing acceptance does not establish pointwise maximum-field convergence. |
| FEM GPU CUDA | MFEM/CUDA FP64 parity tests, device-residency and transfer-audit contracts; historical RTX 4080 SUPER runtime artifacts | Historical tetrahedral runtime identity exists, but it predates the newest mixed-P1 implementation. Current mixed-P1 executed-device qualification remains open. |

The authoritative FEM runtime gate is `just verify-fem-exchange-runtime`. No command was executed
while preparing this review page because the existing recipe rewrites checked-in validation-result
files and the shared worktree contains unrelated user changes.

(limitations)=
## Known limitations and unresolved qualification

- FDM CPU is a double-precision reference engine, not a native production backend.
- The FDM CPU persistent SoA path does not establish per-cell or explicit pair-coupled heterogeneous
  exchange, despite richer allocating helper functions.
- FDM GPU T0/T1 are FP64 and open-boundary only; FP32 fails closed for these corrections.
- FDM staged multilayer exchange is layer-local and has no cross-layer exchange or periodicity.
- FEM CPU currently uses legacy sparse MFEM assembly. It is not partial assembly, hypre, or libCEED
  exchange.
- FEM GPU uses lumped projection only and FP64 CUDA CSR kernels; setup includes host assembly and
  one-time upload.
- Bulk exchange does not implement RKKY, explicit surface exchange, pinned Dirichlet exchange, or
  nonconforming contact coupling.
- Current source-bound executed-device qualification is missing for FDM GPU Exchange and newest
  mixed-P1 FEM GPU Exchange. This page therefore separates implementation availability from
  scientific qualification.

(scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
   [Bibliographic record](https://search.worldcat.org/title/536451).
2. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   National Institute of Standards and Technology, 1999.
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).
3. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
4. T. Schrefl, G. Hrkac, S. Bance, D. Suess, O. Ertl, and J. Fidler, “Numerical methods in
   micromagnetics (finite element method),” in *Handbook of Magnetism and Advanced Magnetic
   Materials*, Wiley, 2007.

(source-code-index)=
## Source-code and test index

| Topic | Implementation symbol | Test or evidence symbol | Status |
|---|---|---|---|
| FDM CPU standard field | `exchange_field_add_into_soa` | `exchange_only_random_to_uniform`; periodic and energy guardrails | Test definitions present; not freshly executed here |
| FDM CPU general accessor | `cell_exchange_field` | spatial $A,M_s$ Taylor consistency tests | Helper validated; runtime SoA equivalence not established |
| FDM GPU FP64 | `exchange_field_fp64_kernel` | `fdm_exchange_fp64_parity`, `fdm_tier_a_compare` | Device-capable tests present; current device run absent |
| FDM GPU FP32 | `exchange_field_fp32_kernel` | `fdm_tier_b_compare` | Device-capable parity test present; current device run absent |
| FDM GPU T0/T1 | `exchange_field_t0_fp64_kernel`, `exchange_field_t1_fp64_kernel` | T0/T1 cases in `fdm_exchange_fp64_parity` | Field/energy smoke present; derivative and geometry qualification incomplete |
| FEM CPU | `initialize_exchange_operator_mfem`, `apply_exchange_component_mass_projection` | `fem_exchange_contract`, `relaxation_energy_derivative_contract` | Broad native contracts plus historical managed energy convergence |
| FEM GPU | `legacy_sparse_exchange_kernel`, `gpu_rk_compute_legacy_sparse_exchange` | CUDA/MFEM parity and transfer-audit cases in `fem_exchange_contract` | Historical device residency; current mixed-P1 qualification incomplete |

The implementation table above is the authoritative path-and-symbol map for this review candidate.
The bibliography is scientific authority; the source index is implementation authority. Neither
substitutes for an executed numerical qualification artifact.
