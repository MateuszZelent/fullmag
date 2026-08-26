# Audyt solvera LLG — FEM CPU

**Repozytorium:** `MateuszZelent/fullmag`
**Gałąź bazowa:** `master`
**Audytowana rewizja źródeł:** [`969efa0941905825ac569d525f4bdaefc059e2af`](https://github.com/MateuszZelent/fullmag/tree/969efa0941905825ac569d525f4bdaefc059e2af)
**Data:** 2026-08-21
**Metoda:** audyt statyczny kontraktów FEM, assembly/apply, pól efektywnych, integratora i kosztu solverów pomocniczych. Wydajność wymaga profilu z MFEM/Hypre na reprezentatywnej siatce.

## Werdykt

FEM CPU ma największe ryzyko kosztu algorytmicznego, nie samej algebry LLG. Jeśli każda ocena stage ponownie składa formy, buduje macierze, ograniczenia lub preconditioner, czas integracji rośnie wielokrotnie. Dodatkowo jawny RK na niejednorodnej siatce jest ograniczony przez najmniejszy element. Produkcyjna ścieżka wymaga jednoznacznego oddzielenia setup od apply, cache zależnego od provenance siatki/materialu oraz kwalifikacji integratora odpornego na stiff exchange.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Setup/assembly a stage RHS | częściowo potwierdzone rozdzielenie, wysoka | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` — `context_step_explicit_rk_mfem`; `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` — `evaluate_rk_stage_rhs` | profiler faz: brak assembly/rebuild po warm-up |
| Ograniczenie przez `h_min` | luka pomiarowa, średnia | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` — `context_step_explicit_rk_mfem` | refinement siatki i time-to-error dla Heun, RK4, RK23, RK45 |
| Reprezentacja state/DOF | potwierdzone właścicielstwo, wysoka | `backends/fem/include/context.hpp` — `Context`; `backends/fem/cpu/mfem/runtime/state_io.cpp` — `context_upload_magnetization_f64`, `context_sync_gpu_magnetization_to_host` | transfer-audit i parity true/local DOF |
| Projekcja przez macierz masy | potwierdzone istnienie operatora, koszt otwarty | `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp` — `apply_exchange_component_mass_projection` | sweep tolerancji i liczby iteracji względem błędu RK |
| Reuse demag | częściowo potwierdzone, średnia | `backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp` — `demag_poisson_try_load_cached_field`; `demag_poisson_solve.cpp` — `context_compute_demag_poisson` | licznik rebuildów i iteracji per stage |
| Norma/stop na siatce FEM z frozen spins | naprawione źródłowo, wysoka | `backends/fem/cpu/mfem/runtime/step_metrics.cpp` — `fill_common_step_metrics`, `max_cross_norm_aos_free`; `backends/fem/cpu/mfem/runtime/stage_completion.hpp` — `update_stage_completion_from_stats` | `just verify-fem-dg0-step-metrics-contract` — managed native fixture wyklucza Airbox i frozen oraz sprawdza przypadek all-frozen |
| Oversubscription | częściowo potwierdzona polityka, koszt otwarty | `backends/fem/cpu/mfem/runtime/cpu_threads.cpp` — `configure_fem_host_runtime_threads`; `backends/fem/include/context.hpp` — `Context::cpu_threads` | sweep OpenMP/MFEM/Hypre threads z NUMA affinity |

### P0/P1 — assembly i konfiguracja solvera nie mogą występować per stage

Macierze masy/exchange, sparsity, restrykcje, essential DOF, mapy regionów, quadrature data i preconditionery powinny być budowane po zmianie zależności, nie po zmianie `m`.

**Naprawa:** dependency graph i cache key obejmujący mesh revision, order, material revision, boundary/periodic constraints i precision. Osobne API `setup()` oraz allocation-free `apply()`.

### P1 — jawny RK jest ograniczony przez `h_min`, nie średni rozmiar elementu

Lokalne refinement i złe elementy mogą wymusić bardzo mały `dt`, nawet gdy większość siatki jest gruba.

**Naprawa:** raport CFL/stiffness estimate, histogram `h` i benchmark jawnego RK dla trajektorii fizycznego czasu. Bieżący `tangent_plane_implicit` jest algorytmem relaksacji z pseudoczasem, retrakcją i akceptacją Armijo; porównuje się go wyłącznie jako time-to-equilibrium. Fizyczno-czasowy tangent-plane/IMEX jest obecnie planowany i nieobsługiwany.

### P1 — niejednoznaczna reprezentacja pola i magnetyzacji

Przenoszenie między node/element/quadrature lub true/local DOF w każdym stage może generować projekcje, kopie i dodatkowe komunikacje.

**Naprawa:** jedna kanoniczna reprezentacja state, jawne adaptery operatorów, trwałe GridFunction/Vector oraz receipt każdej projekcji.

### P1 — mass matrix solve w RHS wymaga właściwej polityki

Jeżeli RHS wymaga rozwiązania z macierzą masy, koszt i tolerancja tego rozwiązania wpływają na formalny błąd integratora. Zbyt luźny solve psuje order, zbyt dokładny marnuje czas.

**Naprawa:** mass lumping/diagonal inverse tam, gdzie fizycznie i numerycznie uzasadnione; w pozostałych przypadkach tolerancja solvera sprzężona z lokalnym błędem RK i cache preconditionera.

### P1 — demag Poisson/airbox może dominować każdą ocenę stage

Ponowne budowanie operatora, warunków brzegowych, gauge lub airbox mapping jest niedopuszczalne. Tylko źródło zależne od `m` powinno się zmieniać w kroku.

**Naprawa:** trwały operator i preconditioner, aktualizacja RHS, kontrola liczby iteracji per stage oraz polityka reuse/rebuild oparta na mierzalnej degradacji.

### P1 — adaptacyjna norma błędu zachowuje maksimum po węzłach

Akceptacja kroku FEM zachowuje kanoniczny kontrakt `LLG-TD-MAX-ERR-V1`: `max_err` jest maksimum normy wektorowego błędu po aktywnych węzłach magnetycznych. Nie wolno zastępować go średnią ani normą ważoną macierzą masy, ponieważ lokalny duży błąd zostałby rozcieńczony wraz ze zmianą refinement. Normy masowe mogą służyć jako dodatkowa diagnostyka globalna, ale nie sterują akceptacją kroku. Kryterium stopu torque jest maksimum `max_torque_Apm` po wolnych aktywnych magnetycznych DOF. Native owner `fill_common_step_metrics` przekazuje teraz maskę aktywnych węzłów magnetycznych i maskę frozen do `max_cross_norm_aos_free`; Airbox i przypięte węzły nie wpływają na stop, a pusty free-set daje metrykę równą zero. `compute_adaptive_error_norm` oraz `compute_adaptive_attempt_guard_metric` stosują ten sam active magnetic free-set i odrzucają błędny rozmiar maski frozen fail-closed. Managed kontrakt obejmuje pinned/non-magnetic oraz all-frozen fixture, a `fem_adaptive_dt_contract` potwierdza wykluczenie frozen i obsługę błędnej maski.

### P1 — równoległość bibliotek może powodować oversubscription

OpenMP/TBB/Rayon, MFEM i Hypre nie mogą niezależnie zajmować wszystkich rdzeni. Dla dużych wektorów krytyczne są NUMA placement i reuse.

## Audyt fizyczny

1. Zweryfikować słabą postać każdego składnika `H_eff` i znak wynikający z wariacji energii.
2. Sprawdzić warunki naturalne dla exchange/DMI oraz okresowe identyfikacje DOF.
3. Airbox nie może wejść do przestrzeni magnetyzacji ani norm/redukcji LLG.
4. Skoki `Ms`, `Aex`, anisotropy/DMI wymagają jawnej polityki interfejsowej; punktowe uśrednianie nie jest uniwersalnie poprawne.
5. `|m|=1` musi być zachowane na magnetycznych DOF bez projekcji airbox/auxiliary fields.
6. Konwencja `gamma`, `mu0` i `H/B` musi być identyczna z FDM reference.

## Audyt numeryczny

- test order w czasie na ustalonej, dokładnej przestrzennie siatce;
- refinement study w przestrzeni przy bardzo małym `dt`;
- kontrola kondycji macierzy masy i exchange;
- rejected-step rollback wszystkich GridFunction/scratch/cache/RNG;
- tolerancje solverów liniowych nie mogą dominować błędu integratora;
- adaptacyjna norma błędu i stop torque zachowują maksimum po aktywnych węzłach; diagnostyki całkowe ważone miarą FEM są raportowane osobno i nie zmieniają akceptacji kroku;
- remesh/state transfer musi zachowywać normę i nie zwiększać niekontrolowanie energii.

## Plan optymalizacji

1. Profil `assembly/setup` osobno od `apply` i solve.
2. Cache sparsity, forms, quadrature, restrictions, constraints i preconditioners.
3. Porównanie assembled sparse, partial assembly i matrix-free dla powtarzanych stage.
4. Prealokacja true/local vectors i brak konwersji reprezentacji w hot path.
5. Dobór tolerancji solverów pomocniczych do błędu czasowego.
6. Integrator odporny na stiffness zamiast nieograniczonego zmniejszania `dt`.
7. NUMA/thread policy i monitor iteracji Hypre na każdy stage.

## Obowiązkowe benchmarki

Dla co najmniej trzech siatek raportować: DOF, `h_min`, order, assembly time, apply time, linear iterations, preconditioner rebuilds, field evaluations, accepted/rejected steps, pamięć peak/steady-state oraz time-to-solution przy ustalonym błędzie fizycznym. Pełną macierz należy wykonać dla każdego wspieranego jawnego integratora — Heun, RK4, RK23 i RK45 — oraz każdej legalnej dla niego polityki fixed/adaptive; pojedynczy wynik Heuna nie kwalifikuje pozostałych hot loopów.

## Minimalne testy akceptacyjne

- macrospin na prostej siatce;
- manufactured exchange solution;
- damping-only energy monotonicity;
- mesh refinement i temporal order oddzielnie;
- periodic DOF fixture;
- airbox exclusion fixture;
- material-interface fixture;
- remesh/state-transfer invariant;
- performance test potwierdzający brak assembly w steady-state step.

## Ograniczenia

Statyczny audyt nie zastępuje profilu MFEM/Hypre. Wyniki solverów liniowych zależą od geometrii, partitioningu, preconditionera i sprzętu; raport wskazuje wymagane gates oraz najbardziej prawdopodobne źródła kosztu.

(fem-cpu-problem-statement)=
## Kontrakt publikacyjny lane FEM CPU

Audyt ocenia realizację FEM CPU, w tym rozdzielenie setup/apply i jawne integratory RK.

(fem-cpu-governing-equations)=
### Równania kanoniczne

Wspólne równanie LLG i norma maksymalna należą do `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`; raport nie tworzy backendowej odmiany fizyki.

(fem-cpu-symbols-and-si-units)=
### Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $H_{\mathrm{eff}}$ | efektywne pole magnetyczne na aktywnych DOF | $\mathrm{A\,m^{-1}}$ |
| $h_{\min}$ | najmniejszy charakterystyczny rozmiar elementu | $\mathrm{m}$ |

(fem-cpu-assumptions-and-validity)=
### Założenia i zakres ważności

Wnioski statyczne dotyczą wskazanego entry pointu MFEM; koszt wymaga profilu managed runtime.

(fem-cpu-python-api)=
### Python API

Raport nie dodaje publicznego konstruktora. Poniższy scenariusz stage-first przechodzi przez publiczny DSL; launcher może go załadować w trybie lightweight, aby wykonać lowering ProblemIR i planowanie FEM CPU bez uruchamiania długiego solve:

```python
# %%
import fullmag as fm

nm = 1.0e-9
study = fm.study("llg_audit_fem_cpu")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(32 * nm, 32 * nm, 8 * nm))
study.universe.mesh(maximum_element_size=16 * nm)
magnet = study.geometry(fm.Box(size=(24 * nm, 24 * nm, 4 * nm), name="audit_fem_cpu"), name="audit_fem_cpu")
magnet.Ms = 8.0e5
magnet.Aex = 13.0e-12
magnet.alpha = 0.1
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
magnet.mesh(maximum_element_size=8 * nm, order=1)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1.0e-8, max_iterations=20)
study.build_domain_mesh()
study.stages.add_relax(stage_id="audit", algorithm="llg_overdamped", dt=5.0e-13, tolA=1.0e-4, max_steps=1)
```

(fem-cpu-problem-ir)=
### ProblemIR

Raport nie zmienia `ProblemIR`; audytuje realizację istniejącej polityki wykonania.

(fem-cpu-round-trip-and-failure-semantics)=
### Round-trip i błędy

`requested intent` pozostaje oddzielony od `resolved execution`. `validation errors` i `unsupported combinations` muszą być jawne i zachować authored intent.

(fem-cpu-discrete-realization)=
### Realizacja dyskretna

| Solver | CPU | GPU | Status na tej stronie |
|---|---|---|---|
| FEM | tak | nie | lane FEM CPU udokumentowany |
| FDM | nie | nie | lane FDM CPU/GPU mają osobne raporty |

(fem-cpu-implementation-mapping)=
### Mapowanie implementacji

Entry point kroku MFEM to `context_step_explicit_rk_mfem`.

(fem-cpu-validation)=
### Walidacja

Wymagane są wszystkie legalne jawne integratory, maksimum błędu po aktywnych węzłach i managed runtime evidence.

(fem-cpu-limitations)=
### Ograniczenia publikacyjne

Audyt statyczny nie kwalifikuje kosztu MFEM/Hypre bez wykonania zarządzanego benchmarku.

(fem-cpu-scientific-bibliography)=
### Bibliografia naukowa

1. W. F. Brown Jr., “Micromagnetics,” Wiley (1963), https://doi.org/10.1002/9780470172914.

(fem-cpu-source-code-index)=
### Indeks kodu źródłowego

| Twierdzenie | Ścieżka | Symbol | Odpowiedzialność | Lane | Test/dowód | Status |
|---|---|---|---|---|---|---|
| Jawny krok RK w MFEM | `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` | `context_step_explicit_rk_mfem` | sterowanie krokiem FEM CPU | FEM CPU | testy integratorów FEM | dowód statyczny |
| Stage RHS | `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` | `evaluate_rk_stage_rhs` | powtarzany apply oddzielony od setup | FEM CPU | `rk_explicit_contract` i profiler warm-up | dowód statyczny; profil wymagany |
| State upload | `backends/fem/cpu/mfem/runtime/state_io.cpp` | `context_upload_magnetization_f64` | mapowanie state/DOF | FEM CPU | transfer audit | dowód statyczny |
| Mass projection | `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp` | `apply_exchange_component_mass_projection` | projekcja exchange przez mass matrix | FEM CPU | `exchange_contract` | test kontraktu; koszt otwarty |
| Cache demag | `backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp` | `demag_poisson_try_load_cached_field` | reuse pola demag | FEM CPU | `demag_poisson_contract` | test kontraktu |
| Solve demag | `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | Poisson solve po aktualizacji RHS | FEM CPU | `demag_poisson_contract` | test kontraktu; koszt otwarty |
| Native torque metric | `backends/fem/cpu/mfem/runtime/step_metrics.cpp` | `fill_common_step_metrics` | publikuje `max_torque_Apm` | FEM CPU | `just verify-fem-dg0-step-metrics-contract` | naprawione: redukcja używa active magnetic free-set |
| Torque reduction | `backends/fem/cpu/mfem/runtime/step_metrics.cpp` | `max_cross_norm_aos_free` | maksimum po aktywnych, niefrozen węzłach | FEM CPU | pinned/non-magnetic i all-frozen fixture | test managed native PASS |
| Adaptive error norm | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `compute_adaptive_error_norm` | maksimum błędu po aktywnych, niefrozen węzłach | FEM CPU | `fem_adaptive_dt_contract` | test managed native PASS; RMS ważony masą pozostaje otwarty |
| Adaptive geometry guards | `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` | `compute_adaptive_attempt_guard_metric` | norm defect/rotation po aktywnych, niefrozen węzłach | FEM CPU | `fem_adaptive_dt_contract` | test managed native PASS; parity CPU/GPU pozostaje otwarta |
| Stage completion | `backends/fem/cpu/mfem/runtime/stage_completion.hpp` | `update_stage_completion_from_stats` | konsumuje torque w stop criterion | FEM CPU | trzypróbkowy stop | dowód statyczny |
| Thread policy | `backends/fem/cpu/mfem/runtime/cpu_threads.cpp` | `configure_fem_host_runtime_threads` | budżet wątków native FEM | FEM CPU | `cpu_threads_contract` i NUMA sweep | test kontraktu; koszt otwarty |
| Relaksacyjny TPI | `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp` | `run_tangent_plane_implicit_step` | pseudoczasowy time-to-equilibrium | FEM CPU | testy relaksacji; nie physical-time order | obsługiwany tylko jako relaksacja |
