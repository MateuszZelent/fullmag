---
title: FDM multilayer convolution
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0421-fdm-multilayer-convolution-demag.md
---

(public-docs-physics-interactions-demagnetization-multilayer-convolution)=
# FDM multilayer demagnetizing-field convolution

This page describes the physics, discretization, and public configuration contract for
`multilayer_convolution`. The method computes the demagnetizing field of disconnected
magnetic layers or objects on separate FDM grids. It is not a FEM Poisson or BEM model;
choosing this strategy changes the numerical realization but does not change the physical
definition of the demagnetizing field.

Each magnetic object owns a native FDM grid. The common convolution grid is an FFT supercell used
for pair kernels and transfers; it is neither a material mesh nor a FEM universe mesh. Geometry
translations determine layer offsets, including the signed $z$ offsets used by the kernels. A
public FDM multilayer script therefore needs `study.fdm(..., per_magnet=..., demag=FDMDemag(...))`
and named geometry, but no `study.universe.mesh(...)` dependency.

The `partial` status is intentional. FDM CPU FP64 has local field, energy, reciprocity,
and transfer evidence for the stated case classes. CUDA sources and the ABI contract are
implemented, but without a fresh, complete device comparison the GPU lane must not be
called production-qualified.

(multilayer-convolution-problem-statement)=
## 1. Physical problem

Consider $L$ disconnected ferromagnetic objects. Index $s$ denotes a source layer and
$d$ a destination layer. Each layer has its own regular `native_grid`, cell size
$\mathbf h_s$, origin $\mathbf o_s$, active mask, and magnetization field $\mathbf M_s$.
The only permitted pair-offset convention is
$\boldsymbol\delta_{d,s}=\mathbf o_d-\mathbf o_s$.

The field in a destination layer is the sum of its self contribution and all inter-layer
contributions. FFT convolution accelerates this sum; it does not replace the magnetostatic
tensor with a local approximation. The `scratch_grid` is a computational tool. Physical
position, source-cell size, and destination-cell size remain part of the kernel.

(multilayer-convolution-governing-equations)=
## 2. Governing equations

### 2.1. Continuous model and discrete pair sum

The magnetostatic field is defined by

```{math}
:label: eq-multilayer-public-continuous-field
\mathbf H(\mathbf r)
=-\int_{\Omega_m}\mathcal N(\mathbf r-\mathbf r')
\mathbf M(\mathbf r')\,\mathrm dV'.
```

The implemented FDM contract is a directed source-to-destination pair sum corresponding
to equation (3) of Lepadatu (2019):

```{math}
:label: eq-multilayer-public-discrete-field
\mathbf H_{d,l}
=-\sum_{s=1}^{L}\sum_{\mathbf r_{s,j}\in V_s}
\mathsf N\!\left(
\mathbf r_{d,l}-\mathbf r_{s,j},\mathbf h_d,\mathbf h_s
\right)\mathbf M(\mathbf r_{s,j}).
```

The tensor $\mathsf N$ has six independent components:
$N_{xx}$, $N_{yy}$, $N_{zz}$, $N_{xy}$, $N_{xz}$, and $N_{yz}$. The minus sign
belongs to the field definition. Tensor-vector multiplication in the FFT
domain accumulates the product without that sign, and the field stage applies the negation
exactly once.

### 2.2. Reciprocity and energy

For different cell volumes, reciprocity is volume-weighted:

```{math}
:label: eq-multilayer-public-reciprocity
V_d\,\mathsf N_{d\leftarrow s}(\mathbf q)
=V_s\,\mathsf N_{s\leftarrow d}^{\mathsf T}(-\mathbf q).
```

Simple equality of the two directions is valid only when $V_d=V_s$. The demagnetization
energy over active cells in all layers is

```{math}
:label: eq-multilayer-public-energy
E_{\mathrm d}
=-\frac{\mu_0}{2}\sum_{d=1}^{L}
\sum_{c\in\mathcal A_d}V_{d,c}\,
\mathbf M_{d,c}\mathbin\cdot\mathbf H_{d,c}.
```

The factor $1/2$ removes double counting of pair energy. The field, active mask, volumes,
and precision used by the energy reduction must match the field path.

### 2.3. FFT convolution

Each source layer is transformed once, each ordered pair accumulates a six-component
tensor product, and each destination receives one inverse transform:

```{math}
:label: eq-multilayer-public-fft
\widehat{\mathbf H}_d(\mathbf k)
=-\sum_{s=1}^{L}
\widehat{\mathsf N}_{d\leftarrow s}(\mathbf k)
\widehat{\mathbf M}_s(\mathbf k),
\qquad
\mathbf H_d=\mathcal F^{-1}\!\left[\widehat{\mathbf H}_d\right].
```

One complete operator refresh for $L$ layers therefore has $L$ forward transforms, $L$
inverse transforms, and $L^2$ pair accumulations. These counters describe the demagnetization
operator, not automatically the residency of the complete time integrator.

### 2.4. Transfer between `native_grid` and `scratch_grid`

When native and scratch grids differ, magnetization is transferred by operator $P$:

```{math}
:label: eq-multilayer-public-transfer
\mathbf M(\mathbf r')=\sum_{i\in\mathcal P}w_i\mathbf M(\mathbf r_i).
```

The weights from equations (4)-(5) of Lepadatu are

```{math}
:label: eq-multilayer-public-transfer-weights
w_i=\frac{\widetilde d_i\delta_i}{\widetilde d_T},
\qquad
\widetilde d_T=\sum_{i\in\mathcal P}\widetilde d_i\delta_i,
\qquad
\widetilde d_i=
\frac{\lvert\mathbf h'+\mathbf h\rvert}{2}
-\lvert\mathbf r'-\mathbf r_i\rvert.
```

Returning the field to a native grid must use the volume-adjoint $P^*$:

```{math}
:label: eq-multilayer-public-transfer-adjoint
\left\langle P\mathbf M,\mathbf H_c\right\rangle_{V_c}
=\left\langle\mathbf M,P^*\mathbf H_c\right\rangle_{V_n}.
```

This identity is the work and energy conservation condition. Pointwise field interpolation
alone is not sufficient evidence of a correct transfer.

### 2.5. Irregular Newell tensor for unequal Z thickness

For common $h_x,h_y$ and different $h_{s,z},h_{d,z}$, Appendix A of the publication
defines

