# Masks for Field Excitation (FDM first) Implementation Plan

> **Execution:** Claude Code native (user decision 2026-11-13): Claude implements every task itself, task by task, then one fresh reviewer checks the whole branch. Steps use checkbox (`- [ ]`) syntax. Start only after the user says so.

**Goal:** Give fullmag the mumax3-level primitive — a hand-written mask, either a function `(x, y, z) → B` or an array filled in a loop inside a user function, plus a hand-written time function `t → number`, added as `antenna.add(mask, time)` with values given at the call — on FDM CPU and FDM CUDA, through Python, ProblemIR, scene/script, API and the Control Room; reproduce the antenna of the user's mumax3 script with it; then add ready antennas and Mateusz's single-function form on top.

**Architecture:** Python transpiles restricted mask and time functions into equations (`FunctionIR`) and saves loop-filled masks as array files. A std-only Rust crate `fullmag-expr` parses and evaluates them and compiles time functions to bytecode. The FDM planner evaluates each function mask once per cell, or resamples an array mask, into the existing dense basis; the solver adds `time_i(t)·mask_i`, with one host-computed number per term per field build (the mumax3 model). FEM later reuses the crate, the IR and the host interpreter with its nodal-basis path.

**Tech Stack:** Rust (new `fullmag-expr`; `fullmag-ir`, `-plan`, `-runner`, `-engine`, `-authoring`, `-api`), C/CUDA (`native/include`, `backends/fdm`), Python (`packages/fullmag-py`), TypeScript (`apps/control-room`), mumax3 v3.12.21 as the reference.

**Spec:** `docs/superpowers/specs/2026-11-13-field-masks-design.md` (rev. 8). § numbers refer to it.

## Global Constraints

- `~/git/fullmag` is read-only. Edits happen in the worktree `~/git/worktrees/field-masks-20261113`, branch `codex/field-masks-20261113`, base `438d917ff`.
- Local only: no `git push`, no PR. The task ends with a ready branch and a request for the merge decision.
- Docs, comments, commit messages in English.
- Builds only in the worktree's Docker Compose group (`just docker-dev-toolchain`, `just docker-dev "$PWD" <port>`). No host `cargo`/`cmake`, no plain `docker compose up/down`, no `prune`.
- Picking up backend edits: `docker stop -t 60 <backend>`, then `just docker-dev-recreate-volume <attempt> <config_sha256> "$PWD" <port> true`. Never plain `docker restart`.
- `cargo test`/`just test` stay banned except where the user lifts it (decision 1). Every behaviour also has a check that needs no test build: plan probes or headless runs in the backend container.
- Never stop `mc`, `mc-backup` or the `fullmag-master` group. One GPU job at a time; check `nvidia-smi` first.
- One script for every lane: scripts switch only `ENGINE`, `DEVICE`, `PRECISION`; an unsupported lane fails with an explicit code.
- A problem without masks produces byte-identical ProblemIR, plan and drive `projection_signature`; built-in waveform kinds keep their CUDA code path.
- The solver never calls Python and never evaluates a mask equation during a run.
- The IR, the planner, the solvers and the UI know only L0 terms (design §1). L1 and L2 produce L0 terms.
- `fullmag-expr` depends on `std` only.
- Before any Docker build: `df -h /mnt/c` shows more than 60 GB free.
- Results, plots, comparison scripts go to `~/git/simulations` as real files.

## Review Focus

1. Python the transpiler cannot express (`if`, a loop, `np.sin`, a helper call, `t` inside a mask, `x` inside a time function), or a parameter that got no value in `fm.mask(...)`/`fm.time(...)` → `MaskFunctionError` naming the line or the parameter, never a silently dropped statement. Test in Task 4.
2. A parameter or an equation edited in the Control Room drops another term, parameter or local, or reorders locals so a later local refers to an undefined name. Tests in Tasks 7, 8.
3. A time function non-finite inside the run (`log(t)` at t = 0) → planning error, not NaN. A mask on `fem` or with two magnets → `mask_field_drive_unsupported_lane`. Tests in Task 5.
4. The clock of `t` jumps at a stage boundary, or a relaxation stage advances the absolute clock → wrong phase after the boundary. Tests in Tasks 7 and 10.
5. Existing `RegionalFieldDrive` scripts → unchanged IR, plan signature and CUDA trajectory. Tests in Tasks 3, 5, 9.

---

### Task 0: mumax3 ground truth — DONE 2026-11-13

`~/git/simulations/amumax/racetrack_3.6GHz/`: `original.mx3`, `clock_check.*`, `dump_inputs.*`, `inputs.npz`, `README.md`.

### Task 1: Worktree and contract documents — DONE 2026-11-13 (`c8390da6a`, `9578adb29`; source map deferred until the mapped symbols exist)

**Files:**
- Create worktree (skill `using-git-worktrees`; registry entry per `docs/guides/fullmag-build-storage-governance.md`)
- Create: `docs/superpowers/specs/2026-11-13-field-masks-design.md` (design rev. 6), `docs/superpowers/plans/2026-11-13-field-masks.md` (this plan)
- Create: `docs/specs/mask-function-v1.md` (restricted Python subset §3, `field_expr.v1` §5, error codes, bytecode table below)
- Create: `docs/physics/0922-masks-for-field-excitation.md` + `.source-map.json` (skill `scientific-documentation-contract`, all 15 sections; FEM: "not realized; path design §6")
- Create: `docs/adr/0081-explicit-field-masks.md` (layers L0–L2; mask vs region vs antenna module)
- Modify: `docs/physics/0920-…md` (cross-reference), `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md` + `.json` (row `mask_field_drive`: FDM CPU/CUDA executable, FEM unsupported with explicit rejection)

**Interfaces:**
- Produces the names later tasks use. Error codes: `expr_syntax`, `expr_unknown_name`, `expr_arity`, `expr_too_large`, `mask_function_wrong_variable`, `mask_support_empty`, `mask_expression_non_finite`, `mask_array_invalid`, `mask_target_unknown`, `mask_too_many_terms`, `mask_field_drive_unsupported_lane`, and for Task 12 `mask_not_separable`. Bytecode `fullmag_time_expr.v1` (opcodes stored as `f64`):

| Code | Op | Code | Op | Code | Op |
|---|---|---|---|---|---|
| 0 | RETURN | 9 | SIN | 18 | TANH |
| 1 | PUSH (next word = literal) | 10 | COS | 19 | EXP |
| 2 | LOAD_T | 11 | TAN | 20 | LOG |
| 3 | ADD | 12 | ASIN | 21 | SQRT |
| 4 | SUB | 13 | ACOS | 22 | ABS |
| 5 | MUL | 14 | ATAN | 23 | MIN |
| 6 | DIV | 15 | ATAN2 | 24 | MAX |
| 7 | POW | 16 | SINH | | |
| 8 | NEG | 17 | COSH | | |

- [ ] **Step 1:** Write the documents; the physics note's example is design §3.
- [ ] **Step 2:** Run `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0922-masks-for-field-excitation.source-map.json --repo-root .` — exit 0 once mapped symbols exist; rerun after each task that adds one.
- [ ] **Step 3:** Commit `docs: define explicit masks for field excitation`.

### Task 2: Crate `fullmag-expr` — DONE 2026-11-13 (`04f6fc28c`; tests run in CI only, the local test ban stays)

