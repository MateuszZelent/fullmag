# Polityka precyzji i kalibracja GPU FDM

- Status: qualification candidate; niepromowany globalnie
- Owners: Fullmag core
- Last updated: 2026-08-30
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`, `docs/adr/0028-fdm-cuda-precision-policy.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md`, `docs/specs/exchange-only-full-solver-architecture-v1.md`, `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`, `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

(fdm-gpu-precision-problem-statement)=
## 1. Problem statement

Fullmag now has a trusted CPU reference engine for the narrow `Exchange + Demag + Zeeman` FDM
slice, and a matching native CUDA `double` execution path for the same slice.
The next production milestone is to finish calibration and qualification of that CUDA path without
changing the physical meaning of the problem.

This move is not only about performance.
It must also define:

- what "single precision" and "double precision" mean in Fullmag,
- where the user selects that mode,
- how the selected precision is preserved through Python API, `ProblemIR`, planning, and backend execution,
- how GPU results are calibrated against the CPU reference and against each other.

The guiding principle is:

> Precision is an execution policy chosen by the user, not a hidden backend implementation detail.

## 2. Physical model

(fdm-gpu-precision-governing-equations)=
### 2.1 Governing equations

The continuum model is unchanged from the current FDM physics notes.
We still solve the Gilbert-form LLG equation with an effective field assembled from the active
interaction set. For the currently executable slice:

```{math}
:label: eq-fdm-gpu-precision-effective-field
\mathbf{H}_{\mathrm{eff}} =
\mathbf{H}_{\mathrm{ex}} +
\mathbf{H}_{\mathrm{demag}} +
\mathbf{H}_{\mathrm{ext}} +
\mathbf{H}_{\mathrm{DMI}}.
```

The Heun stepper still evolves:

```{math}
:label: eq-fdm-gpu-precision-llg
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma}{1 + \alpha^2}
\left(
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha \, \mathbf{m} \times
\left(\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}\right)
\right),
```

Precision choice must not change these equations.
It changes only the floating-point representation and arithmetic used to evaluate the same
discrete operator.

