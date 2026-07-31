---
title: Exchange Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0400-fdm-exchange-demag-zeeman.md
---

(public-docs-python-api-interactions-exchange)=
# Exchange Python API

This page is the canonical Python authoring reference for bulk exchange. The physical model and
the complete FDM/FEM implementation comparison are owned by
{doc}`../../physics/interactions/exchange/index`. This page documents only the Python objects,
parameters, normalization, output requests, and failure semantics that control that interaction.
Geometry, material construction, studies, and generic output scheduling have their own canonical
pages; they are referenced here only where an exchange example uses them.

(exchange-api-problem-statement)=
## 1. Physical problem and ownership

`fullmag.Exchange()` enables the bulk exchange interaction. It has no exchange coefficient of its
own: the coefficient is supplied by each magnetic `Material` as `Material.A`, in
$\mathrm{J\,m^{-1}}$. `Material.Ms`, in $\mathrm{A\,m^{-1}}$, is also required because the
effective field contains $M_s^{-1}$. The Python term therefore declares *which physical
interaction is active*, while the material declares the local coefficient used on its domain.

The compatibility flat function `fullmag.exchange(enabled=...)` changes the script-local requested
intent. It is not a second physical exchange model and it does not accept `A`, `Ms`, a mesh, or a
device argument. Explicit `Exchange()` remains the canonical object representation.

(exchange-api-governing-equations)=
## 2. Governing equations exposed by the API

The API preserves the same SI bulk law as the canonical interaction page:

```{math}
:label: eq-python-exchange-energy
E_{\mathrm{ex}}[\mathbf m]
=\int_{\Omega_m}A(\mathbf x)\,\nabla\mathbf m:\nabla\mathbf m\,\mathrm dV.
```

The resolved effective field is

```{math}
:label: eq-python-exchange-effective-field
\mathbf H_{\mathrm{ex}}
=-\frac{1}{\mu_0M_s}\frac{\delta E_{\mathrm{ex}}}{\delta\mathbf m}
=\frac{2}{\mu_0M_s}\nabla\!\cdot\!\left(A\nabla\mathbf m\right).
```

The canonical Python-to-IR declaration is the exact, backend-neutral record

```{math}
:label: eq-python-exchange-ir-term
\mathrm{IR}_{\mathrm{ex}}=\{\texttt{kind}:\texttt{"exchange"}\}.
```

No CPU/GPU selector, finite-difference stencil, FEM matrix, precision, or boundary correction is
serialized inside this term. Those are requested through the runtime/discretization contract and
resolved by the planner after lowering.

(exchange-api-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $E_{\mathrm{ex}}$ | bulk exchange energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{ex}}$ | exchange effective field passed to LLG | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $A(\mathbf x)$ | local bulk exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $M_s$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\mathbf M$ | magnetization, with $\mathbf m=\mathbf M/M_s$ | $\mathrm{A\,m^{-1}}$ |
| $\mathrm{IR}_{\mathrm{ex}}$ | canonical exchange ProblemIR fragment | $1$ |
| $\mathbf x$ | spatial coordinate | $\mathrm{m}$ |
| $\nabla$ | spatial gradient operator | $\mathrm{m^{-1}}$ |
| $\delta E/\delta\mathbf m$ | variational derivative with respect to reduced magnetization | $\mathrm{J}$ |

(exchange-api-assumptions-and-validity)=
## 4. Assumptions and validity limits

- All numerical values are authored in SI units. `Material.A` is not converted from CGS and is not
  silently interpreted as an interfacial or atomistic exchange constant.
- `Material.Ms` and `Material.A` must be finite and strictly positive. The constructor emits an
  unusual-SI warning outside its configured plausibility intervals, but the warning does not change
  the value.
- `Material.A_field` and `Material.Ms_field` are optional spatial overrides. Their mesh cardinality
  and executable-lane legality are checked downstream; constructing a Python list does not prove
  that a selected solver can consume it.
- The public bulk term assumes a conforming magnetic domain and the natural free-surface exchange
  boundary. Surface exchange, RKKY/interlayer coupling, pinned exchange data, and nonconforming
  contact exchange have separate contracts.
- Normalization, discretization, backend selection, precision, and runtime qualification are not
  decided by `Exchange()`.

