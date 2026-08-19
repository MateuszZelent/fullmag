---
title: Interfacial Dzyaloshinskii–Moriya interaction
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-interfacial)=
# Interfacial Dzyaloshinskii–Moriya interaction

This is the canonical public physics reference for interfacial Dzyaloshinskii–Moriya
interaction (iDMI). It owns the energy convention, chirality sign, interface normal, effective
field, natural boundary contribution, Python/`ProblemIR` semantics, and all four solver/device
realizations. Bulk DMI is documented separately.

The explicit `fullmag.InterfacialDMI` object remains an `energy_terms` entry. `Material.Dind` and
`Material.Dind_field` are material-owned coefficient routes used by FEM when no explicit scalar
term supplies the coefficient. They are not silently added to an explicit term.

(interfacial-dmi-problem-statement)=
## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf m=\mathbf M/M_s$ the reduced magnetization,
and $\hat{\mathbf n}$ the unit interface-symmetry normal. FullMag uses

```{math}
:label: eq-interfacial-dmi-density
w_{\mathrm i}(\mathbf m,\nabla\mathbf m;D,\hat{\mathbf n})
=D\left[(\mathbf m\cdot\hat{\mathbf n})\,\nabla\cdot\mathbf m
-\mathbf m\cdot\nabla(\mathbf m\cdot\hat{\mathbf n})\right].
```

For the current FDM orientation $\hat{\mathbf n}=\hat{\mathbf z}$ this is

```{math}
:label: eq-interfacial-dmi-z-density
w_{\mathrm i}=D\left[m_z(\partial_xm_x+\partial_ym_y)
-m_x\partial_xm_z-m_y\partial_ym_z\right].
```

The $z$-derivative terms cancel for this fixed axis. FEM retains the complete general-normal
contraction and therefore supports a tilted, non-zero normalized normal.

(interfacial-dmi-governing-equations)=
## Governing equations

```{math}
:label: eq-interfacial-dmi-energy
E_{\mathrm i}[\mathbf m]=\int_{\Omega_m}w_{\mathrm i}\,\mathrm dV.
```

Writing $G_{ab}=\partial_bm_a$ and $m_n=\mathbf m\cdot\hat{\mathbf n}$, the first variation
implemented by the FEM residual is

```{math}
:label: eq-interfacial-dmi-variation
\delta E_{\mathrm i}(\mathbf m;\mathbf v)
=\int_{\Omega_m}\left[
D\left(\hat{\mathbf n}\,\nabla\cdot\mathbf m-(\nabla\mathbf m)^T\hat{\mathbf n}\right)\cdot\mathbf v
+D\left(m_nI-\hat{\mathbf n}\otimes\mathbf m\right):\nabla\mathbf v
\right]\mathrm dV.
```

After integration by parts, the volume effective field is

```{math}
:label: eq-interfacial-dmi-effective-field
\mathbf H_{\mathrm i}
=-\frac{1}{\mu_0M_s}\frac{\delta E_{\mathrm i}}{\delta\mathbf m}
=\frac{2D}{\mu_0M_s}\left[\nabla(\mathbf m\cdot\hat{\mathbf n})
-(\nabla\cdot\mathbf m)\hat{\mathbf n}\right].
```

For $+\hat{\mathbf z}$:

```{math}
:label: eq-interfacial-dmi-z-effective-field
\mathbf H_{\mathrm i}=\frac{2D}{\mu_0M_s}
\begin{bmatrix}\partial_xm_z\\\partial_ym_z\\-(\partial_xm_x+\partial_ym_y)\end{bmatrix}.
```

The integrated variation also contains the natural boundary contribution

```{math}
:label: eq-interfacial-dmi-boundary-variation
\delta E_{\mathrm i}^{\partial\Omega}
=D\int_{\partial\Omega_m}
\left[(\hat{\mathbf n}\times\boldsymbol\nu)\times\mathbf m\right]\cdot\mathbf v\,\mathrm dS,
```

with $\boldsymbol\nu$ the outward magnetic-boundary normal. When exchange is present, the free
boundary stationarity law is

```{math}
:label: eq-interfacial-dmi-exchange-boundary
2A\,\partial_{\boldsymbol\nu}\mathbf m
+D\left[(\hat{\mathbf n}\times\boldsymbol\nu)\times\mathbf m\right]=\mathbf0.
```

The native FEM weak residual contains the volume first variation and therefore carries the
natural boundary physics. Adding a separate identical DMI boundary term would double-count it.

