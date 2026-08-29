# FSAL w integratorach RK23 i RK45 dla FDM

- Status: zaimplementowany kontrakt źródłowy; ograniczona kwalifikacja CUDA w toku
- Właściciel numeryki: `backends/fdm`
- Powiązane noty: `0406-thermal-noise.md`,
  `0480-fdm-higher-order-and-adaptive-time-integrators.md`

(problem-statement)=
## Problem fizyczny i numeryczny

Bogacki--Shampine 3(2) (`rk23`) i Dormand--Prince 5(4) (`rk45`) są metodami
FSAL (*First Same As Last*): po zaakceptowanym kroku ostatnie obliczenie prawej
strony może być pierwszym obliczeniem następnego kroku. Reuse jest poprawny
wyłącznie wtedy, gdy zaakceptowany stan, czas, krok, źródła pola, transport,
projekcja, integrator i precyzja mają dokładnie tę samą tożsamość.

Brownowskie pole termiczne zmienia realizację losową dla każdego nowego
zaakceptowanego przedziału. Źródło zależne od czasu może zmienić wartość na
granicy przedziału. W obu przypadkach bezwarunkowe FSAL użyłoby prawej strony
z poprzednią realizacją fizyczną. Bezpieczeństwo ma pierwszeństwo przed
oszczędnością jednego wywołania RHS.

(governing-equations)=
## Równania sterujące

Backend integruje znormalizowaną magnetyzację w postaci Gilberta:

```{math}
:label: fsal-llg-rhs
\frac{\mathrm d\mathbf m}{\mathrm dt}
=\mathbf f(\mathbf m,t,\boldsymbol\xi_n)
=-\frac{\gamma}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times
\left(\mathbf m\times\mathbf H_{\mathrm{eff}}\right)\right].
```

Dla metody FSAL ostatni stage zaakceptowanego kroku jest kandydatem na pierwszy
stage kolejnego kroku:

```{math}
:label: fsal-reuse
\mathbf K_s^{(n)}
=\mathbf f\!\left(\mathcal P(\mathbf m_{n+1}),t_n+h_n,
\boldsymbol\xi_n\right),
\qquad
\mathbf K_1^{(n+1)}=\mathbf K_s^{(n)}.
```

Równość jest dozwolona tylko przy pełnej zgodności tożsamości końca kroku:

```{math}
:label: fsal-identity
\mathcal I_{n+1}=\mathcal I_n^{\mathrm{cache}},
\quad
\mathcal I=(r_m,t,h,r_s,r_H,r_{tr},r_{tr,s},r_P,r_{RK},r_p),
\quad T=0,
\quad q_{\mathrm{wave}}=0.
```

Dla termiki amplituda pola Browna w komórce o objętości $V$ wynosi:

```{math}
:label: fsal-brown-amplitude
\sigma_H=
\sqrt{\frac{2\alpha k_{\mathrm B}T}
{\gamma\mu_0 M_sVh_n}}.
```

Nowy zaakceptowany przedział otrzymuje nową realizację
$\boldsymbol\xi_{n+1}$, więc dla $T>0$ warunek FSAL jest zawsze fałszywy.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m,\mathbf m_n$ | znormalizowana magnetyzacja i stan zaakceptowany | $1$ |
| $t,t_n$ | czas fizyczny | $\mathrm{s}$ |
| $h_n$ | krok czasowy próby | $\mathrm{s}$ |
| $\mathbf f$ | prawa strona LLG | $\mathrm{s^{-1}}$ |
| $\mathbf K_i,\mathbf K_s$ | stage RHS metody Rungego--Kutty | $\mathrm{s^{-1}}$ |
| $s$ | indeks ostatniego stage'u | $1$ |
| $\gamma$ | współczynnik żyromagnetyczny w postaci Gilberta | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | tłumienie Gilberta | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | efektywne pole magnetyczne | $\mathrm{A\,m^{-1}}$ |
| $\mathcal P$ | projekcja stage'u na sferę jednostkową | $1$ |
| $\boldsymbol\xi_n$ | standardowy wektor losowy przedziału n | $1$ |
| $\sigma_H$ | odchylenie standardowe pola Browna | $\mathrm{A\,m^{-1}}$ |
| $k_{\mathrm B}$ | stała Boltzmanna | $\mathrm{J\,K^{-1}}$ |
| $T$ | temperatura | $\mathrm{K}$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $V$ | objętość komórki | $\mathrm{m^3}$ |
| $\mathcal I$ | pełna tożsamość końca kroku FSAL | $1$ |
| $r_m$ | rewizja zaakceptowanego stanu | $1$ |
| $r_s$ | rewizja źródła RHS | $1$ |
| $r_H$ | rewizja pola | $1$ |
| $r_{tr}$ | rewizja stanu transportu | $1$ |
| $r_{tr,s}$ | tożsamość stanu transportu | $1$ |
| $r_P$ | tożsamość polityki projekcji | $1$ |
| $r_{RK}$ | tożsamość integratora | $1$ |
| $r_p$ | tożsamość precyzji | $1$ |
| $q_{\mathrm{wave}}$ | znacznik źródła zależnego od czasu lub nieciągłości | $1$ |

