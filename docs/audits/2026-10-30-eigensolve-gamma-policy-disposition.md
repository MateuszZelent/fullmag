# Disposition: pozostałe semantyczne hunki `f0986ede`

Zakres: historyczny atom `f0986ede9853828dfd573a2bee12302385213321` porównany ze źródłami w bieżącym worktree, HEAD `84197c1b31252cf06e80c97515729657faec2756`. To przegląd źródeł i kontraktów; nie uruchamiałem testów ani buildów.

## Gamma / automatyczny pure Neumann

| Stary hunk | Bieżący odpowiednik | Disposition |
|---|---|---|
| `f0986ede:crates/fullmag-plan/src/mesh.rs:1885-1914` zamieniał resolved Poisson Dirichlet **i** Robin na `pure_neumann` tylko dla dynamicznego `PeriodicAirboxK0`; poza tym pozostawiał wybrany rodzaj. | `crates/fullmag-plan/src/fem.rs:5899-5917` rozwiązuje `Auto` do `PoissonRobin`, zachowuje jawne Dirichlet/Robin i przekazuje realization do `crates/fullmag-plan/src/mesh.rs:2486-2501`, gdzie `bc_kind` jest bezpośrednio `dirichlet` albo `robin`. Builder nie rozgałęzia się po `magnetostatic_bc`. | **Nieprzeniesione celowo dla obecnego benchmarku; przyszła automatyczna polityka K0 pozostaje decyzją fizyczną.** Selective review mówi, że obecny benchmark używa finite Dirichlet i porównuje odpowiadający mu model; zmiana wymaga osobnego scope i zgodności `k→0` (`docs/audits/2026-10-27-eigensolve-exact-gamma-selective-review.md:13`). Nie zastępować żądanej Dirichlet/Robin automatycznie ani nie wyciągać z benchmarku wniosku o wszystkich problemach Gamma. |
| Ten sam stary hunk wykluczał nie-Poisson realizacje dla dynamic K0 i zwracał `None` bez realization. | Bieżąca walidacja `PeriodicAirboxK0` wymaga demag i k=0 (`crates/fullmag-plan/src/fem.rs:6200-6212,6420-6460`); sam builder nadal mapuje tylko resolved airbox-Poisson. | K0 jest ograniczone do Γ; `k!=0` nie przechodzi tą gałęzią. Nie należy przenosić specjalnej reguły K0 na Floquet/nonzero-k path. |
| `f0986ede:crates/fullmag-plan/src/fem.rs:4205-4303` odrzucał wymuszone GPU i kierował Auto+GPU na CPU z powodem `gpu_modal_pure_neumann_gauge_unavailable`, bo wybrany pure-Neumann model wymagał mean-zero gauge. | `crates/fullmag-plan/src/fem.rs:4940-5047` wybiera dla wymuszonego/wykrytego GPU `GpuModalDeviceKrylov`; CPU fallback jest dla ogólnego `gpu_modal_device_krylov_unavailable`, bez pure-Neumann powodu. Plannerowy test `crates/fullmag-plan/src/tests.rs:11923-11953` wiąże bias samples zarówno z CPU, jak i GPU. | **Stary routing jest superseded razem z nieprzeniesioną BC.** Bieżący planner nie niesie uzasadnienia GPU specyficznego dla gauge pure-Neumann. To potwierdza wyłącznie wybór lane w źródle, nie działanie ani kwalifikację GPU runtime. |

## Demag solver policy i budżet relaksacji bias

