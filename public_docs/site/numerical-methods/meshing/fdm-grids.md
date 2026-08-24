---
title: FDM Grids
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 0388c3e7c4804923ee02a00b7ac4a789a44092d9
source_of_truth: canonical stage-first mesh authoring, FDM/FDMGrid/FDMDemag/FdmPbc schemas, ProblemIR, and planner-resolved FDM grid certificates
---

(public-docs-numerical-methods-meshing-fdm-grids)=
# FDM Cartesian grids

:::{admonition} Cell size is part of the numerical operator
:class: important

Changing an FDM cell size changes geometry sampling, cell volume, local stencils, the Newell
demagnetization tensor, FFT padding, periodic-image work, and explicit time-step stability. It is
not a viewport-resolution setting. Fullmag keeps the requested spacing separate from the
planner-resolved integer grid and its provenance.
:::

(numerical-methods-fdm-grids-problem-statement)=
## Problem statement

Fullmag represents an FDM magnetization field on an orthogonal, cell-centred Cartesian grid. The
author supplies one default spacing or an object-owned spacing for every magnetic body. The
planner combines that request with physical geometry, rejects extents that are not integer
multiples of the spacing, samples supported non-box geometry at cell centres, and publishes an
immutable grid certificate.

The rectangular allocation and the magnetic domain are different objects. A box occupies every
allocated cell; supported curved and constructive-solid-geometry bodies carry an active mask.
Region membership is stored separately from the active mask. A multilayer problem may also have a
common convolution grid, but that grid is scratch space for nonlocal communication and does not
replace the native state owned by each magnet.

This page owns coordinates, grid realization, masks, periodic indexing, and the grid-dependent
Newell/FFT contract. Interaction pages own the complete exchange, DMI, and demagnetization physics.

(numerical-methods-fdm-grids-governing-equations)=
## Governing equations

For cell-boundary origin $\mathbf x_0$, integer cell indices $(i,j,k)$, and cell spacings
$(h_x,h_y,h_z)$, the implemented cell-centre convention is

```{math}
:label: eq-numerical-fdm-grid-centre
\mathbf x_{ijk}=\mathbf x_0+
\left((i+\tfrac12)h_x,(j+\tfrac12)h_y,(k+\tfrac12)h_z\right).
```

For a requested rectangular extent $L_\alpha$ on axis $\alpha\in\{x,y,z\}$, the planner tests the
rounded count against the original extent:

```{math}
:label: eq-numerical-fdm-grid-realization
N_\alpha=\operatorname{round}\!\left(\frac{L_\alpha}{h_\alpha}\right),
\qquad
L_{\alpha,h}=N_\alpha h_\alpha,
\qquad
\varepsilon_\alpha=
\frac{\left|L_{\alpha,h}-L_\alpha\right|}{L_\alpha}.
```

The realization is rejected when $\varepsilon_\alpha$ exceeds the planner tolerance. The cell
volume and rectangular allocation size are

```{math}
:label: eq-numerical-fdm-grid-volume
V_{\mathrm{cell}}=h_xh_yh_z,
\qquad
N=N_xN_yN_z.
```

For a binary active mask $\chi_{ijk}$, the sampled magnetic volume is

```{math}
:label: eq-numerical-fdm-grid-binary-volume
V_{m,h}=V_{\mathrm{cell}}
\sum_{i=0}^{N_x-1}\sum_{j=0}^{N_y-1}\sum_{k=0}^{N_z-1}\chi_{ijk}.
```

When a qualified sub-cell boundary realization supplies a volume fraction
$\phi_{ijk}\in[0,1]$, the corresponding fractional volume is

```{math}
:label: eq-numerical-fdm-grid-fractional-volume
V_{m,h}^{\phi}=V_{\mathrm{cell}}
\sum_{i=0}^{N_x-1}\sum_{j=0}^{N_y-1}\sum_{k=0}^{N_z-1}\phi_{ijk}.
```

The shared grid neighbour helper wraps an index on a periodic axis and clamps it on an open axis:

```{math}
:label: eq-numerical-fdm-grid-neighbour
q_\alpha^{\pm}=
\begin{cases}
(q_\alpha\pm1)\bmod N_\alpha, & \alpha\text{ periodic},\\
\min\!\left(N_\alpha-1,\max(0,q_\alpha\pm1)\right), & \alpha\text{ open}.
\end{cases}
```

