---
title: Zeeman Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0401-zeeman-external-field.md
---

(public-docs-python-api-interactions-zeeman)=
# Zeeman Python API

This page owns the public Python constructor, validation, canonical serialization, output names,
and copyable Jupyter examples for the uniform Zeeman interaction. The physical equations and
FDM/FEM implementation lanes live in {doc}`../../physics/interactions/zeeman/index`.

(zeeman-api-problem-statement)=
## Physical problem

`fullmag.Zeeman(B)` declares a uniform prescribed external magnetic flux density. `B` is not an
H-field: its SI unit is tesla. The planner resolves it to the native field
$\mathbf H_{\mathrm{ext}}=\mathbf B/\mu_0$ in A/m.

(zeeman-api-governing-equations)=
## Governing equations

```{math}
:label: eq-python-zeeman-resolved-field
\mathbf H_{\mathrm{ext}}=\frac{\mathbf B_{\mathrm{ext}}}{\mu_0}.
```

```{math}
:label: eq-python-zeeman-energy
E_Z=-\mu_0\int_{\Omega_m}M_s\,\mathbf m\cdot\mathbf H_{\mathrm{ext}}\,\mathrm dV
   =-\int_{\Omega_m}M_s\,\mathbf m\cdot\mathbf B_{\mathrm{ext}}\,\mathrm dV.
```

(zeeman-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf B_{\mathrm{ext}}$ | value supplied to `Zeeman(B)` | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{ext}}$ | field resolved by the planner | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization supplied by the material | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $E_Z$ | Zeeman energy | $\mathrm{J}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |

(zeeman-api-assumptions-and-validity)=
## Assumptions and validity

- `B` is a finite sequence with exactly three components in tesla.
- The vector is uniform and time independent.
- The term does not normalize the magnetization, choose a mesh, select CPU/GPU, or configure an
  integrator.
- The material contract must provide positive finite $M_s$.
- A constructor accepted by Python is requested intent, not proof that a selected backend/device is
  qualified. The planner remains responsible for resolved execution and unsupported combinations.

(zeeman-api-python-api)=
## Constructor and complete parameter reference

### `fullmag.Zeeman`

```python
# %% Minimal constructor
import fullmag as fm

zeeman = fm.Zeeman(B=(0.0, 0.0, 0.1))  # 0.1 T in +z
print(zeeman.B)
print(zeeman.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Zeeman.B` | `Sequence[float]` | `required` | $\mathrm{T}$ | `length 3; all components finite` | `uniform external magnetic flux density` | `FDM/FEM CPU/GPU` | `energy[].B` (serialized key `B`) |

`Sequence[float]` is accepted so tuples, lists, and other finite numeric sequences can be used.
The constructor stores an immutable three-component tuple. It does not accept `H`, `H_ext`, a
unit string, a waveform, or a spatial callback as an alias for `B`.

### Accepted and rejected values

| Input | Result |
|---|---|
| `(0.0, 0.0, 0.1)` | Accepted; resolved field is approximately $(0,0,7.9577\times10^4)\,\mathrm{A\,m^{-1}}$. |
| `[1e-3, -2e-3, 0.0]` | Accepted; list is normalized to the immutable tuple representation. |
| `(0.0, 0.0)` | `ValueError`; the vector is not length three. |
| `(0.0, 0.0, float("nan"))` | `ValueError`; every component must be finite. |
| `H=(0.0, 0.0, 1.0)` | `TypeError`; `H` is not a constructor parameter. |

### Outputs associated with the term

The term does not create outputs automatically. Request them explicitly through the study/output
API, and let planner output validation reject an output that the selected executable lane cannot
materialize.

| Output name | Kind | SI unit | Availability |
|---|---|---|---|
| `H_ext` | vector field | $\mathrm{A\,m^{-1}}$ | Requires a declared Zeeman term and a lane exposing the external field. |
| `E_ext` | scalar | $\mathrm{J}$ | Requires a declared Zeeman term and a lane exposing the scalar energy. |
| `eden_ext` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Requires a declared Zeeman term and a lane exposing spatial energy density. |