(assumptions-and-validity)=
## Założenia i zakres ważności

- Cache FSAL jest wyłącznie cache'em pochodnym; stan zaakceptowany pozostaje
  autorytatywny.
- Reuse wymaga bitowej zgodności czasu i kroku oraz dokładnej zgodności każdej
  rewizji. Nieznana tożsamość oznacza odmowę.
- Obecna realizacja Browna losuje jeden interwał na zaakceptowany krok. Finding
  nie wprowadza specjalnego stochastic-FSAL ani korelacji między interwałami.
- Dynamiczny Oersted i aktywny transport są traktowane konserwatywnie jako
  niezgodne z FSAL. To może kosztować jedno RHS, lecz nie zmienia fizyki.
- Odrzucona próba, błąd kroku, import checkpointu, zmiana pola lub transportu
  oraz nieaktualna publikacja unieważniają cache z typowanym powodem.
- Bounded test natywnego ABI nie promuje całego publicznego adaptive FDM GPU do
  statusu zwalidowanego produkcyjnie.

(python-api)=
## Publiczne API Python

FSAL nie jest parametrem publicznym. Użytkownik wybiera fizyczny integrator,
politykę kroku, temperaturę i źródła; backend automatycznie stosuje bezpieczną
optymalizację. Poniższy deterministyczny scenariusz dociera do ścieżki FSAL:

```python
# %% Model i jawna realizacja wykonania
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_gpu_rk45_fsal")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))

# %% Geometria, materiał i stan
film = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag()
study.b_ext(0.0, 0.0, 5.0e-3)

# %% Integrator i stage fizycznego czasu
study.solver(
    integrator="rk45",
    gamma=2.211e5,
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-7,
        rtol=1.0e-3,
        dt_initial=1.0e-14,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
        safety=0.9,
        growth_limit=2.0,
        shrink_limit=0.2,
    ),
)
study.stages.add_run(stage_id="transient", until=2.0e-10)
```