**Files:**
- Create: `crates/fullmag-expr/Cargo.toml` (no dependencies), `src/{lib.rs,lexer.rs,parser.rs,function.rs,bytecode.rs}`, `tests/expr_tests.rs`, `tests/function_tests.rs`, `tests/fixtures/time_program_golden.json`
- Modify: workspace `Cargo.toml`

**Interfaces:**
- Produces:

```rust
pub const FIELD_EXPR_VERSION: &str = "field_expr.v1";
pub const TIME_PROGRAM_VERSION: u32 = 1;
pub const MAX_MASK_TERMS: usize = 8;
#[derive(Clone, Copy, PartialEq, Eq)] pub enum FunctionKind { Mask, Time }   // variables x,y,z | t
pub struct FunctionSource<'a> {                       // mirrors FunctionIR
    pub parameters: &'a [(String, f64)],
    pub locals: &'a [(String, String)],
    pub outputs: &'a [String],                        // 3 for Mask, 1 for Time
}
pub struct FunctionError { pub code: &'static str, pub path: String, pub position: usize, pub message: String }
pub struct CompiledFunction { /* parsed locals and outputs */ }
pub fn compile_function(source: &FunctionSource<'_>, kind: FunctionKind)
    -> Result<CompiledFunction, FunctionError>;
impl CompiledFunction {
    pub fn eval_mask(&self, point_m: [f64; 3]) -> [f64; 3];
    pub fn eval_time(&self, t_s: f64) -> f64;
    pub fn depends_on_time(&self) -> bool;             // false for a constant time function
    pub fn canonical_outputs(&self) -> Vec<String>;     // locals substituted
    pub fn time_program(&self) -> TimeProgram;          // Time only
}
pub struct TimeProgram { pub code: Vec<f64>, pub max_stack: u32 }
pub fn eval_time_program(code: &[f64], t_s: f64) -> f64;
```

`FunctionError.path` is `parameters[{i}]`, `locals[{i}]` or `outputs[{c}]`.

- [ ] **Step 1: Write `expr_tests.rs`:** `parses_precedence` (`"2+3*4^2^0.5"`); `unary_minus_binds_looser_than_power` (`"-2^2"` → −4); `rejects_unknown_function` (`"sinn(x)"` → `expr_unknown_name`, position 0); `rejects_arity` (`"atan2(x)"`); `rejects_too_large` (4097 characters); `bytecode_matches_tree` (every golden equation at t ∈ {0, 1e-12, 2.5e-9, 1.7e-8}, bit for bit); `golden_file_is_current`.
- [ ] **Step 2: Write `function_tests.rs`:**
  - `user_antenna_mask_matches_closed_form`: the design §3 mask (parameters, locals `k, sigma_y, g`, 3 outputs) at 5 points equals the Rust closed form within 1e-15 relative; component 1 is exactly 0.
  - `user_antenna_time_matches_sine`: at 5 times within 1e-15; `time_program` evaluates to the same bits.
  - `locals_are_evaluated_in_order`; `local_refers_to_later_local` → `expr_unknown_name`, `path == "locals[0]"`.
  - `mask_rejects_t` and `time_rejects_x` → `mask_function_wrong_variable` with path and position.
  - `mask_needs_three_outputs`, `time_needs_one_output` → `expr_arity`.
  - `parameter_shadowing_variable_or_function_is_rejected` (`x`, `sin`, `pi`).
  - `constant_time_function`: output `"1"` → `depends_on_time() == false`, program `[1, 1.0, 0]`.
- [ ] **Step 3: Write the golden file:** 12 time equations covering every opcode, each with `code` and 4 (t, value) pairs.
- [ ] **Step 4: Implement** (recursive-descent parser; locals inlined when compiling; constant folding).
- [ ] **Step 5: Check.** If decision 1 lifts the ban for this crate: `cargo test -p fullmag-expr` in the worktree backend — all pass. Otherwise the crate is exercised by Task 5's probe.
- [ ] **Step 6: Commit** `feat(expr): add field_expr.v1 functions and time bytecode`.

### Task 3: IR types and validation — DONE 2026-11-13 (`c29ea5101`)

**Files:**
- Create: `crates/fullmag-ir/src/mask_field_drive.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`, `crates/fullmag-ir/src/validation.rs`, `crates/fullmag-ir/Cargo.toml`
- Test: `crates/fullmag-ir/tests/mask_field_drive_tests.rs`

**Interfaces:**
- Consumes: `fullmag_expr::{compile_function, FunctionKind, FunctionSource, MAX_MASK_TERMS}`.
- Produces: `MaskFieldDriveIR`, `MaskTermIR { mask: MaskSourceIR, time: Option<FunctionIR> }`, `MaskSourceIR::{Function, Sampled}` (serde tag `kind`), `LibraryCallIR` (`MaskTermIR.origin`, optional, ignored by the planner), `FunctionIR`, `FunctionParameterIR { name, value, source }`, `FunctionLocalIR { name, expression }` exactly as design §4 (`deny_unknown_fields`); `ProblemIR.mask_field_drives` with `#[serde(default, skip_serializing_if = "Vec::is_empty")]`; `pub fn validate_mask_field_drives(problem: &ProblemIR, errors: &mut Vec<String>)`; `impl FunctionIR { pub fn compile(&self, kind: FunctionKind) -> Result<CompiledFunction, FunctionError> }`. Error strings: `{code}: mask_field_drives[{i}].terms[{j}].{mask|time}.{path} @{position}: {message}`.

- [ ] **Step 1: Write the tests:** `problem_without_mask_drives_serializes_unchanged`; `mask_field_drive_round_trips` (three terms: function + time, function without `time`, sampled array + time); `rejects_sampled_mask_with_bad_lattice` (zero size, non-positive cell, empty path or sha256 → `mask_array_invalid`); `rejects_mask_using_t` (`mask_function_wrong_variable`, path `mask_field_drives[0].terms[0].mask.outputs[0]`); `rejects_unknown_target` (`mask_target_unknown`); `rejects_non_finite_parameter`; `rejects_zero_or_nine_terms` (`mask_too_many_terms` for nine); `rejects_duplicate_ids` (also against `field_drives` ids); `drive_active_in_relax_requires_constant_time`; `time_origin_defaults_to_stage_local_and_accepts_absolute`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Check** `just check-api-source` and `just check-cli-source` in the worktree backend — exit 0.
- [ ] **Step 4: Commit** `feat(ir): add mask field drives to ProblemIR`.

### Task 4: Python API — units, transpiler, `add_simpleantenna.mask`, ready antenna — DONE 2026-11-14 (`0e53f8a2a`: units, transpiler, `fm.mask`/`fm.time`, `MaskAntenna`, stage action; `VectorMask`/`study.new_vector_mask` with the array inside the IR (float32, zlib, base64, sha256); `fullmag.antennas.gaussian_k_source` (function and loop style), `READY_ANTENNAS`, `rebuild`, origin contract in `docs/specs/mask-function-v1.md` section 6; probe case `ready_antenna`: basis and time program identical to the hand-written pair)

