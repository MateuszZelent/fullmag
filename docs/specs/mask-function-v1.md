# `mask_field_drive.v1`: mask and time functions, `field_expr.v1`, time bytecode

- Status: approved implementation contract; implementation in progress
- Schema versions: `mask_field_drive.v1`, `field_expr.v1`, `fullmag_time_expr.v1`
- Owner of the semantics: `ProblemIR` and the crate `fullmag-expr`
- Related: [ADR 0081](../adr/0081-explicit-field-masks.md),
  [physics note 0922](../physics/0922-masks-for-field-excitation.md),
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

(mask-function-v1-python)=
## 2. Restricted Python

| Rule | Mask function | Time function |
|---|---|---|
| Leading parameters | exactly `x, y, z` (metres) | exactly `t` (seconds) |
| Return | a 3-tuple `(Bx, By, Bz)` in tesla | one expression, dimensionless |
| Further parameters | named numbers; values come from `fm.mask(f, name=value, …)` | the same with `fm.time(g, name=value, …)` |

- A parameter without a value and without a default in the `def` is an error; a
  value for an unknown name is an error; a value overrides a default.
- Body: a sequence of assignments `name = expression` with a single plain name
  on the left, followed by one `return`. A name is assigned at most once.
- Expressions: numeric literals; parameters; earlier locals; the leading
  variables; `pi`; binary `+ - * / **`; unary `-` and `+`; calls to
  `sin cos tan asin acos atan atan2 sinh cosh tanh exp log sqrt abs min max`
  written bare or as `math.<name>` (`math.fabs` is accepted as `abs`).
- A free name that resolves to an `int` or `float` in the function's closure or
  globals is captured as a parameter with that value.
- Rejected with `MaskFunctionError("line N: …")`: `if`, `for`, `while`, `with`,
  `try`, comprehensions, lambdas, conditional expressions, comparisons, boolean
  operators, attribute access other than `math.<function>`, subscripts, calls to
  any other function, augmented assignment, tuple assignment, starred arguments,
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
power  := atom ("^" unary)?                     # right-associative
atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
number := digits ["." digits] [exponent] | "." digits [exponent]
exponent := ("e" | "E") ["+" | "-"] digits
name   := [A-Za-z_][A-Za-z0-9_]*
```

- Whitespace between tokens is ignored.
- Variables: `x`, `y`, `z` in a mask function; `t` in a time function.
- Reserved names: `x y z t pi` and the function names. A parameter or a local
  may not use a reserved name. Parameter and local names are unique within one
  function.
- Functions and arity: one argument — `sin cos tan asin acos atan sinh cosh tanh
  exp log sqrt abs`; two arguments — `atan2 min max`.
- A local may refer to parameters and to locals defined before it.
- Limits: 4096 characters and 512 syntax nodes per equation; 64 parameters and
  64 locals per function.
- Arithmetic is IEEE-754 binary64. `x^y` is `pow(x, y)`.
- The Python transpiler writes `**` as `^`, keeps parentheses, and writes numeric
  literals with `repr`.

Error codes (`FunctionError.code`):

| Code | Meaning |
|---|---|
| `expr_syntax` | the text does not match the grammar |
| `expr_unknown_name` | a name is not a variable, parameter, earlier local, `pi` or function |
| `expr_arity` | wrong number of function arguments, or wrong number of outputs |
| `expr_too_large` | a limit of this section is exceeded |
| `mask_function_wrong_variable` | `t` in a mask function, or `x`, `y`, `z` in a time function |
| `expr_name_invalid` | a parameter or local uses a reserved or duplicate name |

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
| `mask_field_drive_invalid` | IR validation | wrong schema or expression version, empty or duplicate id or name, a non-finite parameter value, a bad ready-antenna origin, or a time-dependent term active in a relaxation stage |
| `mask_target_unknown` | IR validation | `target_object_id` is not a magnet |
| `mask_shape_invalid` | IR validation | a non-positive or non-finite shape size, a non-finite position, a zero cylinder axis, or a CSG shape (not part of v1) |
| `mask_too_many_terms` | IR validation, runner | zero terms, or more than 8 terms on one drive, or more than 8 time-dependent mask terms active in one stage |
| `mask_array_invalid` | IR validation, planner | array mask with a bad lattice, missing file, wrong sha256, dtype or shape |
| `mask_support_empty` | planner | no active cell of the target lies inside the shape |
| `mask_expression_non_finite` | planner | a mask value at a supported cell, or a time value on the stage horizon, is not finite |
| `mask_field_drive_unsupported_lane` | planner | the resolved lane does not realize mask field drives (`fem`, `fdm_multilayer`) |
| `mask_not_separable` | separation (single-function form) | the function is not a finite sum of space × time factors |