```{math}
:label: eq-multilayer-public-newell-a1
N_{xx}(\mathbf s)=
\mathcal L[f;\mathbf h_s,\mathbf h_d](\mathbf s),
\qquad
N_{xy}(\mathbf s)=
\mathcal L[g;\mathbf h_s,\mathbf h_d](\mathbf s).
```

```{math}
:label: eq-multilayer-public-newell-a2
\begin{aligned}
\mathcal L[w;\mathbf h_s,\mathbf h_d](\mathbf s)
=\frac{1}{\tau}
\sum_{\epsilon_1,\epsilon_2=-1}^{1}
(-1)^{|\epsilon_1|+|\epsilon_2|}
\bigl[&-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-h_{s,z})\\
&-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z+h_{d,z})\\
&+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z)\\
&+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-\Delta)\bigr].
\end{aligned}
```

```{math}
:label: eq-multilayer-public-newell-a3
\begin{aligned}
R^2&=x^2+y^2+z^2,
&\tau&=\pi h_xh_yh_{d,z},
&\Delta&=h_{s,z}-h_{d,z},\\
f(x,y,z)&=\frac{(2x^2-y^2-z^2)R}{6}
+\frac{y(z^2-x^2)}{4}
\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)\\
&\quad+\frac{z(y^2-x^2)}{4}
\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right)
-xyz\arctan\!\frac{yz}{xR}.
\end{aligned}
```

```{math}
:label: eq-multilayer-public-newell-a4
\begin{aligned}
g(x,y,z)&=-\frac{xyR}{3}
-\frac{z^3}{6}\arctan\!\frac{xy}{zR}
-\frac{zy^2}{2}\arctan\!\frac{xz}{yR}
-\frac{zx^2}{2}\arctan\!\frac{yz}{xR}\\
&\quad+\frac{y(3z^2-y^2)}{12}
\ln\!\left(1+\frac{2x(x+R)}{y^2+z^2}\right)
+\frac{x(3z^2-x^2)}{12}
\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)\\
&\quad+\frac{xyz}{2}
\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right).
\end{aligned}
```

The remaining components follow by axis permutations consistent with Newell-tensor
symmetry. Appendix A covers unequal Z thickness with a common XY cell size; it does not
justify arbitrary XY offsets or arbitrary, different XY grids.

(multilayer-convolution-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $L$ | number of magnetic layers | $1$ |
| $d,s$ | destination and source layer indices | $1$ |
| $l,j,c,i$ | cell, component, or transfer-point indices | $1$ |
| $\Omega_m$ | magnetic part of the domain | $\mathrm{m^3}$ |
| $V_s$ | source domain or source-cell volume, according to the sum context | $\mathrm{m^3}$ |
| $V_d$ | destination-cell volume | $\mathrm{m^3}$ |
| $V_{d,c}$ | volume of active cell $c$ in destination layer $d$ | $\mathrm{m^3}$ |
| $V_c$ | convolution-cell volume | $\mathrm{m^3}$ |
| $V_n$ | native-cell volume | $\mathrm{m^3}$ |
| $\mathbf r,\mathbf r'$ | observation and source positions in the continuous model | $\mathrm m$ |
| $\mathbf r_{d,l}$ | destination-cell center | $\mathrm m$ |
| $\mathbf r_{s,j}$ | source-cell center | $\mathrm m$ |
| $\mathbf r_i$ | input-cell center for transfer | $\mathrm m$ |
| $\mathbf o_d,\mathbf o_s$ | destination and source grid origins | $\mathrm m$ |
| $\boldsymbol\delta_{d,s}$ | offset $\mathbf o_d-\mathbf o_s$ | $\mathrm m$ |
| $\mathbf q$ | spatial kernel lag | $\mathrm m$ |
| $\mathbf s=(x,y,z)$ | spatial argument of the Appendix A operator | $\mathrm m$ |
| $x,y,z$ | coordinates of the kernel argument | $\mathrm m$ |
| $R$ | distance $\sqrt{x^2+y^2+z^2}$ | $\mathrm m$ |
| $\mathbf h_s,\mathbf h_d$ | source and destination cell sizes | $\mathrm m$ |
| $\mathbf h,\mathbf h'$ | input and scratch transfer-cell sizes | $\mathrm m$ |
| $h_x,h_y$ | common cell sizes along X and Y | $\mathrm m$ |
| $h_{s,z},h_{d,z}$ | source and destination cell thicknesses | $\mathrm m$ |
| $\Delta$ | difference $h_{s,z}-h_{d,z}$ | $\mathrm m$ |
| $\tau$ | normalization $\pi h_xh_yh_{d,z}$ | $\mathrm{m^3}$ |
| $\mathbf M,\mathbf M_s,\mathbf M_{d,c}$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H,\mathbf H_d,\mathbf H_{d,c},\mathbf H_c$ | magnetostatic or demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf M}_s$ | discrete transform of source magnetization | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf H}_d$ | discrete transform of the destination field | $\mathrm{A\,m^{-1}}$ |
| $\mathcal N$ | continuous magnetostatic kernel | $\mathrm{m^{-3}}$ |
| $\mathsf N,\mathsf N_{d\leftarrow s}$ | discrete cell-pair demagnetizing tensor | $1$ |
| $\widehat{\mathsf N}_{d\leftarrow s}$ | discrete transform of the pair tensor | $1$ |
| $N_{xx},N_{yy},N_{zz},N_{xy},N_{xz},N_{yz}$ | six independent tensor components | $1$ |
| $\mathcal F,\mathcal F^{-1}$ | discrete Fourier transform and inverse | $1$ |
| $\mathbf k$ | discrete-transform index or wave vector | $\mathrm{m^{-1}}$ |
| $P,P^*$ | native-to-scratch transfer and volume adjoint | $1$ |
| $\mathcal P$ | set of cells participating in transfer | $1$ |
| $w_i$ | normalized transfer weight | $1$ |
| $\delta_i$ | cell-overlap indicator | $1$ |
| $\widetilde d_i,\widetilde d_T$ | weighted distance and its sum | $\mathrm m$ |
| $\mathcal A_d$ | active-cell set of layer $d$ | $1$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm J$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathcal L$ | irregular Newell corner operator | $1$ |
| $f,g,w$ | Appendix A basis functions | $\mathrm{m^3}$ |
| $\epsilon_1,\epsilon_2$ | corner-sum indices | $1$ |

(multilayer-convolution-assumptions-and-validity)=
## 4. Assumptions, kernel classes, and validity limits

