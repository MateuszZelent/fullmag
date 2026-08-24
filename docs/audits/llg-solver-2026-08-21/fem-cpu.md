# Audyt solvera LLG — FEM CPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
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
| Norma/stop na siatce FEM | potwierdzone maksimum torque, wysoka | `crates/fullmag-runner/src/derived_fields.rs` — `max_torque_residual_apm_from_field`; `backends/fem/cpu/mfem/runtime/stage_completion.cpp` — `update_stage_completion_from_stats` | nonuniform-mesh fixture i kanoniczny trzypróbkowy stop torque |
| Oversubscription | częściowo potwierdzona polityka, koszt otwarty | `backends/fem/cpu/mfem/runtime/cpu_threads.cpp` — `configure_fem_host_runtime_threads`; `backends/fem/include/context.hpp` — `Context::cpu_threads` | sweep OpenMP/MFEM/Hypre threads z NUMA affinity |

### P0/P1 — assembly i konfiguracja solvera nie mogą występować per stage

Macierze masy/exchange, sparsity, restrykcje, essential DOF, mapy regionów, quadrature data i preconditionery powinny być budowane po zmianie zależności, nie po zmianie `m`.

**Naprawa:** dependency graph i cache key obejmujący mesh revision, order, material revision, boundary/periodic constraints i precision. Osobne API `setup()` oraz allocation-free `apply()`.

### P1 — jawny RK jest ograniczony przez `h_min`, nie średni rozmiar elementu

Lokalne refinement i złe elementy mogą wymusić bardzo mały `dt`, nawet gdy większość siatki jest gruba.

**Naprawa:** raport CFL/stiffness estimate, histogram `h`, benchmark jawny RK kontra tangent-plane, semi-implicit, IMEX lub mass-lumped route.

### P1 — niejednoznaczna reprezentacja pola i magnetyzacji

Przenoszenie między node/element/quadrature lub true/local DOF w każdym stage może generować projekcje, kopie i dodatkowe komunikacje.

**Naprawa:** jedna kanoniczna reprezentacja state, jawne adaptery operatorów, trwałe GridFunction/Vector oraz receipt każdej projekcji.

### P1 — mass matrix solve w RHS wymaga właściwej polityki

Jeżeli RHS wymaga rozwiązania z macierzą masy, koszt i tolerancja tego rozwiązania wpływają na formalny błąd integratora. Zbyt luźny solve psuje order, zbyt dokładny marnuje czas.

**Naprawa:** mass lumping/diagonal inverse tam, gdzie fizycznie i numerycznie uzasadnione; w pozostałych przypadkach tolerancja solvera sprzężona z lokalnym błędem RK i cache preconditionera.

### P1 — demag Poisson/airbox może dominować każdą ocenę stage

Ponowne budowanie operatora, warunków brzegowych, gauge lub airbox mapping jest niedopuszczalne. Tylko źródło zależne od `m` powinno się zmieniać w kroku.

**Naprawa:** trwały operator i preconditioner, aktualizacja RHS, kontrola liczby iteracji per stage oraz polityka reuse/rebuild oparta na mierzalnej degradacji.

### P1 — kryteria stopu muszą mieć sens dla nierównomiernej siatki

Surowa norma nodalna może nadmiernie ważyć gęsto zrefinowane obszary. Torque/error powinny używać odpowiedniej normy masowej lub fizycznie zdefiniowanej maksimum/średniej.

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
- normy błędu i stopu powinny uwzględniać miarę FEM;
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