| Parametr Python | Typ | Domyślna wartość | Jednostka SI | Walidacja i znaczenie | Wsparcie / cel `ProblemIR` |
|---|---|---:|---:|---|---|
| `StudyBuilder.solver(integrator=...)` | `str | None` | `None` | $1$ | integrator must resolve to rk23 or rk45; aliases normalize; requested embedded Runge--Kutta integrator | FDM CPU/GPU according to exact capability; `study.dynamics.integrator` |
| `StudyBuilder.solver(fix_dt=...)` | `float | None` | `None` | $\mathrm{s}$ | finite positive; mutually exclusive with adaptive policy | fixed timestep on capability-gated FDM lanes; `study.dynamics.fixed_timestep` |
| `StudyBuilder.solver(gamma=...)` | `float | None` | `None` | $\mathrm{m\,A^{-1}\,s^{-1}}$ | finite and positive | gyromagnetic ratio on all LLG lanes; `study.dynamics.gyromagnetic_ratio` |
| `AdaptiveTimestep.atol` | `float` | `1e-6` | $1$ | nieujemne; z `rtol` nie mogą być jednocześnie zerowe | `study.dynamics.adaptive_timestep.atol` |
| `AdaptiveTimestep.rtol` | `float` | `1e-3` | $1$ | nieujemne | `study.dynamics.adaptive_timestep.rtol` |
| `AdaptiveTimestep.dt_initial` | `float | None` | `None` | $\mathrm{s}$ | dodatnie i w granicach | `study.dynamics.adaptive_timestep.dt_initial` |
| `AdaptiveTimestep.dt_min` | `float` | `1e-15` | $\mathrm{s}$ | dodatnie | `study.dynamics.adaptive_timestep.dt_min` |
| `AdaptiveTimestep.dt_max` | `float | None` | `None` | $\mathrm{s}$ | dodatnie, nie mniejsze od `dt_min`; planner FDM wymaga wartości | `study.dynamics.adaptive_timestep.dt_max` |
| `AdaptiveTimestep.safety` | `float` | `0.9` | $1$ | $0<\mathrm{safety}\leq1$ | `study.dynamics.adaptive_timestep.safety` |
| `AdaptiveTimestep.growth_limit` | `float` | `2.0` | $1$ | większe od $1$ | `study.dynamics.adaptive_timestep.growth_limit` |
| `AdaptiveTimestep.shrink_limit` | `float` | `0.2` | $1$ | w przedziale $(0,1)$ | `study.dynamics.adaptive_timestep.shrink_limit` |
| `AdaptiveTimestep.max_spin_rotation` | `float | None` | `None` | $1$ | dodatnie; egzekwowane przez adaptacyjne RK23/RK45 dla jawnego urządzenia CUDA; FDM CPU odrzuca | `study.dynamics.adaptive_timestep.max_spin_rotation` |
| `AdaptiveTimestep.norm_tolerance` | `float | None` | `None` | $1$ | dodatnie; egzekwowane przez adaptacyjne RK23/RK45 dla jawnego urządzenia CUDA; FDM CPU odrzuca | `study.dynamics.adaptive_timestep.norm_tolerance` |
| `StudyBuilder.thermal_noise(temperature, seed=...)` | `float, int | None` | `required, None` | $\mathrm{K}$, $1$ | temperature positive; seed positive or None; Brown thermal field intent | single-grid FDM; adaptive Brown rejected; `temperature and energy_terms[].thermal_noise` |

(problem-ir)=
## Reprezentacja `ProblemIR`

Kanoniczny fragment dla deterministycznego przykładu zawiera:

```json
{
  "study": {
    "kind": "time_evolution",
    "dynamics": {
      "kind": "llg",
      "integrator": "rk45",
      "fixed_timestep": null,
      "adaptive_timestep": {
        "tolerance_mode": "advanced",
        "atol": 1e-7,
        "rtol": 1e-3,
        "dt_initial": 1e-14,
        "dt_min": 1e-15,
        "dt_max": 1e-12,
        "safety": 0.9,
        "growth_limit": 2.0,
        "shrink_limit": 0.2
      }
    }
  }
}
```

FSAL nie jest intencją fizyczną i nie jest serializowany w `ProblemIR`.
`ThermalNoise.to_ir()` dodaje `energy_terms[].kind="thermal_noise"`, temperaturę
i opcjonalny seed; `ProblemIR.temperature` zachowuje temperaturę dla planu
natywnego. Requested device, precision i mode pozostają w metadanych wyboru
runtime, a faktyczne wykonanie musi być widoczne w receipt/proweniencji.

(round-trip-and-failure-semantics)=
## Round-trip i semantyka błędów

- Alias `dp54` normalizuje się do `rk45`, a `bs23` do `rk23`; eksport skryptu
  zachowuje kanoniczną nazwę.
- `fixed_timestep` i `adaptive_timestep` są wzajemnie wykluczające.
- Adaptive FDM wymaga jawnego `cpu` lub `gpu/cuda`; `auto` nie może ukryć
  zmiany lane'u.
- Adaptive Brown thermal noise jest obecnie odrzucany przed wykonaniem z
  komunikatem wskazującym fixed-step Heun. Finding nie rozszerza tej capability.
- Regionalne publiczne field drives nie spadają po cichu na CUDA. Wewnętrzny
  dynamiczny Oersted w natywnym ABI wyłącza FSAL konserwatywnie.
- Nieznana albo niezgodna tożsamość cache daje typowany reason code. Stan
  zaakceptowany nie jest mutowany przez samą odmowę reuse.

W terminologii kontraktu są to: **requested intent** (integrator, temperatura,
device i precision zapisane przez autora), **resolved execution** (jeden plan
FDM CPU albo CUDA), **validation errors** (jawne odrzucenie przed krokiem) oraz
**unsupported combinations** (w szczególności adaptive Brown i nieobsługiwane
publiczne CUDA field drives). Żaden z tych przypadków nie może uruchomić
ukrytego fallbacku.