The current public planner accepts disconnected objects with different XY extents and/or
centers by forming the union of their native XY bounds as a **computational** common-scratch
envelope. Native origins, cell sizes, masks, and material objects remain independent; layers
that do not coincide with that envelope use explicit `push_pull` transfer. An explicitly
requested `common_cells` or `common_cells_xy` must contain the union and have a compatible
resolved pitch; a lane that cannot consume the resulting insertion/crop or transfer descriptor
fails closed. This is not the same as evaluating the irregular Newell formula on arbitrary
different XY cells: that formula is only the unequal-Z/common-XY kernel, while lateral
differences are handled by the transfer path. Layers may be separated by arbitrary non-overlapping
Z gaps, but overlapping bodies and periodic axes fail closed until the corresponding pair,
transfer, and exchange-seam classes are qualified.

`two_d_stack` is intended for thin layers with one native Z cell. A layer with multiple Z
cells is rejected: there is no public moment-preserving Z average today, and the planner
does not copy an arbitrary slice. Select `three_d` instead. `common_cells_xy=(N_x,N_y)`
resolves a scratch grid $(N_x,N_y,1)$; `common_cells=(N_x,N_y,N_z)` selects a full 3-D grid.
`two_d_stack` is a Fullmag mode, not a spelling for BORIS `2dmulticonvolution=1` or `=2`:
those BORIS modes remain distinct, unsupported semantics. If both `common_cells` fields are
absent, Fullmag applies planner-auto common-scratch selection and records the resolved layout in
the plan/provenance; the authored `ProblemIR` contains no `common_cells*` fields. This absence is
not an alias for BORIS `ncommonstatus=false`, whose largest-mesh default is a different policy.

The symmetry classes in Lepadatu Table I determine the legal spectral representation:

| Class | Geometry | Spectral representation and storage | Fullmag status |
|---|---|---|---|
| 2D-self | one Z cell, no shift | real diagonal and XY components, reduced | locally verified CPU FP64; no production qualification |
| 3D-self | common cell size | real, reduced | small L=3 local oracle; no independent managed receipt |
| 2D-zShift | common XY, pure Z shift | real diagonal/XY, imaginary XZ/YZ, reduced | locally verified CPU FP64 for both Z signs |
| 3D-zShift | common cell, pure Z shift | complex, reduced | small local oracle; no complete production matrix |
| 2D-full | geometry without shift-only parity | complex, full | not an executable qualified lane |
| 3D-full | general 3-D geometry | complex, full | not an executable qualified lane |

Zero padding must provide at least $n_{\mathrm{src}}+n_{\mathrm{dst}}-1$ samples on each
axis for a linear convolution. The transform descriptor separates physical grids from
`fft_shape`, insertion offsets, lag-zero position, and destination crop. The inverse
transform applies $1/(F_xF_yF_z)$ exactly once.

(multilayer-convolution-python-api)=
## 5. Python API

### 5.1. Complete parameter table

`FDMDemag` selects the numerical realization. `FDMGrid` and `FDM` define native grids.
Physical objects are still created through `study.geometry(...)`; `per_magnet` keys must
match those objects' canonical names.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMGrid.cell` | `Sequence[float]` | `required` | $\mathrm m$ | Exactly three finite, positive values. | Native cell size of one named magnet. | FDM CPU/GPU authoring; execution remains lane-gated. | `backend_policy.discretization_hints.fdm.per_magnet.<name>.cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm m$ | Exactly three positive values; cannot be supplied with `default_cell`. | Backward-compatible alias for the default cell size. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.cell` and normalized `default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm m$ | Exactly three positive values; required when the per-magnet map is incomplete. | Default native cell size. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str,FDMGrid] \| None` | `None` | $1$ | Keys are non-empty names; values must be `FDMGrid`. | Native-grid overrides for named magnets. | FDM multilayer CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | Value must be an `FDMDemag` instance. | Demagnetizing-field realization policy. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag` |
| `FDMDemag.strategy` | `Literal[str]` | `auto` | $1$ | `auto`, `single_grid`, or `multilayer_convolution`. | Requested strategy; an explicit multilayer request cannot silently fall back to single grid. | FDM CPU/GPU authoring; runtime qualified per lane. | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `Literal[str]` | `auto` | $1$ | `auto`, `two_d_stack`, or `three_d`. | Requested mode; `auto` is resolved by the planner after layer geometry is known. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int,int,int] \| None` | `None` | $1$ | Three positive integers; mutually exclusive with `common_cells_xy` and `two_d_stack`. | Explicit full 3-D scratch-grid size. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `tuple[int,int] \| None` | `None` | $1$ | Two positive integers; mutually exclusive with `common_cells` and `three_d`. | Explicit in-plane scratch-grid size for a 2-D stack. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.common_cells_xy` |
| `FDMDemag.explain` | `bool` | `True` | $1$ | Boolean. | Requests a readable plan explanation; it is not physical data and is not serialized by `to_ir()`. | FDM authoring helper. | `not serialized` |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | $1$ | Any value other than `None` raises `ValueError`. | Removed compatibility switch; forbids silent fallback. | Unsupported combinations are rejected. | `not serialized` |

`boundary_correction`, `boundary_phi_floor`, and `boundary_delta_min` belong to the
general FDM partial-cell policy. They are not multilayer-convolution parameters and are not
presented as FFT, padding, or transfer-accuracy controls.

### 5.2. Complete `two_d_stack` example

The example is stage-first, uses SI units, and preserves object names between `per_magnet`
and `study.geometry`. Loading it verifies authoring and lowering; merely placing a stage in
the script is not evidence that a native solver ran.

```python
# %% Imports and study
import fullmag as fm

study = fm.study("fdm_multilayer_two_d_stack_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)

# %% FDM and demagnetization policy
cell = (4e-9, 4e-9, 3e-9)
study.fdm(
    default_cell=cell,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=cell),
        "layer_top": fm.FDMGrid(cell=cell),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(8, 4),
        explain=True,
    ),
)

# %% Domain, geometry, and material
study.universe(
    mode="manual",
    size=(40e-9, 24e-9, 30e-9),
    center=(0.0, 0.0, 4.5e-9),
    padding=(0.0, 0.0, 0.0),
)
bottom = study.geometry(
    fm.Box(size=(32e-9, 16e-9, 3e-9), name="layer_bottom_geom"),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(32e-9, 16e-9, 3e-9), name="layer_top_geom").translate(
        (0.0, 0.0, 9e-9)
    ),
    name="layer_top",
)
for layer in (bottom, top):
    layer.Ms = 8e5
    layer.Aex = 13e-12
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

# %% Interactions, observables, and stage
study.exchange(enabled=True)
study.demag(enabled=True)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.save("H_demag", every=1e-12)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total"],
)
study.stages.add_run(until=1e-12, stage_id="multilayer_run")
```