(exchange-api-python-api)=
## 5. Complete Python API reference

### `fullmag.Exchange`


`Exchange()` accepts no positional or keyword parameters. Passing `A`, `Ms`, `enabled`, a mesh,
or a backend argument raises Python's normal `TypeError`; those values belong to the objects
listed below or to the runtime contract.

### Exchange-facing constructor and parameter table

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Exchange()` | constructor | — | $1$ | accepts no parameters; `to_ir()` is exact | enables one bulk exchange term | FDM CPU/GPU and FEM CPU/GPU, subject to qualification | `energy_terms[] = {"kind": "exchange"}` |
| `Material.Ms` | `float` | required | $\mathrm{A\,m^{-1}}$ | finite and $>0$; unusual-SI warning outside configured range | saturation magnetization in the exchange denominator | all lanes; spatial realization differs | `materials[].saturation_magnetisation` |
| `Material.A` | `float` | required | $\mathrm{J\,m^{-1}}$ | finite and $>0$; unusual-SI warning outside $[10^{-14},10^{-8}]$ | bulk exchange stiffness | all lanes; heterogeneous realization differs | `materials[].exchange_stiffness` |
| `Material.Ms_field` | `list[float] \mid None` | `None` | $\mathrm{A\,m^{-1}}$ | mesh cardinality and lane legality validated downstream | spatial override for scalar $M_s$ | FEM lanes and allocating FDM CPU reference; not persistent FDM SoA/native CUDA | `materials[].ms_field` |
| `Material.A_field` | `list[float] \mid None` | `None` | $\mathrm{J\,m^{-1}}$ | mesh cardinality and lane legality validated downstream | spatial override for scalar $A$; not a CUDA pair-coefficient table | FEM lanes and allocating FDM CPU reference; not persistent FDM SoA/native CUDA | `materials[].a_field` |
| `FDM.cell` | `Sequence[float]` | alias of `default_cell` | $\mathrm{m}$ per component | exactly three finite, strictly positive components | backward-compatible uniform FDM cell size | FDM CPU/GPU; FDM lane only | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `Sequence[float]` | required unless `per_magnet` is supplied | $\mathrm{m}$ per component | exactly three finite, strictly positive components | canonical default FDM cell size | FDM CPU/GPU; FDM lane only | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.boundary_correction` | `str \mid None` | `None` | $1$ | one of `"none"`, `"volume"`, `"full"` | exchange sub-cell policy: binary, T0 volume, or T1 full correction | FP64 FDM GPU has `volume`/`full`; other lanes are policy-dependent | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \mid None` | `None` | $1$ | strictly $0<\varphi_{\mathrm{floor}}<1$ | lower bound for a magnetic volume fraction in T0/T1 | relevant to supported FP64 FDM GPU corrections | `...fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \mid None` | `None` | $\mathrm{m}$ | $\delta_{\min}\geq0$ | lower bound for T1 boundary distance | relevant to supported FP64 FDM GPU T1 | `...fdm.boundary_delta_min` |
| `fullmag.exchange(enabled=...)` | `bool` keyword | `True` | $1$ | coerced to `bool`; updates script-local intent | enables or disables exchange in the flat script surface | flat authoring facade; resolved lane remains planner-dependent | script builder `exchange_enabled` and canonical energy selection |
| `StudyBuilder.exchange(enabled=...)` | `bool` keyword | `True` | $1$ | delegates to flat API and returns the builder | fluent form of the same script-local toggle | same as `fullmag.exchange` | same canonical lowering |

`FDM.cell` and `FDM.default_cell` are aliases at authoring time; supplying both is rejected. The
boundary options are discretization policy, not parameters of the physical exchange law. They are
listed here because they change the exchange realization and appear in the exchange example and
ProblemIR.

### Exchange observables

Outputs are requests, not automatic side effects of declaring `Exchange()`:

| Request | Constructor parameters | SI unit | Validation and availability |
|---|---|---|---|
| `SaveField("H_ex", every=...)` | `field` must be the known field `H_ex`; `every` is a positive sampling period or `"auto"` | $\mathrm{A\,m^{-1}}$ | materialization is checked by the selected executable lane |
| `SaveScalar("E_ex", every=...)` | `scalar` must be the known scalar `E_ex`; `every` is a positive sampling period or `"auto"` | $\mathrm{J}$ | materialization is checked by the selected executable lane |
| `eden_ex` field request | quantity name `eden_ex` | $\mathrm{J\,m^{-3}}$ | available only on lanes that expose exchange energy density |

The generic scheduling parameters are owned by {doc}`../outputs/fields-and-scalars`; the rows
above state the exchange-specific names and units so that an exchange example is reproducible.

### Copyable Jupyter-style stage scenario

```python
# %% Imports and SI constants
import fullmag as fm

