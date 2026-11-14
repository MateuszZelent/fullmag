# Masks for field excitation

- Status: accepted physics and numerics contract; implementation in progress
  (branch `codex/field-masks-20261113`); no lane is qualified yet
- Owners: Fullmag core
- Last updated: 2026-11-13
- Related interaction: `docs/physics/0920-regional-time-domain-field-drive.md`
- Decision record: `docs/adr/0081-explicit-field-masks.md`
- Data contract: `docs/specs/mask-function-v1.md`
- Design and plan: `docs/superpowers/specs/2026-11-13-field-masks-design.md`,
  `docs/superpowers/plans/2026-11-13-field-masks.md`
- Reference scenario: `B_ext.Add(mask, f(t))` of mumax3

This page defines a prescribed magnetic field given by hand-written masks and
time functions. It adds no conductor model. Energy, output names, stage
activation and provenance follow the regional-field-drive contract (note 0920)
unless stated otherwise here. The source map of this page is completed together
with the implementation; until then the code references below name the planned
symbols.

(problem-statement)=
## 1. Problem statement

A user needs to apply a spatially structured, time-dependent magnetic field to a
part of a magnet, for example to excite spin waves of a chosen wavelength. The
field is known in closed form or is produced by user code; it does not depend on
the magnetization. The part of the magnet where it acts is independent of the
material regions of the magnet and may overlap them.

A mask field drive consists of

1. a target magnet and a support shape placed in it;
2. a list of terms, each a vector mask and an optional scalar time function.

(governing-equations)=
## 2. Governing equations

Let $\Omega_m$ be the magnetic domain of the target object and $G$ the support
shape placed at its position. The support is

```{math}
:label: mask-support
\Omega_S=\Omega_m\cap G .
```

For terms $i=1,\dots,N$ with masks $\mathbf B_i(\mathbf r)$ and time functions
$f_i(\tau)$, the flux density and field of the drive are

```{math}
:label: mask-field
\mathbf B_{\mathrm{mask}}(\mathbf r,t)=
\begin{cases}
\displaystyle\sum_{i=1}^{N}\mathbf B_i(\mathbf r)\,f_i(\tau(t)), & \mathbf r\in\Omega_S,\\[4pt]
\mathbf 0, & \text{otherwise},
\end{cases}
\qquad
\mathbf H_{\mathrm{mask}}=\frac{\mathbf B_{\mathrm{mask}}}{\mu_0}.
```

A term without a time function has $f_i\equiv 1$. The drive clock is the
stage clock of regional drives (note 0920, section 4):

```{math}
:label: mask-clock
\tau(t)=
\begin{cases}
t-t_{\mathrm{stage}}, & \text{time origin } \texttt{stage\_local},\\
t, & \text{time origin } \texttt{absolute},
\end{cases}
```

where $t$ is the physical simulation time and $t_{\mathrm{stage}}$ its value at
the start of the current run stage. Relaxation stages do not advance $t$
(note 0530).

The field enters the effective field additively,

```{math}
:label: mask-effective-field
\mathbf H_{\mathrm{eff}}\;\leftarrow\;\mathbf H_{\mathrm{eff}}+\mathbf H_{\mathrm{mask}},
```

and contributes the Zeeman energy reported as the drive energy

```{math}
:label: mask-energy
E_{\mathrm{drive}}(t)=-\mu_0\int_{\Omega_S}M_s(\mathbf r)\,\mathbf m(\mathbf r,t)\cdot
\mathbf H_{\mathrm{mask}}(\mathbf r,t)\,\mathrm dV .
```

In the local frame a mask function receives coordinates measured from the
position $\mathbf r_0$ of the support,

```{math}
:label: mask-local-frame
\mathbf B_i(\mathbf r)=\boldsymbol\beta_i(\mathbf r-\mathbf r_0)\quad(\text{local}),\qquad
\mathbf B_i(\mathbf r)=\boldsymbol\beta_i(\mathbf r)\quad(\text{world}),
```

where $\boldsymbol\beta_i$ is the authored function. $\mathbf r_0$ is the authored
`position` in the target's object frame (translation only in v1); a global target
has no object, and its frame is the world frame.

(symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf r=(x,y,z)$ | position in the world frame | $\mathrm{m}$ |
| $\mathbf r_0$ | position of the support shape | $\mathrm{m}$ |
| $t$ | physical simulation time | $\mathrm{s}$ |
| $t_{\mathrm{stage}}$ | simulation time at the start of the current run stage | $\mathrm{s}$ |
| $\tau$ | drive clock | $\mathrm{s}$ |
| $\Omega_m$ | magnetic domain of the target object | $\mathrm{m^3}$ |
| $G$ | support shape (box, cylinder, sphere) placed at $\mathbf r_0$ | $\mathrm{m^3}$ |
| $\Omega_S$ | support of the drive | $\mathrm{m^3}$ |
| $N$ | number of terms, $1\le N\le 8$ | $1$ |
| $\mathbf B_i$ | mask of term $i$ | $\mathrm{T}$ |
| $\boldsymbol\beta_i$ | authored mask function of term $i$ | $\mathrm{T}$ |
| $f_i$ | time function of term $i$ | $1$ |
| $\mathbf B_{\mathrm{mask}}$ | flux density of the drive | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{mask}}$ | field of the drive | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective field | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{T\,m\,A^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | unit magnetization | $1$ |
| $E_{\mathrm{drive}}$ | Zeeman energy of prescribed drives | $\mathrm{J}$ |
| $\mathbf r_c$ | centre of FDM cell $c$ | $\mathrm{m}$ |
| $V_c$ | volume of FDM cell $c$ | $\mathrm{m^3}$ |
| $\mathbf h_{i,c}$ | stored basis of term $i$ at cell $c$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf L_{ijk}$ | lattice point $(i,j,k)$ of an array mask | $\mathrm{m}$ |
| $\mathbf A_{ijk}$ | array-mask value at lattice point $(i,j,k)$ | $\mathrm{T}$ |

(assumptions-and-validity)=
## 4. Assumptions and validity limits

- The field is prescribed. It does not respond to the magnetization and implies
  no conductor, return current or wave propagation.
- A mask function is a closed expression of position; a time function a closed
  expression of time (`docs/specs/mask-function-v1.md`). Functions of position
  and time together are outside the primitive; the single-function authoring
  form is split into terms of {eq}`mask-field` or rejected.
- Time functions are continuous (the language has no step function), so a mask
  field drive creates no integrator event.
- The support is binary at the discretization: an FDM cell belongs to it when
  its centre lies in $\Omega_S$.
- An array mask is piecewise constant on its lattice. It is exact where the
  lattice coincides with the FDM grid.
- The local frame is a translation; rotation of the frame is not part of v1.
- Mask values and time values must be finite on the support and on the stage
  horizon; otherwise planning fails.
- Periodic boundary conditions do not replicate a mask; the mask is evaluated in
  the primary cell only.

(python-api)=
## 5. Python API

```python
# %% Study, magnet and stages
from math import exp, log, pi, sin, sqrt

import fullmag as fm
from fullmag import GHz, mT, nm

study = fm.study("mask_antenna")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(2000 * nm, 500 * nm, 20 * nm),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(5 * nm, 5 * nm, 5 * nm)

film = study.geometry(fm.Box(size=(2000 * nm, 500 * nm, 20 * nm), name="film"),
                      name="film", object_id="film")
film.Ms = 139e3
film.Aex = 4e-12
film.alpha = 1e-3
film.m = fm.texture.uniform(0.0, -1.0, 0.0)
study.exchange()
study.demag()

# %% Mask and time function, written by hand; values are given at the call
def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
    g = exp(-(x + xs)**2 / (2 * wavelength**2)) * exp(-y**2 / (2 * sigma_y**2))
    return (B01 * g * sin(k * x - pi / 2), 0.0, B01 * g * sin(k * x))


def antenna_time(t, frequency, t0):
    return sin(2 * pi * frequency * (t - t0))


antenna = film.add_simpleantenna.arbitrary_mask(
    shape=fm.Box(2000 * nm, 500 * nm, 10 * nm), position=(0.0, 0.0, -5 * nm),
    frame="world", time_origin="stage_local", name="Antenna",
)
antenna.add(
    fm.mask(antenna_mask, B01=0.2 * mT, wavelength=279 * nm, fwhm_y=240 * nm, xs=600 * nm),
    fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0),
)

# %% The stage adds the source; the run advances the dynamics
study.stages.add_field_drive(antenna, stage_id="add_antenna")
study.stages.add_run(2e-9, stage_id="drive")
```

An array mask is filled by ordinary Python, usually a loop inside a function:

```python
# %% Loop style, as VectorMask in mumax3
def uniform_layers(field, bz, n_layers):
    nx, ny, nz = field.size
    for i in range(nx):
        for j in range(ny):
            for k in range(n_layers):
                field.set_vector(i, j, k, (0.0, 0.0, bz))
    return field


antenna.add(uniform_layers(study.new_vector_mask(), bz=0.1 * mT, n_layers=2))
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.add_simpleantenna.arbitrary_mask(target, …)`, `magnet.add_simpleantenna.arbitrary_mask(…)`, `region.add_simpleantenna.arbitrary_mask(…)` | magnet, region of a magnet, or `"global"` | required (bound by a scoped factory) | $1$ | an existing magnet or region; `target=` on a scoped factory raises `scoped_target_override_not_allowed` | cells the drive may act on | FDM CPU/GPU; FEM rejected | `mask_field_drives[].target` (`global`, `object`, `region`) |
| `…mask.shape` | `fm.Box`, `fm.Cylinder`, sphere | required | $\mathrm{m}$ | positive sizes | support shape $G$ | FDM CPU/GPU; FEM rejected | `mask_field_drives[].shape` |
| `…mask.position` | 3 floats | `(0, 0, 0)` | $\mathrm{m}$ | finite | $\mathbf r_0$ | FDM CPU/GPU; FEM rejected | `mask_field_drives[].position_m` |
| `…mask.frame` | `"local"`, `"world"` | `"local"` | $1$ | one of the two | frame of $\mathbf r_0$ and of mask coordinates, {eq}`mask-local-frame` | FDM CPU/GPU; FEM rejected | `mask_field_drives[].frame` |
| `…mask.time_origin` | `"stage_local"`, `"absolute"` | `"stage_local"` | $1$ | one of the two | clock of {eq}`mask-clock` | FDM CPU/GPU; FEM rejected | `mask_field_drives[].time_origin` |
| `…mask.name`, `…mask.id` | `str` | derived | $1$ | non-empty, unique id | display name, stable id | all | `mask_field_drives[].name`, `.id` |
| `antenna.add(mask, time, name=None)` | `MaskFunction` or `VectorMask`; `TimeFunction` or `None`; `str` | `time=None` | $\mathrm{T}$, $1$ | at most 8 terms; bare callables rejected; names unique within the antenna | one term of {eq}`mask-field` | FDM CPU/GPU; FEM rejected | `mask_field_drives[].terms[]` (`name`) |
| `fm.mask(function, **values)` | restricted function + numbers | required | $\mathrm{T}$ | rules of `mask-function-v1`; every parameter needs a value | function mask $\boldsymbol\beta_i$ | FDM CPU/GPU; FEM rejected | `terms[].mask` (`kind: function`) |
| `fm.time(function, **values)` | restricted function + numbers | required | $1$ | rules of `mask-function-v1` | time function $f_i$ | FDM CPU/GPU; FEM rejected | `terms[].time` |
| `study.new_vector_mask(size, cell, origin)` | 3 ints, 3 floats, 3 floats | the FDM grid of the study | $\mathrm{m}$ | positive size and cell; a lattice is required when the study has no FDM cell | array mask $\mathbf A_{ijk}$ | FDM CPU/GPU; FEM rejected | `terms[].mask` (`kind: sampled`) |
| `VectorMask.set_vector(i, j, k, value)` | ints, 3 floats | — | $\mathrm{T}$ | indices in range, finite values | one lattice value | FDM CPU/GPU; FEM rejected | array file |
| `study.stages.add_field_drive(antenna, stage_id)` | `MaskAntenna`, `str` | generated id | $1$ | unique stage id | adds the drive from this pipeline point on | FDM CPU/GPU; FEM rejected | stage action `add_mask_field_drive` |
| `study.field_drives.add(antenna)` | `MaskAntenna` | — | $1$ | unique id | adds the drive for the whole study | FDM CPU/GPU; FEM rejected | `mask_field_drives[]` |
| `study.stages.update_field_drive(antenna, mask_parameters, time_parameters, term, stage_id)` | `MaskAntenna` or id; `{name: float}`; term name or index | generated id | units of the parameters | the id is active; known names; finite values; `term` required for several terms (`mask_update_invalid`) | replaces parameter values of the active instance from this point on; the antenna's definition is unchanged | FDM CPU/GPU; FEM rejected | stage action `update_mask_field_drive` |
| `study.stages.remove_field_drive(id, stage_id)` | `str`, `str` | generated id | $1$ | the id is active | removes the drive from this point on | all lanes | stage action `remove_field_drive` |

(problem-ir)=
## 6. ProblemIR representation

```json
{
  "schema_version": "mask_field_drive.v1",
  "id": "antenna",
  "name": "Antenna",
  "enabled": true,
  "target": {"kind": "object", "object_id": "film"},
  "shape": {"kind": "box", "size": [2e-06, 5e-07, 1e-08], "center": [0.0, 0.0, 0.0]},
  "position_m": [0.0, 0.0, -5e-09],
  "frame": "world",
  "terms": [
    {
      "mask": {
        "kind": "function",
        "function": {
          "expression_version": "field_expr.v1",
          "parameters": [
            {"name": "B01", "value": 0.0002},
            {"name": "wavelength", "value": 2.79e-07},
            {"name": "fwhm_y", "value": 2.4e-07},
            {"name": "xs", "value": 6e-07}
          ],
          "locals": [
            {"name": "k", "expression": "2 * pi / wavelength"},
            {"name": "sigma_y", "expression": "fwhm_y / (2 * sqrt(2 * log(2)))"},
            {"name": "g", "expression": "exp(-(x + xs)^2 / (2 * wavelength^2)) * exp(-y^2 / (2 * sigma_y^2))"}
          ],
          "outputs": ["B01 * g * sin(k * x - pi / 2)", "0.0", "B01 * g * sin(k * x)"]
        }
      },
      "time": {
        "expression_version": "field_expr.v1",
        "parameters": [{"name": "frequency", "value": 3600000000.0}, {"name": "t0", "value": 0.0}],
        "locals": [],
        "outputs": ["sin(2 * pi * frequency * (t - t0))"]
      }
    }
  ],
  "time_origin": "stage_local",
  "activation": {"kind": "all_time_evolution"}
}
```

This block states the contract. It is replaced by the serialized output of the
example once the lowering exists (plan Task 4). An array mask is stored as
`{"kind": "sampled", "path", "sha256", "size", "cell_m", "origin_m"}`; the file is
a float32 `.npy` of shape `(nz, ny, nx, 3)` in tesla.

(round-trip-and-failure-semantics)=
## 7. Round trip and failure semantics

- Requested intent: the IR keeps functions as authored (parameters, locals,
  outputs). Resolved execution: the plan keeps one basis and one time program per
  term with a signature; provenance records both.
- Script → scene → script keeps every equation, parameter name and value, and
  the order of locals and terms. Comments and formatting of the original
  functions are not kept. An array mask is exported as a file load.
- Terms produced by a ready antenna of `fullmag.antennas` carry the call (name
  and arguments) so the Control Room can change the arguments and rebuild them.
- Failures are explicit and happen before a solver is allocated: the codes of
  `docs/specs/mask-function-v1.md` sections 3 and 5. An unsupported lane is an
  error; there is no fallback to another lane and no run without the mask.

(discrete-realization)=
## 8. Discrete realization

### 8.1 Support and maps on FDM (CPU and CUDA)

A cell $c$ with centre $\mathbf r_c$ belongs to the support when it is an active
cell of the target and $\mathbf r_c\in G$. The cells of a global target are all
magnetic cells; of an object target, the cells of that magnet; of a region target,
the cells whose exclusive region marker is that region. Regions overlap by
priority, so a region covered by a region of higher priority has no cells and
planning fails with `mask_support_empty`. For a function mask the stored basis is

```{math}
:label: mask-fdm-basis
\mathbf h_{i,c}=
\begin{cases}
\mathbf B_i(\mathbf r_c)/\mu_0, & c\in\Omega_S,\\
\mathbf 0, & \text{otherwise}.
\end{cases}
```

For an array mask with lattice points $\mathbf L_{ijk}$ and values
$\mathbf A_{ijk}$ the basis takes the value of the lattice cell that contains the
cell centre,

```{math}
:label: mask-fdm-array
\mathbf h_{i,c}=\frac{1}{\mu_0}\mathbf A_{ijk(c)},\qquad
ijk(c)=\left\lfloor\frac{\mathbf r_c-\mathbf o}{\Delta}\right\rfloor,
```

with lattice origin $\mathbf o$ (lower corner) and spacing $\Delta$, and
$\mathbf h_{i,c}=\mathbf 0$ when $ijk(c)$ is outside the lattice or
$c\notin\Omega_S$. When lattice and grid coincide this is a copy.

### 8.2 Time evaluation

At every evaluation of the effective field at time $t$ the solver adds

```{math}
:label: mask-fdm-update
\mathbf H_c\;\leftarrow\;\mathbf H_c+\sum_{i=1}^{N}f_i(\tau(t))\,\mathbf h_{i,c},
```

and the reported energy is the discrete form of {eq}`mask-energy`,

```{math}
:label: mask-fdm-energy
E_{\mathrm{drive}}=-\mu_0\sum_{c}V_c\,M_{s,c}\,\mathbf m_c\cdot
\sum_{i=1}^{N}f_i(\tau)\,\mathbf h_{i,c}.
```

FDM CPU evaluates $f_i$ with the Rust interpreter of the time bytecode. FDM CUDA
evaluates $f_i$ on the host, once per field evaluation, and passes the numbers to
the device kernels; the basis is stored in the solver precision, the multiplier in
double precision. Runge–Kutta substages use their own times, as for built-in
waveforms.

### 8.3 FEM CPU and FEM GPU

Not realized. Planning fails with `mask_field_drive_unsupported_lane:fem`. The
intended realization evaluates {eq}`mask-fdm-basis` at magnetic P1 nodes of the
support and feeds the existing pre-projected nodal basis of the regional drive;
the time evaluation is the same as on FDM.

### 8.4 Lane matrix

| Solver | Device | Status | Boundary |
|---|---|---|---|
| FDM | CPU | implementation in progress | single grid, one magnet |
| FDM | GPU | implementation in progress | single grid; at most 8 time-dependent mask terms per stage; host-driven step loop |
| FEM | CPU | unsupported | explicit rejection; path described in 8.3 |
| FEM | GPU | unsupported | explicit rejection; path described in 8.3 |

Multilayer FDM (more than one magnet) rejects mask field drives, as it rejects
every regional drive.

(implementation-mapping)=
## 9. Implementation mapping

| Claim | Planned owner |
|---|---|
| restricted Python → equations | `packages/fullmag-py/src/fullmag/model/mask_function.py` |
| equation language and bytecode | `crates/fullmag-expr` |
| IR types and validation | `crates/fullmag-ir/src/mask_field_drive.rs` |
| {eq}`mask-support`, {eq}`mask-fdm-basis`, {eq}`mask-fdm-array` | `crates/fullmag-plan/src/mask_field.rs`, `crates/fullmag-plan/src/selection/fdm.rs` |
| {eq}`mask-fdm-update` on CUDA | `backends/fdm/gpu/cuda/interactions/regional_field_drive.cuh`, `native/include/fullmag_time_expression.h` |
| {eq}`mask-fdm-update` on CPU | `crates/fullmag-engine/src/fdm/shared/terms.rs` |
| {eq}`mask-fdm-energy` on CUDA tables | `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` |

(validation)=
## 10. Validation strategy

1. Equation engine: precedence, error positions, bytecode against tree
   evaluation bit for bit (plan Task 2).
2. Planner: supports, closed-form maps at cell centres, array copy and
   resampling, explicit rejections (plan Task 5, probe script).
3. Device: cells outside the support keep their initial magnetization bit for
   bit with exchange and demagnetization off; {eq}`mask-fdm-energy` against the
   closed form; a mask with `sin` against the built-in sinusoidal drive; CPU
   against CUDA (plan Task 9).
4. Reference: the antenna of a mumax3 script — map equal to the dumped
   `VectorMask` at every cell, time factor equal to the tabulated `B_ext`, a
   100 ps trajectory (plan Tasks 10 and 11).

No result is recorded yet.

(limitations)=
## 11. Limitations and deferred work

- FEM lanes and multilayer FDM.
- Rotation of the local frame; shapes other than box, cylinder and sphere.
- Step functions and conditional expressions in functions.
- Array masks loaded from OVF files; trilinear resampling.
- Evaluation of a non-separable function of position and time per cell.
- A backend-evaluated preview of a mask in the viewport.
- Masks as the scope of absorbing layers, material parameters and table averages.
- Any time-dependent drive, including a mask term, makes FDM CUDA use the
  host-driven step loop instead of the captured adaptive graph.

(scientific-bibliography)=
## 12. Scientific bibliography

1. A. Vansteenkiste, J. Leliaert, M. Dvornik, M. Helsen, F. Garcia-Sanchez,
   B. Van Waeyenberge, "The design and verification of MuMax3", AIP Advances 4,
   107133 (2014). DOI: 10.1063/1.4899186.
2. W. F. Brown Jr., *Micromagnetics*, Interscience, New York (1963).

(source-code-index)=
## 13. Source-code index

The index and the adjacent source map are filled when the symbols of section 9
exist (plan Tasks 2 to 6) and are validated with
`.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`.
