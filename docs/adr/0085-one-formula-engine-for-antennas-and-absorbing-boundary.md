# ADR 0085: one formula engine for antennas and the absorbing boundary

- Status: accepted for implementation
- Date: 2026-11-20
- Complements: [ADR 0081](0081-explicit-field-masks.md)
- Physics contract: [`docs/physics/absorbing-boundary-layer.md`](../physics/absorbing-boundary-layer.md#abl-formula-language)
- Data contract: [`docs/specs/mask-function-v1.md`](../specs/mask-function-v1.md), sections 3 and 8

## Context

Two features accept a formula typed as text. The antennas (ADR 0081) store
equations in `field_expr.v1`, which the crate `fullmag-expr` parses and
evaluates; the Python transpiler checks antenna functions with an `ast`
node checker. The absorbing boundary layer accepts a custom ramp profile
`p(u)` and a custom distance `d(x, y, z)` as strings. These had their own
grammar, implemented twice: a hand-written parser and tree evaluator in
`crates/fullmag-ir/src/absorbing_boundary.rs` and a regex plus `ast`
whitelist in `packages/fullmag-py/src/fullmag/model/_absorbing_boundary_expression.py`
(eight functions, `min`/`max` for distances only, no `pi`). The Control Room
had a third copy for its form validation.

Two implementations of one grammar drift apart: each fix and each new
function has to be made twice and nothing checks that they agree.

## Decision

1. **One language.** A profile and a distance are formulas of `field_expr.v1`
   with two new kinds, `FunctionKind::Profile` (variable `u`) and
   `FunctionKind::Distance` (variables `x`, `y`, `z`), each with one output.
   `fullmag-expr` parses and evaluates them; the ABL parser and evaluator in
   `fullmag-ir` are removed.
2. **The owner keeps its rules.** `crates/fullmag-ir/src/absorbing_boundary.rs`
   keeps its public types (`ResolvedAbsorbingBoundaryProfile`,
   `AbsorbingBoundaryCoordinate`) and wraps the compiled function with the
   rules of the layer: at most 256 printable ASCII characters, the 257-point
   probe of a profile in $[0, 1]$ with $p(0) = 0$ and $p(1) = 1$. Errors carry
   the engine code and character position.
3. **One Python front end.** `fullmag.model.mask_function.compile_formula`
   checks a formula with the syntax-tree checker of the antenna functions
   (kind `profile` or `distance`, no capture of free names, no `math.`
   attributes), checks what `ast` does not keep (literal spellings, a
   trailing comma, a parenthesized function name, the nesting depth) and
   evaluates the checked tree with `math`, mapping the exceptions of `math`
   to the IEEE-754 values that Rust computes. Text is never passed to `eval`.
   `_absorbing_boundary_expression.py` is deleted.
4. **Function availability is per kind.** The sixteen shared functions are
   available everywhere. `log1p` is added for profiles and distances only,
   because `fullmag_time_expr.v1` has no opcode for it; `heaviside` stays with
   mask and time functions. `^` is accepted only as the legacy power of mask
   and time equations.
5. **Preserve existing readers.** Profile and distance expressions keep the
   ABL rule that rejects decimal integers such as `01`. Existing mask and
   time expressions still read that spelling as one and may bind a parameter
   or local named `log1p`. Their version remains `field_expr.v1`.
6. **One case table.** `crates/fullmag-ir/tests/fixtures/absorbing_boundary_formula_cases.json`
   lists accepted formulas with values and rejected formulas with an error
   category; the Rust and Python tests read it. The values of the removed
   Python evaluator at the 257 probe points are kept in
   `absorbing_boundary_formula_baseline.json`; both implementations must
   reproduce them for every formula it accepted.

## Consequences

- A profile may use `pi`, `tan`, `asin`, `acos`, `atan`, `sinh`, `cosh`,
  `atan2`, `min` and `max`; a distance may use `pi` and the same functions.
- Arithmetic follows IEEE-754 like the antennas: an intermediate infinity no
  longer rejects a formula whose value is finite (`u + 1/exp(999)` is now the
  linear ramp). Only the value is checked.
- Nesting deeper than 128 levels (for example 130 unary minus signs) is
  rejected; the old parsers had no limit.
- Every stored formula that the old parsers accepted gives the same values;
  the `ProblemIR` fields, OpenAPI and the script export are unchanged.
- The Control Room keeps a client-side check for its form; its function list
  follows this table and the backend remains the authority.

## Out of scope

A `def` form for profiles (`fm.profile`), parameters of profiles, and `log1p`
in time functions (a new time opcode).
