# Field masks: our plan (rev. 7) vs Mateusz's plan (V1–V4, 2026-11-14)

Sources: `microwave-field-mask-plan-2026-11-13.rar` (MASK-TIME-I-STAGES-V4, KATALOG-I-PYTHON-V3,
PLAN-V2, PLAN-V1; design only, "bez implementacji w produkcie"); our design rev. 7 and branch
`codex/field-masks-20261113`.

## 1. Same user API

Both plans converge on the same script form:

```python
def antenna_mask(x, y, z, B01, wavelength, fwhm_y, xs): ...   # separate def, values at the call
def antenna_time(t, frequency, t0): ...
antenna.add(fm.mask(antenna_mask, B01=0.2*mT, ...), fm.time(antenna_time, frequency=3.6*GHz, t0=0.0))
study.stages.add_field_drive(antenna, stage_id="source_on")
study.stages.add_run(stage_id="run", until=2e-9)
study.stages.remove_field_drive(antenna.id, stage_id="source_off")
```

Shared decisions: no decorator; `x, y, z`, `t` reserved; values in `fm.mask`/`fm.time` win over
`def` defaults; a missing or unknown value is an error; one vector source with one id (no Bx/By/Bz
sources); `antenna.add(field)` without time is static; `t0` is a phase, not a switch; the clock is
`stage_local` or `absolute` as for regional drives, `until` is the length of one run; functions are
transpiled, never called by the solver; presets (`gaussian_k_source`) return the same `(field, drive)`
pair.

## 2. Status against Mateusz's tasks (V4 §8)

| V4 task | Content | Our branch |
|---|---|---|
| S01 | `fm.mask`/`fm.time`, SI bindings, parser | done: transpiler + 28 tests; missing: reassignment (SSA), conditionals |
| S02 | source model/factory, `.add`, script generator | factory + `.add` done; script generator: our Task 7 |
| S03 | stage builder, wire/CLI/resolved action | Python Add/Remove done (`add_mask_field_drive`); Rust contract: Task 7; **Update missing** |
| S04 | pipeline planner / application layer | Task 7 |
| S05 | FDM CPU/GPU | planner basis written and compiling (Task 5, uncommitted); runtime: Task 6 |
| S06 | FEM CPU/GPU | not started; explicit rejection, path described |
| S07 | Study/Inspector/Explorer UI | Task 8 (smaller scope than V3/V4) |
| S08 | `fullmag.antennas` presets | planned (one preset) |
| S09 | four-backend qualification | mumax3 ground truth done; device tests: Task 9–11 |
| — | equation engine, IR, docs | done: `fullmag-expr`, `mask_field_drives` in ProblemIR, ADR 0081, note 0922, spec |

## 3. Architectural differences

| Topic | Mateusz | Ours | Assessment |
|---|---|---|---|
| Time dependence at run time | static basis × waveform; exact separable sum as an optimization; **general non-separable B(r,t) mandatory**: device/native evaluator with quadrature at every RHS | explicit terms `mask_i(r)·time_i(t)` are the primitive (mumax3 `B_ext.Add`); one host-evaluated number per term per field build; single-function form split algebraically; non-separable rejected | ours: zero per-cell cost, identical on all lanes through the existing basis × multiplier path; theirs is more general (moving sources). Our bytecode can be extended to x, y, z, t and run per cell on the device later, as an opt-in tier, without a new language |
| Where equations are evaluated | Rust validation + native C++ FEM evaluator + CUDA device evaluator (general) | spatial: only the Rust planner; time: Rust + one small C header with a shared golden file | ours: one evaluator, smaller parity burden |
| Form in ProblemIR | typed JSON AST (`expression_ast.v2`), extends the existing Python-only `parameter_ast.v1`/`parameter_library.v1`, SI dimension vectors | equation text + `field_expr.v1`, one Rust parser | both store equations, not samples. Text: readable, verbatim round trip, already working. Theirs: schema-level validation, dimension checks, link to the study parameter library (sweeps) |
| FDM projection | cell-volume integral with **certified enclosures** (interval arithmetic, adaptive split, budget 1e8 evaluations) | value at the cell centre (as mumax3 `VectorMask`) | ours: exact mumax3 parity, simple. Theirs: more accurate on coarse grids, but the enclosure requirement is research-grade work that blocks delivery. Proposal: `projection="cell_center"` (default) and later `"cell_average"` (adaptive Gauss as existing regional drives, no certification claim) |
| FEM projection | native C++ L2 projection with quadrature | planned: values at P1 nodes into the existing `PREPROJECTED_NODAL` path | theirs more accurate. Keep one evaluator: native exports quadrature points, Rust evaluates, native projects |
| Loops (mumax3 style) | "not needed"; imperative `setVector` only as a later sampled-asset generator (V2 E12) | first-class: a `def` with a loop that fills `study.new_vector_mask()` | user requirement: functions with or without loops; ours |
| Stage operations | Add / **Update** (typed patch of mask/time parameters, term names, revisions, atomic) / Remove; active set per run | Add / Remove | theirs better; adopt Update and term names |
| Target | global / object / region; scoped factories `study.`, `film.`, `region.add_simpleantenna`; one factory owner | object (magnet) via `study.add_simpleantenna.mask(target, ...)` | theirs better; cheap to adopt |
| Naming | `add_simpleantenna.arbitrary_mask(...)` builder + catalog of five kinds | `add_simpleantenna.mask(...)` | align with theirs (`arbitrary_mask`) |
| Local reassignment | V4 example reassigns `g` (SSA required) | rejected | adopt SSA renaming |
| Conditionals | `if`/`select` with lazy branches in V2 core | not supported (use a loop mask) | useful later; moderate work |
| Units | readable unit literals; dimension checks | plain float literals, no checks | optional later: float-subclass quantities carrying a dimension, checked in Rust |
| Captured globals | must be declared explicitly | numeric globals captured as visible parameters | ours more convenient for mumax3-style scripts |
| Scope of first slice | all four lanes mandatory | FDM CPU/GPU first (user decision); FEM added without IR/API change | to settle with Mateusz |
| UI | catalog, Explorer under the region, Creator, Add/Update/Remove/Run inspectors, preview | one antenna panel, Add Antenna stage type chooser | theirs much richer; compatible with our model |

## 4. Recommendation

Keep our core (explicit terms with host scalar time, one Rust evaluator, text equations, cell-centre
default, loop masks): it is implemented, matches mumax3 behaviour and cost, and extends to their
general tier later. Adopt from Mateusz: Update stage action with term names, scoped factories and
region targets, `arbitrary_mask` naming, SSA reassignment, the four-lane acceptance matrix as the
target, H_drive readback on CUDA, and the UI catalog/inspector design. Settle with Mateusz: FDM-first
order, the certified-enclosure requirement, loops as a first-class mask, the IR form (text vs typed
AST) and the link of mask parameters to the study parameter library.

## 5. Decision

2026-11-14: the recommendation of section 4 is accepted. Design and plan rev. 8 apply it (plan Task 4b,
Task 6 Step 0, Task 7 Step 4a, Task 8).