Interaction-specific boundary stencils decide how those neighbours enter a field. The index rule
alone does not define a universal exchange or DMI boundary condition.

For truncated-image periodic demagnetization, the CPU Newell builder constructs the requested
finite image sum

```{math}
:label: eq-numerical-fdm-grid-periodic-newell
N_{ab}^{\mathrm{pbc}}(\boldsymbol\ell)=
\sum_{n_x=-I_x}^{I_x}
\sum_{n_y=-I_y}^{I_y}
\sum_{n_z=-I_z}^{I_z}
N_{ab}^{\mathrm{open}}
\!\left(\boldsymbol\ell+(n_xN_x,n_yN_y,n_zN_z)\right),
```

where $I_\alpha=0$ on an open axis. The FFT allocation uses

```{math}
:label: eq-numerical-fdm-grid-padding
P_\alpha=
\begin{cases}
N_\alpha, & \alpha\text{ periodic},\\
2N_\alpha, & \alpha\text{ open}.
\end{cases}
```

`compute_newell_kernels` evaluates the six tensor components from Newell base functions. For an
$N_z=1$ grid it uses the exact double-volume corner sum at every in-plane lag. For a three-
dimensional grid, lags at or beyond the hard-coded 40-cell threshold use the point-dipole
asymptotic tensor

```{math}
:label: eq-numerical-fdm-grid-newell-asymptotic
N_{ab}^{\mathrm{dip}}(\boldsymbol\rho)=
\frac{V_s}{4\pi}
\left(\frac{\delta_{ab}}{\rho^3}-\frac{3\rho_a\rho_b}{\rho^5}\right).
```

The exact implementation condition is $N_z>1$ and either one absolute integer lag is at least 40
or the squared integer-lag norm is at least $40^2$. No a-priori error bound is encoded, so
large-grid demagnetization still requires numerical validation.

For native magnet grid label $g_n$ and common convolution-grid label $g_c$, multilayer planning
records an identity or push/pull transfer:

```{math}
:label: eq-numerical-fdm-grid-common-transfer
\mathbf M_{g_c}=\mathcal P_{g_n\to g_c}\mathbf M_{g_n},
\qquad
\mathbf H_{g_n}=\mathcal R_{g_c\to g_n}\mathbf H_{g_c}.
```

The descriptor and runtime must define $\mathcal P_{g_n\to g_c}$ and
$\mathcal R_{g_c\to g_n}$; declaring a common grid does not prove conservation, adjointness, or
energy consistency. The distinct grid labels avoid overloading the displacement magnitude used in
the Newell asymptote.