(interfacial-dmi-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | physical magnetization $M_s\mathbf m$ | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf v$ | admissible variation/test field | $1$ |
| $\hat{\mathbf n}$ | normalized interface normal | $1$ |
| $\boldsymbol\nu$ | outward magnetic-boundary normal | $1$ |
| $D$ | interfacial DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $A$ | exchange stiffness in the coupled boundary law | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $G_{ab}$ | gradient component $\partial_bm_a$ | $\mathrm{m^{-1}}$ |
| $m_n$ | projection $\mathbf m\cdot\hat{\mathbf n}$ | $1$ |
| $w_{\mathrm i}$ | local iDMI energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm i}$ | total iDMI energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm i}$ | iDMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM lumped nodal integration weight | $\mathrm{m^3}$ |
| $g_i$ | assembled FEM residual at node $i$ | $\mathrm{J}$ |
| $i$ | discrete cell or node index | $1$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell sizes | $\mathrm{m}$ |
| $\partial_a$ | derivative with respect to coordinate $x_a$ | $\mathrm{m^{-1}}$ |
| $I$ | three-dimensional identity tensor | $1$ |

(interfacial-dmi-assumptions-and-validity)=
## Assumptions and validity

- `D` is a surface-energy coefficient in $\mathrm{J\,m^{-2}}$, not exchange stiffness or
  volume anisotropy.
- `M_s` is finite and positive; the field scales as $1/M_s$ and the energy has no hidden $\mu_0$.
- The public normal is length three and finite. FEM rejects zero and normalizes any other non-zero
  vector. FDM rejects every orientation except one equivalent to $+\hat{\mathbf z}$.
- A missing normal resolves to $(0,0,1)$ in FEM and is the only executable FDM orientation.
- FDM uses centered differences and substitutes the center value for inactive/non-periodic missing
  neighbors. This is an implemented stencil closure, not a general continuum boundary proof.
- FEM evaluates the weak residual at quadrature points and projects the field with lumped mass.
- FEM `Dind_field` length and finite values are validated against the resolved mesh; it is not an
  arbitrary-length Python interpolation array.

(interfacial-dmi-python-api)=
## Python API

The constructor and IR contract are in
{doc}`../../../python-api/interactions/interfacial-dmi`. In the stage-first body API, assigning
`Dind` activates the interfacial-DMI term. This complete thin-film scenario starts from a Neel
skyrmion texture, declares the canonical FDM interface orientation implicitly as $+\hat{\mathbf z}$,
and records the realized DMI field and energy during relaxation.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Thin-film FDM study
study = fm.study("interfacial_dmi_neel_skyrmion")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))

# %% Geometry, material, initial texture, and interactions
film = study.geometry(
    fm.Box(size=(128 * nm, 128 * nm, 1 * nm), name="film"),
    name="film",
)
film.Ms = 5.8e5
film.Aex = 15.0e-12
film.Dind = 3.0e-3
film.alpha = 0.3
film.m = fm.texture.neel_skyrmion(
    radius=24 * nm,
    wall_width=8 * nm,
    chirality=1,
    core_polarity=-1,
)
study.exchange()
study.demag()