### 5.3. When to use `three_d`

Set `mode="three_d"` and `common_cells=(N_x,N_y,N_z)` when at least one layer has multiple
native Z cells or when through-thickness texture matters. Do not set `common_cells_xy` at
the same time. For the simplest identity transfer, choose a common grid equal to every
native grid. Different grids activate `push_pull` and require a separate transfer-error
assessment.

(multilayer-convolution-problem-ir)=
## 6. ProblemIR, planner, and provenance

`FDMGrid.to_ir()` normalizes a cell tuple to an SI list. `FDMDemag.to_ir()` writes only
the requested strategy, requested mode, and optional common layout. `explain` does not
change physics and does not enter `ProblemIR`.

The following fragment is the actual serialized shape for an $L=3$ scenario with
`mode="three_d"`:

```json
{
  "backend_policy": {
    "discretization_hints": {
      "fdm": {
        "cell": [3.90625e-09, 3.90625e-09, 3e-09],
        "default_cell": [3.90625e-09, 3.90625e-09, 3e-09],
        "per_magnet": {
          "layer_bottom": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
          "layer_middle": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
          "layer_top": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]}
        },
        "demag": {
          "strategy": "multilayer_convolution",
          "mode": "three_d",
          "common_cells": [16, 8, 2]
        }
      }
    }
  }
}
```

The planner creates one `FdmLayerPlanIR` per object and one `FdmMultilayerPlanIR` for the
realization. Each layer contains stable `layer_id`, `object_id`, native grid, origin, mask,
scratch grid, and `transfer_kind`. `planner_summary` preserves `requested_strategy`,
`selected_strategy`, `requested_mode`, `resolved_mode`, eligibility, and estimates of kernel
count and memory.

### 6.1. UI authoring → generated Python → ProblemIR

The Control Room does not invent a second FDM model. The authoring chain is explicit:

| Stage | Canonical implementation | Mapping |
|---|---|---|
| UI draft | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` — `buildStudyGlobalMergePatch` | Inspector fields `study.fdm.default_cell`, `study.fdm.per_magnet`, `study.fdm.demag`, and the separate `study.demag_enabled` become one scene merge patch. |
| Generated Python | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` — `render_loaded_problem_as_script` | The patch is rendered as `study.fdm(default_cell=..., per_magnet={...}, demag=fm.FDMDemag(...))` plus an independent `study.demag(enabled=True)` call. |
| Per-magnet identity | `study.geometry(..., name="layer_bottom")` → `per_magnet["layer_bottom"]` | The geometry name is the lookup key; it is not a mesh or a generated alias. |
| Python lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` — `FDM.to_ir` | `FDMGrid.cell`, default cell, per-magnet grids, and demag policy lower under `backend_policy.discretization_hints.fdm`. |
| Resolution | `crates/fullmag-plan/src/fdm.rs` — `plan_fdm_multilayer` | The planner resolves mode, origins, common transform layout, transfer kind, pair keys, and eligibility without overwriting authored intent. |

`common_transform_layout` is an API resource describing FFT scratch. It is not a physical
mesh, material body, FEM universe mesh, or field fallback. The public API route is
`GET /v2/sessions/current/data/domain/fdm-multilayer-layout`; unavailable layouts return an
explicit reason. The Explorer omits layout-specific nodes when `available=false` rather than
synthesizing a mesh. Native layer fields use `layer`/`object` scopes; the target-only Airbox
uses `airbox`; no field request projects a common transform layout.

(multilayer-convolution-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

**requested intent** is the authored contract: strategy, mode, per-magnet cells, common
layout, device, and precision. **resolved execution** is the planner/runtime decision:
actual mode, grids, transfers, padding, FFT backend, device, and operator counters. UI
export preserves requested intent as `study.fdm(..., demag=fm.FDMDemag(...))`; it does not
export multilayer as a FEM realization.

**validation errors** are returned for invalid enums, non-positive sizes, simultaneous
`common_cells` and `common_cells_xy`, mode/layout mismatches, missing per-magnet cells,
overlapping layers, an explicit common grid that cannot contain the union of native XY
rectangles, unsupported transfer/boundary combinations, and periodicity.
**unsupported combinations** must be rejected; the planner cannot silently change strategy,
device, precision, boundary conditions, or remove an interaction.

Runtime artifacts must separate requested/resolved demag realization, transfer telemetry,
and CUDA stage telemetry. CUDA `L/L/L²` counters prove the shape of one device demag refresh,
not that the complete integrator was device-resident.

(multilayer-convolution-discrete-realization)=
## 8. Backend realizations

| Solver | Device | Status | What is implemented | What the status does not prove |
|---|---|---|---|---|
| FDM | CPU | `reference-executable`, not production-qualified | FP64, FFT, six-component pairs, identity and push/pull, field and energy; local 2-D/3-D oracles and scoped Airbox convergence. | Does not automatically qualify full-complex, PBC, or every size and offset. |
| FDM | GPU | `implemented`, runtime-unqualified | ABI v2, D-07 plan, cuFFT workspace, and stage telemetry counters exist in source. | Build and ABI contract do not replace fresh executed-device field/energy parity; FP32 has separate thresholds. |
| FEM | CPU | `not-applicable` | None: this method is Newell/FFT Cartesian convolution on FDM grids. | It does not describe Poisson on an Airbox or FEM-BEM. |
| FEM | GPU | `not-applicable` | None for the same physical/numerical reason; FEM GPU has separate magnetostatic realizations. | `multilayer_convolution` cannot be selected as a FEM realization. |

### 8.1. FDM CPU

CPU FP64 is the reference execution lane. `MultilayerDemagRuntime` clears each destination
spectrum, sums all sources, performs the inverse FFT, and pulls the field back to the native
grid. The 2-D lane uses the exact Newell corner sum. General 3-D has an explicitly bounded
asymptotic branch for distant pairs; the oracle scope must therefore be reported with every
result.

### 8.2. FDM CUDA

The native v2 plan stores layer and pair descriptors, creates a compute stream, and prepares
cuFFT workspace. An identity common grid may use device-side D-07; a heterogeneous path may
retain host-authoritative orchestration. Provenance must report that distinction instead of
calling the whole run device-resident.

(multilayer-convolution-implementation-mapping)=
## 9. Enable and control the method in the UI

1. Open the **Study** module in the unified workspace and select the study's global Explorer
   node to open its Inspector.
2. Set **Engine** to `FDM`, **Requested device** to `CPU`, `CUDA`, or `Auto`, **Requested
   precision** to `Double` or `Single`, and keep **Mode**=`Strict` when fallback is forbidden.
3. Enable **Demag enabled**. In **FDM demag**, select **FDM multilayer convolution**.
4. Enter `dx, dy, dz` in metres under **FDM default cell**. Under **FDM per-magnet grids**,
   enter JSON keyed by exact magnet names, for example
   `{"layer_bottom":{"cell":[4e-9,4e-9,3e-9]}}`.
5. For thin, one-cell layers select **FDM demag mode** = **2-D stack** and enter `Nx, Ny`
   under **Common convolution cells XY**. Leave **Common convolution cells** empty.
6. For full 3-D select **3-D** and enter `Nx, Ny, Nz` under **Common convolution cells**.
   Leave the XY field empty. Positive integers are required.
7. Enable **Explain FDM demag plan** to retain a readable planner explanation, then apply the
   draft; the UI validator rejects contradictory parameter pairs.

After materialization, Explorer shows each native layer target as
`fdm-native-layer:<layer-id>`. If a target-only Airbox is published, it appears as a separate
target. Select a layer or Airbox and request quantity `H_demag`; Airbox `H_eff` is explicitly
unavailable and must not be synthesized by the UI.

The viewport supports layer solids, bounds, wireframe, points, and field vectors. A full Airbox
wireframe also includes an interior bounds/volume overlay. A visible image is not by itself
correctness evidence: qualification requires a fresh `compute_fields`, runtime-origin data,
working WebGL, and a non-zero drawing buffer.

### 9.1. Stable implementation mapping

| Responsibility | Path | Symbol | Lane |
|---|---|---|---|
| Python grid | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Public authoring |
| Python demag policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Public authoring |
| Python FDM wrapper | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Public authoring |
| ProblemIR validation | `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR::validate` | Authored and resolved FDM IR |
| Planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | FDM planner |
| CPU runtime | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `execute_reference_fdm_multilayer` | FDM CPU FP64 |
| CPU observation and energy | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `observe_multilayer` | FDM CPU FP64 |
| Push transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `push_m_with_boundary_policy` | FDM CPU transfer |
| Pull transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `pull_h_with_boundary_policy` | FDM CPU transfer |
| Newell diagonal primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_f` | Kernel preparation |
| Newell cross primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_g` | Kernel preparation |
| Shifted Newell builder | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels_shifted` | Shifted pair kernel |
| CUDA v2 plan creation | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_create_v2` | FDM CUDA |
| CUDA FFT workspace | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_prepare_multilayer_fft_workspace_v2` | FDM CUDA |
| UI round-trip model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft` | Control Room authoring |
| UI native-layer adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainMeta` | Explorer/viewport |
| UI Airbox adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | Explorer/viewport |