**Files:**
- Create: `packages/fullmag-py/src/fullmag/units.py` (`nm, um, mT, T, GHz, MHz, ns, ps` as floats)
- Create: `packages/fullmag-py/src/fullmag/model/mask_function.py` (transpiler, `MaskFunction`, `TimeFunction`, `fm.mask`, `fm.time`), `model/vector_mask.py` (`VectorMask`), `model/mask_field_drive.py` (`MaskAntenna`), `fullmag/antennas.py` (`gaussian_k_source`)
- Modify: `fullmag/__init__.py`, `model/__init__.py`, `world.py` (`study.add_simpleantenna.mask`; `study.new_vector_mask`; `stages.add_field_drive` accepts `MaskAntenna`; problem build writes array files), `model/problem.py`
- Test: `packages/fullmag-py/tests/test_mask_function.py`, `test_vector_mask.py`, `test_mask_antenna.py`, `test_ready_antennas.py`

**Interfaces:**
- Produces:

```python
class MaskFunctionError(ValueError): ...            # "line {n}: …" or "parameter '{name}': …"
class MaskFunction:                                 # (x, y, z, params…) -> (Bx, By, Bz)
    parameters: tuple[tuple[str, float, str | None], ...]   # name, value, source text if known
    locals: tuple[tuple[str, str], ...]                     # name, field_expr text
    outputs: tuple[str, str, str]
    def with_parameter(self, name: str, value: float) -> "MaskFunction"
    def to_ir(self) -> dict[str, object]
class TimeFunction: ...                             # (t, params…) -> float; same members, outputs: tuple[str]
def mask(function, /, **values: float) -> MaskFunction      # exported as fm.mask
def time(function, /, **values: float) -> TimeFunction      # exported as fm.time
class VectorMask:                                   # array mask, tesla, float32
    size: tuple[int, int, int]; cell_m: tuple[float, float, float]; origin_m: tuple[float, float, float]
    array: "numpy.ndarray"                          # shape (nz, ny, nx, 3)
    def index2coord(self, i: int, j: int, k: int) -> tuple[float, float, float]   # cell centre, world
    def set_vector(self, i: int, j: int, k: int, value: Sequence[float]) -> None
    def save(self, path) -> str                     # writes .npy, returns sha256
    @classmethod
    def load(cls, path, *, cell, origin) -> "VectorMask"
class MaskAntenna:
    id: str; name: str; target_object_id: str; shape: object
    position_m: tuple[float, float, float]; frame: str; enabled: bool
    terms: tuple[tuple[MaskFunction | VectorMask, TimeFunction | None], ...]
    def add(self, mask: MaskFunction | VectorMask, time: TimeFunction | None = None) -> "MaskAntenna"
    def to_ir(self, *, activation: DriveActivation, asset_dir) -> dict[str, object]
# study.add_simpleantenna.arbitrary_mask(target, shape, position=(0, 0, 0), frame="local",
#     time_origin="stage_local", name=None, id=None) -> MaskAntenna   # authoring only
# study.field_drives.add(antenna)                         # active for the whole study (activation)
# study.new_vector_mask(size=None, cell=None, origin=None) -> VectorMask   # default: the study's FDM grid
# study.stages.add_field_drive(antenna, stage_id=...)     # stage action add_mask_field_drive
# study.stages.remove_field_drive(antenna.id, stage_id=...)
# fullmag.antennas.gaussian_k_source(study, *, amplitude, wavelength, frequency, fwhm_y, center_x,
#     sigma_x=None, t0=0.0, n_layers=None, style="function")
#     -> tuple[tuple[MaskFunction | VectorMask, TimeFunction], ...]   # style "function" | "loop"
# fullmag.antennas.READY_ANTENNAS: dict[str, ReadyAntennaSpec]        # name -> callable, argument names, units, docs
# Terms returned by a ready antenna carry origin = (function path, arguments, call_index, output_index).
```

`antenna.add` raises `TypeError` for a bare callable: `"wrap the function: antenna.add(fm.mask(f, name=value, …), fm.time(g, …))"`.

- [ ] **Step 1: Write `test_mask_function.py`:**
  - `test_antenna_mask_transpiles`: design §3 `fm.mask(antenna_mask, B01=0.2*mT, wavelength=279*nm, fwhm_y=240*nm, xs=6000*nm/2.3)` → parameters `B01, wavelength, fwhm_y, xs` with values `2e-4, 2.79e-7, 2.4e-7, 6e-6/2.3`; locals `k, sigma_y, g`; `outputs[1] == "0.0"`; every `**` became `^`.
  - `test_antenna_time_transpiles`: `fm.time(antenna_time, frequency=3.6*GHz, t0=0.0)` → parameters `frequency, t0`; output `sin(2 * pi * frequency * (t - t0))` in `field_expr` text.
  - `test_missing_value_is_an_error` (`fm.mask(antenna_mask, B01=1e-3)` → `MaskFunctionError` naming `wavelength`); `test_unknown_value_is_an_error` (`fm.mask(antenna_mask, …, foo=1)`); `test_default_in_def_is_used_when_no_value_given`; `test_value_overrides_default`.
  - `test_closure_and_global_numbers_are_captured`; `test_math_prefix_is_accepted`.
  - Rejections, each `MaskFunctionError` with the right line: `if`, `for`, a helper call, `np.sin`, a mask whose first parameters are not `x, y, z`, a time function whose first parameter is not `t`, `t` used in a mask, a mask `return` that is not a 3-tuple, a time `return` that is a tuple, augmented assignment, a local assigned twice, a lambda (no source).
- [ ] **Step 1b: Write `test_vector_mask.py`:** `test_default_lattice_is_the_fdm_grid` (universe 80×40×20 nm, cell 5 nm → `size == (16, 8, 4)`, `index2coord(0,0,0) == (-37.5e-9, -17.5e-9, -7.5e-9)`); `test_set_vector_and_array_agree`; `test_loop_function_returns_filled_mask` (design §3 `antenna_mask_loop` on that grid equals the closed form at every cell within float32 rounding); `test_save_load_round_trip` (same sha256); `test_new_vector_mask_without_grid_needs_cell` (FEM study without `study.cell` → `ValueError` naming `cell`); `test_out_of_range_index_raises`.
- [ ] **Step 2: Write `test_mask_antenna.py`:** `test_add_returns_self_and_appends_terms`; `test_bare_callable_is_rejected_with_hint`; `test_static_term_has_no_time`; `test_lowers_to_ir` (keys of design §4; an array term writes `<asset_dir>/<antenna id>_term<n>.npy` and records path, sha256, size, cell, origin); `test_ninth_term_is_rejected`; `test_add_field_drive_registers_stage_action` (action kind `add_mask_field_drive`, full drive payload; a `RegionalFieldDrive` still emits `add_field_drive`); `test_field_drives_add_accepts_mask_antenna`; `test_remove_field_drive_removes_mask_antenna`; `test_antenna_never_added_warns`; `test_user_module_returning_pairs_works` (design §3 `my_antenna`, two terms); `test_problem_without_masks_has_no_mask_keys`; `test_target_must_be_a_magnet`.
- [ ] **Step 3: Write `test_ready_antennas.py`:** `test_gaussian_k_source_equals_hand_written` (`style="function"`: equal `outputs` text after parameter substitution to the design §3 functions); `test_loop_style_equals_function_style` (`style="loop"` on a 16×8×4 grid: array equals the function evaluated at the cell centres within float32 rounding); `test_terms_carry_origin` (function path, the argument values, `output_index`); `test_registry_lists_gaussian_k_source_with_argument_names`.
- [ ] **Step 4: Run** the four files with the repo Python (`just ensure-python`) — fail (modules missing).
- [ ] **Step 5: Implement.** Source lookup: `inspect.getsource`; fallback: the `FunctionDef` in `script_source` found by name and `__code__.co_firstlineno`. Parse with `ast`; defaults are evaluated by Python, their text taken with `ast.get_source_segment`; closure cells and globals resolve free names.
- [ ] **Step 6: Run** the four files and `test_regional_field_drive.py` — pass.
- [ ] **Step 7: Commit** `feat(py): add hand-written function and array masks, time functions and a ready antenna`.

