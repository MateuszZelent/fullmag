# `mask_field_drive.v1`: mask and time functions, `field_expr.v1`, time bytecode

- Status: approved implementation contract; implementation in progress
- Schema versions: `mask_field_drive.v1`, `field_expr.v1`, `fullmag_time_expr.v1`
- Owner of the semantics: `ProblemIR` and the crate `fullmag-expr`
- Related: [ADR 0081](../adr/0081-explicit-field-masks.md),
  [ADR 0085](../adr/0085-one-formula-engine-for-antennas-and-absorbing-boundary.md),
  [physics note 0922](../physics/0922-masks-for-field-excitation.md),
  [absorbing boundary layer](../physics/absorbing-boundary-layer.md),
  [design](../superpowers/specs/2026-11-13-field-masks-design.md)

(mask-function-v1-scope)=
## 1. Scope

A mask field drive is a list of terms. Each term is a mask (a vector field in
tesla) and an optional time function (dimensionless). It enters a study through
the stage action `add_mask_field_drive` (Python: `study.stages.add_field_drive`)
or the drive list (`study.field_drives.add`), and leaves it through
`remove_field_drive`. The field of the drive is
the sum of `mask_i(r) · time_i(t)` on the support of the drive. This file fixes
the three data languages behind it:

1. the restricted Python accepted for mask and time functions;
2. the equation text `field_expr.v1` stored in `ProblemIR`;
3. the time bytecode `fullmag_time_expr.v1` consumed by the solvers.

The solver never calls Python. A mask equation is evaluated by the planner only.

The same equation language also carries the two formulas of an absorbing
boundary layer, a ramp profile `u -> number` and a distance `(x, y, z) -> number`
(section 8), and the equations of material parameter fields
`(x, y, z) -> number` (section 9). They are not mask field drives; they share
the parser, the evaluator and the error codes.

(mask-function-v1-python)=
## 2. Restricted Python

| Rule | Mask function | Time function |
|---|---|---|
| Leading parameters | exactly `x, y, z` (metres) | exactly `t` (seconds) |
| Return | a 3-tuple `(Bx, By, Bz)` in tesla | one expression, dimensionless |
| Further parameters | named numbers; values come from `fm.mask(f, name=value, …)` | the same with `fm.time(g, name=value, …)` |

- A parameter without a value and without a default in the `def` is an error; a
  value for an unknown name is an error; a value overrides a default.
- Body: a sequence of assignments `name = expression` or `name op= expression`
  (`op` one of `+ - * / **`) with a single plain name on the left, followed by
  one `return`. A name may be assigned again, also a parameter or the function's
  own variable (`x = x - x0`); the transpiler gives each new value a new local
  (`g`, then `g_2`, `g_3`, skipping names used in the function), so later lines
  and the return read the latest value, as in Python. Augmented assignment of a
  name without a value is an error.
- Expressions: numeric literals; parameters; earlier locals; the leading
  variables; `pi`; binary `+ - * / **`; unary `-` and `+`; calls to
  `sin cos tan asin acos atan atan2 sinh cosh tanh exp log sqrt abs min max`
  written bare or as `math.<name>` (`math.fabs` is accepted as `abs`).
- A free name that resolves to an `int` or `float` in the function's closure or
  globals is captured as a parameter with that value.
- Rejected with `MaskFunctionError("line N: …")`: `if`, `for`, `while`, `with`,
  `try`, comprehensions, lambdas, conditional expressions, comparisons, boolean
  operators, attribute access other than `math.<function>`, subscripts, calls to
  any other function, a parenthesized function name (`(sin)(x)`, which
  `field_expr.v1` cannot read), augmented operators other than `+= -= *= /= **=`, tuple
  assignment, starred arguments,
  keyword-only and positional-only parameters, `*args`, `**kwargs`.
- A function without retrievable source (built-in, lambda, interactive input) is
  rejected.

Code that needs any rejected construct belongs in an array mask: a function that
fills `study.new_vector_mask()` in ordinary Python.

(mask-function-v1-field-expr)=
## 3. `field_expr.v1`

```text
expr   := term (("+" | "-") term)*
term   := unary (("*" | "/") unary)*
unary  := ("-" | "+") unary | power
power  := atom (("**" | "^") unary)?            # right-associative
atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
number := digits ["." digits] [exponent] | "." digits [exponent]
exponent := ("e" | "E") ["+" | "-"] digits
name   := [A-Za-z_][A-Za-z0-9_]*
```