(fdm-gpu-precision-symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `\mathbf{m}` | zredukowana magnetyzacja | `1` |
| `t` | czas fizyczny | `\mathrm{s}` |
| `\mathbf{H}_{\mathrm{eff}}` | pole efektywne | `\mathrm{A\,m^{-1}}` |
| `\mathbf{H}_{\mathrm{ex}}` | pole wymiany | `\mathrm{A\,m^{-1}}` |
| `\mathbf{H}_{\mathrm{demag}}` | pole demagnetyzacji | `\mathrm{A\,m^{-1}}` |
| `\mathbf{H}_{\mathrm{ext}}` | pole zewnętrzne | `\mathrm{A\,m^{-1}}` |
| `\mathbf{H}_{\mathrm{DMI}}` | pole DMI międzyfazowego lub objętościowego | `\mathrm{A\,m^{-1}}` |
| `\gamma` | współczynnik żyromagnetyczny w postaci Gilberta | `\mathrm{m\,A^{-1}\,s^{-1}}` |
| `\alpha` | tłumienie Gilberta | `1` |
| `q_i` | lokalny składnik sumowanej wielkości skalarnej | zależna od obserwabli |
| `S` | wynik redukcji skalarnej | taka jak `q_i` |
| `N` | liczba składników redukcji | `1` |

(fdm-gpu-precision-assumptions-and-validity)=
### 2.3 Assumptions and approximations

- The executable FDM discretization remains the same in CPU and GPU paths for the active term set.
- The public precision selector exposes only:
  - `double`
  - `single`
- Public `mixed` precision is out of scope for the current release.
- In `single` mode, scalar reductions may still accumulate into wider internal types if that is
  documented and deterministic. This does not create a third public precision mode.
- The CPU reference engine remains a correctness baseline and stays `double` only.

(fdm-gpu-precision-discrete-realization)=
## 3. Numerical interpretation

### 3.0 Macierz realizacji

| Solver | Device | Status | Znaczenie dla polityki precyzji |
|---|---|---|---|
| FDM | CPU | documented | referencyjne wykonanie wyłącznie FP64; `single` jest odrzucane |
| FDM | GPU | documented | dwie wersjonowane realizacje single-grid CUDA opisane poniżej |
| FEM | CPU | unsupported | ta nota nie zmienia istniejącego kontraktu FEM double-only |
| FEM | GPU | unsupported | ta nota nie promuje ani nie definiuje FEM FP32 |

### 3.1 FDM

The GPU backend must implement the same 6-point exchange stencil and the same Heun stepping logic
as the CPU reference engine.

Produkcyjny kontrakt nie jest już pojedynczym enumem stanu. Rozdziela cztery
składniki i nadaje całej kombinacji stabilny identyfikator realizacji:

| Publiczna polityka | Storage | Compute | FFT/spectra | Reductions | Realization ID |
|---|---|---|---|---|---|
| `full_double` | FP64 | FP64 | FP64 | FP64 | `fullmag.fdm.cuda.precision.full_double.v1` |
| `single_storage_fp64_reduction` | FP32 | FP32 | FP32 | FP64 | `fullmag.fdm.cuda.precision.single_storage_fp64_reduction.v1` |

W polityce `single_storage_fp64_reduction` pola i widma pozostają FP32, ale
redukcja krytycznych obserwabli akumuluje w FP64:

```{math}
:label: eq-fdm-gpu-precision-reduction
S = \sum_{i=1}^{N} \operatorname{fp64}(q_i).
```

User-visible precision modes mean:

- `double`
  - state arrays are stored in `fp64`,
  - local operator evaluation uses `fp64`,
  - scalar observables are reduced in `fp64`.
- `single`
  - state arrays are stored in `fp32`,
  - local operator evaluation uses `fp32`,
  - scalar observables may be reduced in `fp64` accumulators if documented in provenance and
    validated against the `double` GPU path.

The important invariant is that `single` and `double` use the same discrete scheme, not two
different algorithms.

Adaptive CUDA RK23/DP45 error control uses the same scalar error semantics in both precisions:
the per-cell error field is reduced on device, only the final scalar maximum is copied to host,
and the max-sqrt reduction is scheduled on the backend compute stream with explicit ordering
against the remaining legacy-default-stream producers. Adaptive backup, FSAL reuse, and reject
restore D2D copies are also bound to the backend compute stream. The adaptive policy scalar
calculation is device-side: a stream-bound CUDA policy kernel converts the reduced max-error
square into the accepted/rejected predicate and candidate next timestep using the same exponent
as the selected integrator (`1/3` for RK23, `1/5` for DP45). The host still consumes the compact
policy result to drive the current control loop until the whole retry/accept controller is moved
fully onto the device.

Calibration order is mandatory:

1. CPU `double` vs GPU `double`,
2. GPU `double` vs GPU `single`.

The project must not validate `single` directly against CPU and skip GPU `double`.

### 3.2 FEM

FEM execution is not part of this milestone.
When FEM lands, precision must follow the same user-facing contract:

- precision is selected by the user,
- stored in canonical IR,
- reflected in provenance,
- calibrated against a reference path.

### 3.3 Hybrid

Hybrid execution is deferred.
When it lands, the precision policy must specify whether both coupled representations use the same
precision or whether explicit mixed-precision coupling is legal.
That is out of scope for exchange-only Phase 2.

## 4. API, IR, and planner impact

(fdm-gpu-precision-python-api)=
### 4.1 Python API surface

Precision belongs to runtime/backend policy, not to the physical interaction definition.

Kanoniczny scenariusz stage-first wybiera publiczne `single`; planner rozwiązuje
z niego dokładną politykę `single_storage_fp64_reduction`:

```python
# %% Authoring i wykonanie
import fullmag as fm

study = fm.study("fdm_cuda_single_precision_contract")
study.engine("fdm")
study.device("cuda:0", precision="single")
study.mode("strict")
study.fdm(default_cell=(2.5e-9, 2.5e-9, 2.5e-9))

film = study.geometry(
    fm.Box(size=(20e-9, 10e-9, 2.5e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

study.exchange(enabled=True)
study.demag(enabled=True)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.stages.add_run(until=2e-14, stage_id="run")

# %% Inspekcja dokładnej polityki bez uruchamiania solvera
policy = (
    fm.backend.cuda(1)
    .engine("fdm")
    .precision_policy("single_storage_fp64_reduction")
)
assert policy.to_runtime_metadata()["fdm_precision_policy"]["reduction"] == "double"
```

Scenariusz stage-first nie ma osobnego argumentu exact-policy: transportuje
`execution_precision="single"`, a kanoniczny planner rozwiązuje jedyną legalną
realizację FP32. Obiektowa metoda `RuntimeSelection.precision_policy(...)`
umożliwia jawne sprawdzenie lub niskopoziomowe authoring dokładnej polityki;
nie tworzy alternatywnego modelu fizyki.

| Python | Typ | Default | Jednostka SI | Walidacja | Znaczenie | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.device(..., precision)` | `str \| None` | `None (dziedziczy double)` | `$1$` | `single \| double` | publiczny wybór precyzji wykonania | `FDM CUDA; CPU tylko double; FEM poza zakresem tej strony` | `backend_policy.execution_precision` |
| `RuntimeSelection.precision_policy(policy)` | `FdmPrecisionPolicy \| str` | `required` | `$1$` | `full_double \| single_storage_fp64_reduction` | jawna kompletna polityka FDM | `FDM CUDA single-grid` | `backend_policy.fdm_precision_policy` |

Default:

- `precision="double"`

This default is chosen because:

- the CPU reference path is double-only,
- double precision is the calibration baseline,
- it is the safer default while the CUDA backend is still being hardened.

(fdm-gpu-precision-problem-ir)=
### 4.2 ProblemIR representation

Precision is stored in `BackendPolicyIR`, not `DynamicsIR`.

That reflects the architectural truth:

- `gamma`, integrator, and timestep belong to dynamics semantics,
- floating-point precision belongs to execution policy.

The canonical IR fields are:

- `backend_policy.execution_precision`
- `backend_policy.fdm_precision_policy.storage`
- `backend_policy.fdm_precision_policy.compute`
- `backend_policy.fdm_precision_policy.fft`
- `backend_policy.fdm_precision_policy.reduction`
- `backend_policy.fdm_precision_policy.realization_id`

The backend-specific executable FDM plan must also carry:

- `FdmPlanIR.precision`
- `FdmPlanIR.precision_policy`

so the runner and native backend do not infer or silently override precision.

(fdm-gpu-precision-round-trip-and-failure-semantics)=
### 4.3 Round-trip and failure semantics

`requested intent` zachowuje authored `execution_precision` oraz, gdy podano,
pełne `fdm_precision_policy`. `resolved execution` zawiera dokładny realization
ID, a receipt wykonania osobno zapisuje `requested`, `resolved` i `executed`.
Eksport skryptu zachowuje publiczny wybór `single`/`double`; jawna exact-policy
nie jest rekonstruowana z nazwy urządzenia.

`validation errors` obejmują konflikt scalar precision z exact-policy, nieznany
identyfikator polityki i różnicę resolved/executed. `unsupported combinations`
— CPU FP32, periodic exchange FP32, subcell boundary correction FP32, termika,
heterogeniczne pola materiałowe i multilayer FP32 — kończą się fail-closed
przed krokiem i nie przechodzą przez fallback do CPU ani FP64.

Kanoniczny fragment serializowanego `ProblemIR`, chroniony testem
`test_fdm_precision_policy_round_trips_through_public_authoring`, ma postać:

```json
{
  "backend_policy": {
    "execution_precision": "single",
    "fdm_precision_policy": {
      "storage": "single",
      "compute": "single",
      "fft": "single",
      "reduction": "double",
      "realization_id": "fullmag.fdm.cuda.precision.single_storage_fp64_reduction.v1"
    }
  }
}
```

(fdm-gpu-precision-implementation-mapping)=
### 4.4 Planner and capability-matrix impact

- `execution_precision="double"` is the only public-executable precision in the current CPU
  reference path.
- `execution_precision="single"` is legal in Python API and `ProblemIR`, but currently
  planning-only for the CPU reference runner.
- Current CUDA execution state:
  - FDM `double` is public-executable on GPU,
  - FDM `single` is public-executable on GPU after calibration,
  - bieżący kontrakt polityki precyzji i jego receipt dotyczą wyłącznie
    single-grid CUDA; nie promują multilayer FP32,
  - bounded device-resident multilayer CUDA odrzuca FP32 kodem
    `fdm_cuda_device_resident_multilayer_fp32_not_qualified`; inne historyczne
    ścieżki assisted nie mogą dziedziczyć kwalifikacji single-grid bez osobnego
    requested/resolved/executed receiptu i parity,
  - the native CUDA FDM transfer ABI also exposes precision-matched `f32` and
    `f64` upload/export entrypoints, so calibrated `single` execution no longer
    has to round-trip runtime magnetization and field buffers through host `f64`
    unless a higher-level caller explicitly requests `f64` artifacts,
  - single-grid native CUDA exposes `H_ani` as a first-class observable through
    the `FULLMAG_FDM_OBSERVABLE_H_ANI` copy, preview, and async snapshot paths;
    the field uses the same uniaxial/cubic anisotropy equations and active-mask
    semantics as the anisotropy contribution accumulated into `H_eff`.

This means the capability matrix must distinguish:

- semantic legality,
- current executable backend support,
- calibration status.

(fdm-gpu-precision-validation)=
## 5. Validation strategy

### 5.1 Analytical checks

- Uniform magnetization must still give zero exchange field and zero LLG RHS in both precisions.
- The GPU exchange stencil must match the CPU reference stencil on small toy problems.
- Precision mode must not change the sign convention of precession or damping terms.

### 5.2 Cross-backend checks

Calibration must be layered.

#### Tier A: CPU `double` vs GPU `double`

Purpose:

- verify that the CUDA port preserves the reference discrete model.

Default acceptance targets for exchange-only benchmarks:

- relative `E_ex` error: `<= 1e-9`,
- magnetization L2 difference: `<= 1e-9`,
- max per-cell norm drift: `<= 1e-12`.

These are not bitwise requirements.
They are reference-equivalence tolerances allowing for different floating-point reduction order.

#### Tier B: GPU `double` vs GPU `single`

Purpose:

- qualify `single` as a production mode rather than an unchecked speed path.

Default acceptance targets:

- relative `E_ex` error: `<= 1e-4`,
- magnetization L2 difference: `<= 1e-4`,
- max per-cell norm drift: `<= 1e-6`.

These values are intentionally looser than Tier A because they validate an intentionally lower
precision mode, not an equivalent `fp64` implementation.

### 5.3 Regression tests

- unit tests for IR/planner precision propagation,
- runner rejection test for unsupported CPU `single`,
- native CUDA tests for `fp64` exchange field parity,
- native CUDA tests for `fp64` Heun parity,
- native CUDA tests for `fp32` stability and drift,
- end-to-end smoke tests that record `execution_precision` in metadata and artifacts.

### 5.4 Wykonana kwalifikacja sprzętowa z 2026-08-30

Powtarzalna bramka to
`just verify-fdm-gpu-precision-policy-native-qualification`. Receipt jest
zapisywany poza checkoutem jako
`/mnt/fullmag-zfn2-native/fdm-gpu-precision-policy-contract/precision-policy-qualification-v1.json`.
Zawiera pełny commit bazowy, SHA-256 roboczego diffu, requested/resolved/executed
policy, urządzenie, sterownik, runtime, interakcje, liczniki operatorów,
accepted/rejected, błędy, VRAM i stop reason.

Wykonany tuple:

- NVIDIA GeForce RTX 3070 Laptop GPU, compute capability 8.6;
- CUDA runtime 12.4 (`12040`), driver API `13020`;
- Heun, RK4, RK23, DP45 i ABM3: field/RHS/stage/step parity dla FP64/FP32,
  exchange, DMI oraz demag FFT;
- niezależny oracle granic iDMI/bulk DMI dla FP64/FP32;
- analityczny oracle makrospinu Gilberta i time-to-accuracy;
- fixed Heun, siatka `8 x 8 x 4`, 256 kroków dla długiej trajektorii
  exchange + demag FFT + Zeeman + iDMI + bulk DMI.

Wynik długiej trajektorii:

| Metryka | Wynik | Budżet |
|---|---:|---:|
| max component trajectory error | `3.663506e-6` | `2e-4` |
| relative total-energy error | `9.066454e-8` | `2e-4` |
| relative demag-energy error | `4.605473e-8` | `2e-4` |
| relative DMI-energy error | `1.716964e-6` | `2e-4` |
| FP64 max norm defect | `2.220446e-16` | `1e-12` |
| FP32 max norm defect | `1.385389e-7` | `2e-6` |
| peak VRAM FP64 / FP32 | `422912 / 219112 B` | FP32 < FP64 |
| demag forward/inverse FFT | `768 / 768` | identyczny schedule |
| FP64 reductions | `1536` | jawnie policzone |

Obie polityki osiągnęły błąd makrospinu `<5e-4` po 128 krokach. Hot loop
wykazał zero alokacji urządzeniowych i zero tworzenia planów FFT. Wszystkie
siedem natywnych testów zarządzanej bramki przeszło.

Widmo tensora użyte do porównania precyzji FFT jest jawnie oznaczone jako
syntetyczny fixture numeryczny. Nie zastępuje oracla fizycznego Newella.
Pełny kontrakt `just verify-fdm-gpu-precision-policy-contract` wykonał na tym
samym aktualnym diffie niezależne porównania CPU↔GPU dla fizycznego tensora
Newella: thin-film oraz periodic truncated-images. Oba testy przeszły bez
poluzowania tolerancji.

Pierwsze uruchomienie testu periodycznego ujawniło dwa defekty samego oracla:
ręcznie budowany plan nie zawierał `resolved_periodic_images`, a helper CPU nie
przenosił warunków periodycznych i porównywał GPU periodic z CPU open. Helper
został wyrównany z produkcyjnym `materialize_reference_problem`; dopiero po tej
naprawie wynik jest dowodem tej samej fizyki po obu stronach.

Receipt natywny jest obecnie związany z bazowym commitem i SHA-256 roboczego
diffu. Promocja rejestru pozostaje wstrzymana do ponownego wykonania tej samej
bramki na czystym commicie źródłowym.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend source tree and ABI
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables contract
- [x] Native CUDA tests / benchmarks scaffold
- [x] Documentation

(fdm-gpu-precision-limitations)=
## 7. Known limits and deferred work

- The current CPU reference runner remains `double` only.
- Single-grid CUDA ma sprzętowy receipt i zielone orakle Newella dla dwóch
  kompletnych polityk, lecz promocja rejestru wymaga jeszcze receipt z czystego
  commita źródłowego.
- Multilayer FP32 ma odrębne ograniczenia, nie dziedziczy tej kwalifikacji
  single-grid, a bounded device-resident lane obecnie odrzuca tę kombinację.
- Public `mixed` precision is intentionally deferred.
- Precision-specific performance claims must not be made before Nsight-backed profiling exists.
- Precision policy for FEM and hybrid backends is deferred until those backends exist.
- The current detailed execution handoff for Phase 2 implementation lives in:
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

## 8. References

(fdm-gpu-precision-scientific-bibliography)=
### 8.1 Bibliografia naukowa

1. T. L. Gilbert, *A phenomenological theory of damping in ferromagnetic
   materials*, IEEE Transactions on Magnetics 40(6), 3443–3449 (2004),
   [doi:10.1109/TMAG.2004.836740](https://doi.org/10.1109/TMAG.2004.836740).
2. A. J. Newell, W. Williams, D. J. Dunlop, *A generalization of the
   demagnetizing tensor for nonuniform magnetization*, Journal of Geophysical
   Research 98(B6), 9551–9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).

(fdm-gpu-precision-source-code-index)=
### 8.2 Indeks kodu źródłowego

| Odpowiedzialność | Ścieżka | Symbol | Lane | Dowód |
|---|---|---|---|---|
| publiczna exact-policy i lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPrecisionPolicy` | FDM CUDA authoring | `test_fdm_precision_policy_round_trips_through_public_authoring` |
| metoda publicznego runtime policy | `packages/fullmag-py/src/fullmag/model/problem.py` | `precision_policy` | FDM CUDA authoring | test Python API |
| kanoniczny kontrakt IR | `crates/fullmag-ir/src/execution.rs` | `FdmPrecisionPolicyIR` | backend-neutral IR | testy `fdm_precision_policy` |
| rozwiązywanie i fail-closed | `crates/fullmag-plan/src/fdm.rs` | `resolve_precision_policy` | FDM planner | testy planner policy conflict |
| wersjonowana telemetria ABI | `native/include/fullmag_fdm.h` | `fullmag_fdm_backend_get_precision_policy_telemetry_v1` | FDM CUDA ABI | layout/FFI contract |
| projekcja requested/resolved/executed | `crates/fullmag-runner/src/fdm/gpu/cuda/native/residency.rs` | `precision_policy_from_native` | FDM CUDA runner | native policy tests |
| natywna trajektoria i time-to-accuracy | `backends/fdm/tests/tier_b_compare.cu` | `run_interaction_fixture` | FDM CUDA | managed qualification 7/7 |
| analityczny oracle makrospinu | `backends/fdm/tests/tier_b_compare.cu` | `qualify_macrospin_time_to_accuracy` | FDM CUDA | managed qualification 7/7 |
| referencyjne pole efektywne | `crates/fullmag-engine/src/fdm/shared/problem.rs` | `effective_field` | FDM CPU | CPU↔GPU parity |
| referencyjny RHS LLG | `crates/fullmag-engine/src/fdm/shared/problem.rs` | `llg_rhs` | FDM CPU | CPU↔GPU parity |
| oracle Newella thin-film | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_thin_film_demag_matches_cpu_reference_when_cuda_is_available` | FDM CPU↔CUDA | pełny kontrakt NUM-002 |
| oracle Newella periodic truncated-images | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_periodic_truncated_demag_matches_cpu_reference_when_cuda_is_available` | FDM CPU↔CUDA | pełny kontrakt NUM-002 |