# %% Ordered relaxation stage and DMI observables
study.stages.add_relax(
    stage_id="relax_skyrmion",
    algorithm="projected_gradient_bb",
    max_steps=2_000,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=20,
            quantities=[
                "step",
                "mx",
                "my",
                "mz",
                "e_ex",
                "e_demag",
                "e_dmi",
                "e_total",
                "max_torque_T",
            ],
        ),
        fields=[fm.FieldAutosave("H_dmi", every_steps=50)],
    )
)
```

The public interaction matrix is:


| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `InterfacialDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite | scalar interfacial DMI coefficient and chirality sign | FDM/FEM CPU/GPU | `energy_terms[].D` for `kind=interfacial_dmi` |
| `InterfacialDMI.interface_normal` | `Sequence[float] \| None` | `None` | $1$ | length 3; finite; FEM non-zero; FDM normalized +z only | interface symmetry axis | FDM +z; FEM any non-zero normalized axis | `energy_terms[].interface_normal` when supplied |
| `Material.Dind` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied; FEM planner resolves active value | material-owned scalar iDMI coefficient | FEM CPU/GPU; not a native FDM scalar route | `materials[].interfacial_dmi` |
| `Material.Dind_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | FEM node cardinality and finite values validated downstream | spatial nodal iDMI coefficient | FEM CPU/GPU | `materials[].dind_field` |

(interfacial-dmi-problem-ir)=
## ProblemIR

An explicit term lowers to:

```json
{"kind": "interfacial_dmi", "D": 0.003, "interface_normal": [0.0, 0.0, 1.0]}
```

If the normal is omitted, the key is absent in Python IR and the FEM planner resolves the
normalized default. A material-owned route is separate:

```json
{"interfacial_dmi": 0.003, "dind_field": null}
```

The explicit term and material fallback are alternative resolution inputs, not summed energy
terms. Requested intent, normalized normal, coefficient location, solver, device, precision, and
output decisions belong in resolved provenance.

(interfacial-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical script export preserves whether the user authored an explicit `InterfacialDMI` term or
material-owned `Dind`/`Dind_field`. Resolved execution records the backend-selected coefficient
route and normalized FEM normal; it must not invent a rotated FDM stencil.

Validation errors include non-finite coefficients, malformed/zero normals, non-`+z` FDM normals,
duplicate iDMI terms, invalid `Dind_field` cardinality or values, missing FEM mesh/context, and
missing GPU-resident buffers. Unsupported combinations are planner/runtime errors, not silent
fallbacks.

(interfacial-dmi-discrete-realization)=
## Discrete realization

### FDM CPU

For active cell $i$ the double-precision reference uses

```{math}
:label: eq-interfacial-dmi-fdm-field
\mathbf H_{\mathrm i,i}=\frac{2D}{\mu_0M_{s,i}}
\begin{bmatrix}\delta_xm_z\\\delta_ym_z\\-(\delta_xm_x+\delta_ym_y)\end{bmatrix}_i,
\qquad
E_{\mathrm i}^{\mathrm{FDM}}=\sum_{i\in\mathcal A}D
\left[m_z(\delta_xm_x+\delta_ym_y)-m_x\delta_xm_z-m_y\delta_ym_z\right]_iV_i.
```

$\delta_x$ and $\delta_y$ use $1/(2\Delta x)$ and $1/(2\Delta y)$. Periodic axes wrap;
inactive or non-periodic missing neighbors are replaced by the center cell. Inactive cells have
zero field and energy.

### FDM GPU

FP64 and FP32 CUDA `combine_effective_field` kernels compute the same local stencil, periodic
neighbor indices, inactive-neighbor clamping, and $2/(\mu_0M_s)$ scaling in the fused effective
field. `dmi_energy_blocks_kernel` separately computes the density and multiplies by cell volume
before reduction. FP32 changes arithmetic precision only. Kernel presence is not executed-device
qualification.

### FEM CPU

The MFEM path interpolates $\mathbf m_q$ and $\nabla\mathbf m_q$, averages nodal `Dind_field` when
present, and accumulates

```{math}
:label: eq-interfacial-dmi-fem-residual
R_{\mathrm i,h}(\mathbf m_h;\mathbf v_h)=\sum_{e,q}w_{e,q}
\left[\frac{\partial w_{\mathrm i}}{\partial\mathbf m}\cdot\mathbf v_h
+\frac{\partial w_{\mathrm i}}{\partial\nabla\mathbf m}:\nabla\mathbf v_h\right]_{e,q}.
```

The effective field is recovered from the residual by

```{math}
:label: eq-interfacial-dmi-fem-projection
\mathbf H_{\mathrm i,h,i}=-\frac{\mathbf g_{\mathrm i,h,i}}
{\mu_0M_{s,i}w_i^{\mathrm{lump}}}.
```

The energy is the direct quadrature sum of $w_{\mathrm i}$, not a second reduction of the
projected field. Missing MFEM context, FE space, mesh, or lumped mass is a fail-closed error.

### FEM GPU

The CUDA tetrahedral kernel computes element gradients, volume, quadrature magnetization, and the
general-normal residual. It averages `Dind_field` over tetrahedral nodes, atomically accumulates
residual and energy, and the RK layer uses device-resident $M_s$, lumped mass, geometry, and field
buffers. Missing resources are errors; no CPU fallback is implied.

### Backend matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Centered differences, `+z`, active-neighbor clamping, cell-volume energy. |
| FDM | GPU | implemented | FP64/FP32 fused field and DMI energy reductions; runtime parity is separate. |
| FEM | CPU | implemented | MFEM weak residual, material field, lumped projection, quadrature energy. |
| FEM | GPU | implemented | Device tetrahedral residual, field dispatch, and final reduction; runtime evidence required. |

### Observables

| Observable | Kind | SI unit | Meaning |
|---|---|---|---|
| `H_dmi` | vector field | $\mathrm{A\,m^{-1}}$ | total DMI field, potentially combining bulk and interfacial terms |
| `H_DMI` | vector field | $\mathrm{A\,m^{-1}}$ | FEM interfacial field |
| `E_dmi` | scalar | $\mathrm{J}$ | iDMI energy contribution |
| `eden_dmi` | spatial scalar | $\mathrm{J\,m^{-3}}$ | local iDMI density |

(interfacial-dmi-implementation-mapping)=
## Implementation mapping

The adjacent source map binds each claim to stable path-plus-symbol identities. `InterfacialDMI`
and `Material` own authoring; `plan_fdm` owns strict `+z` legality; `plan_fem` owns normal and
material-field resolution; FDM CPU/CUDA own stencil/reduction; FEM CPU/CUDA own weak residual,
projection, device field, and energy reduction.

(interfacial-dmi-validation)=
## Validation

Verify uniform magnetization gives zero volume field and density; $D\to-D$ reverses field and
energy; linear $m_z(x,y)$ reproduces field signs; chiral wall reflection changes energy sign;
FEM satisfies $-\mu_0\sum_iM_{s,i}w_i^{\mathrm{lump}}\mathbf H_i\cdot\mathbf v_i=R_{\mathrm i,h}$;
finite differences of FEM energy match the residual; tilted FEM normals are normalized; and
non-`+z` FDM normals are rejected. GPU qualification requires device identity, executed kernels,
matched state/precision, and a documented tolerance.

(interfacial-dmi-limitations)=
## Limitations

- FDM supports only the canonical `+z` interface normal.
- Spatial normal fields, tensor DMI, curved-surface corrections, and region-interface DMI are not
  public semantics.
- `Dind_field` is currently a FEM material realization, not a native FDM scalar-field route.
- FEM uses element-averaged nodal `Dind_field`; higher-order coefficient quadrature and consistent
  mass projection remain deferred.
- Explicit user-selectable non-natural DMI boundary operators are not implemented here.

(interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

- Rohart, S. and Thiaville, A., “Skyrmion stability, metastability and dynamics in ultrathin
  magnetic films,” *Physical Review B* **88**, 184422 (2013), DOI:
  `10.1103/PhysRevB.88.184422`.
- Bogdanov, A. N. and Rößler, U. K., “Chiral symmetry breaking in magnetic thin films and
  multilayers,” *Physical Review Letters* **87**, 037203 (2001), DOI:
  `10.1103/PhysRevLett.87.037203`.
- FullMag canonical note: `docs/physics/0404-interfacial-dmi.md`.

(interfacial-dmi-source-code-index)=
## Source-code index

| Claim/equation | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | constructor and term IR | Python |
| Material route | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | `Dind`/`Dind_field` IR | Python/FEM |
| Vector validation | `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | vector validation | Python |
| FDM plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | scalar resolution and legality | FDM |
| FDM normal | `crates/fullmag-plan/src/fdm.rs` | `fdm_supports_interfacial_dmi_normal` | `+z` predicate | FDM |
| FEM plan | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | normal/material resolution | FEM |
| FEM material checks | `backends/fem/core/fem_material_fields.cpp` | `validate_material_fields` | field length/value checks | FEM |
| FDM CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `interfacial_dmi_field` | centered-difference field | FDM CPU |
| FDM CPU energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `dmi_energy_from_soa` | cell-volume energy | FDM CPU |
| FDM FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused field | FDM GPU |
| FDM FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | fused field | FDM GPU |
| FDM energy | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_dmi_energy_fp64` | energy reduction | FDM GPU |
| FEM CPU | `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp` | `compute_interfacial_dmi_field` | residual/projection/energy | FEM CPU |
| FEM residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_interfacial_residual` | residual action | FEM CPU/GPU contract |
| FEM projection | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_project_lumped_field` | field projection | FEM CPU |
| FEM CUDA kernel | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | device residual/energy | FEM GPU |
| FEM CUDA field | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` | `gpu_rk_compute_dmi_field_contributions` | field dispatch | FEM GPU |
| FEM CUDA energy | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu` | `gpu_rk_reduce_final_dmi_energy_terms` | final reduction | FEM GPU |