### Task 4b: Adopted from Mateusz's V4 (IR, Python) — DONE 2026-11-14 (`8f91dce64`)

**Files:**
- Modify: `crates/fullmag-ir/src/mask_field_drive.rs` (`target: FieldTargetIR` replaces `target_object_id`; `MaskTermIR.name`; validation of region targets and term names), `crates/fullmag-ir/tests/mask_field_drive_tests.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/mask_function.py` (SSA renaming of reassigned locals, augmented assignment), `model/mask_field_drive.py` (target, term names, `with_parameters`), `world.py` (`StudySimpleAntennaFactory.arbitrary_mask`, scoped factories on `MagnetHandle` and `ObjectRegion`, `stages.update_field_drive`)
- Test: `packages/fullmag-py/tests/test_mask_function.py`, `test_mask_antenna.py`

**Interfaces:**
- Produces: `study.add_simpleantenna.arbitrary_mask(target, shape, position=(0, 0, 0), *, frame="local", time_origin="stage_local", activation=None, name=None, id=None)`; `magnet.add_simpleantenna.arbitrary_mask(shape, ...)`; `region.add_simpleantenna.arbitrary_mask(shape, ...)` (`target=` rejected: `scoped_target_override_not_allowed`); `antenna.add(mask, time=None, *, name=None)`; `study.stages.update_field_drive(antenna_or_id, *, mask_parameters=None, time_parameters=None, term=None, stage_id=None)` emitting `{"kind": "update_mask_field_drive", "drive_id", "term", "mask_parameters", "time_parameters"}`.

- [ ] **Step 1: Tests:** reassignment `g = ...; g = g * ...` transpiles to locals `g`, `g_2` and outputs use `g_2`; `g *= 2` works; `region.add_simpleantenna.arbitrary_mask` gives target `{"kind": "region", ...}`; `film.add_simpleantenna...` gives `{"kind": "object", ...}`; scoped `target=` rejected; duplicate term names rejected; Update: patched instance in the following stages, base antenna unchanged, re-Add after Remove installs the base values, unknown parameter / inactive id / missing term selector rejected; Rust IR tests for region target, unknown region, duplicate term names.
- [ ] **Step 2: Implement.** **Step 3:** run Python tests (pytest, repo venv) and `cargo check -p fullmag-ir`. **Step 4: Commit** `feat: adopt scoped factories, region targets, term names, SSA and Update`.

### Task 5: FDM planner — DONE 2026-11-14 (probe 15/15; a regional-only plan is byte-identical to the `438d917ff` binary)

**Files:**
- Create: `crates/fullmag-plan/src/mask_field.rs`
- Modify: `crates/fullmag-plan/src/selection/geometry.rs` (`GeometryPredicate::from_region_shape`), `crates/fullmag-plan/src/fdm.rs` (call next to `resolve_fdm_regional_field_drives`; multilayer rejection), `crates/fullmag-plan/src/fem.rs` (rejection), `crates/fullmag-plan/src/lib.rs` (a mask drive counts as a localized source for `spin_wave_response` finite k), `crates/fullmag-ir/src/plan.rs` (`ResolvedMaskFieldTermBasisIR`, `FdmPlanIR.mask_field_term_bases`), runner literals of `FdmPlanIR`
- Create: `scripts/benchmarks/fdm_mask_plan_checks.py`, `scripts/benchmarks/test_fdm_mask_plan_checks.py`

**Interfaces (as implemented):**
- Consumes: Tasks 2–4b.
- Produces:

```rust
// mask_field.rs
pub(crate) struct FdmMaskFieldDomain<'a> {
    pub cell_centres_m: &'a [[f64; 3]], pub active_mask: Option<&'a [bool]>,
    pub region_mask: &'a [u32], pub region_legend: &'a [FdmRegionLegendEntryIR],
    pub target_aliases: &'a [&'a str],           // magnet name, geometry name, object id
    pub object_translation_m: [f64; 3], pub stage_start_time_s: f64,
}
pub(crate) fn active_mask_field_drives(problem: &ProblemIR) -> Vec<&MaskFieldDriveIR>;
pub(crate) fn resolve_fdm_mask_field_terms(problem: &ProblemIR, domain: &FdmMaskFieldDomain<'_>)
    -> Result<Vec<ResolvedMaskFieldTermBasisIR>, PlanError>;
```

Support = active cell ∧ target cells (global: all; object: the magnet; region: the cells whose exclusive marker is the region) ∧ cell centre inside the shape placed at `frame_origin` (world: `position`; local: object translation + `position`; a global target uses the world frame). Signature = sha256 over `mask_field_term.v1`, drive id, term index, program words and field values (raw little-endian bytes). The time function is checked at the stage start (the horizon is not in ProblemIR); the runner checks every evaluation (Task 6).

- [ ] **Step 1: Write the plan probe** (pattern of `fdm_regions_pbc_abi_checks.py`: lower scripts with `python3 -m fullmag.runtime.helper export-run-config`, plan each stage with `fullmag-bin plan-json --execution-plan`, assert on `backend_plan.mask_field_term_bases`) and the unit test of its helpers. Cases on a 16×8×4 grid of 5 nm, magnet `film` centred at the origin:

| Case | Antenna | Expected |
|---|---|---|
| `uniform_static` | mask `(0, 0, 1e-3)`, no time; shape = whole film | 1 basis; every active cell `[0,0,1e-3/μ0]`; `time_program == [1, 1.0, 0]` |
| `box_support` | same; `shape=Box(40nm,20nm,10nm)`, `position=(0,0,-5nm)`, world | non-zero cells = 8·4·2, all k ∈ {0,1} |
| `local_frame` | mask `(B*x/L, 0, 0)`; `frame="local"`, `position=(20nm,0,0)` | value at each cell = `B*(x_cell − 20nm)/L` within 1e-15 relative |
| `formula` | mask `(B*x/L, 0, B*cos(2*pi*y/L))`, world | closed form at every cell centre within 1e-15 relative |
| `two_terms` | `add(mask_sin_kx, cos_wt)`, `add(mask_minus_cos_kx, sin_wt)` | 2 bases with `term_index` 0, 1 and the two time programs |
| `reassigned_locals` | Mateusz-style mask with `g = …; g = g * …; g *= B01` and a time function that reassigns `t` | field and time program equal to the Python functions |
| `region_overlap` | `uniform_static`; region `a` (x<0, priority 1) under region `b` (all, priority 2); shape = box over x<0 | 8·8·4 non-zero cells |
| `regional_unchanged` | existing `RegionalFieldDrive` script | plan JSON equals the master plan; no `mask_field_term_bases` key |
| `empty_support` | shape outside the film | fails, `mask_support_empty` |
| `non_finite_time` | time `log(t)` | fails, `mask_expression_non_finite` |
| `region_target` | `region.add_simpleantenna...`, region `a` covering x<0 | non-zero cells = the cells whose `region_mask` is region `a` |
| `region_target_shadowed` | region `a` under region `b` of higher priority, target `a` | fails, `mask_support_empty` |
| `global_target` | `target="global"` | every active cell inside the shape |
| `fem` | `uniform_static` with `engine("fem")` | fails, `mask_field_drive_unsupported_lane:fem` |
| `multilayer` | `uniform_static` with a second magnet | fails, `mask_field_drive_unsupported_lane:fdm_multilayer` |