nm = 1.0e-9
study = fm.study("exchange_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.cell(2 * nm, 2 * nm, 1 * nm)
film = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3       # A/m
film.Aex = 13.0e-12     # J/m
film.alpha = 0.01
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("H_ex", every_steps=100)],
    )
)
```

This script is the normal public authoring path. It declares the physical request and ordered
stage; lowering to `ProblemIR`, planner resolution, and runtime qualification happen after the
stage graph is captured. `Exchange()` is an internal/API compatibility symbol; it is not the way
a user launches a study.

(exchange-api-problem-ir)=
## 6. Canonical ProblemIR lowering

For the explicit term, `Exchange.to_ir()` returns exactly:

```json
{
  "kind": "exchange"
}
```

The exchange-relevant material fragment from the complete example is:

```json
{
  "name": "Permalloy",
  "saturation_magnetisation": 800000.0,
  "exchange_stiffness": 1.3e-11,
  "damping": 0.01,
  "ms_field": null,
  "a_field": null
}
```

The FDM hint is normalized as:

```json
{
  "cell": [2e-9, 2e-9, 1e-9],
  "default_cell": [2e-9, 2e-9, 1e-9],
  "boundary_correction": "none"
}
```

These fragments are embedded in a larger IR object containing geometry, study, runtime, and
provenance fields. The printed `problem_ir` from the example, not a hand-written fragment, is the
complete canonical result.

| Python authoring value | Canonical IR destination | Normalization and consequence |
|---|---|---|
| `fm.Exchange()` | `energy_terms[].kind` | preserves `"exchange"`; no backend data is added |
| `Material.Ms` | `materials[].saturation_magnetisation` | preserves SI A/m value |
| `Material.A` | `materials[].exchange_stiffness` | preserves SI J/m value; no conversion |
| `Material.Ms_field` | `materials[].ms_field` | preserves optional list; cardinality remains a downstream concern |
| `Material.A_field` | `materials[].a_field` | preserves optional list; it is not transformed into CUDA pair coefficients |
| `FDM.cell` | `backend_policy.discretization_hints.fdm.cell` and `default_cell` | legacy alias is normalized to the same three-component cell |
| `FDM.boundary_correction` | `backend_policy.discretization_hints.fdm.boundary_correction` | preserves `none`, `volume`, or `full` |
| `SaveField("H_ex", every)` | `study.sampling.outputs[]` | becomes a field record with `name: "H_ex"` |
| `SaveScalar("E_ex", every)` | `study.sampling.outputs[]` | becomes a scalar record with `name: "E_ex"` |
| `fullmag.exchange(enabled)` | script builder exchange intent | enabled state controls whether the flat builder emits the exchange term |

(exchange-api-round-trip-and-failure-semantics)=
## 7. Round-trip, planning, and failure semantics

Requested intent is the authored `Exchange()` term, SI material values, optional spatial fields,
FDM policy, output requests, and flat `enabled` state. Resolved execution is recorded separately:
selected FEM/FDM solver, CPU/GPU device, precision, resolved mesh, native operator, capability
decision, output materialization, and qualification evidence. Export must preserve authored `A`
and `Ms` values; it must not replace them with a backend-specific field or silently add a device
selector.

Validation errors occur before execution for, among others:

- `FDM(cell=..., default_cell=...)` supplied with both aliases;
- an FDM cell with the wrong length or a non-positive component;
- `boundary_correction` outside `none`, `volume`, and `full`;
- `boundary_phi_floor` outside $(0,1)$ or `boundary_delta_min < 0`;
- non-finite or non-positive `Material.Ms` or `Material.A`;
- a non-finite material field or a field whose resolved mesh cardinality is invalid; and
- an unknown `H_ex`, `E_ex`, or `eden_ex` output name.

Unsupported combinations are planner errors, not silent CPU fallbacks. Examples include a native
FDM path that cannot consume spatial `A_field`/`Ms_field`, FP32 FDM with FP64-only T0/T1 boundary
corrections, and a requested output not materializable by the selected lane. The authored model is
not rewritten to make an unsupported combination appear executable.

(exchange-api-discrete-realization)=
## 8. Discrete realization and backend matrix

| Solver | CPU | GPU |
|---|---|---|
| FDM | Double-precision reference six-neighbor stencil; scalar persistent material path and richer allocating reference accessor are distinct. | Native CUDA FP64/FP32 standard stencils; FP64-only T0/T1 sub-cell policies; device qualification is separate from source availability. |
| FEM | Native MFEM exchange stiffness assembly with lumped field projection and optional consistent-mass CPU projection. | Host MFEM setup followed by FP64 CUDA CSR application and RK dispatch; consistent-mass projection is not the GPU realization. |

The physical equations are not duplicated here. For the exact stencil, MFEM matrix, mass projection,
precision, memory ownership, and qualification boundaries, use the realization chapters in
{doc}`../../physics/interactions/exchange/index`. Python lowering remains common to all four lanes;
the planner resolves the lane after IR validation.

(exchange-api-implementation-mapping)=
## 9. Implementation mapping

Each claim is identified by repository path plus a stable symbol. Moving line numbers are not used
as the citation identity.

| API or claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| canonical term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Exchange` | exact `{"kind": "exchange"}` lowering |
| material values | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | validation and material IR fields |
| FDM hint | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | cell and boundary-policy validation/lowering |
| explicit output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveField` | `H_ex` field request validation/lowering |
| scalar output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveScalar` | `E_ex` scalar request validation/lowering |
| flat facade state | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | script-local exchange-enabled state |
| fluent facade | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | fluent `exchange(enabled=...)` method |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | lane-specific exchange/output decisions |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | lane-specific exchange/output decisions |