- For a profile or distance, a number written as `digits` alone (no `.`, no exponent) must not start with
  `0` unless all its digits are `0`: `01` is an `expr_syntax` error, as in
  Python; `0`, `00`, `0.5`, `01.5` and `01e3` are numbers.

- Whitespace between tokens is ignored. `**` is one token: its two stars must
  touch (`* *` is a syntax error, as in Python).
- `**` is the power operator, with Python's precedence: it is
  right-associative (`2**3**2` is `2**9`), binds tighter than a unary minus on
  its left (`-x**2` is `-(x**2)`) and accepts a unary minus on its right
  (`2**-x**2` is `2**(-(x**2))`). So an equation written with `**` is a
  Python expression over the names of this section, with the value Python
  gives it except where IEEE-754 and Python differ (below).
- `^` is a legacy spelling of `**`: the same token with the same precedence.
  Equations stored before `**` became canonical (2026-11-20) keep loading with
  their meaning; writers emit `**` only. The version stays `field_expr.v1`
  because the change adds a spelling and changes no meaning: every text
  accepted before is accepted with the same value and the same time bytecode.
  An equation with `**` is not readable by builds older than this change.
  A profile or distance formula (section 8) rejects `^` with `expr_syntax`: no
  stored formula of those kinds used it.
- Variables: `x`, `y`, `z` in a mask function; `t` in a time function; `u`
  in a profile; `x`, `y`, `z` in a distance (section 8) and in a field
  (section 9). `u` is a variable
  of a profile only: in the other kinds it is an ordinary name.
- Reserved names: `x y z t pi` and the original function names. Profiles and distances also reserve `log1p`.
  A parameter or a local may not use a reserved name or a Python keyword
  (`lambda`, `class`, …), since an exported script writes these names as
  Python names; in a profile it may not be named `u` either. Parameter and
  local names are unique within one function.
- An equation is one line: a line break is an `expr_syntax` error.
- Functions and arity: one argument — `sin cos tan asin acos atan sinh cosh tanh
  exp log sqrt abs`; two arguments — `atan2 min max`. These are available in
  every kind. Two more one-argument functions depend on the kind:

  | Function | Mask | Time | Profile | Distance | Field |
  |---|---|---|---|---|---|
  | `log1p(a)` = $\ln(1+a)$ | no | no | yes | yes | no |
  | `heaviside(a)` (0, ½ at 0, 1) | yes | yes | no | no | yes |

  `log1p` has no opcode in `fullmag_time_expr.v1` (section 4), so a time
  function cannot use it; `heaviside` serves the spin-transfer-torque time
  expressions. A function that the kind does not provide is an
  `expr_unknown_name` error.
- A local may refer to parameters and to locals defined before it.
- Limits: 4096 characters, 512 syntax nodes and 128 levels of nesting
  (parentheses, argument lists, unary signs and exponents) per equation; 64 parameters and
  64 locals per function. With its locals substituted, an equation has at most
  65 536 nodes and 512 levels of nesting (a chain of locals that doubles at each
  step is rejected before it is expanded).
- Arithmetic is IEEE-754 binary64. `x**y` is `pow(x, y)`. Where Python raises
  or leaves the reals, the equation gives an IEEE value instead: `0.0**-1` is
  `inf` (Python: `ZeroDivisionError`), `(-8)**(1/3)` is NaN (Python: a complex
  number), an overflow is `inf` (Python: `OverflowError`); integer literals are
  binary64, not Python integers. A non-finite mask or time value is rejected
  with `mask_expression_non_finite` (section 5).
- The Python transpiler keeps `**`, parentheses and formatting, and writes
  numeric literals with `repr`. The canonical text of `fullmag-expr`
  (`CompiledFunction::canonical_outputs`) is a fully parenthesized Python
  expression with `**`; a negative folded parameter is parenthesized
  (`((-2.0)**2.0)`).

Version. Mask and time functions retain their existing `field_expr.v1`
read contract. Archived antenna equations can contain a decimal integer with
leading zeros, such as `007`, and can use `log1p` as a parameter or local.
Calling `log1p(...)` in those kinds remains invalid. For the absorbing
boundary, profile and distance equations occupy their existing `ProblemIR`
fields and retain the Python integer syntax accepted by the previous ABL readers.

Error codes (`FunctionError.code`):