(multilayer-convolution-validation)=
## 10. Validation and current evidence status

Statuses are disjoint: `implemented` means code is present, `executable` means the contract
can run, `runtime-verified` means a fresh execution, `physically-validated` means an
independent oracle, and `production-qualified` means a complete evidence matrix. A lower
status does not inherit a higher one.

| Scope | Evidence | Status |
|---|---|---|
| CPU 2D-self FP64 | Complete L=1 field, energy, reciprocity, cubature, and self-trace | locally physically-validated; not production-qualified |
| CPU 2D-zShift FP64 | Complete L=2 field for both Z signs, energy, and weighted reciprocity | locally physically-validated; not production-qualified |
| CPU 3D identity FP64 | Small L=3 field, energy, reciprocity, self-trace, and cubature | locally physically-validated; no independent managed receipt |
| CPU push/pull FP64 | Equal and small unequal cases, field, energy, and adjointness | locally physically-validated in the stated scope |
| CPU target-only Airbox | `160×40×18` versus `160×40×24` convergence at common centers | locally runtime-verified and physically-validated for this mesh pair |
| CUDA FP64 | ABI v2 contract, plan creation, and static tests | implemented/executable contract; no fresh device parity |
| CUDA FP32 | Source and runtime path | not runtime-verified and not physically-validated |
| UI/viewport | Round-trip, adapter, Explorer/Inspector, and render-model tests | contract-verified; no fresh post-integration browser/WebGL proof |

An independent oracle should check all six tensor components, lag signs, complete field
coverage, energy, weighted reciprocity, transfer moment, and adjointness. Comparing two paths
that share the same kernel builder is not independent physical evidence.

(multilayer-convolution-limitations)=
## 11. Limitations

- PBC, general XY offsets, and full-complex 2-D/3-D classes are not production-qualified.
- `two_d_stack` cannot represent through-thickness texture without an explicit
  moment-preserving transfer; multi-cell Z fails closed.
- Different XY cells require a transfer grid or rejection; Appendix A does not legalize an
  arbitrary XY difference.
- CPU FP64 is the execution reference but does not replace independent analysis or cubature.
- A CUDA build, cuFFT presence, and a valid ABI are not field/energy parity evidence on a
  concrete GPU.
- Target-only Airbox publishes `H_demag`. `H_eff` outside magnetic support has a versioned
  unavailable reason and is not synthesized.
- SP4-derived scenarios provide traceability and do not change the canonical µMAG Standard
  Problem 4 definition.

## 11.1. BORIS comparison and gap matrix

BORIS is a traceability reference, not a Fullmag oracle. The comparison below records the
observable contract differences against the clean-room manifest
`docs/physics/multilayer_convolution/boris-reference-manifest.v1.json`. Line anchors are
repository snapshots and must be refreshed when the external snapshot changes.

