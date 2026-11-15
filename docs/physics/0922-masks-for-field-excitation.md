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
| `study.add_simpleantenna.arbitrary_mask(target, …)`, `magnet.add_simpleantenna.arbitrary_mask(…)`, `region.add_simpleantenna.arbitrary_mask(…)` | magnet, region of a magnet, or `"global"` | required (bound by a scoped factory) | $1$ | an existing magnet or region; `target=` on a scoped factory raises `scoped_target_override_not_allowed` | cells (FDM) or nodes (FEM) the drive may act on | FDM and FEM, CPU/GPU | `mask_field_drives[].target` (`global`, `object`, `region`) |
| `…mask.shape` | `fm.Box`, `fm.Cylinder`, sphere | required | $\mathrm{m}$ | positive sizes | support shape $G$ | FDM and FEM, CPU/GPU | `mask_field_drives[].shape` |
| `…mask.position` | 3 floats | `(0, 0, 0)` | $\mathrm{m}$ | finite | $\mathbf r_0$ | FDM and FEM, CPU/GPU | `mask_field_drives[].position_m` |
| `…mask.frame` | `"local"`, `"world"` | `"local"` | $1$ | one of the two | frame of $\mathbf r_0$ and of mask coordinates, {eq}`mask-local-frame` | FDM and FEM, CPU/GPU | `mask_field_drives[].frame` |
| `…mask.time_origin` | `"stage_local"`, `"absolute"` | `"stage_local"` | $1$ | one of the two | clock of {eq}`mask-clock` | FDM and FEM, CPU/GPU | `mask_field_drives[].time_origin` |
| `…mask.name`, `…mask.id` | `str` | derived | $1$ | non-empty, unique id | display name, stable id | all | `mask_field_drives[].name`, `.id` |
| `antenna.add(mask, time, name=None)` | `MaskFunction` or `VectorMask`; `TimeFunction` or `None`; `str` | `time=None` | $\mathrm{T}$, $1$ | at most 8 terms; bare callables rejected; names unique within the antenna | one term of {eq}`mask-field` | FDM and FEM, CPU/GPU | `mask_field_drives[].terms[]` (`name`) |
| `fm.mask(function, **values)` | restricted function + numbers | required | $\mathrm{T}$ | rules of `mask-function-v1`; every parameter needs a value | function mask $\boldsymbol\beta_i$ | FDM and FEM, CPU/GPU | `terms[].mask` (`kind: function`) |
| `fm.time(function, **values)` | restricted function + numbers | required | $1$ | rules of `mask-function-v1` | time function $f_i$ | FDM and FEM, CPU/GPU | `terms[].time` |
| `study.new_vector_mask(size, cell, origin)` | 3 ints, 3 floats, 3 floats | the FDM grid of the study | $\mathrm{m}$ | positive size and cell; a lattice is required when the study has no FDM cell | array mask $\mathbf A_{ijk}$ | FDM and FEM, CPU/GPU | `terms[].mask` (`kind: sampled`) |
| `VectorMask.set_vector(i, j, k, value)` | ints, 3 floats | — | $\mathrm{T}$ | indices in range, finite values | one lattice value | FDM and FEM, CPU/GPU | array file |
| `study.stages.add_field_drive(antenna, stage_id)` | `MaskAntenna`, `str` | generated id | $1$ | unique stage id | adds the drive from this pipeline point on | FDM and FEM, CPU/GPU | stage action `add_mask_field_drive` |
| `study.field_drives.add(antenna)` | `MaskAntenna` | — | $1$ | unique id | adds the drive for the whole study | FDM and FEM, CPU/GPU | `mask_field_drives[]` |
| `study.stages.update_field_drive(antenna, mask_parameters, time_parameters, term, stage_id)` | `MaskAntenna` or id; `{name: float}`; term name or index | generated id | units of the parameters | the id is active; known names; finite values; `term` required for several terms (`mask_update_invalid`) | replaces parameter values of the active instance from this point on; the antenna's definition is unchanged | FDM and FEM, CPU/GPU | stage action `update_mask_field_drive` |
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
example once the lowering exists (plan Task 4). An array mask is stored in the IR
as `{"kind": "sampled", "encoding": "f32le-zlib-base64", "data", "sha256", "size",
"cell_m", "origin_m"}`: little-endian float32 values in tesla in (z, y, x,
component) order, zlib-compressed and base64-encoded, cropped to the cells that
hold a non-zero value; `sha256` hashes the raw bytes. The IR stays self-contained,
also through the Control Room and the API.

(round-trip-and-failure-semantics)=
## 7. Round trip and failure semantics

- Requested intent: the IR keeps functions as authored (parameters, locals,
  outputs). Resolved execution: the plan keeps one basis and one time program per
  term with a signature; provenance records both.
- Script → scene → script keeps every equation, parameter name and value, the
  order of locals and terms, the function names and the stage actions (Add,
  Update, Remove). A function used by several terms is exported once; values are
  exported as exact literals at the call. Comments, formatting and the display
  text of parameter values (`source`) are not kept. An array mask is exported
  with its data (`fm.VectorMask.from_data`).
