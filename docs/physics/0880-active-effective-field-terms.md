# Active effective-field terms

- Status: implementation-aligned reference note
- Owners: Fullmag core and physics teams
- Last updated: 2026-08-26
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/capability-matrix-v0.md`

(problem-statement)=
## 1. Problem statement

Fullmag authors a physical effective field as a set of active energy terms. Exchange and
demagnetization are baseline micromagnetic terms and are active by default in both the flat
Python API and `fm.study(...)`. A script does not need `study.exchange()` or an unconfigured
`study.demag()` call to activate them.

Material parameters and term activation have separate responsibilities. A positive material
`Aex` supplies the exchange stiffness used by an active exchange term; assigning `Aex` does not
act as an enable/disable switch. Likewise, `Ms` supplies the saturation magnetization used by
multiple terms and does not replace the global demag activation decision. A user who intentionally
removes a baseline term must write `disable_exchange()` or `disable_demag()` (the legacy
`enabled=False` form remains accepted).

These controls are physics authoring decisions. They are not visualization flags, runtime debug
masks, or permission for a planner to silently change backend or device.

(governing-equations)=
## 2. Governing equations

For reduced magnetization $\mathbf m=\mathbf M/M_s$, the active effective field is

```{math}
:label: eq-active-effective-field

\mathbf H_{\mathrm{eff}}(\mathbf m)
= \sum_{i\in\mathcal A}\mathbf H_i(\mathbf m),
\qquad
\mathbf H_i
=-\frac{1}{\mu_0 M_s}\frac{\delta E_i}{\delta\mathbf m},
```

where $\mathcal A$ is the authored active-term set represented by
`ProblemIR.energy_terms`. For exchange,

```{math}
:label: eq-active-exchange

E_{\mathrm{ex}}[\mathbf m]
=\int_{\Omega_m} A_{\mathrm{ex}}(\mathbf x)
\lVert\nabla\mathbf m(\mathbf x)\rVert_F^2\,\mathrm dV.
```

For demagnetization,

```{math}
:label: eq-active-demag

E_{\mathrm d}[\mathbf m]
=-\frac{\mu_0}{2}\int_{\Omega_m}
M_s(\mathbf x)\,\mathbf m(\mathbf x)\cdot
\mathbf H_{\mathrm d}(\mathbf x)\,\mathrm dV.
```

Calling `disable_exchange()` removes $E_{\mathrm{ex}}$ and
$\mathbf H_{\mathrm{ex}}$ from $\mathcal A$. Calling `disable_demag()` removes
$E_{\mathrm d}$ and $\mathbf H_{\mathrm d}$. Material values remain authored and available if
the term is re-enabled or the script is edited later.

(symbols-and-si-units)=
### 2.1 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | active effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_i$ | field contribution of active term $i$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $E_i$ | energy functional of term $i$ | $\mathrm{J}$ |
| $E_{\mathrm{ex}}$ | exchange energy | $\mathrm{J}$ |
| $E_{\mathrm d}$ | demagnetizing energy | $\mathrm{J}$ |
| $A_{\mathrm{ex}}$ | exchange stiffness field | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\mathcal A$ | authored set of active energy terms | $1$ |
| $\nabla$ | spatial gradient | $\mathrm{m^{-1}}$ |
| $\lVert\cdot\rVert_F$ | Frobenius norm | $1$ |
| $\mathrm dV$ | volume measure | $\mathrm{m^3}$ |

(assumptions-and-validity)=
## 3. Assumptions and validity

Exchange and demag activation is global for the authored problem. Per-object demag participation
is not implied. `Aex` may vary by material or region, but the global exchange term decides whether
the exchange operator belongs to the effective field at all. An explicit disable is legal even
when a ferromagnet has positive `Aex`; this is an intentional model simplification and must remain
visible in the exported script and authoring state.

The default-on rule applies at Python/SceneDocument authoring. It does not bypass backend
capability validation: an active term that is unsupported for the requested discretization,
device, precision, or mode is rejected explicitly.

(python-api)=
## 4. Python API

The recommended API is default-on plus explicit opt-out:

| Python API | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| absence of an exchange control call | authoring default | active | $1$ | none | include exchange | FDM/FEM CPU/GPU, lane qualification applies | `energy_terms[].kind=exchange` |
| absence of a demag control call | authoring default | active | $1$ | none | include demag with default realization | FDM/FEM CPU/GPU, lane qualification applies | `energy_terms[].kind=demag` |
| `fm.disable_exchange()` / `study.disable_exchange()` | operation | not called | $1$ | no parameters | explicitly remove exchange | all authoring lanes | absence of `kind=exchange` |
| `fm.disable_demag()` / `study.disable_demag()` | operation | not called | $1$ | no parameters | explicitly remove demag | all authoring lanes | absence of `kind=demag` |
| `fm.demag(realization=...)` / `study.demag(realization=...)` | operation | default realization | $1$ | supported canonical realization string | configure active demag | realization-dependent | `kind=demag` plus realization |
| `exchange(enabled=False)` / `demag(enabled=False)` | compatibility operation | `enabled=True` | $1$ | boolean | legacy explicit opt-out | all authoring lanes | corresponding term absent |

`study.exchange()` remains accepted for compatibility but is redundant. Canonical script export
omits redundant enable calls. It emits `study.disable_exchange()` or `study.disable_demag()` for
an explicit opt-out. A configured but disabled demag is exported as configuration followed by
`study.disable_demag()`, preserving both author intent and the inactive `ProblemIR` term set.

```python
# %% Imports and study
import fullmag as fm