| Contract axis | BORIS snapshot (path and symbol, line anchor) | Fullmag public contract | Qualification or gap |
|---|---|---|---|
| Multilayer versus supermesh choice | `external_solvers/BORIS/Boris/SDemag.h`, multilayer/supermesh comments (L59-L61); `SDemag::Set_Multilayered_Convolution` in `SDemag_MConv.cpp` (L1195-L1202) | `FDMDemag.strategy="multilayer_convolution"` is an explicit requested strategy. There is no hidden conversion to a single-grid supermesh and no public single-grid fallback for a multi-body request. | Fullmag preserves requested intent and fails closed when the requested path is not eligible; BORIS's supermesh option is not a semantic alias. |
| Per-layer `Rect_collection` and scratch rectangles | `SDemag::set_Rect_collection` in `external_solvers/BORIS/Boris/SDemag.cpp` (L98-L179) and `SDemag::get_convolution_rect` (L194-L204); `Initialize_MConv_Demag` in `SDemag_MConv.cpp` (L128-L166) | `FdmLayerPlanIR` keeps native grid/origin/mask and a separate convolution layout. API `FdmCommonTransformLayoutResource` is FFT scratch only; `is_physical_mesh=false` and provenance are explicit. | `common_transform_layout` is computational `CommonTransformLayout`, not a physical mesh, material body, or FEM/universe mesh, and it cannot be used as a field fallback. |
| `n_common` versus physical grid | BORIS `SDemag::set_default_n_common` (L56-L96) and `Set_n_common` (L206-L227) choose common convolution counts; `n_common.z=1` forces the 2-D option. | `FDMDemag.common_cells` and `common_cells_xy` are explicit scratch-grid hints lowered under `backend_policy.discretization_hints.fdm.demag`; they never create a physical layer. | A matching integer tuple does not imply matching semantics: Fullmag native grids and physical origins remain per magnet. |
| `2dmulticonvolution=0/1/2` | `external_solvers/BORIS/Boris/SDemag.h` force-mode comments (L81-L91) define 0=no 2-D, 1=take every mesh as 2-D, and 2=layer each mesh along Z. | Fullmag `mode="two_d_stack"` is **not** BORIS `2dmulticonvolution=1` or `=2`; it is a separate Fullmag mode requiring one native Z cell per layer. A multi-cell-Z request has no public moment-preserving reduction and fails closed with a validation error. | No Fullmag claim maps either BORIS option to `two_d_stack`; use `mode="three_d"` for native through-thickness cells. |
| Arbitrary XY extents, centers, and XYZ offsets | BORIS `SDemag::set_Rect_collection` enlarges/alines rectangles and supports different XY extents/starts (L98-L179); shifted kernels operate on the resulting rectangles. | Planner materializes the union of native XY bounds as one computational scratch envelope and marks layers that need `push_pull`; native origins remain physical. An explicit common grid must contain that union. | Authoring/planner support is present, but the complete transfer, insertion/crop, energy, and CUDA matrix is not production-qualified. Do not draw the union scratch envelope as a material mesh. |
| Arbitrary Z gaps | BORIS pair kernels carry signed shifts through `SDemag_MConv.cpp::UpdateField_MConv_Demag` (L197-L337) and shifted tensor functions. | Non-overlapping layers may have arbitrary Z gaps. The planner quantizes the signed origin difference by resolved convolution-cell thickness for a reuse key; overlapping Z intervals are rejected. | Gap support is planner/runtime scoped and still requires pair-kernel and energy evidence for each claimed geometry class. |
| Unequal source/destination thickness | BORIS `DemagTFunc::CalcDiagTens2D_Shifted_Irregular` in `DemagTFunc_Irregular.cpp` (L5-L119) explicitly supports unequal Z thickness while requiring common XY. | Fullmag's irregular Newell contract is documented for common XY cells and unequal $h_{s,z},h_{d,z}$; the checked pair builder preserves both cell sizes in the oriented kernel. | Pair/oracle tests and a focused CPU unequal-thickness test pass; this does not qualify arbitrary XY transfer, reduced-storage families, or CUDA. |
| Weighted transfer | BORIS `SDemag_Demag::Initialize_Mesh_Transfer` and weighted transfer branch (L63-L87, L282-L295) use mesh-transfer weights. | Fullmag exposes `push_m_with_boundary_policy` and its volume-adjoint `pull_h_with_boundary_policy`; `transfer_kind="push_pull"` is explicit in `FdmLayerPlanIR`. | Transfer correctness requires moment, energy, and adjointness evidence; point interpolation is not enough. |
| Full pair-oriented kernels | BORIS `DemagKernelCollection::KernelMultiplication_2D` and `KernelMultiplication_3D` in `DemagKernelCollection_Mult.cpp` (L635-L735) multiply all ordered inputs; `UpdateField_MConv_Demag` performs forward/pair/inverse stages. | Fullmag plans all $L^2$ ordered source→destination pairs and six tensor components. Pair orientation includes source/destination cell sizes, signed Z shift, common shape, masks, and transfer. | A scalar separation-only kernel is not the Fullmag contract; each orientation must have field/energy and reciprocity evidence. |
| Spectral storage and representation | BORIS `DemagKernelCollection::KerType` in `external_solvers/BORIS/Boris/DemagKernelCollection.h` (L35-L62) stores real/complex kernels, shift flags, source/destination cell sizes, and FFT dimensions. | Fullmag `TensorDemagKernel` in `crates/fullmag-fdm-demag/src/types.rs` stores six components on the padded FFT shape; `CellPairTensor::components` fixes the `xx,yy,zz,xy,xz,yz` order. | Real/reduced versus complex/full storage is a kernel-class decision; source presence does not qualify every representation or precision. |
| Kernel catalog and reuse | BORIS catalog declarations in `DemagKernelCollection.h` (L108-L131) cover 2-D/3-D self, Z-shifted, X-shifted, and complex-full families; `KernelAlreadyComputed` (L130-L131) checks reuse. | Fullmag `KernelReuseKey::from_pair_with_layout` in `crates/fullmag-fdm-demag/src/descriptors.rs` includes quantized oriented shifts, source/destination cell sizes, and the exact transform/crop shape. | Reuse is a key-level optimization, not proof that all catalog families or all pair symmetries are qualified. |
| FFT work decomposition | BORIS `SDemag::UpdateField_MConv_Demag` in `SDemag_MConv.cpp` (L197-L337) performs forward transforms, pair kernel multiplication, and inverse transforms. | Fullmag's documented operator shape is $L$ forward transforms, $L^2$ pair accumulation, and $L$ inverse transforms; CUDA telemetry is scoped to one demag refresh. | Counters do not prove full time-integrator device residency or production parity. |
| Zero padding and crop | BORIS `Initialize_MConv_Demag` sets convolution dimensions and scratch spaces in `SDemag_MConv.cpp` (L128-L166). | Fullmag records `fft_shape`, insertion offsets, lag-zero, crop, and inverse normalization in the resolved transform descriptor; linear convolution needs at least $n_{src}+n_{dst}-1$ samples per axis. | Static shape descriptions do not qualify numerical padding for every geometry or precision. |
| CPU/CUDA realization | BORIS has `SDemagCUDA::Initialize_MConv_Demag` and `SDemagCUDA::UpdateField_MConv_Demag` in `SDemagCUDA_MConv.cpp` (L14-L277). | Fullmag has a CPU FP64 reference and a CUDA v2 plan/workspace contract. GPU status remains partial until fresh managed executed-device field/energy parity and residency telemetry are recorded. | BORIS CUDA source presence is not a Fullmag qualification receipt, and Fullmag source/build/ABI presence is not device proof. |
| Airbox target-only observation | BORIS multilayer/supermesh descriptions do not define Fullmag's target-only Airbox resource. | Fullmag `FdmMultilayerAirboxRenderDomain` is a target-only grid for `H_demag`; it is deliberately unrelated to the FFT/common-transform grid. Airbox `H_eff` is unavailable with a versioned reason. | Airbox extent and wireframe are UI geometry evidence only; field qualification needs fresh runtime data and WebGL checks. |
| UI, Explorer, and viewport semantics | BORIS source has no Fullmag resource-first browser contract. | `GET /v2/sessions/current/data/domain/fdm-multilayer-layout` publishes availability and reason; Explorer omits unavailable layout nodes; viewport adapters expose native-layer targets and target-only Airbox, never the common scratch grid. | UI tests and source mappings are contract evidence, not fresh interactive qualification. |
| Production qualification boundary | BORIS source and the clean-room manifest provide traceability only. | Fullmag must report implemented, executable, runtime-verified, physically-validated, and production-qualified separately for CPU, CUDA, UI, and each requested display mode. | Neither static source comparison nor a visual screenshot alone closes the production gate. |