- Terms produced by a ready antenna of `fullmag.antennas` carry the call (name
  and arguments) so the Control Room can change the arguments and rebuild them;
  the call is exported only when calling it again rebuilds the same terms, and an
  Update removes it (`docs/specs/mask-function-v1.md` section 6).
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
the device kernels by value (regional-drive waveform `HOST_MULTIPLIER`, descriptor
v3); the basis is stored in the solver precision, the multiplier in double
precision. Runge–Kutta substages use their own times, as for built-in waveforms.
The argument $\tau$ is the stage-local or the absolute time of the regional-drive
clock (note 0530). Before stepping, both runners check every time program at 4097
uniform times of the stage and stop with `mask_expression_non_finite`; CUDA also
checks each host evaluation. At upload the CUDA runner compares the library's
interpreter with the Rust interpreter on every program (4 ulp).

The sum in {eq}`mask-fdm-update`, together with the built-in regional drives, is
published as the field `H_drive` (A/m). FDM CPU takes it from the solver's drive
terms; FDM CUDA resolves it on the host from the same double-precision bases and
time functions at the time of the saved state, so it reports the prescribed drive,
not a readback of the device buffers.

### 8.3 FEM CPU and FEM GPU

On the FEM lanes the drive acts on the nodes of the P1 mesh. A node $n$ with
position $\mathbf r_n$ belongs to the support when it is a node of a magnetic
element of the target and $\mathbf r_n\in G$. The elements of a global target
are all magnetic elements; of an object target, the magnetic elements of that
object; of a region target, the elements of the region's mesh part. The stored
basis is the nodal interpolant of the mask,

```{math}
:label: mask-fem-basis
\mathbf h_i^h(\mathbf r)=\sum_{n\in\Omega_S}
\frac{\mathbf B_i(\mathbf r_n)}{\mu_0}\,\varphi_n(\mathbf r),
```

with the P1 shape functions $\varphi_n$. It equals the mask at the support
nodes and falls linearly to zero across the one layer of elements around the
support, so the edge of the support is resolved to one element. Nodes on the
interface between the target and its neighbours belong to the support. An array
mask gives each node the value of the lattice cell that contains it
({eq}`mask-fdm-array` with $\mathbf r_n$); nodes on the outer faces of the
lattice count as inside.

The solver adds $\sum_i f_i(\tau)\,\mathbf h_{i,n}$ to the nodal effective field
at every field evaluation, as in {eq}`mask-fdm-update`. Both lanes evaluate
$f_i$ on the host with the interpreter of the time bytecode, once per field
evaluation: FEM CPU inside the drive materialization, FEM GPU before the drive
kernel, which receives the numbers by value (waveform kind `HOST_EXPRESSION`,
regional-drive ABI v4; at most 8 mask terms per stage on the GPU lane). The
basis is the existing pre-projected nodal basis of the regional drive, in double
precision on both lanes. The energy is the regional-drive energy with the
lumped nodal weights $w_n$,

```{math}
:label: mask-fem-energy
E_{\mathrm{drive}}=-\mu_0\sum_n w_n\,M_{s,n}\,\mathbf m_n\cdot
\sum_{i=1}^{N}f_i(\tau)\,\mathbf h_{i,n},
```

or its consistent-mass form when $M_s$ is stored per element. `H_drive` is the
nodal field of the solver. Before stepping the runner checks every time program
at 4097 uniform times of the stage, and compares the library's interpreter with
the Rust interpreter on every program (4 ulp); a non-finite factor during the
run stops the step with `mask_expression_non_finite`.

On a periodic mesh the two nodes of a periodic pair are one degree of freedom,
so a mask must have equal values on them; otherwise planning fails with
`mask_not_periodic`. A statically periodic plan that runs on the Rust reference
reduction instead of the native solver rejects mask drives
(`mask_field_drive_unsupported_lane:fem_reference`).

### 8.4 Lane matrix

| Solver | Device | Status | Boundary |
|---|---|---|---|
| FDM | CPU | realized (function and array masks) | single grid, one magnet |
| FDM | GPU | realized (function and array masks) | single grid; at most 8 mask terms per stage |
| FEM | CPU | realized (function and array masks) | P1 nodal interpolant; not on the Rust reference reduction of statically periodic plans |
| FEM | GPU | realized (function and array masks) | P1 nodal interpolant; at most 8 mask terms per stage |

Multilayer FDM (more than one magnet) rejects mask field drives, as it rejects
every regional drive.

(implementation-mapping)=
## 9. Implementation mapping