| Code | Meaning |
|---|---|
| `expr_syntax` | the text does not match the grammar |
| `expr_unknown_name` | a name is not a variable, parameter, earlier local, `pi` or function |
| `expr_arity` | wrong number of function arguments, or wrong number of outputs |
| `expr_too_large` | a limit of this section is exceeded |
| `mask_function_wrong_variable` | `t` in a mask function, or `x`, `y`, `z` in a time function; `x`, `y`, `z`, `t` in a profile; `t` in a distance or a field |
| `expr_name_invalid` | a parameter or local uses a reserved name, a Python keyword or a duplicate name |

Every error carries the path (`parameters[i]`, `locals[i]`, `outputs[c]`) and the
zero-based character position inside that equation.

(mask-function-v1-bytecode)=
## 4. `fullmag_time_expr.v1`

A compiled time function is a flat array of binary64 words. A word is either an
opcode (a small non-negative integer stored exactly) or the literal that follows
`PUSH`. Parameters, locals and `pi` are folded into literals. The machine has one
value stack of at most 64 entries and one input, `t`.

| Code | Op | Stack effect | Code | Op | Stack effect |
|---|---|---|---|---|---|
| 0 | `RETURN` | pops 1, ends | 13 | `ACOS` | 1 → 1 |
| 1 | `PUSH` literal | 0 → 1 | 14 | `ATAN` | 1 → 1 |
| 2 | `LOAD_T` | 0 → 1 | 15 | `ATAN2` | 2 → 1 (`atan2(a, b)`, `b` on top) |
| 3 | `ADD` | 2 → 1 | 16 | `SINH` | 1 → 1 |
| 4 | `SUB` | 2 → 1 (`a − b`, `b` on top) | 17 | `COSH` | 1 → 1 |
| 5 | `MUL` | 2 → 1 | 18 | `TANH` | 1 → 1 |
| 6 | `DIV` | 2 → 1 (`a / b`) | 19 | `EXP` | 1 → 1 |
| 7 | `POW` | 2 → 1 (`pow(a, b)`) | 20 | `LOG` | 1 → 1 |
| 8 | `NEG` | 1 → 1 | 21 | `SQRT` | 1 → 1 |
| 9 | `SIN` | 1 → 1 | 22 | `ABS` | 1 → 1 |
| 10 | `COS` | 1 → 1 | 23 | `MIN` | 2 → 1 |
| 11 | `TAN` | 1 → 1 | 24 | `MAX` | 2 → 1 |
| 12 | `ASIN` | 1 → 1 | | | |

- A program ends with exactly one `RETURN`. The constant function `1` is
  `[1, 1.0, 0]`.
- A malformed program (unknown opcode, stack underflow or overflow, missing
  `RETURN`, trailing words) evaluates to NaN; the planner never emits one.
- Two interpreters implement this table: `fullmag_expr::eval_time_program` (Rust)
  and `fullmag_time_expression_eval` in `native/include/fullmag_time_expression.h`
  (C, host code). `TIME_PROGRAM_VERSION` and `FULLMAG_TIME_EXPRESSION_VERSION`
  are both `1` and are checked against each other at build time.

(mask-function-v1-drive-errors)=
## 5. Drive-level error codes

| Code | Raised by | Meaning |
|---|---|---|
| `mask_field_drive_invalid` | IR validation | wrong schema or expression version, empty or duplicate id or name, an invalid or duplicate term name, a non-finite parameter value, a bad ready-antenna origin, or a time-dependent term active in a relaxation stage |
| `mask_target_unknown` | IR validation, planner | the target object is not a magnet or the target region does not exist; in the planner, the target is not on the resolved grid or its region has no marker |
| `scoped_target_override_not_allowed` | Python authoring | `target=` given to `magnet.add_simpleantenna` or `region.add_simpleantenna` |
| `mask_update_invalid` | Python authoring, stage materialization | Update of an inactive id or of a non-mask drive, an unknown parameter, a missing or unknown term selector, an empty patch, a non-finite value, or time parameters for a static term |
| `mask_shape_invalid` | IR validation | a non-positive or non-finite shape size, a non-finite position, a zero cylinder axis, or a CSG shape (not part of v1) |
| `mask_too_many_terms` | IR validation, runner, native FEM, `fm.space_time` | zero terms, or more than 8 terms on one drive, or more than 8 mask terms active in one stage on a GPU lane, or a space-time function that expands to more than 8 terms |
| `mask_array_invalid` | IR validation, planner | array mask with a bad lattice, an unknown encoding, data that is not base64 or zlib, a wrong sha256 or a byte count that does not match the lattice |
| `mask_support_empty` | planner | no magnetic cell (FDM) or node (FEM) of the target lies inside the shape |
| `mask_expression_non_finite` | planner, runner, native FEM | a mask value at a supported cell or node, a time value on the stage horizon, or a time factor during the run, is not finite |
| `mask_field_drive_unsupported_lane` | planner, runner | the resolved lane does not realize mask field drives (`fdm_multilayer`; `fem_reference`: the Rust FEM reference reduction of a statically periodic plan; `fdm_cuda`: a native library without host-multiplier drives) |
| `mask_not_periodic` | planner (FEM) | a mask has different values on the two nodes of a periodic node pair |
| `mask_not_separable` | `fm.space_time` | the function is not a finite sum of (function of position) × (function of time) under the rules of section 7, or it returns a zero field; the message quotes the sub-expression |