study = fm.study("default_effective_field_terms")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry and material
body = study.geometry(
    fm.Box(size=(40e-9, 40e-9, 10e-9)),
    name="film",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# Exchange and demag are already active. Configure only the non-default detail.
study.demag(realization="poisson_robin")

# %% Mesh, stage, and output
study.objects.mesh.defaults(maximum_element_size=5e-9, order=1)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=10,
).tableautosave(every_steps=1, quantities=("E_total", "max_torque"))
```

An intentional exchange-free model changes only the interaction section:

```python
study.disable_exchange()
```

(problem-ir)=
## 5. ProblemIR and planning

The default example lowers exchange and demag into the canonical energy-term list:

```json
{
  "energy_terms": [
    {"kind": "exchange"},
    {"kind": "demag", "realization": "poisson_robin"}
  ]
}
```

The JSON fragment shows the relevant fields of the runtime-independent lowering. Disabling a term
removes its object from `energy_terms`; no boolean solver mask is added to `ProblemIR`. Planners
derive `enable_exchange` and `enable_demag` from membership in this list and then resolve backend,
device, precision, demag realization, and execution mode.

SceneDocument retains `exchange_enabled` and `demag_enabled` booleans because authoring must
round-trip an explicit opt-out. `authored_demag_realization` in Python runtime metadata preserves
a chosen realization even when demag is inactive; it does not activate the term or alter planner
legality.

(round-trip-and-failure-semantics)=
## 6. Round-trip and failure semantics

- Missing authoring booleans default to `true` in the Rust builder and SceneDocument contracts.
- Default `true` values are omitted from canonical Python output.
- `false` exports as `disable_exchange()` or `disable_demag()`.
- A demag realization exports as `demag(realization=...)`; if inactive, `disable_demag()` follows.
- Legacy `enabled=False` input is accepted and canonicalized to the new disable form.
- Unsupported active-term combinations fail in planning; no disabled term is silently restored.
- An explicitly disabled term remains absent from field, energy, and observable computation.

Requested intent consists of the authored active-term switches and any selected demag realization.
Resolved execution consists of the planner-selected backend, device, precision, operator flags,
and concrete demag strategy. Validation errors report malformed authoring values before planning.
Unsupported combinations are rejected without enabling a disabled term or silently changing the
requested execution lane.

(discrete-realization)=
## 7. Discrete realization and qualification matrix

This API change does not modify a numerical operator. Each planner and runtime continues to consume
the same resolved active-term flags.

| Solver | Device | Implementation status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | implemented | active terms select CPU exchange stencil and demag path; scenario-specific scientific validation still applies |
| FDM | GPU | implemented | active terms select CUDA operators; production claims require current executed-device evidence |
| FEM | CPU | implemented | active terms select native MFEM exchange and selected demag realization; workload qualification remains operator-specific |
| FEM | GPU | implemented | active terms select native CUDA/MFEM operators; production claims require managed-runtime and device evidence |

Strict, extended, auto, and future hybrid planning must preserve the authored active-term set.
There is no fallback that may enable a disabled term merely to satisfy a backend profile.

(implementation-mapping)=
## 8. Implementation mapping

- `_WorldState` owns default-on authoring state.
- `_build_problem` lowers active flags into `Exchange()` and `Demag()` objects.
- `disable_exchange`, `disable_demag`, and their `StudyBuilder` methods provide explicit opt-out.
- `_render_exchange` and `_render_demag` canonicalize script output.
- `SceneStudyState` and `ScriptBuilderState` preserve browser authoring booleans with default `true`.
- `plan_fdm` and `plan_fem` derive executable flags from `ProblemIR.energy_terms`.

(validation)=
## 9. Validation

Focused Python tests prove default lowering, explicit opt-out, compatibility, SceneDocument
round-trip, canonical export, and preservation of an inactive demag realization. Planner and
backend tests remain responsible for proving that resolved flags gate their respective operators.
No new runtime capability claim is introduced by this authoring-only change.

(limitations)=
## 10. Limitations

Activation is global rather than per-object. The model does not infer activation from a material
name or object type. Assigning `Aex` does not override a deliberate `disable_exchange()` call.
Re-enabling after a disable uses the compatibility configuration call `exchange()` or
`demag(...)`; dedicated `enable_*` aliases are not part of this change.

(scientific-bibliography)=
## 11. Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- Aharoni, A., *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press, 2000. https://doi.org/10.1093/acprof:oso/9780198508083.001.0001
- Gilbert, T. L., “A phenomenological theory of damping in ferromagnetic materials,” *IEEE Transactions on Magnetics* 40 (2004). https://doi.org/10.1109/TMAG.2004.836740

(source-code-index)=
## 12. Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| default-on state | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | authoring defaults | Python | focused tests |
| default-on lowering | `packages/fullmag-py/src/fullmag/world.py` | `_build_problem` | energy-term construction | Python | focused tests |
| canonical exchange rewrite | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_exchange` | omit default and preserve opt-out | Python/SceneDocument | focused tests |
| canonical demag rewrite | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_demag` | separate configuration and opt-out | Python/SceneDocument | focused tests |
| exchange IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Exchange` | serialize the active exchange term | Python/ProblemIR | source and tests |
| demag IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | serialize the active demag term | Python/ProblemIR | source and tests |
| explicit opt-out | `packages/fullmag-py/src/fullmag/world.py` | `disable_exchange`, `disable_demag`, `StudyBuilder.disable_exchange`, `StudyBuilder.disable_demag` | public API | Python | focused tests |
| Python contract tests | `packages/fullmag-py/tests/test_api.py` | `class ProblemApiTests` | default, opt-out, rewrite, and round-trip tests | Python | executed focused tests |
| browser defaults | `crates/fullmag-authoring/src/scene.rs` | `SceneStudyState` | default-true SceneDocument flags | Control room | Rust adapter tests |
| FDM planning | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | resolve FDM active operators | FDM CPU/GPU | existing planner tests |
| FEM planning | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | resolve FEM active operators | FEM CPU/GPU | existing planner tests |