- [ ] **Step 2: Implement** the support compiler (reuse `prepare_expression_realization`/`evaluate_expression`; reject state-dependent input), term resolution (evaluate the function mask at supported cell centres, or read the `.npy` file — verify sha256, size and dtype, else `mask_array_invalid` — and copy/resample it; divide by μ0; compile the time program; signature = sha256 of the serde JSON of (drive, term_index, field_xyz)), the time sampling check (4097 uniform samples over the stage horizon), lane rejections.
Deferred to the tasks that add the features: `ready_antenna` (`gaussian_k_source` vs the hand-written pair: identical `field_xyz` and `time_program`), `loop_mask` (`formula` as a loop filling `study.new_vector_mask()`: within 1e-6 relative) and `loop_mask_resampled` (8×4×2 lattice of 10 nm: nearest lattice point, 0 outside) — with `VectorMask` and `fullmag.antennas` of Task 4.

- [ ] **Step 3: Rebuild** the worktree backend; run `docker exec <backend> python3 /opt/fullmag/source/scripts/benchmarks/fdm_mask_plan_checks.py` — `15/15 cases passed`, exit 0 (18/18 with the deferred cases, 2026-11-14).
- [ ] **Step 4: Commit** `feat(plan): resolve hand-written masks into FDM bases`.

### Task 6: Runtime — host multiplier on CUDA, Rust interpreter on CPU — DONE 2026-11-14 (`2f35afe73`: descriptor v3 and HOST_MULTIPLIER on CUDA, `DriveTimeFunction::Expression` on CPU, horizon check, E_drive; verified through the API, see Task 7; `e23e0a6a9`: Step 0 `H_drive` readback — CPU preview dispatcher, CUDA resolved on the host like `H_ant`, `H_drive`/`E_drive` outputs legal with mask antennas; saved `H_drive` equals the sum of the drive terms to 1.3e-14 on CPU and CUDA, `~/git/simulations/fullmag/field_masks/h_drive`; the live-preview path shares the resolver but was not exercised at run time)