(discrete-realization)=
## Realizacja dyskretna i lane'y

| Lane | Realizacja | Status tej noty | Dowód |
|---|---|---|---|
| FDM CPU | osobne implementacje referencyjne RK23/RK45 | udokumentowane osobnym kontraktem; bez promocji | testy `fullmag-engine` |
| FDM GPU | RK23/DP45 FP32 i FP64, centralna `rhs_allows_fsal_reuse` | zaimplementowane źródłowo; fresh actual-device gate wymagany | kontrakt C++/ABI, planowany managed CUDA runtime |
| FEM CPU | osobny backend MFEM/hypre | poza zakresem; nie dziedziczy statusu | brak roszczenia |
| FEM GPU | osobny backend MFEM/hypre/libCEED/CUDA | poza zakresem; nie dziedziczy statusu | brak roszczenia |

W FDM GPU candidate cache jest publikowany dopiero razem z zaakceptowanym
stanem. Odrzucenie lub błąd usuwa pending cache. Telemetria ABI v2 publikuje
`fsal_reused`, skumulowane `rhs_evaluations_saved`, liczbę losowań termicznych,
indeks zaakceptowanego kroku i licznik każdego stabilnego powodu invalidation.

(implementation-mapping)=
## Mapowanie implementacji

| Odpowiedzialność | Ścieżka + symbol |
|---|---|
| centralna decyzja reuse i typowane powody | `backends/fdm/gpu/cuda/integrators/fsal_policy.hpp` + `context_note_fsal_decision` |
| transakcyjna publikacja cache i telemetria v2 | `backends/fdm/gpu/cuda/integrators/fsal_policy.hpp` + `context_publish_pending_fsal`, `context_get_fsal_telemetry_v2` |
| RK23 FP64 / FP32 | `backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu` + `launch_rk23_step_fp64`; `llg_rk23_fp32.cu` + `launch_rk23_step_fp32` |
| DP45 FP64 / FP32 | `backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu` + `launch_dp45_step_fp64`; `llg_dp45_fp32.cu` + `launch_dp45_step_fp32` |
| ABI telemetrii | `native/include/fullmag_fdm.h` + `fullmag_fdm_fsal_telemetry_v2` |
| odczyt telemetrii przez C ABI | `backends/fdm/api/c_api.cpp` + `fullmag_fdm_backend_get_fsal_telemetry_v2` |
| termiczna realizacja FP64 / FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` + `compute_demag_field_fp64`; `demag_fp32.cu` + `compute_demag_field_fp32` |
| Python i IR | `packages/fullmag-py/src/fullmag/model/dynamics.py` + `LLG`; `model/energy.py` + `ThermalNoise`; `crates/fullmag-ir/src/execution.rs` + `IntegratorChoice`; `crates/fullmag-ir/src/study.rs` + `EnergyTermIR` |
| planner fail-closed | `crates/fullmag-plan/src/fdm.rs` + `plan_fdm` |

(validation)=
## Walidacja

Wymagane bramki dla bounded FDM CUDA obejmują:

1. RED/GREEN kontrakt, w którym aktywna termika lub waveform ma pierwszeństwo
   diagnostyczne nad pustym cache'em.
2. Actual-device test RK23 i DP45 w FP64 oraz FP32: deterministyczny drugi krok
   używa FSAL i oszczędza jedno RHS; termika nigdy nie używa FSAL i zwiększa
   licznik nowych losowań; dynamiczny Oersted raportuje własny reason code.
3. Analityczny macrospin w stałym polu jako niezależny oracle trajektorii dla
   deterministycznej ścieżki.
4. Receipt zawierający pełny commit, hash diffu, device identity, integrator,
   precision, accepted/rejected counts, telemetrię i pusty fallback trail.
5. Managed/container `just` z buildem poza repozytorium oraz walidator
   dokumentacji naukowej.

Wszystkie powyższe bramki przeszły 2026-08-28 w zarządzanym kontenerze CUDA
12.4 na `NVIDIA GeForce RTX 3070 Laptop GPU` (compute capability 8.6). Dla
RK23 i DP45 w FP64 oraz FP32 przebieg deterministyczny zaakceptował 20 kroków,
nie wykonał rollbacku i oszczędził dokładnie 19 wywołań RHS. Przebiegi Brown
thermal oraz dynamic Oersted zaakceptowały po dwa kroki bez rollbacku, nie
użyły FSAL i zarejestrowały po dwa właściwe powody invalidation. Receipt miał
`executed_backend=cuda_fdm`, `fallback_count=0` i poprawne accounting.

Jest to bounded dowód wewnętrznego kontraktu FSAL, a nie promocja całego
publicznego adaptive FDM GPU. Rejestr pozostaje `source_visible/unvalidated`,
ponieważ nie istnieje jeszcze pełny Python--IR--runner E2E ani produkcyjny
time-to-accuracy gate dla całej kombinacji interakcji.

(limitations)=
## Ograniczenia

- Brak stochastic-FSAL; termika zawsze wyłącza reuse.
- Dynamiczny Oersted i aktywny transport zawsze wyłączają reuse, nawet jeśli
  konkretna funkcja źródła jest lokalnie stała.
- Bounded natywny test nie dowodzi pełnego publicznego Python--IR--runner E2E,
  wszystkich interakcji, wszystkich siatek ani time-to-accuracy produkcyjnego
  workloadu.
- Adaptive Brown SDE replay pozostaje niewspierany i fail-closed.
- Ta nota nie promuje FEM ani FDM multilayer.

(scientific-bibliography)=
## Bibliografia naukowa

1. P. Bogacki, L. F. Shampine, “A 3(2) pair of Runge--Kutta formulas”,
   *Applied Mathematics Letters* 2(4), 321--325 (1989),
   [doi:10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
2. J. R. Dormand, P. J. Prince, “A family of embedded Runge--Kutta formulae”,
   *Journal of Computational and Applied Mathematics* 6(1), 19--26 (1980),
   [doi:10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
3. W. F. Brown Jr., “Thermal Fluctuations of a Single-Domain Particle”,
   *Physical Review* 130, 1677--1686 (1963),
   [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).

(source-code-index)=
## Indeks kodu źródłowego

| Twierdzenie | Źródło + symbol | Lane | Test / stan dowodu |
|---|---|---|---|
| pełna tożsamość FSAL i fail-closed | `backends/fdm/gpu/cuda/integrators/fsal_policy.hpp` + `context_note_fsal_decision` | FDM GPU | `fdm_fsal_retry_transaction_contract`; managed CUDA PASS |
| transactional commit/publish | `backends/fdm/gpu/cuda/integrators/fsal_policy.hpp` + `context_commit_accepted_step`, `context_publish_pending_fsal` | FDM GPU | fault-injection source contract |
| RK23 FP32/FP64 | `backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu` + `launch_rk23_step_fp32`; `llg_rk23_fp64.cu` + `launch_rk23_step_fp64` | FDM GPU | managed CUDA oracle/FSAL PASS |
| DP45 FP32/FP64 | `backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu` + `launch_dp45_step_fp32`; `llg_dp45_fp64.cu` + `launch_dp45_step_fp64` | FDM GPU | managed CUDA oracle/FSAL PASS |
| termiczny seed i accepted interval FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` + `launch_effective_field_fp64` | FDM GPU | `fdm_thermal_brown_contract`; managed CUDA PASS |
| termiczny seed i accepted interval FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` + `launch_effective_field_fp32` | FDM GPU | `fdm_thermal_brown_contract`; managed CUDA PASS |
| sprzętowy oracle, termika, waveform i receipt | `backends/fdm/tests/fsal_thermal_cuda_runtime.cpp` + `run_deterministic`, `run_thermal`, `run_dynamic_oersted` | FDM GPU | `fdm_fsal_thermal_cuda_runtime_contract`; 12/12 przypadków PASS |
| append-only ABI v2 | `native/include/fullmag_fdm.h` + `fullmag_fdm_backend_get_fsal_telemetry_v2`; `crates/fullmag-fdm-sys/src/lib.rs` + `fullmag_fdm_fsal_telemetry_v2` | C/Rust ABI | layout tests |
| publiczne mapowanie LLG | `packages/fullmag-py/src/fullmag/model/dynamics.py` + `class LLG` | Python/IR | Python round-trip i planner tests |
| publiczne mapowanie termiki | `packages/fullmag-py/src/fullmag/model/energy.py` + `class ThermalNoise` | Python/IR | Python round-trip i planner tests |
| adaptive Brown fail-closed | `crates/fullmag-plan/src/fdm.rs` + `plan_fdm` | planner FDM | `adaptive_fdm_rejects_brown_thermal_noise_until_sde_replay_is_qualified` |