(mask-function-v1-origin)=
## 6. Ready-antenna origin

A term returned by a function-style ready antenna of `fullmag.antennas` carries
`origin = {function, arguments, call_index, output_index}`: the qualified function
name (a key of `fullmag.antennas.READY_ANTENNAS`), the numeric arguments as
written in the call (omitted optional arguments are absent), the order of the
call among the drive's calls, and the position of the term among the call's
outputs. The planner and the solvers ignore it.

- An Update of a term (stage action or `MaskAntenna.with_parameters`) removes
  its origin: the term no longer equals the output of the call.
- A script exporter writes the import and the call for a block of consecutive
  terms with one `call_index` and output indices `0..n-1` only when
  `fullmag.antennas.rebuild(function, arguments)` returns the same equations
  and values for every term; otherwise it writes the terms as functions.
- A loop-style ready antenna (`style="loop"`) returns an array mask without an
  origin; it is exported as data like any array mask.

(mask-function-v1-space-time)=
## 7. Space-time functions

```python
def wave(x, y, z, t, B, k, f):
    return (B * sin(k * x - 2 * pi * f * t), 0.0, 0.0)


antenna.add_space_time(wave, B=1 * mT, k=2 * pi / (196 * nm), f=4.5 * GHz)
```

`fm.space_time(function, **values)` takes one function under the rules of
section 2 with leading parameters exactly `x, y, z, t` and a 3-tuple return. It
returns a tuple of `(mask, time)` pairs for `antenna.add(mask, time)`;
`antenna.add_space_time(function, **values)` adds every pair. The pairs are
ordinary function terms: nothing else is stored in `ProblemIR`, and the scene,
the Control Room and an exported script show the terms, not the function.

Each output is rewritten, after the local equations are substituted, as a sum
of (factor of position) × (factor of time):

| Expression | Terms |
|---|---|
| `u` without `t` | `(u, 1)` |
| `u` without `x`, `y`, `z` | `(1, u)` |
| `u + v`, `u - v`, `-u` | the terms of the operands; a minus sign goes to the position factor |
| `u * v` | every product of a term of `u` and a term of `v` |
| `u / v`, with `v` of one kind | `v` divides the factor of its kind |
| `u ** n`, `n` = 2, 3, 4 | the repeated product |
| `sin(a + b)` | `(sin(a), cos(b))`, `(cos(a), sin(b))` |
| `cos(a + b)` | `(cos(a), cos(b))`, `(-sin(a), sin(b))` |
| `exp(a + b)` | `(exp(a), exp(b))` |

Here `a` holds the addends without `t` (constants included) and `b` the addends
of time only. For `sin` and `cos`, a time part written as `-c` is used as `c`
with the sign moved to the position factor, so `sin(k * x - w * t)` gives the
time functions `cos(w * t)` and `sin(w * t)`.

Terms with the same time factor (compared as text) become one term whose
components are the sums of the position factors; a component without a
contribution is `0.0`. A term whose time factor is 1 has no time function
(a static term). Terms keep the order of first appearance. Term `i` (from 1)
is named `<function>_space_<i>` and `<function>_time_<i>`, and each function
carries the parameters its equations use.

No algebraic simplification is done: `cos(w * t) * sin(w * t)` and
`sin(w * t) * cos(w * t)` are two terms. Any other expression that depends on
both position and time is rejected with `mask_not_separable` and the
expression (for a call, the whole call, for example
`exp(-(x - v * t) ** 2 / s ** 2)`); more than 8 terms are rejected with
`mask_too_many_terms`.

(mask-function-v1-formulas)=
## 8. Profile and distance formulas