- Historyczny IR dodał `FemEigenPlanIR.demag_solver_policy` (`f0986ede:crates/fullmag-ir/src/plan.rs:1720-1725`), a planner kopiował wartość z `ProblemIR.backend_policy.discretization_hints.fem` (`f0986ede:crates/fullmag-plan/src/fem.rs:5098-5103`). Stary test bias sweep (`f0986ede:crates/fullmag-plan/src/tests.rs:11183-11212`) sprawdzał wyłącznie CPU device/precision binding; nie sprawdzał propagacji solver policy ani budżetu.
- Bieżący `FemEigenPlanIR` kończy się osobnym `solver_policy` dla modalnego solvera (`crates/fullmag-ir/src/plan.rs:1882-1892`); nie ma w nim `demag_solver_policy`, a konstrukcja eigen planu przekazuje tylko `solver_policy` (`crates/fullmag-plan/src/fem.rs:5991-6027`). Demag policy nadal jest przenoszone do zwykłego `FemPlanIR` (`crates/fullmag-plan/src/fem.rs:4035-4074,4658`) i do `FemFrequencyResponsePlanIR` (`crates/fullmag-plan/src/fem.rs:6310-6315`), więc luka dotyczy tu eigen-owned relax dla bias sample, nie wszystkich FEM planów.
- Runner przygotowuje osobny plan relaksacji dla każdego pola: `prepare_bias_field_sample_plan` wybiera seed, ustawia bieżące pole i przekazuje stan jako `RelaxedInitialState` (`crates/fullmag-runner/src/fem/eigen_sweep.rs:115-173`); `execute_bias_field_sample_with_potential_publication` uruchamia `bias_field_relax_plan` przed modal solve (`crates/fullmag-runner/src/fem/eigen_execution.rs:473-529`). Wygenerowany `FemPlanIR` ma `demag_solver_policy: None` (`crates/fullmag-runner/src/fem/eigen_execution.rs:657-741`, pole 735). Resolver Native FEM wtedy wybiera default (`crates/fullmag-runner/src/native_fem/plan.rs:63-85`): CPU default `CG+AMG`, `rtol=1e-8`, `max_iterations=500` (`crates/fullmag-ir/src/study.rs:907-945`).
- **Disposition: luka propagacji w bias-sample relaxation, jeśli oczekiwanym kontraktem jest zastosowanie user-authored `FemHintsIR.demag_solver_policy` również do tych wewnętrznych relaksacji.** Aktualny eigen IR usuwa miejsce na ten przekaz, a builder jawnie ustawia `None`; `FemFrequencyResponsePlanIR` i zwykły `FemPlanIR` są odpowiednikami tylko dla swoich ścieżek. Decyzja produktowa do potwierdzenia: czy policy ma obejmować tę oddzielną Relax→Eigen relaksację. Jeśli tak, potrzebny jest IR/planner→runner pass-through i test sprawdzający m.in. `rtol` oraz `max_iterations` w wygenerowanym planie.
- Należy rozdzielić dwa budżety. `FemLinearSolverPolicy.max_iterations` to limit iteracji liniowego demag solvera; niezależnie runner ustawia dla bias-sample LLG `algorithm=LlgOverdamped`, `torque_tolerance_apm=1e-3` i `max_steps=8` (`crates/fullmag-runner/src/fem/eigen_execution.rs:694-702`). `BiasFieldSweepIR` nie ma pola budżetu relaksacji (`crates/fullmag-ir/src/study.rs:1463-1470`). **Disposition: obecnie jest to stały, wewnętrzny budżet runnera; jego konfigurowalność/uzasadnienie nie wynika z historycznego hunka i pozostaje osobną decyzją.** Nie zastępować tego budżetu wartością `demag_solver_policy.max_iterations`.

## Odbiór

Planner/runner wskazani przez zadanie są prześledzeni. Żadne źródło/runtime nie kwalifikuje tu Gamma physics ani GPU execution. Repozytorium pozostało bez zmian; istniejące dirty audit/evidence docs pozostawiłem nietknięte.


## Korekta po review i implementacji źródłowej

W ramach obowiązującego kontraktu hintu FEM naprawiono pass-through istniejącej
polityki demag do wewnętrznego planu Relax każdego bias sample. Pole eigen IR
jest opcjonalne i pomijane dla None, co zachowuje dawny serialized plan. Some
przenosi wszystkie pola; nie steruje osobnym modalnym solver_policy ani
dynamicznym Floquet inner KSP. Niezależny review nie znalazł blokad. Regresje
planner/runner dodano, lecz nowe hosted CI i runtime pozostają NOT VERIFIED.
Powyższa pozycja pytająca o propagację ma zatem status source-implemented,
CI-pending. Stały limit LLG max_steps=8 pozostaje odrębnym otwartym punktem.
Automatyczna zmiana wybranej Dirichlet/Robin na Neumann nie została przeniesiona;
pozostałe hunki historycznego atomu i 388-entry inventory nie są tu zamykane.