(zeeman-api-problem-ir)=
## Canonical ProblemIR lowering

The exact object lowering is:

```python
# %% Exact public lowering
import json
import fullmag as fm

term = fm.Zeeman(B=(0.0, 0.0, 0.1))
assert term.to_ir() == {"kind": "zeeman", "B": [0.0, 0.0, 0.1]}
print(json.dumps(term.to_ir(), indent=2))
```

The serialized key is uppercase `B` because the IR field is explicitly named `B`. The Python
object does not serialize a backend-specific H-field and does not embed CPU/GPU selection.
Planning resolves the same vector independently in FDM and FEM:

```{math}
:label: eq-python-zeeman-planner-resolution
\mathbf H_{\mathrm{ext}}^{\mathrm{plan}}
=\left[
\frac{B_x}{\mu_0},\frac{B_y}{\mu_0},\frac{B_z}{\mu_0}
\right].
```

(zeeman-api-round-trip-and-failure-semantics)=
## Round-trip, planning, and failure semantics

Canonical export preserves requested intent: Python and IR retain the tesla-valued `B`. Resolved
execution separately records the A/m field, selected solver, device, precision, and capability
decision. This prevents a later export from confusing a resolved backend value with the public
authoring unit.

The following are validation errors:

- wrong vector length or non-finite component;
- more than one `Zeeman` term in one executable problem;
- an output request that is not materializable for the selected lane; and
- a backend/device combination that cannot execute the complete problem.

Unsupported combinations are planner errors, not silent fallbacks. Regional field drives,
Oersted fields, antenna fields, and waveform sources have separate constructors/contracts and
must not be smuggled into `Zeeman.B`.

(zeeman-api-discrete-realization)=
## Discrete realization selected after lowering

The Python object is backend neutral. FDM uses cell storage and cell volumes; FEM uses nodal
storage and lumped or saturation-weighted quadrature. CPU and GPU are separate execution
realizations, even when they consume the same resolved vector. The complete physical and
implementation comparison is in the canonical interaction page.

(zeeman-api-implementation-mapping)=
## Implementation mapping

`Zeeman.__init__` calls the shared vector validator and stores the immutable `B` tuple.
`Zeeman.to_ir` returns the exact `kind`/`B` object shown above. The planner converts the values
using `MU0`; the native backends then add the resolved field and calculate separately named
observables. Stable path-plus-symbol citations are listed below and machine-checked by the
adjacent source map.

(zeeman-api-validation)=
## Validation plan

At the Python layer, test sequence normalization, wrong length, non-finite values, exact IR, and
round-trip export. At the planner layer, test tesla-to-A/m conversion, duplicate rejection, and
output legality. At runtime, compare `H_ext`, `E_ext`, and `eden_ext` for identical B, material,
mesh, magnetization, and precision policy. A passing constructor test is not a CPU/GPU parity
result.

(zeeman-api-limitations)=
## Limitations

`Zeeman` currently exposes only one uniform static vector. It has no `rtol`, iteration count,
mesh parameter, CPU/GPU selector, spatial profile, waveform, antenna mask, or regional drive
parameter. Adding any of those would be a separate public contract and would require a new
physics/API/IR review rather than an undocumented overload.

(zeeman-api-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag internal source of truth: `docs/physics/0401-zeeman-external-field.md`.
- FullMag public implementation: `packages/fullmag-py/src/fullmag/model/energy.py`.

(zeeman-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Zeeman` | Public constructor and canonical lowering. |
| `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | Exact length and finite-component validation. |
| `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveField` | Public field-output request used by examples. |
| `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveScalar` | Public scalar-output request used by examples. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM resolved-field lowering and output validation. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM resolved-field lowering and output validation. |
| `crates/fullmag-plan/src/validate.rs` | `validate_executable_outputs` | Fail-closed output legality. |