(exchange-api-validation)=
## 10. Validation evidence and required checks

The API contract is validated at four levels:

1. Python tests execute the example and assert `energy_terms`, material fields, FDM normalization,
   and output records.
2. Source-map validation resolves every page claim to one declaration-like path-plus-symbol.
3. Planner tests reject duplicate terms, illegal output requests, unsupported precision/lane
   combinations, and invalid boundary policies.
4. Native FDM/FEM field, energy, derivative, parity, and device-runtime tests determine whether an
   implementation is qualified. A constructor test or a compiled CUDA kernel is not GPU parity
   proof.

The canonical physics page records the current evidence state for each lane. Runtime claims must
be tied to the managed/container validation recipe and an executed device identity when applicable.

(exchange-api-limitations)=
## 11. Limitations

- `Exchange()` has no per-term numerical parameters; coefficient and saturation data remain
  material-owned.
- The Python material spatial fields do not promise that every persistent FDM or CUDA lane realizes
  heterogeneous coefficients.
- T0/T1 FDM boundary corrections are not a general FEM boundary condition and are not available in
  every precision/device lane.
- The API page does not define surface exchange, RKKY, atomistic exchange, or nonconforming contact
  coupling; those are separate physical contracts.
- Current implementation availability does not imply current-revision executed-device qualification.

(exchange-api-scientific-bibliography)=
## 12. Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
2. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).
3. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
4. FullMag canonical physical owner: {doc}`../../physics/interactions/exchange/index`.

(exchange-api-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Lane | Evidence status |
|---|---|---|---|---|
| Exchange lowering | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Exchange` | common API | source-mapped; Python example executed |
| Material validation/lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | common API | source-mapped; constructor/IR tests present |
| FDM policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | FDM CPU/GPU | source-mapped; validation tests present |
| Field output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveField` | all lanes, output-dependent | source-mapped; output contract tested |
| Energy output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveScalar` | all lanes, output-dependent | source-mapped; output contract tested |
| Flat authoring | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | common API | source-mapped; script round-trip tests present |
| Planner resolution | `crates/fullmag-plan/src/fdm.rs` / `fem.rs` | `plan_fdm` / `plan_fem` | FDM/FEM CPU/GPU | source-mapped; runtime qualification remains lane-specific |