An absorbing boundary layer
([physics note](../physics/absorbing-boundary-layer.md#abl-formula-language))
stores up to two formulas as plain strings in `ProblemIR`:

| Field | Kind (`FunctionKind`) | Variables | Output |
|---|---|---|---|
| `absorbing_boundary[.layers[]].expression` | `Profile` | `u` (ramp coordinate, dimensionless) | one number, dimensionless |
| `absorbing_boundary.layers[].geometry.expression` | `Distance` | `x`, `y`, `z` (metres, layer frame) | one number, metres |

- A formula is one equation of section 3 for its kind: no parameters, no
  locals, one output. `pi`, the shared functions and `log1p` are available;
  `heaviside` and `^` are not.
- `fullmag-expr` compiles it (`compile_function`) and evaluates it
  (`CompiledFunction::eval_profile`, `CompiledFunction::eval_distance`) with
  the arithmetic of section 3. Only the value of the formula is checked;
  intermediate infinities follow IEEE-754.
- The owner adds its own rules in `crates/fullmag-ir/src/absorbing_boundary.rs`:
  at most 256 characters, printable ASCII or tab only, not blank; a profile
  must give finite values in $[0, 1]$ at the 257 points $u = k/256$ and
  $p(0) = 0$, $p(1) = 1$ within $10^{-12}$. An engine error is reported with its
  code and zero-based character position, for example
  `expression error expr_syntax at character 0: integer literal '01' has a
  leading zero; write it without the zero, as in Python`.
- The Python front end (`fullmag.model.mask_function.compile_formula`) parses
  the string with `ast`, applies the syntax-tree checker of the antenna
  functions for the kind (no capture of free names, no `math.` attributes, no
  parenthesized function name), checks what `ast` does not keep (literal
  spellings, a trailing comma, the nesting depth of section 3) on the tokens,
  and evaluates the checked tree with `math`, returning the IEEE-754 result
  where `math` raises. It never calls `eval`. Its errors carry the character
  position (`FormulaError`, `character N: …`) but not the Rust error code.
- The accept/reject table shared by the Rust and Python tests is
  `crates/fullmag-ir/tests/fixtures/absorbing_boundary_formula_cases.json`.

(mask-function-v1-field)=
## 9. Field functions (material parameter fields)

`fm.fields.function` (`docs/specs/material-assignment-and-spatial-fields-v0.md`,
section 3.3) stores a scalar material parameter as a function of the field kind:

| Field | Kind (`FunctionKind`) | Variables | Output |
|---|---|---|---|
| `MaterialParameterFieldIR::Function.function` | `Field` | `x`, `y`, `z` (metres, in the field's `frame`) | one number, in the SI unit of the parameter |

- A field function is a `FunctionIR` of section 3 with exactly one output:
  parameters, ordered locals, and the functions of a mask (`heaviside`
  included, `log1p` not), `pi` and `**`. `^` is rejected with `expr_syntax`
  (no stored field equation used it). The engine evaluates it with
  `CompiledFunction::eval_field`; the value is not checked there.
- Two authored forms give the same `FunctionIR`. An equation string (the main
  form) becomes one output and its parameters, in the order of the call, with
  no `name` and no locals. A `def` (`x, y, z` first) goes through the transpiler
  of section 2 with the kind `field` (one returned number, `heaviside`
  allowed) and keeps its `name` and locals. `name` present means "write back as
  a `def`"; absent means "write back as a string". Parameter `source` texts are
  not stored for field functions.
- The Python front end checks a string like a formula of section 8: `ast`
  syntax-tree rules (no `eval`), token rules, nesting depth; a free name must be
  `x`, `y`, `z`, `pi`, a function or a parameter given at the call, and every
  given parameter must be used. Errors are `FieldFunctionError`
  (`character N: …`, `line N: …`, `parameter 'name': …`).
- `ProblemIR` validation (`MaterialParameterFieldIR::compile_function`) adds:
  scalar parameter only (`material_field_function_invalid` for
  `anisotropy_axis`), `expression_version` `field_expr.v1`, finite parameter
  values, a `name` that `validate_name` accepts (not reserved, not a keyword).
  Engine errors keep their code with the path `function.outputs[0]`,
  `function.locals[i]` or `function.parameters[i]`.
- The planner compiles the function once per resolution and evaluates it at
  every FDM cell centre and FEM node; the material parameter's own range rules
  apply to the sampled values.
- Version: the field kind adds texts to `field_expr.v1` and changes the value of
  none, so the version is kept. A `ProblemIR` with a function field is not
  readable by builds older than this change.