(multilayer-convolution-scientific-bibliography)=
## 12. Scientific bibliography

1. S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution,” *Journal of Applied Physics*
   **126**, 103903 (2019),
   [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the
   demagnetizing tensor for nonuniform magnetization,” *Journal of
   Geophysical Research: Solid Earth* **98**, 9551–9555 (1993),
   [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).
3. A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,”
   *Journal of Applied Physics* **83**, 3432–3434 (1998),
   [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).

### BORIS clean-room boundary

BORIS is used only as external traceability material for kernel categories and convolution
organization. The canonical boundary is recorded in
`docs/physics/multilayer_convolution/boris-reference-manifest.v1.json`. BORIS code is not
copied into Fullmag, is not a numerical oracle, and is not qualification evidence. The
equations on this page come from Lepadatu and Newell and map to independently maintained
Fullmag code.

(multilayer-convolution-source-code-index)=
## 13. Source-code index

| Claim | Path | Symbol | Responsibility | Lane | Tests/evidence | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python grid | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Validates and lowers one magnet's cell. | Public API | `packages/fullmag-py/tests/test_fdm_multilayer_contract.py` | executable authoring | Repository link pending immutable commit |
| Python demag policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Validates requested strategy, mode, and common layout. | Public API | `packages/fullmag-py/tests/test_fdm_multilayer_contract.py` | executable authoring | Repository link pending immutable commit |
| Python FDM wrapper | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Lowers complete FDM hints. | Public API | `packages/fullmag-py/tests/test_fdm_ui_roundtrip.py` | round-trip contract | Repository link pending immutable commit |
| ProblemIR topology identity | `crates/fullmag-ir/src/mesh_hints.rs` | `fdm_multilayer_topology_tokens` | Binds resolved mode and layer geometry to topology certificate. | IR | `crates/fullmag-ir/src/mesh_hints.rs` tests | executable contract | Repository link pending immutable commit |
| ProblemIR validation | `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR::validate` | Rejects illegal authored configuration. | IR | `crates/fullmag-ir/src/mesh_hints.rs` tests | executable contract | Repository link pending immutable commit |
| Planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | Resolves mode, layers, grid certificate, and transfer. | Planner | `crates/fullmag-plan/src/tests.rs` multilayer tests | executable contract | Repository link pending immutable commit |
| CPU runtime | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `execute_reference_fdm_multilayer` | Runs CPU reference; runtime performs FFT, pairs, and field pull. | FDM CPU FP64 | multilayer engine tests and independent oracles | runtime-verified, scoped | Repository link pending immutable commit |
| CPU observation and energy | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `observe_multilayer` | Publishes CPU field, energy, and provenance. | FDM CPU FP64 | SP4-derived runtime artifacts | runtime-verified, scoped | Repository link pending immutable commit |
| Push transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `push_m_with_boundary_policy` | Transfers magnetization to the scratch grid. | FDM CPU transfer | transfer parity oracle | physically-validated, scoped | Repository link pending immutable commit |
| Pull transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `pull_h_with_boundary_policy` | Returns field to the native grid. | FDM CPU transfer | adjointness oracle | physically-validated, scoped | Repository link pending immutable commit |
| Newell diagonal primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_f` | Evaluates Newell tensor function $f$. | Kernel preparation | Newell reference tests | code/test evidence | Repository link pending immutable commit |
| Newell cross primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_g` | Evaluates Newell tensor function $g$. | Kernel preparation | Newell reference tests | code/test evidence | Repository link pending immutable commit |
| Shifted Newell builder | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels_shifted` | Builds an oriented shifted tensor. | FDM CPU kernel | shifted/cubature tests | locally physically-validated | Repository link pending immutable commit |
| CUDA v2 plan creation | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_create_v2` | Validates, uploads, and prepares D-07 plan. | FDM CUDA | managed ABI/contract tests | executable contract, no device parity | Repository link pending immutable commit |
| CUDA FFT workspace | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_prepare_multilayer_fft_workspace_v2` | Prepares batched cuFFT workspace. | FDM CUDA | managed contract tests | executable contract, no device parity | Repository link pending immutable commit |
| UI round-trip model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft` | Reads scene FDM values into the Inspector draft. | Control Room | `StudyGlobalAuthoringModel.test.ts` | contract-verified | Repository link pending immutable commit |
| UI native-layer adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainMeta` | Provides the base for independent native-layer targets. | Explorer/viewport | viewport adapter tests | contract-verified | Repository link pending immutable commit |
| UI Airbox adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | Provides the base for the target-only Airbox. | Explorer/viewport | viewport adapter tests | contract-verified, no fresh browser proof | Repository link pending immutable commit |
| BORIS rectangle collection | `external_solvers/BORIS/Boris/SDemag.cpp` | `SDemag::set_Rect_collection` | Traceability for per-layer rectangles and scratch alignment. | BORIS reference | BORIS source snapshot L98-L179 | traceability only | External snapshot anchor |
| BORIS common counts | `external_solvers/BORIS/Boris/SDemag.cpp` | `SDemag::set_default_n_common` | Traceability for `n_common` defaults and forced 2-D Z count. | BORIS reference | BORIS source snapshot L56-L96 | traceability only | External snapshot anchor |
| BORIS force-mode header | `external_solvers/BORIS/Boris/SDemag.h` | `set_default_n_common` | Traceability for the documented `force_2d_convolution` values 0, 1, and 2. | BORIS reference | BORIS source snapshot L81-L103 | traceability only | External snapshot anchor |
| BORIS explicit common counts | `external_solvers/BORIS/Boris/SDemag.cpp` | `SDemag::Set_n_common` | Traceability for the explicit common convolution-count setter. | BORIS reference | BORIS source snapshot L206-L227 | traceability only | External snapshot anchor |
| BORIS convolution rectangle | `external_solvers/BORIS/Boris/SDemag.cpp` | `SDemag::get_convolution_rect` | Traceability for the adjusted scratch rectangle. | BORIS reference | BORIS source snapshot L194-L204 | traceability only | External snapshot anchor |
| BORIS multilayer initialization | `external_solvers/BORIS/Boris/SDemag_MConv.cpp` | `SDemag::Initialize_MConv_Demag` | Traceability for per-module convolution scratch setup. | BORIS reference | BORIS source snapshot L128-L166 | traceability only | External snapshot anchor |
| BORIS multilayer update | `external_solvers/BORIS/Boris/SDemag_MConv.cpp` | `SDemag::UpdateField_MConv_Demag` | Traceability for forward/pair/inverse stages. | BORIS reference | BORIS source snapshot L197-L337 | traceability only | External snapshot anchor |
| BORIS 2-D mode switch | `external_solvers/BORIS/Boris/SDemag_MConv.cpp` | `SDemag::Set_2D_Multilayered_Convolution` | Traceability for `force_2d_convolution`. | BORIS reference | BORIS source snapshot L1203-L1223 | traceability only | External snapshot anchor |
| BORIS multilayer toggle | `external_solvers/BORIS/Boris/SDemag_MConv.cpp` | `SDemag::Set_Multilayered_Convolution` | Traceability for the multilayer-versus-supermesh choice. | BORIS reference | BORIS source snapshot L1195-L1202 | traceability only | External snapshot anchor |
| BORIS kernel catalog | `external_solvers/BORIS/Boris/DemagKernelCollection.h` | `Calculate_Demag_Kernels_2D_Self` | Traceability for self/shifted/full kernel families. | BORIS reference | BORIS source snapshot L108-L131 | traceability only | External snapshot anchor |
| BORIS kernel reuse | `external_solvers/BORIS/Boris/DemagKernelCollection.h` | `KernelAlreadyComputed` | Traceability for shift and cell-size reuse. | BORIS reference | BORIS source snapshot L130-L131 | traceability only | External snapshot anchor |
| BORIS kernel storage | `external_solvers/BORIS/Boris/DemagKernelCollection.h` | `KernelAlreadyComputed` | Traceability for `KerType` storage flags, cell sizes, and FFT dimensions. | BORIS reference | BORIS source snapshot L35-L62 | traceability only | External snapshot anchor |
| BORIS pair multiplication | `external_solvers/BORIS/Boris/DemagKernelCollection_Mult.cpp` | `DemagKernelCollection::KernelMultiplication_2D` | Traceability for ordered multiple-input multiplication. | BORIS reference | BORIS source snapshot L635-L735 | traceability only | External snapshot anchor |
| BORIS 3-D pair multiplication | `external_solvers/BORIS/Boris/DemagKernelCollection_Mult.cpp` | `DemagKernelCollection::KernelMultiplication_3D` | Traceability for ordered 3-D multiple-input multiplication. | BORIS reference | BORIS source snapshot L685-L735 | traceability only | External snapshot anchor |
| BORIS irregular thickness | `external_solvers/BORIS/Boris/DemagTFunc_Irregular.cpp` | `DemagTFunc::CalcDiagTens2D_Shifted_Irregular` | Traceability for unequal Z thickness. | BORIS reference | BORIS source snapshot L5-L119 | traceability only | External snapshot anchor |
| BORIS weighted transfer | `external_solvers/BORIS/Boris/SDemag_Demag.cpp` | `SDemag_Demag::Initialize_Mesh_Transfer` | Traceability for weighted mesh transfer. | BORIS reference | BORIS source snapshot L63-L87 | traceability only | External snapshot anchor |
| BORIS CUDA update | `external_solvers/BORIS/Boris/SDemagCUDA_MConv.cpp` | `SDemagCUDA::UpdateField_MConv_Demag` | Traceability for CUDA multilayer staging. | BORIS CUDA reference | BORIS source snapshot L114-L277 | traceability only | External snapshot anchor |
| BORIS CUDA initialization | `external_solvers/BORIS/Boris/SDemagCUDA_MConv.cpp` | `SDemagCUDA::Initialize_MConv_Demag` | Traceability for CUDA scratch initialization. | BORIS CUDA reference | BORIS source snapshot L14-L100 | traceability only | External snapshot anchor |
| Fullmag kernel reuse | `crates/fullmag-fdm-demag/src/descriptors.rs` | `from_pair_with_layout` | Builds the reuse key from the exact transform and crop descriptor. | FDM CPU/GPU | descriptor unit tests | executable contract | Repository link pending immutable commit |
| Fullmag common-transform schema | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` | `fdm_multilayer_layout_resource` | Builds the resource containing the computational common-transform schema, not a physical mesh. | Control Room API | API schema tests | contract-verified | Repository link pending immutable commit |
| Fullmag layout route | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` | `fdm_multilayer_layout_resource` | Backs `get_fdm_multilayer_layout`, publishing layout availability and explicit unavailable reason. | Control Room API | v2 route tests | contract-verified | Repository link pending immutable commit |
| Fullmag Explorer omission | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` | `buildModelTree` | Omits unavailable layout nodes and keeps native-layer targets separate. | Explorer | Explorer tests | contract-verified | Repository link pending immutable commit |
| Fullmag native-layer domains | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmMultilayerNativeLayerDomains` | Adapts physical native-layer carriers only. | Viewport | viewport adapter tests | contract-verified | Repository link pending immutable commit |
| Fullmag target-only Airbox domain | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmMultilayerAirboxDomain` | Adapts target-only Airbox and validates field availability. | Viewport | viewport adapter tests | contract-verified, no fresh browser proof | Repository link pending immutable commit |
