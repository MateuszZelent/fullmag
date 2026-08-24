---
title: Floquet Response
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-frequency-domain-floquet-response)=
# Floquet/Bloch frequency response

(numerical-methods-floquet-response-problem-statement)=
## Physical and numerical problem

Floquet response imposes a phase relation between corresponding periodic boundary faces. It is a
boundary-value condition on the dynamic magnetization, not merely a nonzero `k_vector` field. The
pair IDs, translation vectors, phase convention, k sampling, demagnetization policy and solver lane
must all be resolved before a response is executable.

(numerical-methods-floquet-response-governing-equations)=
## Governing equations

For a periodic pair separated by $\Delta\mathbf r$, the dynamic field satisfies

```{math}
:label: eq-numerical-floquet-phase
\widehat{\mathbf m}(\mathbf r+\Delta\mathbf r)=
e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}
\widehat{\mathbf m}(\mathbf r).
```

The same phase relation is applied to the response operator constraints. A driven response at a
prescribed frequency therefore solves

```{math}
:label: eq-numerical-floquet-response
\left(\mathrm i\omega\mathsf B_{\alpha}(\mathbf k)-\mathsf L(\mathbf k)\right)
\widehat{\mathbf q}(\omega,\mathbf k)=\widehat{\mathbf b}(\omega,\mathbf k).
```

The current native FEM production slice supports a narrow projected Floquet response, including a
no-dynamic-demag path. Nonzero-k dynamic demagnetization is rejected until its coupled
$\delta\mathbf m/\delta\phi$ operator is qualified.

(numerical-methods-floquet-response-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\widehat{\mathbf m}$ | complex dynamic magnetization amplitude | $1$ |
| $\mathbf r$ | position | $\mathrm{m}$ |
| $\Delta\mathbf r$ | periodic face translation | $\mathrm{m}$ |
| $\mathbf k$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\mathsf L(\mathbf k)$ | k-dependent tangent dynamic operator | $\mathrm{s^{-1}}$ |
| $\mathsf B_{\alpha}(\mathbf k)$ | k-dependent damping/mass operator | $1$ |
| $\omega$ | angular drive frequency | $\mathrm{rad\,s^{-1}}$ |
| $\widehat{\mathbf q}$ | tangent response amplitude | $1$ |
| $\widehat{\mathbf b}$ | harmonic tangent-space forcing | $\mathrm{s^{-1}}$ |

(numerical-methods-floquet-response-assumptions-and-validity)=
## Assumptions and validity

- `FloquetBC.pair_ids` must refer to periodic mesh pairs with finite translations and complete node
  correspondence. A k vector without pair metadata is not a Floquet boundary condition.
- The documented phase convention is `exp_minus_i_k_dot_delta_r`; changing convention changes the
  sign of the phase and must be recorded.
- Nonzero-k dynamic demagnetization is not available in the current native FEM contract. A request
  combining it with Floquet response is a validation error, not permission to drop demag silently.
- CPU and GPU projected slices are separate qualifications. A CPU result does not prove GPU support.

(numerical-methods-floquet-response-python-api)=
## Python API

```python
# %% Stage-first projected Floquet response without dynamic demagnetization
import fullmag as fm

nm = 1.0e-9
study = fm.study("floquet_response")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_frequency_response(
    frequencies_hz=(1.0e9, 2.0e9),
    include_demag=False,
    bc=fm.FloquetBC(pair_ids=("x_faces",), phase_convention="exp_minus_i_k_dot_delta_r"),
    k_vector=(1.0e6, 0.0, 0.0),
    magnetostatic_bc="open",
    observable="susceptibility_tensor",
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FloquetBC.pair_ids` | `Sequence[str]` | required | $1$ | at least one nonempty pair ID | periodic face pair identities | FEM mesh/planner | `study.spin_wave_bc.pair_ids` |
| `FloquetBC.phase_convention` | `str` | `exp_minus_i_k_dot_delta_r` | $1$ | nonempty supported convention | sign convention for phase | FEM Floquet | `study.spin_wave_bc.phase_convention` |
| `FrequencyResponseStageSpec.k_vector` | `tuple[float,float,float] | None` | `None` | $\mathrm{m^{-1}}$ | finite three-vector | legacy Bloch vector | FEM Floquet | `study.k_vector` |
| `FrequencyResponseStageSpec.k_sampling` | `object | None` | `None` | $1$ | valid k sampling schema | Bloch sampling | FEM Floquet | `study.k_sampling` |
| `FrequencyResponseStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include dynamic demag | narrow gated slice | `study.operator.include_demag` |
| `FrequencyResponseStageSpec.magnetostatic_bc` | `str` | `open` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` | magnetostatic closure | FEM | `study.magnetostatic_bc` |

(numerical-methods-floquet-response-problem-ir)=
## ProblemIR and provenance

The IR keeps Floquet pair IDs and phase convention separate from k sampling and magnetostatic
policy. Resolved provenance records periodic mesh certificate, translation vectors, k vector, phase
loop diagnostics, dynamic-demag status, solver lane, precision and rejection/qualification reason.

(numerical-methods-floquet-response-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves pair IDs, phase convention and k sampling. Validation errors include missing
pair metadata, invalid phase convention, nonzero-k Floquet requests without periodic mesh pairs and
dynamic demagnetization without a qualified demag-k operator. Unsupported combinations are explicit;
they cannot silently become free boundaries or open demagnetization. Requested intent and resolved execution are recorded separately.

(numerical-methods-floquet-response-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial-production-executable | projected nonzero-$k$ driven-response slice without dynamic demag; full nonzero-$k$ demag is gated |
| FEM | GPU | partial-production-executable | separate projected no-demag response slice; device execution evidence remains required |
| FDM | CPU | unsupported | no native FDM Floquet response lane |
| FDM | GPU | unsupported | no public FDM CUDA Floquet response lane |

(numerical-methods-floquet-response-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Floquet boundary schema | `packages/fullmag-py/src/fullmag/model/study.py` | `class FloquetBC` | pair IDs and phase convention | Python |
| Request validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | Floquet legality checks | FEM |
| Response contract | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_driven_response_contract` | projected response diagnostics | FEM |

(numerical-methods-floquet-response-validation)=
## Validation

Validate periodic pair completeness, translation vectors, phase-loop closure, k-vector units, field
continuity, response residuals and CPU/GPU parity at identical k, phase, operator and precision.
Validate dynamic-demag rejection explicitly; an unavailable coupled operator is a scientifically
important result, not a passing response.

(numerical-methods-floquet-response-limitations)=
## Limitations

The native nonzero-k dynamic-demag operator is not production-qualified. This page documents the
projected response slice and its rejection boundary; it does not claim a general periodic
magnetostatic response solver.

(numerical-methods-floquet-response-scientific-bibliography)=
## Scientific bibliography

- C. Kittel, *Introduction to Solid State Physics*, magnetic spin-wave boundary conventions.
- I. A. Kalinikos and A. N. Slavin, *Journal of Physics C* 19 (1986), periodic spin-wave theory.
- Canonical boundary owner: {doc}`../../physics/foundations/boundary-conditions`.

(numerical-methods-floquet-response-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Floquet schema | `packages/fullmag-py/src/fullmag/model/study.py` | `class FloquetBC` | pair IDs and phase | Python source |
| Native validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | legality | native source |
| Native response | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_driven_response_contract` | response contract | native source |
