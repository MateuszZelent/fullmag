# Masks for field excitation — design

Date: 2026-11-14 (rev. 8; adopts parts of Mateusz's V4, see `docs/superpowers/specs/2026-11-14-field-masks-comparison-with-v4.md`). Source: `~/git/fullmag` master `438d917ff`.
Plan: `docs/superpowers/plans/2026-11-13-field-masks.md`.

Scope: masks as a field excitation (antenna) only, no material parameters.
Executable first on FDM CPU and FDM CUDA; Python, ProblemIR, scene ↔ script, API
and Control Room are in scope; FEM rejects with an explicit code and reuses every
shared piece later (section 7).

## 1. Layers

| Layer | What the user writes | Status in this plan |
|---|---|---|
| **L0 — primitive (mumax3 level)** | a mask, written either as a function of space `(x, y, z) → (Bx, By, Bz)` or as an array filled in a loop (`set_vector`, as `VectorMask` in mumax3); a time function `t → number`; `add(mask, time)` once or several times | core |
| L1 — user modules | an ordinary Python function that builds and returns one or several (mask, time) terms; it runs when the script runs | core (it is plain Python on L0) |
| L1 — ready antennas | `from fullmag.antennas import …` — library functions that return L0 terms | one antenna in this plan (the Gaussian k-source of the user's script) |
| L2 — single function | Mateusz's `f(x, y, z, t)`; fullmag splits it into L0 terms automatically | last task, on top of L0 |

Everything in the IR, the planner, the solvers and the UI is L0. L1 and L2 only
produce L0 terms.

## 2. How mumax3 does it (source: fork `MateuszZelent/3` @ `984c6e9d`)

- `B_ext.Add(mask, f)` stores `mulmask{mul, mask}`; the mask is resampled and moved
  to the GPU once (`data.Resample`, `assureGPU`), float32, 3 components.
- Every effective-field build calls `B_ext.AddTo(dst)`: for each term one scalar
  `mul = float32(t.mul())` on the CPU, then `cuda.Madd2(dst, dst, t.mask, 1, mul)`,
  i.e. `dst[i] += mul · mask[i]`.
- RK45 sets `Time = t0 + c_i·Dt` before each stage torque; `relaxSteps` restores
  `Time` (measured: `minimize()` and `relax()` leave `t` unchanged).

fullmag already has this engine on all four lanes: FDM keeps a dense per-cell
basis and adds `multiplier(t) · basis` per RK substage; FEM does the same with a
nodal basis (`PREPROJECTED_NODAL`). Missing: a way to author masks and time
functions, and a time multiplier given by a user equation.

## 3. L0 authoring (the mumax3 script, by hand)

Values are given where the function is used, not in its `def`.

Function style:

```python
from math import exp, log, pi, sin, sqrt
import fullmag as fm
from fullmag import nm, mT, GHz

def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs):
    k = 2 * pi / wavelength
    sigma_y = fwhm_y / (2 * sqrt(2 * log(2)))
    g = exp(-(x + xs)**2 / (2 * wavelength**2)) * exp(-y**2 / (2 * sigma_y**2))
    return (B01 * g * sin(k * x - pi / 2), 0.0, B01 * g * sin(k * x))

def antenna_time(t, frequency, t0):
    return sin(2 * pi * frequency * (t - t0))

antenna = sample.add_simpleantenna.arbitrary_mask(          # or region.add_simpleantenna...,
    shape=fm.Box(6000 * nm, 1000 * nm, 45 * nm),               # or study.add_simpleantenna.arbitrary_mask(target=...)
    position=(0, 0, -15 * nm), frame="world", name="Antenna",
)
field = fm.mask(antenna_mask, B01=0.2 * mT, wavelength=279 * nm, fwhm_y=240 * nm, xs=6000 * nm / 2.3)
drive = fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0)
antenna.add(field, drive)                    # mumax3: B_ext.Add(field, sin(omega*(t - t0)))
study.stages.add_field_drive(antenna, stage_id="add_antenna")
```

Loop style (as in mumax3, also written as a function; it is ordinary Python that
runs in the script and fills an array, so `math`, loops and `if` all work):

```python
def antenna_mask_loop(field, B01, k, sigma_x, sigma_y, source_position, phase_shift, y_zero, n_layers):
    Nx, Ny, Nz = field.size
    for i in range(Nx):
        x = field.index2coord(i, 0, 0)[0]
        gaussx = exp(-(x + source_position)**2 / (2 * sigma_x**2))
        z_sinKX = sin(k * x) * gaussx
        x_sinKX = sin(k * x + phase_shift) * gaussx
        for j in range(Ny):
            y = field.index2coord(0, j, 0)[1]
            ymask = exp(-(y - y_zero)**2 / (2 * sigma_y**2))
            for kz in range(n_layers):
                field.set_vector(i, j, kz, (B01 * ymask * x_sinKX, 0, B01 * ymask * z_sinKX))
    return field                              # a module may return several masks

field = antenna_mask_loop(
    study.new_vector_mask(),                  # mumax3: newVectorMask(Nx, Ny, Nz)
    B01=0.2 * mT, k=2 * pi / (279 * nm), sigma_x=279 * nm,
    sigma_y=240 * nm / (2 * sqrt(2 * log(2))), source_position=6000 * nm / 2.3,
    phase_shift=-pi / 2, y_zero=0.0, n_layers=9,
)
antenna.add(field, fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0))
```

A travelling wave by hand (two masks, as in mumax3):

```python
antenna.add(fm.mask(mask_sin_kx, k=k, B0=B0), fm.time(cos_wt, f=frequency))
antenna.add(fm.mask(mask_minus_cos_kx, k=k, B0=B0), fm.time(sin_wt, f=frequency))
```

L1 user module (plain Python; runs at script time; returns one or several pairs):

```python
def my_antenna(wavelength, frequency, B0):
    k = 2 * pi / wavelength
    return (
        (fm.mask(mask_sin_kx, k=k, B0=B0), fm.time(cos_wt, f=frequency)),
        (fm.mask(mask_minus_cos_kx, k=k, B0=B0), fm.time(sin_wt, f=frequency)),
    )

for field, drive in my_antenna(wavelength=196 * nm, frequency=4.5 * GHz, B0=1 * mT):
    antenna.add(field, drive)
```

L1 ready antennas: functions shipped in `fullmag.antennas`, written in either style,
called with values:

```python
from fullmag.antennas import gaussian_k_source

for field, drive in gaussian_k_source(study, amplitude=0.2 * mT, wavelength=279 * nm,
                                      frequency=3.6 * GHz, fwhm_y=240 * nm,
                                      center_x=-6000 * nm / 2.3, n_layers=9):
    antenna.add(field, drive)
```

A ready antenna is known to fullmag by name, so the scene stores the call (name
and argument values) next to the terms it produced. The Control Room lists the
ready antennas, edits their arguments, and the backend calls the function again
to rebuild the terms. This holds for loop-style ready antennas too. A script
exported from the UI contains the import and the call.

Scoped factories (one implementation owner): `study.add_simpleantenna.arbitrary_mask(target=..., ...)`
needs an explicit target (a magnet, a region of a magnet, or `"global"`);
`magnet.add_simpleantenna.*` binds the magnet and `region.add_simpleantenna.*` binds the region;
a scoped factory rejects `target=` with `scoped_target_override_not_allowed`. `position` and `frame`
keep their meaning in every form. Terms may be named: `antenna.add(field, drive, name="left")`;
names are unique within the antenna and address the term in an Update.

Rules for mask and time **functions** (restricted Python, transpiled to equations;
the solver never calls Python):

- Mask function: first parameters `x, y, z` (metres); returns a 3-tuple in tesla.
  Time function: first parameter `t` (seconds); returns one number. A term
  without a time function is static.
- Every further parameter gets its value in `fm.mask(function, name=value, …)` /
  `fm.time(function, name=value, …)`. A missing or unknown name is an error.
  A default in the `def` is allowed but not needed. Parameters stay named and
  editable in the IR and the UI.
- Body: assignments `name = expression` (a name may be reassigned, also with `+= -= *= /= **=`;
  the transpiler renames versions, SSA style), then `return`. Expressions: numbers,
  parameters, earlier locals, `pi`, `+ - * / **`, unary minus, and
  `sin cos tan asin acos atan atan2 sinh cosh tanh exp log sqrt abs min max`
  (bare or `math.`). Free names that resolve to a number in the function's
  globals or closure are captured as fixed parameters.
- Anything else (`if`, loops, numpy, helper calls) → `MaskFunctionError` with the
  line number; such code belongs in the loop style.

Rules for **array** masks (loop style):

- `study.new_vector_mask(size=None, cell=None, origin=None)`: a float32 array of
  3-vectors in tesla on a regular lattice. Default lattice = the FDM grid of the
  study (universe size and cell). `field.size`, `field.index2coord(i, j, k)`
  (cell centre, metres, world frame), `field.set_vector(i, j, k, (bx, by, bz))`,
  `field.array` (numpy view for vectorized code), `fm.VectorMask.from_data(...)`.
- The array travels inside the IR (float32, zlib, base64, sha256), cropped to its
  non-zero cells, so no file has to follow the script through the API; an exported
  script carries the same data in `fm.VectorMask.from_data(...)`.
- The planner resamples it to the lane: identical lattice → copied; otherwise
  nearest lattice point at each cell centre (mumax3 also resamples); outside the
  lattice → 0. The antenna's `shape` still limits the support.
- An array mask written by the user's own loop comes from arbitrary code, so the
  Control Room shows it read-only and a script exported from the UI loads the file
  instead of repeating the loop. A loop inside a ready antenna of `fullmag.antennas`
  is editable through the antenna's arguments (see L1 ready antennas).

Common rules:

- `target`: global, a magnet, or a region of a magnet. `shape` + `position`: the
  support of all terms, intersected with the target's magnetic cells (cell centres).
  A region target follows the FDM region membership (exclusive, by priority); the shape
  is independent of regions.
  `frame="world"`: `x, y, z` and `position` are world coordinates.
  `frame="local"`: `x, y, z` of mask functions are measured from `position`, given
  in the target's object frame (translation only in v1; a global target's frame is the world frame). Array masks are always in
  the world frame.
- `t` follows the stage clock of regional field drives (ADR 0019, note 0920 §4),
  chosen per antenna with `time_origin`: `"stage_local"` (default) — `t = 0` at the
  start of every run stage in which the drive is active; `"absolute"` — the
  simulation time, i.e. `t` of mumax3. Relaxation stages must not advance the
  absolute clock (note 0530); the plan verifies it.
- Stages: creating an antenna (`study.add_simpleantenna.arbitrary_mask(...)`) only authors
  it. It enters the physics at a pipeline point with
  `study.stages.add_field_drive(antenna, stage_id=...)` (Mateusz's form) or for the
  whole study with `study.field_drives.add(antenna)`;
  `study.stages.remove_field_drive(antenna_id, stage_id=...)` removes it. An
  antenna that is never added gives a warning when the script is captured.
- Units: `fullmag.nm, um, mT, T, GHz, MHz, ns, ps` are plain floats.

## 4. ProblemIR (L0 only)

```
ProblemIR.mask_field_drives: Vec<MaskFieldDriveIR>      # serde default, skipped when empty
MaskFieldDriveIR {
  schema_version: "mask_field_drive.v1", id, name, enabled: bool,
  target: FieldTargetIR,                                  # reused: global | object | region
  shape: RegionShapeIR, position_m: [f64; 3], frame: "world" | "local",
  terms: Vec<MaskTermIR>,                                 # 1..=8
  time_origin: FieldTimeOriginIR,                         # reused: stage_local | absolute
  activation: DriveActivationIR,                          # reused
}
MaskTermIR { name: Option<String>,                         # unique within the drive
             mask: MaskSourceIR, time: Option<FunctionIR>,   # time absent = 1
             origin: Option<LibraryCallIR> }                 # set when a ready antenna produced the term
LibraryCallIR { function: String,                          # e.g. "fullmag.antennas.gaussian_k_source"
                arguments: BTreeMap<String, f64>, call_index: u32, output_index: u32 }
MaskSourceIR =
    function { function: FunctionIR }
  | sampled  { encoding: "f32le-zlib-base64", data: String, sha256: String,
               size: [u32; 3], cell_m: [f64; 3], origin_m: [f64; 3] }   # float32 (z, y, x, 3), tesla
FunctionIR {
  expression_version: "field_expr.v1",
  parameters: Vec<{ name, value: f64, source: Option<String> }>,
  locals:     Vec<{ name, expression: String }>,          # in order
  outputs:    Vec<String>,                                # 3 for a mask (T), 1 for time
}
```

Validation in `fullmag-ir` (shared by CLI, API, planner): ids, target exists,
shape positive, 1..=8 terms, every equation parses, names resolve, mask functions
do not use `t`, time functions do not use `x, y, z`, parameter values finite. A
drive active in a relaxation stage needs every time function free of `t`.
Existing drive types are not changed; a problem without masks serializes
byte-identically.

## 4a. Stage pipeline

| Stage action (`ScriptExecutionStageAction`) | Payload | Effect on the following stages |
|---|---|---|
| `add_field_drive` (exists) | `drive: RegionalFieldDriveIR` | unchanged |
| **`add_mask_field_drive`** (new) | `drive: MaskFieldDriveIR` | pushed to `ProblemIR.mask_field_drives` |
| **`update_mask_field_drive`** (new) | `drive_id`, `term` (name or index; may be omitted for one term), `mask_parameters`, `time_parameters` | replaces parameter values of the active instance; atomic |
| `remove_field_drive` (exists) | `drive_id` | removes the drive with that id from either list |

- Both add actions are pipeline-input configuration stages: no solver work, a
  synthetic stage record, magnetization carried on (as `add_field_drive` today).
- Python: `study.stages.add_field_drive(x, stage_id=...)` emits `add_field_drive`
  for a `RegionalFieldDrive` and `add_mask_field_drive` for a mask antenna, so the
  user writes the same call for both.
- Ids are unique across `field_drives` and `mask_field_drives`.
- Update (adopted from Mateusz's V4 §3): the id must be active; unknown parameter
  names, a missing term selector on a multi-term antenna or a non-finite value reject
  the whole action; omitted values keep the current instance; the patch belongs to the
  stage, not to the antenna's definition, so Remove followed by Add installs the base
  definition again. Add of an active id is not an upsert. Update and Remove do not step
  the dynamics, change `m` or move time.
- Python: `study.stages.update_field_drive(antenna_or_id, mask_parameters={...},
  time_parameters={...}, term=None, stage_id=...)`.
- Control Room: the "Add Antenna" stage offers both antenna types; the mask type
  opens the mask antenna editor (section 7).

## 5. Equation engine: crate `fullmag-expr` (std only)

`field_expr.v1` (`^` for power; variables `x y z` or `t`):

```
expr  := term (("+"|"-") term)* ;  term := unary (("*"|"/") unary)*
unary := "-" unary | power ;       power := atom ("^" unary)?
atom  := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
```

Limits: 4096 characters and 512 nodes per equation. The crate parses, prints
canonically, evaluates a function (parameters → locals → outputs) and compiles a
time function to bytecode `fullmag_time_expr.v1` (flat `f64` array; opcode table
in the plan). The same interpreter exists as a header-only C function for host
code (`native/include/fullmag_time_expression.h`). For L2 the crate later gains
`separate` (section 8).

## 6. Planner and runtime

```
FdmPlanIR.mask_field_term_bases: Vec<ResolvedMaskFieldTermBasisIR>
ResolvedMaskFieldTermBasisIR {
  drive_id, term_index: u32, time_origin, time_expression: String, time_program: Vec<f64>,
  time_dependent: bool,
  field_xyz: Vec<[f64; 3]>,          # A/m (B/μ0), one per cell, zero outside the support
  projection_signature: String,
}
```

| Lane | Realization |
|---|---|
| FDM planner | support = target ∩ shape at `position` (cell centres, through the existing selection compiler); a function mask is evaluated once at the centre of each supported active cell; an array mask is copied or resampled to the cell centres (as mumax3). Errors: `mask_support_empty`, `mask_expression_non_finite`; the time program is checked at the stage start (the stage horizon is not part of ProblemIR). |
| Runner (all lanes) | checks every host evaluation of a time program and stops with `mask_expression_non_finite` and the time. |
| `H_drive` readback | FDM CPU and CUDA publish `H_drive` including mask terms (today `H_ext` does not contain drives on CUDA). |
| FDM CUDA | waveform kind `FULLMAG_FDM_REGIONAL_FIELD_DRIVE_HOST_MULTIPLIER = 5`: before each field build the host evaluates each term's time program (one number per term) and passes the values to the kernels by value (at most 8); the kernel does `h += multiplier[i] · basis[i][cell]`. No equation per cell, no upload per step. Built-in waveform kinds untouched. Capability bit. |
| FDM CPU | `DriveTimeFunction::Expression(program)` with the Rust interpreter. |
| Multilayer FDM, FEM | planning fails with `mask_field_drive_unsupported_lane:<lane>`. |
| FEM (later) | planner evaluates the mask function, or interpolates the array mask, at magnetic P1 nodes in the support → existing `PREPROJECTED_NODAL` basis; FEM time descriptor gets the same host-multiplier kind and header. No change to the crate, the IR, Python or the UI. |

Known cost outside this plan: any time-dependent drive (built-in or mask) makes
FDM CUDA use the host-driven step loop instead of the captured adaptive graph;
mumax3 also drives every step from the host. The plan measures it.

## 7. Scene, API, Control Room

- Scene ↔ script: the SceneDocument holds `MaskFieldDriveIR`. The script builder
  writes one `def` per mask and per time function (no defaults), the
  `add_simpleantenna.mask(...)` call and one `.add(fm.mask(f, name=value, …), fm.time(g, …))`
  per term; an array mask is written as `fm.VectorMask.load(path)`. User modules and library calls (L1) are
  expanded: a script exported from the UI contains the L0 form.
- API: `MaskFieldDriveResource`, CRUD like field drives; errors
  `{code, path, position, message}`.
- Control Room: one panel per antenna — target, shape, position, frame, and a
  list of terms; each term shows the mask function (parameter table, local
  equations, `Bx`, `By`, `Bz`) and the time function (parameters, locals,
  `f(t)`); an array mask is shown read-only (file, lattice, min/max). Terms can be
  added and removed. "Add ready antenna" lists `fullmag.antennas`, shows the
  arguments of the chosen one and rebuilds its terms on the server when an
  argument changes. The server validates; no client-side
  evaluation.

## 8. L2: one function of space and time (Mateusz's form)

`study.add_simpleantenna.arbitrary_mask(function=f(x, y, z, t, …), target, shape,
position, frame, name)`. The function is transpiled with the same rules, then
`fullmag_expr::separate` rewrites each output as `Σ S_j(x,y,z)·T_j(t)` (sums,
products, `sin/cos(u+v)`, `exp(u+v)`, integer powers 2..4) and the result is
stored as ordinary L0 terms. A function that does not separate →
`mask_not_separable` naming the sub-expression; more than 8 terms →
`mask_too_many_terms`. The IR and the UI show the L0 terms.

## 9. Later

Adopted from Mateusz as later work: conditionals with lazy branches (`if`/`select`),
dimension checks through unit literals that carry a dimension, linking mask parameters to
the study parameter library (`parameter_library.v1`, sweeps), `projection="cell_average"`
beside the default cell centre, FEM L2 projection with native quadrature points evaluated
by the Rust planner (one evaluator), a general non-separable tier that evaluates the same
bytecode per cell on the device, the five-kind catalog (gaussian, microstrip, point,
dispersion matched, arbitrary mask), the Explorer and Add/Update/Remove/Run inspectors of
V3/V4, and the four-lane acceptance matrix (V3 §18.9).

FEM lanes; array masks loaded from OVF files; more ready antennas; a per-cell evaluation
mode for non-separable L2 functions; a backend-evaluated preview; masks for ABC,
material parameters and table averages; conditional expressions; rotation of the
local frame; keeping the CUDA adaptive graph with time-dependent drives.

## 10. Reproduction target

`~/git/simulations/amumax/racetrack_3.6GHz/original.mx3`; ground truth in
`README.md` there (clock, mask on layers k = 0..8 equal to the formula within
3.6e-8, geometry 2 404 728 cells). fullmag model: one magnet `sample` (YIG box +
track boxes − notch boxes), regions for the track ends and the ABC columns
(existing features), the antenna of section 3, `study.pbc(x=True, y=True,
demag="truncated_images", images=(4,256,0))` with CUDA double, no thermal step.

## 11. Open points for the co-author (defaults used by the plan)

1. Functions are transpiled to equations and never called by the solver. (assumed)
2. `t` uses the existing stage clock of drives: `time_origin="stage_local"` by
   default, `"absolute"` = mumax3 `t`. (assumed; replaces "time since the add stage")
3. `frame="local"`: coordinates from `position` in the target's frame; `"world"` also
   available. (assumed)
4. Masks exist next to `RegionalFieldDrive`; nothing is removed. (assumed)
5. Names: `study.add_simpleantenna.arbitrary_mask(...)`, `.add(mask, time)`, `fm.mask(f, …)`,
   `fm.time(g, …)`, `study.new_vector_mask()` for L0; `arbitrary_mask(function=…)` for L2. (proposed)
6. The user's own loop-style masks are authored in the script only; the UI shows and
   keeps them. Ready antennas of `fullmag.antennas` (either style) are editable in the
   UI through their arguments. (proposed)