(numerical-methods-fdm-grids-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x_{ijk}$ | centre of Cartesian cell $(i,j,k)$ | $\mathrm{m}$ |
| $\mathbf x_0$ | lower cell-boundary origin of the allocation | $\mathrm{m}$ |
| $i,j,k$ | integer Cartesian cell indices | $1$ |
| $h_x,h_y,h_z$ | requested or resolved cell spacings | $\mathrm{m}$ |
| $h_\alpha$ | requested or resolved spacing on axis $\alpha$ | $\mathrm{m}$ |
| $\alpha$ | Cartesian axis index in $\{x,y,z\}$ | $1$ |
| $L_\alpha$ | requested physical extent on axis $\alpha$ | $\mathrm{m}$ |
| $L_{\alpha,h}$ | realized grid extent on axis $\alpha$ | $\mathrm{m}$ |
| $N_x,N_y,N_z$ | resolved cell counts | $1$ |
| $N_\alpha$ | resolved cell count on axis $\alpha$ | $1$ |
| $N$ | total rectangular allocation size | $1$ |
| $\varepsilon_\alpha$ | relative extent mismatch on axis $\alpha$ | $1$ |
| $\left|\cdot\right|$ | absolute-value operator used for the extent mismatch | unit inherited from its argument |
| $\operatorname{round}$ | nearest-integer operator used for the dimensionless candidate count | $1$ |
| $\sum$ | finite summation operator over cell or periodic-image indices | unit inherited from its summand |
| $V_{\mathrm{cell}}$ | Cartesian cell volume | $\mathrm{m^3}$ |
| $\chi_{ijk}$ | binary active-cell indicator | $1$ |
| $\phi_{ijk}$ | qualified magnetic volume fraction | $1$ |
| $V_{m,h}$ | binary-mask magnetic volume | $\mathrm{m^3}$ |
| $V_{m,h}^{\phi}$ | fractional-mask magnetic volume | $\mathrm{m^3}$ |
| $q_\alpha$ | cell index on axis $\alpha$ | $1$ |
| $q_\alpha^{\pm}$ | neighbour index after open/periodic resolution | $1$ |
| $\bmod$ | modulo operator used for periodic integer indices | $1$ |
| $\min$ | minimum operator used to clamp an open-axis integer index | $1$ |
| $\max$ | maximum operator used to clamp an open-axis integer index | $1$ |
| $P_\alpha$ | FFT allocation count on axis $\alpha$ | $1$ |
| $N_{ab}^{\mathrm{open}}$ | open-boundary cell demagnetization tensor component | $1$ |
| $N_{ab}^{\mathrm{pbc}}$ | truncated-image periodic cell demagnetization tensor component | $1$ |
| $N_{ab}^{\mathrm{dip}}$ | point-dipole asymptotic tensor component | $1$ |
| $a,b$ | Cartesian tensor-component indices | $1$ |
| $\boldsymbol\ell$ | integer cell-lag vector | $1$ |
| $n_x,n_y,n_z$ | periodic image indices | $1$ |
| $I_x,I_y,I_z$ | requested image counts | $1$ |
| $I_\alpha$ | requested image count on axis $\alpha$; zero on an open axis | $1$ |
| $\boldsymbol\rho$ | physical source-to-destination displacement | $\mathrm{m}$ |
| $\rho$ | magnitude of $\boldsymbol\rho$ | $\mathrm{m}$ |
| $\rho_a,\rho_b$ | Cartesian components of $\boldsymbol\rho$ | $\mathrm{m}$ |
| $V_s$ | source-cell volume used by the dipole asymptote | $\mathrm{m^3}$ |
| $\delta_{ab}$ | Kronecker delta | $1$ |
| $\pi$ | circle constant in the dipole prefactor | $1$ |
| $g_n$ | native-grid label | $1$ |
| $g_c$ | common convolution-grid label | $1$ |
| $\mathbf M_{g_n}$ | magnetization on native grid $g_n$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_{g_c}$ | magnetization represented on common grid $g_c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{g_c}$ | field on common grid $g_c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{g_n}$ | field returned to native grid $g_n$ | $\mathrm{A\,m^{-1}}$ |
| $\mathcal P_{g_n\to g_c}$ | native-to-common linear transfer | $1$ |
| $\mathcal R_{g_c\to g_n}$ | common-to-native linear transfer | $1$ |

(numerical-methods-fdm-grids-assumptions-and-validity)=
## Assumptions and validity

- Native FDM cells are uniform, orthogonal rectangular prisms. A nonuniform or body-fitted mesh is
  a FEM problem, not an FDM-grid option.
- Supported analytic bodies are sampled at cell centres. Curved and oblique surfaces therefore
  have staircase error unless a separately qualified boundary correction is active.
- The strict planner does not silently round a physical extent. It computes rounded counts only as
  a candidate, then rejects a relative extent mismatch above `GRID_TOLERANCE`.
- `boundary_correction="volume"` requests T0 volume weighting and `"full"` requests the T1
  embedded/cut-boundary path. These requests are interaction-, precision-, and lane-gated; the
  public field alone is not evidence that every operator used it.
- The single-grid planner caps the resolved grid at $10^9$ cells and uses a conservative 256-byte
  per-cell estimate with an 8 GiB pre-allocation budget.
- Periodic local indexing and periodic demagnetization are separate semantics. With demagnetization
  enabled, a periodic FDM axis requires `demag="truncated_images"`; ordinary open Newell padding is
  rejected rather than reinterpreted.
- Truncated images are a finite approximation, not an infinite Ewald sum. The planner caps the
  image product at $10^6$ terms and the estimated periodic FFT workspace at 8 GiB.
- The 3-D Newell implementation uses a point-dipole asymptote beyond its source-coded 40-cell lag
  threshold. The code does not publish a universal error bound for anisotropic cells.
- A one-cell-thick film stores one thickness-averaged magnetization vector. It cannot resolve
  thickness-dependent textures, surface asymmetry, or perpendicular standing-wave profiles.
- Unequal native grids require an explicit common convolution spacing in canonical authoring.
  Multilayer PBC is currently rejected, and a common grid does not by itself qualify transfer
  accuracy.

(numerical-methods-fdm-grids-python-api)=
## Python API

### Canonical stage-first authoring

The following complete example was parsed and lowered from the current package. It requests one
periodic axis, FP64 CPU execution, an object-owned native grid, and truncated-image Newell demag.

```python
# %% Study and execution request
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid_contract")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Default and object-owned native grids
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 1 * nm))
film = study.geometry(
    fm.Box(size=(200 * nm, 80 * nm, 1 * nm), name="film"),
    name="film",
)
film.mesh(cell_size=(2 * nm, 2 * nm, 1 * nm))
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Physics, periodicity, and stage
study.exchange()
study.demag()
study.pbc(x=True, demag="truncated_images", images=(4, 0, 0))
study.stages.add_relax(
    stage_id="grid_contract",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-13,
    max_err=1.0e-7,
    tolT=1.0e-6,
    max_steps=100,
)
```

For multiple objects with unequal native spacings, add
`study.universe.mesh(cell_size=(...))`. The universe cell size lowers to the common convolution
request; it is not an additional magnetic state grid.

### Canonical authoring parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `body.mesh(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; cannot be combined with FEM mesh controls | object-owned native FDM spacing | FDM CPU/GPU authoring; planner and runtime capability-gated | `backend_policy.discretization_hints.fdm.per_magnet.<object>.cell` |
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; cannot be combined with FEM default-mesh controls | inherited native spacing for objects without overrides | FDM CPU/GPU authoring | `backend_policy.discretization_hints.fdm.default_cell` and compatibility `backend_policy.discretization_hints.fdm.cell` |
| `study.universe.mesh(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; cannot be combined with FEM universe controls; common extent must divide exactly | common convolution-grid target spacing for unequal native grids | FDM multilayer CPU/GPU authoring; execution capability-gated | `backend_policy.discretization_hints.fdm.demag.common_cell_size` |
| `study.pbc(x=...)` | `bool` | `False` | $1$ | coerced to Boolean; demag/images require at least one periodic axis | request periodic x indexing | FDM CPU/GPU single-grid; multilayer FDM rejected | `pbc.axes[0]` as `periodic` or `open` |
| `study.pbc(y=...)` | `bool` | `False` | $1$ | coerced to Boolean; demag/images require at least one periodic axis | request periodic y indexing | FDM CPU/GPU single-grid; multilayer FDM rejected | `pbc.axes[1]` as `periodic` or `open` |
| `study.pbc(z=...)` | `bool` | `False` | $1$ | coerced to Boolean; demag/images require at least one periodic axis | request periodic z indexing | FDM CPU/GPU single-grid; multilayer FDM rejected | `pbc.axes[2]` as `periodic` or `open` |
| `study.pbc(demag=...)` | `Literal["open", "truncated_images", "periodic_airbox_k0"]` | `"open"` | $1$ | normalized to lowercase enum; FDM rejects `periodic_airbox_k0`; periodic axes plus enabled FDM demag reject `open` | requested demag boundary realization | FDM supports open without periodic axes and truncated images; periodic-airbox is FEM-only | `pbc.demag` |
| `study.pbc(images=...)` | `tuple[int, int, int] \| None` | `None` | $1$ | exactly three values coercible to integers, nonnegative, and legal only with `truncated_images`; planner resolves open-axis counts to zero | finite periodic-image radius per axis | FDM CPU/GPU single-grid; planner budget-gated | `pbc.image_counts` |

### Typed migration adapters

`study.fdm(...)`, `fm.fdm(...)`, `FDM`, `FDMGrid`, and `FDMDemag` remain public compatibility
adapters. Ordinary new scripts should use the object/default/universe mesh API above. This complete
stage-first compatibility example also shows how the typed fragments can be inspected without
constructing a low-level `Problem`:

```python
# %% Inspect the exact typed migration fragments
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid_migration_adapter")
study.engine("fdm")
study.device("cpu", precision="double")
film = study.geometry(
    fm.Box(size=(200 * nm, 80 * nm, 1 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

native = fm.FDMGrid(cell=(2 * nm, 2 * nm, 1 * nm))
demag = fm.FDMDemag(
    strategy="multilayer_convolution",
    mode="two_d_stack",
    common_cells_xy=(256, 128),
    explain=True,
)
fdm = fm.fdm(
    default_cell=(4 * nm, 4 * nm, 1 * nm),
    per_magnet={"film": native},
    demag=demag,
    boundary_correction="none",
)
study.exchange()
study.demag()
study.stages.add_relax(
    stage_id="migration_adapter",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-13,
    max_err=1.0e-7,
    tolT=1.0e-6,
    max_steps=100,
)

native_fragment = native.to_ir()
demag_fragment = demag.to_ir()
fdm_fragment = fdm.to_ir()
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; mutually exclusive with `default_cell`; one default or nonempty per-magnet map is required | legacy default native spacing | FDM CPU/GPU compatibility authoring | `backend_policy.discretization_hints.fdm.cell` and `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; mutually exclusive with `cell`; one default or nonempty per-magnet map is required | explicit default native spacing | FDM CPU/GPU compatibility authoring | `backend_policy.discretization_hints.fdm.default_cell` and compatibility `backend_policy.discretization_hints.fdm.cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | keys must be nonempty strings and values must be `FDMGrid`; missing objects require a default | object-owned native grids | FDM CPU/GPU; multilayer path capability-gated | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | annotated as `FDMDemag`, but the constructor performs no `isinstance` check; an incompatible value normally fails later when `FDM.to_ir()` calls `demag.to_ir()` | advanced nonlocal grid policy | FDM CPU/GPU; strategy and mode capability-gated | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | `None`, `none`, `volume`, or `full` | requested binary, T0, or T1 boundary treatment | single-grid interaction/precision gated; multilayer accepts only omitted/`none` | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | strictly inside $(0,1)$ when supplied | minimum accepted volume fraction for T0/T1 stabilization | boundary-correction gated; multilayer rejects it | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | rejects values below zero; the current Python constructor has no separate finiteness guard | minimum T1 intersection distance | boundary-correction gated; multilayer rejects it | `backend_policy.discretization_hints.fdm.boundary_delta_min` |
| `FDMGrid.cell` | `Sequence[float]` | required | $\mathrm{m}$ | exactly three finite positive values | one magnet's native Cartesian spacing | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.per_magnet.<name>.cell` |
| `FDMDemag.strategy` | `Literal["auto", "single_grid", "multilayer_convolution"]` | `"auto"` | $1$ | exact enum; multi-body planner rejects `single_grid` | requested nonlocal execution family | FDM CPU/GPU, planner-resolved | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `Literal["auto", "two_d_stack", "three_d"]` | `"auto"` | $1$ | exact enum; `two_d_stack` rejects 3-D counts and requires one native z cell per layer | requested common-grid dimensionality | FDM multilayer CPU/GPU, planner-resolved | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int, int, int] \| None` | `None` | $1$ | exactly three positive non-Boolean integers; mutually exclusive with XY counts and cell size; incompatible with `two_d_stack` | explicit 3-D common-grid counts | FDM multilayer CPU/GPU, capability-gated | `backend_policy.discretization_hints.fdm.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `tuple[int, int] \| None` | `None` | $1$ | exactly two positive non-Boolean integers; mutually exclusive with 3-D counts and cell size; valid only for `auto`/`two_d_stack` | explicit common in-plane counts | FDM multilayer CPU/GPU, capability-gated | `backend_policy.discretization_hints.fdm.demag.common_cells_xy` |
| `FDMDemag.common_cell_size` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m}$ | exactly three finite positive values; mutually exclusive with explicit counts; incompatible with explicit `two_d_stack` in Rust IR validation | target common-grid spacing | canonical FDM multilayer authoring; execution capability-gated | `backend_policy.discretization_hints.fdm.demag.common_cell_size` |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | $1$ | every non-`None` value raises because silent fallback was removed | rejected compatibility input | unsupported | not serialized; rejected before ProblemIR lowering |
| `FDMDemag.explain` | `bool` | `True` | $1$ | stored as an authoring-only flag; it is not serialized by `to_ir()` | request human-readable legacy planning output | authoring only; no execution semantics | not serialized; no ProblemIR destination |

`study.fdm(...)` and `fm.fdm(...)` forward `default_cell`, `per_magnet`, `demag`,
`boundary_correction`, `boundary_phi_floor`, and `boundary_delta_min` to the matching `FDM` rows and
emit a deprecation warning for ordinary authoring.

(numerical-methods-fdm-grids-problem-ir)=
## ProblemIR and planner resolution

The exact `backend_policy` and `pbc` projection produced by the canonical example above is:

```json
{
  "backend_policy": {
    "requested_backend": "fdm",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {
        "cell": [4e-09, 4e-09, 1e-09],
        "default_cell": [4e-09, 4e-09, 1e-09],
        "per_magnet": {
          "film": {"cell": [2e-09, 2e-09, 1e-09]}
        }
      },
      "fem": {
        "order": 1,
        "hmax": 5.6858023018340375e-09,
        "mesh": null
      },
      "hybrid": null
    }
  },
  "pbc": {
    "axes": ["periodic", "open", "open"],
    "demag": "truncated_images",
    "image_counts": [4, 0, 0]
  }
}
```

The compatibility `cell` mirror and canonical `default_cell` deliberately coexist in the current
wire contract. Requested `auto` strategy/mode also remain unchanged in ProblemIR. The planner, not
the authoring layer, resolves:

- native counts, origin, extent, active cells, region legend, estimated bytes, and grid
  fingerprint in `FdmGridCertificateIR`;
- selected multilayer strategy/mode, common counts and spacing, per-layer native/convolution
  origins, and `identity` versus `push_pull` transfer kind;
- periodic demag boundary, open-axis versus periodic-axis padding, resolved image counts, image
  terms, workspace bytes, and kernel identity;
- requested CPU/GPU/precision policy into the selected runtime lane.

Runtime metadata and `mesh/fdm_pbc_provenance.v1.json` preserve these resolved facts. They are not
reconstructed later from a rounded display value.

(numerical-methods-fdm-grids-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The round trip preserves requested intent: default and object-owned cell sizes, common-grid
request, boundary-correction request, PBC axes, demag policy, image counts, execution device, and
precision. Script export uses the stage-first API. The planner publishes resolved execution
separately through its grid certificate, multilayer summary, periodic workspace, and provenance.

Validation errors are raised before allocation for nonfinite/nonpositive spacing, missing native
grid specifications, invalid per-object keys or values, non-divisible extents, conflicting common-
grid controls, invalid PBC policy, cell/image/workspace budget overflow, and unsupported geometry.
There is no silent cell-count rounding or single-grid fallback.

Unsupported combinations fail closed:

- periodic axes plus enabled FDM demag with `demag="open"`;
- FDM with `demag="periodic_airbox_k0"`;
- any multilayer FDM periodic axis;
- periodic axes with T0/T1 boundary correction;
- CUDA FP32 with periodic axes or nontrivial boundary correction;
- multilayer T0/T1 parameters, `single_grid` strategy for multiple bodies, or `two_d_stack` with
  more than one native z cell;
- unequal canonical native cell sizes without `study.universe.mesh(cell_size=...)`.

A successful GPU-shaped ProblemIR or source-visible CUDA kernel is not executed-device evidence.
GPU qualification requires a runtime receipt and a non-skipped device parity result.

(numerical-methods-fdm-grids-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization and qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | FP64 cell-centred native grids, masks, strict extent validation, Newell FFT demag, truncated-image PBC, and planner certificates; multilayer common-grid execution remains feature-gated by its explicit contracts |
| FDM | GPU | source-backed, capability-gated | same requested/resolved grid semantics; CUDA consumes host-built Newell spectra and periodic flags; FP32 PBC and FP32 T0/T1 are rejected, and device qualification cannot be inferred from source |
| FEM | CPU | not applicable | FEM uses a conforming shared-domain mesh rather than an FDM Cartesian state grid |
| FEM | GPU | not applicable | FEM uses a conforming shared-domain mesh rather than an FDM Cartesian state grid |

CPU/GPU comparisons require identical grid fingerprints, masks, precision, PBC resolution, image
counts, padding, and Newell spectra. Changing any of them defines a different discrete problem.

(numerical-methods-fdm-grids-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol | Lane |
|---|---|---|---|
| Object-owned native spacing | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | Python authoring |
| Default native spacing | `packages/fullmag-py/src/fullmag/world.py` | `class StudyObjectsMeshDefaultsHandle` | Python authoring |
| Common convolution spacing | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | Python authoring |
| Canonical study, PBC and compatibility entrypoints | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Python authoring |
| Stage-first lowering | `packages/fullmag-py/src/fullmag/world.py` | `_build_problem` | Python to ProblemIR |
| Native-grid schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Python compatibility API |
| Complete FDM hint schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Python compatibility API |
| Common-grid policy schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Python compatibility API |
| PBC schema | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Python/ProblemIR |
| Cell-centre reconstruction | `crates/fullmag-plan/src/fdm.rs` | `resolved_fdm_cell_centers` | planner |
| Geometry sampling | `crates/fullmag-plan/src/geometry.rs` | `voxelize_shape` | planner |
| Strict extent check | `crates/fullmag-plan/src/geometry.rs` | `validate_realized_grid` | planner |
| Grid cell/memory budgets | `crates/fullmag-plan/src/geometry.rs` | `checked_fdm_grid_cost` | planner |
| Single-grid resolution | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM CPU/GPU |
| Native/common multilayer resolution | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | FDM CPU/GPU multilayer |
| Periodic demag legality | `crates/fullmag-ir/src/execution.rs` | `resolve_demag_boundary` | lane-neutral IR |
| Periodic image/workspace resolution | `crates/fullmag-ir/src/execution.rs` | `resolve_periodic_images` | lane-neutral IR |
| Open/periodic neighbour indexing | `crates/fullmag-engine/src/fdm/shared/types.rs` | `neighbor_index` | FDM CPU/shared semantics |
| Newell tensor and 3-D asymptote | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | FDM reference kernel |
| Open Newell FFT spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra` | FDM CPU/reference |
| Truncated-image spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | FDM CPU and CUDA input |
| CUDA single-grid construction | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `create` | FDM GPU |
| Requested/resolved PBC artifact | `crates/fullmag-runner/src/fdm/artifacts.rs` | `pbc_provenance_artifacts` | provenance |

(numerical-methods-fdm-grids-validation)=
## Validation

1. Reconstruct the first and last cell centres and verify the certificate extent.
2. Reject every geometry extent that is not an integer multiple of its requested cell spacing.
3. Compare active-cell count and binary/fractional volume with analytical geometry under
   refinement and after rigid translation by integer cell offsets.
4. Check grid fingerprints change with origin, counts, spacing, active mask, or region map.
5. Validate Newell self terms, tensor symmetry, analytical demagnetizing factors, and the 3-D
   far-lag asymptote against the direct cell-pair oracle.
6. Verify open padding and periodic-axis compact padding, finite image sums, and planner/runtime
   workspace identity.
7. Test periodic exchange and truncated-image demag on CPU; require non-skipped device parity for
   GPU claims at the same precision.
8. For multilayer grids, test constant-field transfer, native/common coverage, offsets, volume
   weighting, and energy consistency for every layer; reject periodic transfer until qualified.
9. Perform independent spatial, temporal, and image-count convergence studies. A visually smooth
   texture is not a convergence criterion.

Relevant executable regressions include
`test_mesh_cell_size_lowers_per_object_and_common_domain`,
`test_problem_to_ir_serializes_fdm_pbc_truncated_images`,
`fdm_pbc_demag_resolution_matrix_is_lane_independent`,
`fdm_cpu_pbc_truncated_images_demag_plans`, and the CUDA-conditional
`native_fdm_periodic_truncated_demag_matches_cpu_reference_when_cuda_is_available`.

(numerical-methods-fdm-grids-limitations)=
## Limitations

- Cartesian sampling staircases curved and oblique boundaries.
- The 3-D Newell far-field branch has a source-coded switch but no universal published error bound.
- Truncated periodic images do not represent an infinite periodic Ewald solution.
- Multilayer periodic axes are not executable.
- Boundary correction is not universally qualified across interactions, precision lanes, and PBC.
- A common convolution grid does not guarantee conservative or adjoint native/common transfer.
- One-cell-thick films are thickness-averaged.
- Requested spacing alone does not identify counts, origin, mask, region map, padding, image budget,
  precision, or runtime device.

(numerical-methods-fdm-grids-scientific-bibliography)=
## Scientific bibliography

1. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551–9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
3. Canonical interaction owner: {doc}`../../physics/interactions/demagnetization/fdm-convolution`.

(numerical-methods-fdm-grids-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Solver/backend lane | Tests or evidence | Evidence status |
|---|---|---|---|---|---|---|
| Object native spacing | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | validates `body.mesh(cell_size=...)` | Python/FDM | `test_mesh_cell_size_lowers_per_object_and_common_domain` | implemented and tested |
| Default native spacing | `packages/fullmag-py/src/fullmag/world.py` | `class StudyObjectsMeshDefaultsHandle` | canonical default-mesh facade | Python/FDM | `test_mesh_cell_size_defaults_allow_per_object_override` | implemented and tested |
| Common convolution spacing | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | validates universe/common FDM cell size | Python/FDM multilayer | `test_mesh_cell_size_lowers_per_object_and_common_domain` | implemented and tested |
| Stage-first entrypoints | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | exposes `fdm` and `pbc` methods | Python/FDM | `test_flat_pbc_configures_periodic_demag_images` | implemented and tested |
| Stage-first lowering | `packages/fullmag-py/src/fullmag/world.py` | `_build_problem` | normalizes canonical mesh state into `FDM`/ProblemIR | Python to ProblemIR | executable example projection in this page | implemented and executed |
| Native-grid compatibility schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | validates one positive finite cell triple | Python/FDM | `test_fdm_rejects_invalid_per_magnet_entries` | implemented and tested |
| Complete compatibility hints | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | default/per-magnet/boundary lowering | Python/FDM | `test_fdm_per_magnet_round_trip_preserves_missing_default` | implemented and tested |
| Common-grid compatibility policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | validates strategy, mode, counts and removed fallback | Python/FDM multilayer | `test_demag_rejects_incompatible_common_grid_combinations` | implemented and tested |
| PBC authoring schema | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | validates axes, demag enum and image counts | Python/ProblemIR | `test_problem_to_ir_serializes_fdm_pbc_truncated_images` | implemented and tested |
| Cell-centre coordinates | `crates/fullmag-plan/src/fdm.rs` | `resolved_fdm_cell_centers` | materializes the documented coordinate convention | planner/FDM | planner unit tests | implemented and tested |
| Geometry sampling and mask | `crates/fullmag-plan/src/geometry.rs` | `voxelize_shape` | count realization and cell-centre membership | planner/FDM | planner geometry tests | implemented and tested |
| Exact extent rejection | `crates/fullmag-plan/src/geometry.rs` | `validate_realized_grid` | rejects non-divisible extents | planner/FDM | planner geometry tests | implemented and tested |
| Allocation budget | `crates/fullmag-plan/src/geometry.rs` | `checked_fdm_grid_cost` | checked count and estimated-byte limits | planner/FDM | grid overflow/budget tests | implemented and tested |
| Single-grid plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | resolves grid certificate, PBC and lane gates | FDM CPU/GPU | `fdm_pbc_demag_resolution_matrix_is_lane_independent` | implemented and tested |
| Multilayer plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | resolves native/common grids and rejects unsupported PBC | FDM CPU/GPU multilayer | `fdm_multilayer_periodic_axes_fail_closed_until_kernel_parity` | implemented and tested |
| Demag boundary resolution | `crates/fullmag-ir/src/execution.rs` | `resolve_demag_boundary` | separates requested PBC from executable demag boundary | lane-neutral/FDM | planner PBC matrix | implemented and tested |
| Periodic workspace resolution | `crates/fullmag-ir/src/execution.rs` | `resolve_periodic_images` | checked images, padding, terms and bytes | lane-neutral/FDM | `fdm_cpu_pbc_truncated_images_demag_plans` | implemented and tested |
| Neighbour indexing | `crates/fullmag-engine/src/fdm/shared/types.rs` | `neighbor_index` | open clamp versus periodic wrap | FDM CPU/shared | periodic exchange tests | implemented and tested |
| Newell tensor | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | exact/near and dipole-asymptotic tensor construction | FDM reference | Newell and shifted-oracle tests | implemented and tested |
| Open FFT spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra` | open $2N$ Newell spectra | FDM CPU/reference | FFT/demag tests | implemented and tested |
| Periodic FFT spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | truncated-image tensor folding and spectra | FDM CPU/CUDA input | CPU PBC and conditional CUDA parity tests | implemented; GPU evidence conditional |
| CUDA construction | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `create` | consumes resolved PBC and uploads matching spectra | FDM GPU | `native_fdm_periodic_truncated_demag_matches_cpu_reference_when_cuda_is_available` | source-backed; device test may skip |
| PBC provenance artifact | `crates/fullmag-runner/src/fdm/artifacts.rs` | `pbc_provenance_artifacts` | records requested and resolved grid/PBC contract | runtime provenance | `fdm_pbc_provenance_artifact_round_trips_requested_and_resolved_contract` | implemented and tested |