| Claim | Owner |
|---|---|
| restricted Python → equations | `packages/fullmag-py/src/fullmag/model/mask_function.py` |
| antennas, targets, terms, Update | `packages/fullmag-py/src/fullmag/model/mask_field_drive.py`, `packages/fullmag-py/src/fullmag/world.py` |
| equation language and bytecode | `crates/fullmag-expr` |
| IR types, validation, Update | `crates/fullmag-ir/src/mask_field_drive.rs` |
| {eq}`mask-support`, {eq}`mask-fdm-basis`, {eq}`mask-fem-basis` | `crates/fullmag-plan/src/mask_field.rs` |
| {eq}`mask-fdm-update` on CUDA | `backends/fdm/gpu/cuda/interactions/regional_field_drive.cuh`, `backends/fdm/gpu/cuda/runtime/context.cu`, `native/include/fullmag_time_expression.h`, `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` |
| {eq}`mask-fdm-update` on CPU | `crates/fullmag-engine/src/fdm/shared/terms.rs`, `crates/fullmag-runner/src/fdm/cpu/reference.rs` |
| {eq}`mask-fdm-energy` | CUDA: `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs`; CPU: `crates/fullmag-runner/src/fdm/cpu/reference.rs` |
| FEM update and {eq}`mask-fem-energy` | `backends/fem/cpu/mfem/interactions/zeeman_time_dependence.cpp`, `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp`, `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu`, `native/include/fullmag_fem.h`, `crates/fullmag-runner/src/native_fem.rs` |
| time programs on the stage horizon | `crates/fullmag-runner/src/mask_time.rs` |
| stage actions Add, Update, Remove | `crates/fullmag-application/src/script_stage_materialization.rs` |
| scene and script round trip | `crates/fullmag-authoring/src/{scene.rs,builder.rs,adapters.rs,validation.rs}`, `packages/fullmag-py/src/fullmag/runtime/{script_builder.py,scene_document.py}` |

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

Recorded results (2026-11-14, branch `codex/field-masks-20261113`):

- Planner probe `scripts/benchmarks/fdm_mask_plan_checks.py`: 18/18 cases; maps
  equal the authored Python functions at every cell centre bit for bit; time
  programs equal the independent oracle; a plan without masks is byte-identical
  to the base binary; array masks written in a loop equal the function within
  float32 rounding; the ready antenna `fullmag.antennas.gaussian_k_source` plans
  to the same basis, time expression and time program as the hand-written
  mumax3 pair, bit for bit.
- Host interpreter: `native/include/fullmag_time_expression.h` reproduces the
  time-program golden file (67 checks in C99, C11 and C++17).
- Runtime through the managed API, 16 × 8 × 4 cells, 1 ns: a mask term
  $(0,b,0)\sin(2\pi ft)$ equals the equivalent built-in sinusoidal regional drive
  bit for bit on FDM CPU and to 2.2e-16 in $\mathbf m$ on FDM CUDA.
- Stage pipeline, Add → Run → Update → Run → Remove → Run → Add → Run: Update
  equals Remove plus Add of an antenna with the new values bit for bit on CPU and
  CUDA; $E_{\mathrm{drive}}=0$ exactly while the antenna is removed.
- `H_drive` readback: with a time-dependent mask term, a static mask term and a
  built-in regional drive active together, the saved `H_drive` equals the sum of
  the three terms to 1.3e-14 (relative) on FDM CPU and FDM CUDA at the time of
  each sample (`~/git/simulations/fullmag/field_masks/h_drive`).
- FEM, 1091 nodes (760 magnetic), 0.3 ns through the managed API
  (`~/git/simulations/fullmag/field_masks/fem`): a uniform mask term reproduces
  the built-in regional drive bit for bit on FEM CPU and to 1.4e-17 in
  $\mathbf m$ on FEM GPU; the two lanes agree to 1.4e-15. `H_drive` of a
  position-dependent mask equals {eq}`mask-fem-basis` at the node coordinates to
  4.6e-16 on both lanes, is zero outside the support, and every support node
  lies inside the shape.

- Reference (item 4, inputs): the antenna of the mumax3 script `racetrack 3.6 GHz`
  written by hand (`~/git/simulations/fullmag/racetrack_3.6GHz.py`) plans on the
  mumax3 grid (1200 × 200 × 15 cells, 2 404 728 active, identical) to a map equal
  to the dumped `VectorMask` within 7.3e-12 T (3.7e-8 of the peak, the float32
  rounding of the dump) on layers k = 0..8; the 661 896 cells that the dump stores
  as 0 hold |B| < 7e-46 T (float32 underflow). The drive stage starts at 2 ns on
  the absolute clock and the time factor equals mumax3's `B_ext` to 5.4e-8; Ms,
  Aex and m0 are identical (report `~/git/simulations/compare_racetrack_antenna.md`).
  Written as the mumax3 loop (`study.new_vector_mask()` + `set_vector`, float32), the
  same antenna has the dump's support exactly and equals it to 2.7e-20 T. With the
  absorbing boundary of the script (damping regions), the planned $\alpha$ equals
  the dump in every active cell (204 values).

Evidence: `~/git/simulations/fullmag/field_masks/{runtime_smoke,staged}`. Item 3
(untouched cells, energy closed form) and the trajectory of item 4 are open.

(limitations)=
## 11. Limitations and deferred work

- Multilayer FDM; the Rust FEM reference reduction of statically periodic plans.
- FEM elements of order above 1 (the basis is the P1 nodal interpolant).
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
