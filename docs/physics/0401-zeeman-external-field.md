# Zeeman external field

- Status: implementation-aligned reference note
- Owners: FullMag physics and backend team
- Last updated: 2026-08-12
- Related ADRs: none
- Related specs: `public_docs/site/physics/interactions/zeeman/index.md`

(problem-statement)=
## 1. Problem statement

The Zeeman interaction represents a prescribed external magnetic flux density that couples
locally to the magnetization. The public Python contract accepts one uniform vector
`Zeeman(B)` in tesla. The planner converts that requested quantity to the resolved magnetic
field `H_ext = B / mu0` in A/m. No backend may silently reinterpret `B` as an H-field.

This note is the internal scientific source of truth. Publication documentation is kept under
`public_docs/site/`; it is derived from this note but has its own user-facing structure and
source maps.

(governing-equations)=
## 2. Physical model

For reduced magnetization `m = M/Ms` in the magnetic domain, the uniform-field energy is

```{math}
:label: eq-zeeman-internal-energy

E_Z[\mathbf m] = -\mu_0 \int_{\Omega_m} M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ext}}\,\mathrm dV
                 = -\int_{\Omega_m} M_s(\mathbf x)\,
\mathbf m(\mathbf x)\cdot\mathbf B_{\mathrm{ext}}\,\mathrm dV.
```

The corresponding effective field is

```{math}
:label: eq-zeeman-internal-field

\mathbf H_Z = -\frac{1}{\mu_0 M_s}\frac{\delta E_Z}{\delta\mathbf m}
             = \mathbf H_{\mathrm{ext}}
             = \frac{\mathbf B_{\mathrm{ext}}}{\mu_0}.
```

(symbols-and-si-units)=
### 2.1 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf B_{\mathrm{ext}}$ | prescribed uniform flux density requested by `Zeeman(B)` | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{ext}}$ | resolved uniform external field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_Z$ | Zeeman contribution to the effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | active magnetic integration domain | $\mathrm{m^3}$ |
| $E_Z$ | Zeeman energy | $\mathrm{J}$ |

The current public constructor is uniform and time independent. Regional and time-dependent
field drives are separate field-drive contracts; they must not be documented as extra
parameters of `Zeeman(B)`.

(assumptions-and-validity)=
## 3. Numerical interpretation and validity

### FDM

The planner stores the resolved vector in A/m. For the FDM CPU LLG update and Zeeman-energy
reduction, the mask is active-cell-only: inactive cells do not evolve under Zeeman torque and do
not contribute to $E_Z$. Separately, `observe_state_with_antenna_field` constructs a uniform
`H_ext` **full-domain observable** by expanding the resolved vector over the entire structured
grid, including inactive cells. This observational field does not alter LLG support, energy
integration, or torque semantics. It is eligible for an Airbox aggregate only if terminal
metadata records `full_domain` coverage for the same grid, state generation, step, and time.
The CUDA lane consumes the same resolved field in the device field and energy paths; a CUDA
full-domain terminal-observable claim remains planned / in implementation until executed-device
evidence exists.

### FEM

The FEM planner imports the resolved A/m vector into the Zeeman aggregate. CPU initialization
broadcasts it to a nodal `h_ext_xyz` buffer. The CPU field stage adds that buffer to `H_eff`;
the energy stage uses lumped nodal mass or the saturation-weighted element-quadrature material
path when a spatial `Ms` field is active. The GPU lane uploads the field and material arrays,
adds it during the device RK stage, and reduces the energy on the device.

### Hybrid

There is no hybrid physical definition. A hybrid execution may combine backend realizations,
but its provenance must retain the requested B vector, resolved H vector, backend lane, precision,
and output legality decision.

(python-api)=
## 4. API, IR, and planner impact

`Zeeman(B)` validates a finite length-three vector and lowers to an `EnergyTermIR::Zeeman` with
the serialized key `B`. FDM and FEM planning each reject duplicate Zeeman terms, convert each
component by the same `MU0`, and store the result in the native plan as `external_field` in A/m.
`H_ext`, `E_ext`, and `eden_ext` are legal only when a Zeeman source is active.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.Zeeman(B=(Bx, By, Bz))` | `Zeeman` | required | $\mathrm{T}$ | exactly three finite components | uniform external flux-density request | FDM/FEM CPU/GPU, lane qualification applies | `energy_terms[].kind=zeeman` with `B` |

```python
# %% Object-level authoring/lowering fragment; the public page owns the full stage-first example.
import fullmag as fm

zeeman = fm.Zeeman(B=(0.0, 0.0, 0.1))
assert zeeman.to_ir()["kind"] == "zeeman"
```

(problem-ir)=
### 4.1 ProblemIR, requested intent, and resolved execution

The authored `B` vector is requested intent. The planner conversion to the resolved A/m vector,
backend/device, precision, active mask, and output legality are resolved execution and provenance;
they are never back-written into the authoring request.

(round-trip-and-failure-semantics)=
### 4.2 Round-trip and failure semantics

Validation errors include non-finite or wrong-length `B`, duplicate Zeeman terms, and a requested
field output unavailable in the selected lane. Unsupported combinations remain explicit and must
not silently fall back to another backend or scope.

(discrete-realization)=
## 5. Validation strategy

- Verify exact Python validation and `{"kind":"zeeman","B":[...]}` lowering.
- Verify planner conversion against `MU0` in both FDM and FEM paths.
- Verify duplicate-term rejection and fail-closed output validation.
- Compare FDM CPU and qualified CUDA field/energy values for a uniform magnetization.
- Compare FEM CPU lumped/quadrature energy with the device reduction within declared tolerances.
- Verify that inactive FDM cells and non-magnetic FEM nodes do not contribute.

(validation)=
### 5.1 Evidence boundary

The current source and focused contracts establish the CPU separation of active-cell LLG/energy
from the full-domain uniform observable. They do not establish an atomic final field batch or
CUDA terminal-observable behavior; those remain planned / in implementation.

(limitations)=
## 6. Known limits and deferred work

The public uniform `Zeeman` term does not expose a spatial field, waveform, antenna mask,
regional drive, or solver tolerance. Those belong to separate field-source contracts. CUDA
implementation evidence exists in source, but production qualification remains dependent on
executed-device and parity evidence for the current revision.

(scientific-bibliography)=
## 7. References

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag Python implementation: `packages/fullmag-py/src/fullmag/model/energy.py`.
- FullMag planner and backend sources listed in the publication source index.

(implementation-mapping)=
## 8. Implementation mapping

- `plan_fdm` resolves the requested tesla vector to the FDM A/m plan value.
- `external_field_add_into_soa` and `external_energy_from_fields` own active-cell LLG/energy
  behavior.
- `observe_state_with_antenna_field` owns the separate CPU full-domain observable construction.

(source-code-index)=
## 9. Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Zeeman` | Public Zeeman authoring and lowering. | Python | source contract |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | Resolves `B / \mu_0` and validates FDM execution. | FDM CPU/GPU planner | source contract |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `external_field_add_into_soa` | Adds the field to active-cell FDM LLG assembly. | FDM CPU | source contract |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `external_energy_from_fields` | Reduces Zeeman energy over active cells. | FDM CPU | source contract |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `observe_state_with_antenna_field` | Builds the separate full-domain uniform `H_ext` observable. | FDM CPU | source contract; not CUDA or atomic-batch proof |