**Files:**
- Create: `native/include/fullmag_time_expression.h` (header-only host C function `fullmag_time_expression_eval(const double *code, uint64_t len, double t)`; `FULLMAG_TIME_EXPRESSION_VERSION 1`)
- Modify: `native/include/fullmag_fdm.h` (waveform `FULLMAG_FDM_REGIONAL_FIELD_DRIVE_HOST_MULTIPLIER = 5`; `fullmag_fdm_regional_field_drive_desc_v3 { desc_v2 drive; const double *time_program; uint64_t time_program_len; }`, `static_assert(sizeof == 144)`; setter `fullmag_fdm_backend_set_regional_field_drives_v3`; capability bit; `FULLMAG_FDM_MAX_HOST_MULTIPLIER_DRIVES 8`)
- Modify: `backends/fdm/include/context.hpp` (host copies of the programs; `RegionalFieldDriveParams.host_multiplier_slot`), `backends/fdm/gpu/cuda/runtime/context.cu` (v3 upload; v1/v2 forward to v3), `backends/fdm/gpu/cuda/interactions/regional_field_drive.cuh` (struct `RegionalFieldDriveHostMultipliers { double value[8]; }` passed by value; `case 5: return host.value[params.host_multiplier_slot];`), the four kernels that call `regional_field_drive_component` (`demag_fp64.cu`, `demag_fp32.cu`, `energy_density_fp64.cu`, `runtime/reductions_fp64.cu`) and their host launch sites (evaluate the programs at the launch's `evaluation_time_s − time_offset_s`), `backends/fdm/api/c_api.cpp`
- Modify: `crates/fullmag-fdm-sys`, `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` (`NativeDriveSpec::MaskTerm`, capability check, v3 call), `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` (host `E_drive`), `crates/fullmag-engine/src/fdm/shared/terms.rs` (`DriveTimeFunction`), `crates/fullmag-runner/src/fdm/cpu/reference.rs`

**Interfaces:**
- Consumes: `ResolvedMaskFieldTermBasisIR`; `fullmag_expr::{eval_time_program, TIME_PROGRAM_VERSION}`.
- Produces: `pub enum DriveTimeFunction { Waveform(TimeDependenceIR), Expression(Vec<f64>) }`, `fn multiplier_at(&self, local_time_s: f64) -> f64`. Clock: `local_time = absolute_time − origin`, origin = absolute start of the stage that added the antenna (the `waveform_origin_time_s` mechanism of descriptor v2).

- [ ] **Step 0:** Publish `H_drive` (FDM CPU and CUDA) including mask terms; add it to the device evidence of Task 9.
- [ ] **Step 1:** Add `const _: () = assert!(fullmag_expr::TIME_PROGRAM_VERSION == 1);` beside the binding of `FULLMAG_TIME_EXPRESSION_VERSION`; the runner refuses mask terms when the capability bit is missing or when more than 8 host-multiplier terms are active (`mask_too_many_terms`).
- [ ] **Step 2: Implement.** Built-in waveform cases in `regional_field_drive_multiplier` stay as they are.
- [ ] **Step 3: Check:** rebuild the worktree backend — the `phase: development` receipt reports success; `just check-api-source` exit 0.
- [ ] **Step 4: Commit** `feat(fdm): add host-evaluated time multipliers for mask terms`.

### Task 7: Stage pipeline, scene, script and API round trip — PARTIAL (`c1ea04542` scene, `980a8c4e5` stage actions; Update equals Remove + Add bit for bit on CPU and CUDA through the API; open: API resource CRUD and ready-antenna endpoints, array-mask export, the Rust tests of Step 1)

**Files:**
- Modify (stage pipeline): `crates/fullmag-application/src/script_stage_contract.rs` (`ScriptExecutionStageAction::AddMaskFieldDrive { drive: MaskFieldDriveIR }`, `UpdateMaskFieldDrive { drive_id, term, mask_parameters, time_parameters }` and the resolved variants), `crates/fullmag-application/src/script_stage_materialization.rs` (materialize the action and the pipeline payload, `ensure_mask_field_drive_can_be_added`, `remove_field_drive` searches both lists, transition metadata = continue in place), `crates/fullmag-application/src/script_pipeline_compilation.rs` (authored-configuration check), `crates/fullmag-cli/src/orchestrator.rs` (synthetic stage record `add_mask_field_drive`), `crates/fullmag-cli/src/control_room.rs` (stage kind lists), `crates/fullmag-authoring/src/builder.rs` (`StudyPrimitiveStageKind::AddMaskFieldDrive`, pipeline-input configuration), `crates/fullmag-api/src/openapi_v2.rs` (stage kind enum)
- Modify (Python): `packages/fullmag-py/src/fullmag/runtime/script_builder.py` (stage rendering `study.stages.add_field_drive(<antenna>, stage_id=...)` for both kinds; label "Add Antenna"), `runtime/scene_document.py`, `runtime/loader.py` (introduced drive ids for `add_mask_field_drive`), `crates/fullmag-authoring/src/{scene.rs,validation.rs,adapters.rs}`, `crates/fullmag-api/src/schemas/authoring.rs` (`MaskFieldDriveResource`), `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` (CRUD like field drives)
- Regenerate: OpenAPI + TS types (`just docker-dev-codegen "$PWD"`), Python client models
- Test: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`, `test_scene_document_problem_ir.py`; Rust round-trip test beside the field-drive one

**Interfaces:**
- Produces: rendered script format (fixed):

```python
def <id>_mask_<n>(x, y, z, <name>, ...):
    <local> = <expression with ** for ^>
    return (<Bx>, <By>, <Bz>)

def <id>_time_<n>(t, <name>, ...):
    return <expression>

<id> = study.add_simpleantenna.arbitrary_mask(target=<target>, shape=<shape>, position=<position>,
                                    frame=<frame>, name=<name>, id=<id>)
<id>.add(fm.mask(<id>_mask_<n>, <name>=<source or repr(value)>, ...),
         fm.time(<id>_time_<n>, <name>=<source or repr(value)>, ...))   # one per term; no fm.time for a static term
<id>.add(fm.VectorMask.load(<path>, cell=<cell>, origin=<origin>), fm.time(...))   # array term
for field, drive in <function>(study, <name>=<value>, ...):                          # terms with an origin
    <id>.add(field, drive)
```

  API: `GET …/ready-antennas` (registry: name, arguments, units, docs) and `POST …/mask-field-drives/{id}/ready-antenna` (`{function, arguments}` → the backend runs the Python helper and replaces the terms of that origin).

  API error body `{code, path, position, message}`.

- [ ] **Step 1: Write the tests:** `test_stage_added_mask_antenna_survives_script_scene_script` (Mateusz's form: `add_field_drive(antenna, stage_id="add_source")` then `add_run`; the stage list, stage ids and the drive payload survive); `test_add_then_remove_mask_antenna_stage_round_trips`; Rust `materialize_add_mask_field_drive_updates_following_stages` and `remove_field_drive_removes_mask_drive` (beside the existing `materialize_explicit_remove_field_drive_action_updates_following_state` in `crates/fullmag-cli/src/step_utils.rs`); `test_mask_antenna_survives_script_scene_script` (design §3 antenna plus a second static term: the two ProblemIR `mask_field_drives` are equal; parameter sources survive; locals keep their order); `test_rendered_functions_transpile_to_same_ir`; `test_user_module_script_exports_l0_form` (the `my_antenna` script exports two `def` pairs and two `.add` lines); `test_loop_mask_script_exports_a_file_load` (the exported script loads the `.npy` with the same sha256 and plans to the same basis); `test_ready_antenna_exports_import_and_call` (terms with an `origin` export as `from fullmag.antennas import gaussian_k_source` plus the call with the stored arguments, and re-import to the same IR); `test_script_without_masks_renders_unchanged`; Rust `mask_field_drive_resource_round_trips_through_ir`.
- [ ] **Step 2: Run** the Python tests — the first five fail.
- [ ] **Step 3: Implement**, regenerate API artifacts (diff shows additions only).
- [ ] **Step 4: Run** the tests (pass) and `just check-api-source` (exit 0).
- [ ] **Step 4a: Update** materializes atomically in `script_stage_materialization.rs` (patch the active `ProblemIR.mask_field_drives` entry; reject inactive id, unknown parameter, missing term selector); scenario Add → Run → Update → Run → Remove → Run → Add → Run plans to the expected bases and time programs in each run (base values again after the second Add).
- [ ] **Step 4b: Stage probe** (extends Task 5's probe): a script `run 10 ps → add_field_drive(antenna) → run 10 ps → run 10 ps → remove_field_drive → run 10 ps` plans to: no `mask_field_term_bases` in run 1, one basis in runs 2 and 3, none in run 4. With `time_origin="absolute"`, the planned `time_stage.start_time_s` of run 2 equals 10 ps; with a relaxation stage inserted before run 2 it still equals 10 ps (note 0530). If the relaxation advances it, record the measured value as a finding; do not change the clock in this task.
- [ ] **Step 5: Commit** `feat(stages): add and remove mask antennas in the study pipeline`.

### Task 8: Control Room panel

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/mask/MaskAntennaPanel.tsx`, `MaskAntennaPanelModel.ts`, `MaskAntennaPanelModel.test.ts`, `MaskAntennaPanel.dom.test.tsx`
- Follow Mateusz's V3 §12–14 and V4 §6 for the Explorer (antenna under its object/region), the Add/Update/Remove inspectors and the Run inspector's active set, as far as they fit this panel; the five-kind catalog is later work.
- Modify: the inspector registry that lists `RegionalFieldDrivePanel`; resource hooks (typed client only); the study pipeline: `apps/control-room/src/modules/explorer/builders/study/` (node for `add_mask_field_drive`), `inspector/panels/StudyStageAuthoringModel.ts`, `studyPipelineStageDrafts.ts`, `StudyStageInspectorRouter.tsx` (the "Add Antenna" stage offers both antenna types; the mask type embeds `MaskAntennaPanel`)

**Interfaces:**
- Consumes: generated `MaskFieldDriveResource`; error body of Task 7.
- Produces: `applyMaskAntennaEdit(resource, edit): MaskFieldDriveResource` (pure; keeps everything the edit does not name; never reorders terms or locals).

- [ ] **Step 1: Write the tests:** `changing a parameter value keeps locals, outputs and other terms`; `adding a term keeps existing terms`; `removing term 1 keeps term 2 unchanged`; `editing one local keeps the order of the others`; `shows the server error under its equation` (path `terms[1].mask.locals[2]` → message under the third local of term 2, with position); `target and shape edits keep the terms`; `an array term is shown read-only and survives edits of other terms`; `changing an argument of a ready antenna posts the call and replaces only its terms`; `Add Antenna stage with the mask type creates an add_mask_field_drive draft`; `the stage inspector edits the antenna of its stage only`.
- [ ] **Step 2: Run** `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/mask` in the frontend container — fails.
- [ ] **Step 3: Implement.** Antenna: target, shape, position, frame. Term list with Add/Remove; per term the mask (parameter table: name, value, source read-only; local equations; `Bx`, `By`, `Bz` in T) and the time function (parameters, locals, `f(t)`; "static" toggle); an array mask shows file, lattice and value range, read-only; terms with an origin are grouped under the ready antenna's name with its argument form ("Add ready antenna" lists the registry). Save sends the whole resource and shows server errors. No client-side evaluation.
- [ ] **Step 4: Run** the tests, `just lint-control-room-source`, `just check-control-room-production-source` — pass. Browser check in the worktree group: open the antenna, change `frequency`, save, export the script, find the new value in the `def`; add a second term; enter `t` in a mask equation and see the error at its field. Screenshot to `~/git/simulations/fullmag/field_masks/ui_panel.png`.
- [ ] **Step 5: Commit** `feat(control-room): edit mask antennas`.

### Task 9: Device evidence and overhead on FDM CPU and CUDA

**Files:**
- Create: `scripts/benchmarks/fdm_mask_case.py`, `run_fdm_mask_parity.py`, `test_run_fdm_mask_parity.py` (pattern: `fdm_regions_parity_case.py`, `run_fdm_regions_parity.py`)

**Interfaces:**
- Produces: `parity.jsonl`, a Markdown table, exit 0 only if every check passes; a lane that cannot start is a failure.

Common case: grid 32×16×4 of 5 nm, one magnet, Ms 800 kA/m, alpha 0.5, exchange and demag off, `study.solver(integrator="rk45", fix_dt=1e-13)`, 200 steps, table every step (`t, mx, my, mz, e_drive`), final `m`. Lanes `cpu/double`, `gpu/double`, `gpu/single`.

| Case | Setup | Checks |
|---|---|---|
| `support` | m0 (1,0,0); mask `(0,0,5e-3)` static; shape = lower two layers | cells k ∈ {2,3}: final m = m0 bit for bit; cells k ∈ {0,1}: \|Δm\| > 1e-3 |
| `energy` | m0 (0,0,1) frozen on all cells; mask `(0,0,B)`, time `exp(-((t-t0)/s)**2)` | `e_drive(t) = −B·Ms·V·N·f(t)` at every row; ≤ 1e-12 relative (fp64), ≤ 1e-6 (fp32) |
| `vs_builtin` | m0 (1,0,0); `RegionalFieldDrive` uniform 5 mT z + `Sinusoidal(5e9)` vs mask `(0,0,B)` + time `sin(2*pi*f*t)` on the same lane | max\|Δm\| ≤ 1e-12 (fp64), ≤ 1e-6 (fp32) |
| `two_terms` | m0 (0,0,1); hand-written travelling wave (two terms), CPU vs CUDA | CUDA fp64 vs CPU max\|Δm\| ≤ 1e-10; fp32 ≤ 1e-5 |

Overhead (GPU double, grid 256×256×8, exchange and demag on, adaptive RK45, 2000 steps, three runs each, median steps/s): (a) no drive, (b) `RegionalFieldDrive` uniform + `Sinusoidal`, (c) mask + time function with the same field. Criterion: (c) ≥ 0.98 × (b). Report (b)/(a) as the cost of leaving the adaptive graph; not a pass criterion.

- [ ] **Step 1:** Write the unit test of the comparison helpers (untouched-cell violation, energy mismatch, missing lane → non-zero exit); run — fails.
- [ ] **Step 2:** Write the case and the runner; unit test passes.
- [ ] **Step 3:** Run in the worktree backend: `python3 scripts/benchmarks/run_fdm_mask_parity.py --output /tmp/mask-parity --with-overhead` — 12 parity rows `PASS`, overhead criterion met, exit 0.
- [ ] **Step 4:** Copy evidence to `~/git/simulations/fullmag/field_masks/parity/`; commit `test(fdm): qualify hand-written masks on CPU and CUDA`.

### Task 10: Antenna milestone — inputs equal to mumax3 — PARTIAL (2026-11-14, function and loop style: every criterion met, the loop style equals the dump to 2.7e-20 T; report `~/git/simulations/compare_racetrack_antenna.md`; open: the 240 ABC regions; findings: `export-run-config` fails for action stages when `study.storage(...)` is set, also on master; the FDM grid follows the geometry extent, so the YIG box is placed on cell faces)

**Files:**
- Create: `~/git/simulations/fullmag/racetrack_3.6GHz.py`, `~/git/simulations/compare_racetrack_antenna.py`, output `compare_racetrack_antenna.md`

**Interfaces:**
- Consumes: `~/git/simulations/amumax/racetrack_3.6GHz/inputs.npz`, `clock_check.zarr/table.txt`.

- [ ] **Step 1: Write the reproduction script** (design §10 model; antenna exactly as design §3, hand-written, `frame="world"`, `time_origin="absolute"` with `t0 = 2 ns` as in mumax3, added by `study.stages.add_field_drive(antenna, stage_id="add_antenna")`; a switch `MASK_STYLE = "function" | "loop"` selects `fm.mask(antenna_mask, …)` or `antenna_mask_loop(study.new_vector_mask(), …)`). Stages as `reference_nothermal.mx3`: `run` 1 ns, `minimize` (PG-BB), `run` 1 ns, `relax`, `add_antenna`, `drive` (15 ns, `study.solver(integrator="rk45", max_error=1e-7, dt_max=1e-13)`), `sample` (160 · 9.5785e-12 s, `dt_max=5e-14`, `m` and `torque` every 9.5785e-12 s). Switch `STAGES = "full" | "short"`; `"short"`: no relax, `add_antenna`, one 100 ps run with `m` every 10 ps.
- [ ] **Step 2: Plan it** with `~/git/simulations/fullmag/region_examples/check_plan.sh` against the worktree backend — `PLAN OK` for all stages; `drive` and `sample` carry exactly 1 `mask_field_term_bases` entry.
- [ ] **Step 3: Compare** (`compare_racetrack_antenna.py`, order z,y,x):

| Quantity | Criterion |
|---|---|
| support | cells with a non-zero basis = non-zero cells of `antenna_mask` (layers 0..8, inside the geometry) |
| values | `max |μ0·field_xyz − antenna_mask| ≤ 1e-6 × 2e-4 T`, for both mask styles; the two styles agree with each other within the same bound |
| time factor | CPU run of a 4×4×1 copy with the `energy` trick of Task 9 and the same time function; `f(t)` against `B_extz(t + 2 ns)` of `clock_check`: max difference ≤ 1e-7 |
| clock continuity | the same tiny run split into two run stages: `f` equals the single-stage run within 1e-12 across the boundary |
| geometry, Ms, Aex, alpha, m0 | identical active cells; Ms, Aex ≤ 1e-6 relative; alpha within 0.0065 only on float-edge cells (listed); m0 identical direction |

- [ ] **Step 4:** Write the report with every measured number.

### Task 11: Short trajectory, feasibility, evidence

**Files:**
- Create: `~/git/simulations/amumax/racetrack_3.6GHz/reference_short.mx3` (`original.mx3` without the block `setsolver(6)` … the four `saveas` lines; `t0 := 0`; `autosave(m, 10e-12)`, `tableautosave(1e-12)`, `run(100e-12)`)
- Create: `~/git/simulations/compare_racetrack_short.py`, outputs `racetrack_feasibility.md`, `compare_racetrack_short.md`
- Modify (worktree): physics note 0922 evidence section, capability matrix row

- [ ] **Step 1:** Run `reference_short.mx3` (mumax3, zarr), then the fullmag script with `STAGES="short"` on GPU double through the managed route. Record device memory at start, PBC kernel build time, steps per second for both codes, wall time.
- [ ] **Step 2: Gates.** Memory preflight refuses → stop and report the refusal text; do not shrink the model. Projected wall time of the full 16.53 ns above 24 h → report before any full run.
- [ ] **Step 3: Compare** `m` at 10, 50, 100 ps: max\|Δm\| over active cells and over YIG layers 0..8 under the antenna. Starting threshold 1e-2; report the numbers either way; above it, hypotheses only.
- [ ] **Step 4:** Record the evidence in the physics note and the matrix (facts only); rerun the source-map validator; commit `docs: record FDM evidence for hand-written masks`.

### Task 12: L2 — single function `f(x, y, z, t)` (Mateusz's form)

**Files:**
- Create: `crates/fullmag-expr/src/separate.rs`, `crates/fullmag-expr/tests/separate_tests.rs`
- Modify: `crates/fullmag-api` (endpoint `POST …/mask-functions/separate`: `FunctionIR` with variables `x, y, z, t` → list of `MaskTermIR`), `packages/fullmag-py/src/fullmag/model/mask_function.py` (`SpaceTimeFunction.from_callable`), `world.py` (`study.add_simpleantenna.arbitrary_mask(function, target, shape, position, frame, name)`), the Control Room panel ("Split a space-time function" dialog that fills the term list)
- Test: `packages/fullmag-py/tests/test_arbitrary_mask.py`

**Interfaces:**
- Produces: `pub fn separate(function: &FunctionSource<'_>) -> Result<Vec<(Vec<String>, String)>, FunctionError>` (per term: three mask outputs and one time output as `field_expr` text, locals substituted); rules of design §8. The result is stored as ordinary L0 terms; no new IR.
- Python needs the Rust separation: `arbitrary_mask` records the function and the terms are produced when the problem is lowered through the native core or the API; without either, `to_ir` raises `MaskFunctionError("arbitrary_mask needs the fullmag runtime to split the function; write the terms by hand or run through fullmag")`.

- [ ] **Step 1: Write `separate_tests.rs`** (each also checks at 5 points × 5 times that `Σ mask_i(r)·time_i(t)` equals the direct evaluation within 1e-12 relative): `product_of_space_and_time` → 1 term; `travelling_wave_expands_to_two_terms`; `mateusz_example` (locals `k`, `envelope`, `phase`) → 2 terms; `components_with_same_time_merge`; `exp_of_sum_factorizes`; `moving_gaussian_is_rejected` (`mask_not_separable`, `path == "outputs[0]"`, message contains the canonical text of the `exp(...)` call); `too_many_terms` (`mask_too_many_terms`).
- [ ] **Step 2: Write `test_arbitrary_mask.py`:** Mateusz's example script plans to 2 terms equal to the hand-written travelling wave of Task 5's `two_terms` case (same `field_xyz` within 1e-12 relative, same time values at 5 times); the user's antenna written as one function plans to 1 term equal to Task 10's basis.
- [ ] **Step 3: Implement**; rebuild; run the tests and the plan probe (now 14 cases with `l2_travelling`, `l2_not_separable`).
- [ ] **Step 4: Commit** `feat: split space-time field functions into mask terms`.
- [ ] **Step 5: Finish** with `finishing-a-development-branch`, local steps only: clean worktree, head hash, commit list, evidence paths. Ask the user about the merge, the full 16.53 ns run and the FEM follow-up.

### Task 13: FEM CPU and FEM GPU lanes — DONE 2026-11-15 (`c64adb258`, `7ed3ed58d`; open: the FEM/FDM one-script comparison)

Added on the user's request of 2026-11-14 (finish the antennas completely, FEM included).

- Planner: `FemPlanIR.mask_field_term_bases`; `resolve_fem_mask_field_terms` evaluates each mask at the nodes of the target's magnetic elements inside the shape (shared resolver with FDM in `crates/fullmag-plan/src/mask_field.rs`); `mask_not_periodic` on periodic node pairs.
- Native FEM: regional-drive ABI v4, time kind `FULLMAG_FEM_TIME_HOST_EXPRESSION` with the time program; CPU evaluates it per drive materialization, GPU on the host with the factors passed to the kernel by value (at most 8); `fullmag_fem_time_expression_eval_v1` for the interpreter cross-check; a non-finite factor stops the step.
- Runner: bases packed as pre-projected nodal drives; horizon check shared with FDM (`crates/fullmag-runner/src/mask_time.rs`); `H_drive`/`E_drive` gates; the certified-equilibrium handoff and the accepted-state materialization treat a stage with mask terms as driven; the Rust FEM reference path rejects masks.
- Evidence (`~/git/simulations/fullmag/field_masks/fem`): a uniform mask equals the built-in regional drive bit for bit on FEM CPU and to 1.4e-17 on FEM GPU; `H_drive` of a position-dependent mask equals the function at the node coordinates to 4.6e-16 on both lanes, is zero outside the support, and the support nodes all lie inside the shape.
- Not done: a plan-only probe for FEM (the mesh asset exists only on the managed route, so the FEM planner is checked through runs); the comparison of `parity_fem.py` with `parity_fdm.py` (blocked by finding 6 until the backend restarts).

---

## Findings outside the masks (2026-11-14, not fixed)

1. A staged `RegionalFieldDrive` fails in the API worker ("physics_graph execution
   observation references unknown module ID"): the scene physics graph lists only
   whole-study drives. The run stays in `waiting_for_compute` instead of failing, and
   after a Stop the workspace cannot be retired until the group restarts.
2. `study.solver(..., max_error=..., dt_max=...)` without `dt_initial` writes
   `"dt_initial": null` into the scene, which the API rejects.
3. CPU and CUDA adaptive RK45 differ by about 1e-4 in m after 1 ns at max_error 1e-9,
   for regional drives and masks alike.
4. FDM CUDA saves fields and table rows at the first accepted step at or after the
   output time (11.27 fs late in the `H_drive` check; FDM CPU lands on the time). The
   `separate` Zarr field layout does not record the sample times, so the offset is
   invisible in a field store.
5. FEM RK45 fails with `adaptive RK decision failed: invalid_timestep` when the stage
   end is a whole number of `dt_max` steps after an output time (0.3 ns, `dt_max`
   0.1 ps, output every 50 ps; also with the built-in regional drive).
6. A scene that cannot be lowered blocks the workspace: a script with `study.cell(...)`
   and `study.universe.mesh(maximum_element_size=...)` is rejected ("FEM mesh controls
   cannot be combined with cell_size"), and every later script fails with
   `live_retirement_capture_failed` until the backend restarts.
7. FEM fields are stored as three blocks (all x, all y, all z) and FDM fields
   interleaved; the field arrays carry neither the layout nor node coordinates.

## User decisions (2026-11-13)

1. `cargo test` ban: open. Recommendation: lift it only for `cargo test -p fullmag-expr` (std-only crate, small build, no CUDA/MFEM). Default: the ban stays; plan probes and device runs carry the evidence.
2. Execution mode: Claude Code native.
3. The primitive is the mumax3 level: hand-written masks — as a function of `(x, y, z)` or as a loop inside a function that fills an array — and time functions, added explicitly; values are given at the call, not in the `def`. The antenna always lives in the script (hand-written or generated by the UI). User modules, ready antennas and the single-function form are layers on top.
4. Scope: field excitation only; FDM CPU/CUDA executable; FEM rejected explicitly and prepared (design §6).
5. Thermal step left out on both sides; the quirks of the mumax3 script are reproduced as they are.
6. Later plans: array masks from OVF files, more ready antennas (the user will send examples), FEM lanes.
7. Design §11 points 1–5: assumed, to be confirmed with the co-author.
9. 2026-11-14: finish the antennas completely, FEM CPU and GPU included (Task 13); leave the bugs found outside the masks as they are.
8. 2026-11-14: keep our core (explicit terms, host scalar time, one Rust evaluator, text equations, cell-centre default, loop masks); adopt from Mateusz's V4: Update stage action with term names, scoped factories and region targets, `arbitrary_mask` naming, SSA reassignment, `H_drive` readback, the four-lane acceptance matrix as the target, and the UI design (`docs/superpowers/specs/2026-11-14-field-masks-comparison-with-v4.md`).
