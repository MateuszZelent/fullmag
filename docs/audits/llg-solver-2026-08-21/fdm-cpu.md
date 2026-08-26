# Audyt solvera LLG — FDM CPU

**Repozytorium:** `MateuszZelent/fullmag`
**Gałąź bazowa:** `master`
**Audytowana rewizja źródeł:** [`969efa0941905825ac569d525f4bdaefc059e2af`](https://github.com/MateuszZelent/fullmag/tree/969efa0941905825ac569d525f4bdaefc059e2af)
**Data:** 2026-08-21
**Metoda:** audyt statyczny architektury, fizyki, numeryki, testów i hot path; zalecenia wydajnościowe wymagają potwierdzenia profilem na reprezentatywnym CPU.

## Werdykt

FDM CPU pozostaje referencyjną ścieżką poprawności, ale nie może być traktowany jako wzorzec wydajności bez osobnego profilu kosztu pól, algebry LLG, redukcji i alokacji. Konwencja `H_eff`/`gamma_0`, maksymalna norma błędu oraz składanie regionalnych napędów w polu i energii są rozstrzygnięte przez kanoniczny kontrakt i implementację; bezpośredni analityczny test stałego pola dla live SoA RHS oraz test redukcji po komórkach zostały dodane w remediacji 2026-08-26. Otwarte są nadal pomiary alokacji, kosztu demag, stiffness i polityki wątków.

### Aktualizacja remediacji — 2026-08-26

Na bieżącym `master` wykonano brakujące bramy testowe wskazane w tym audycie:

- `constant_field_live_soa_rhs_and_trajectory_match_analytic_llg` porównuje live SoA RHS z analityczną konwencją LLG, sprawdza parytet AoS/SoA oraz trajektorię stałego pola;
- `finite_error_reduction_uses_active_free_cells_for_aos_and_soa` sprawdza nierówne skończone błędy, ignorowanie komórek nieaktywnych i frozen oraz zgodność redukcji AoS/SoA;
- `max_error_norm_buf` i `max_error_norm_soa_buf` jawnie filtrują komórki poza swobodną dziedziną przed redukcją;
- stałokrokowe persistent-SoA RK23/RK45 nie wykonują już konwersji `to_aos`/`to_soa` w każdym kroku.
- regionalne napędy są składane przez wspólne helpery AoS/SoA do effective field, pełnego `StepReport`, `observe()` i gęstości energii; multiplier jest pobierany dla czasu ocenianego etapu, bez alokacji w hot loop;
- `adaptive_cpu_meets_steady_state_allocation_and_rhs_to_accuracy_budgets` mierzy alokacje po rozgrzaniu dla RK23/RK45 w reprezentacjach AoS, buffer-SoA i persistent-SoA; pełny budżet pozostałych integratorów i outputów pozostaje otwarty.

Brak tych testów w historycznym rejestrze poniżej dotyczy rewizji audytowanej 2026-08-21; aktualny dowód wykonania zapisano także w `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/STATUS-2026-08-26.md`.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Konwencja LLG | implementacja i test bezpośredni potwierdzone | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `effective_field_into_soa_ws_at_time`, `llg_rhs_soa_into` | `constant_field_live_soa_rhs_and_trajectory_match_analytic_llg` |
| Regionalne napędy w polu i energii | implementacja i parytet AoS/SoA potwierdzone | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `regional_field_drives_add_into_at_time`, `regional_field_drives_add_into_soa_at_time`; `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `compute_step_observables_soa_full` | `regional_drive_energy_is_reported_for_aos_and_soa_full_steps` (StepReport, `observe()`, gęstość energii) |
| Maksymalna norma adaptacyjna | implementacja i test redukcji potwierdzone | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `max_error_norm_buf`, `max_error_norm_soa_buf` | `finite_error_reduction_uses_active_free_cells_for_aos_and_soa`; test propagacji `NaN` nadal pokrywa rollback |
| Brak alokacji w live RHS | stałokrokowe persistent-SoA RK23/RK45 nie konwertują stanu przez AoS; ścieżki adaptive wymagają profilu | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `effective_field_into_soa_ws_at_time`, `llg_rhs_soa_into`; `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `rk23_step_soa_state_buf`, `rk45_step_soa_state_buf` | `fixed_rk23_rk45_aos_and_soa_use_exact_dt_without_adaptive_suggestion`; profil alokatora dla pełnej macierzy nadal otwarty |
| Stiffness exchange | luka pomiarowa, średnia | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `exchange_field_add_into` | refinement `h_min` i time-to-error dla każdego legalnego integratora |
| Koszt demag per stage | luka pomiarowa, średnia | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `rk23_step_soa_state_buf`, `rk45_step_soa_state_buf`; `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `demag_field_add_into_soa_fft_backend` | licznik `demag_solves` i profil accepted/rejected step |
| Planowanie CPU/Rayon/FFT | luka pomiarowa, niska | `crates/fullmag-engine/src/fdm/cpu/fft.rs` — `FftWorkspace`; `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs` — `RustFftBackend` | sweep Rayon/FFT z affinity, bandwidth i LLC misses; Hypre nie uczestniczy w FDM CPU |
| Stop relaksacji | potwierdzone, wysoka | `crates/fullmag-runner/src/relaxation.rs` — `effective_max_torque_apm`; `crates/fullmag-runner/src/types.rs` — `relaxation_torque_confirmation_count` | kontrakty zakończenia w `crates/fullmag-runner/src/dispatch.rs` |

### Stan potwierdzony — kanoniczna konwencja LLG

Konwencja nie jest otwartą decyzją: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md` (identyfikator `LLG-TD-POLICY-V1`) oraz `docs/physics/llg_conventions.md` (sekcja `Gamma Convention`) definiują `H_eff` w A/m, `gamma_0` w m/(A s) i mianownik Gilberta `1/(1+alpha^2)`. Live SoA integratory przechodzą przez `effective_field_into_soa_ws_at_time` i `llg_rhs_soa_into`. Test `constant_field_live_soa_rhs_and_trajectory_match_analytic_llg` podaje znane stałe `H_eff`, sprawdza analityczny RHS oraz trajektorię bez tłumienia; test SOT pozostaje dodatkowym pokryciem członu niekonserwatywnego.

### Stan potwierdzony — kanoniczna maksymalna norma błędu

`LLG-TD-MAX-ERR-V1` wymaga maksimum wektorowego błędu po aktywnych, swobodnych komórkach, a nie RMS. Właścicielami implementacji są `crates/fullmag-engine/src/fdm/cpu/integrators.rs` (`max_error_norm_buf`, `max_error_norm_soa_buf`). Maksimum chroni przed rozcieńczeniem lokalnego dużego błędu wraz ze wzrostem siatki, a filtr `is_error_cell_active` wyklucza domenę nieaktywną i frozen przed redukcją. Test `finite_error_reduction_uses_active_free_cells_for_aos_and_soa` sprawdza nierówne skończone wartości osobno dla obu layoutów; `direct_cpu_entry_points_propagate_injected_nonfinite_error_norm` nadal potwierdza propagację wartości niefinitywnej i rollback.

### P1 — alokacje i kopie w `step/RHS` są niedopuszczalne w steady state

RK23/RK45 wymagają kilku buforów stage. `Vec`, `clone`, `to_vec`, tworzenie masek lub scratch w każdej ocenie pola zwiększa koszt i presję na allocator/cache.

**Naprawa:** trwały workspace na sesję/siatkę, SoA (`mx`, `my`, `mz`), ping-pong state, prealokowane `k1..ks`, `m_trial`, `H_eff`, redukcje i listy aktywnych komórek.

### P1 — explicit RK jest stabilnościowo ograniczony przez exchange

Dla najmniejszego kroku przestrzennego stabilny krok jawny skaluje się w przybliżeniu jak `h_min^2`. Samo przyspieszenie RHS nie rozwiązuje problemu time-to-solution dla bardzo drobnych siatek.

**Naprawa:** benchmark dokładność–czas dla każdego wspieranego integratora FDM — Heun, RK4, RK23, RK45 i ABM3 — z każdą legalną dla niego polityką fixed/adaptive, oraz kwalifikacja tangent-plane, semi-implicit lub IMEX dla stiff exchange. Kombinacje nieobsługiwane mają być odrzucane i raportowane, a nie pomijane w macierzy.

### P1 — ponowna ewaluacja demag dominuje wielostopniowy integrator

Demag FFT jest zwykle najdroższym składnikiem. Każdy dodatkowy stage oznacza kolejną transformację, dlatego optymalizacja musi minimalizować liczbę ocen pola na osiągniętą dokładność, a nie tylko czas pojedynczego kroku.

**Naprawa:** trwałe plany FFT i work areas, brak replanowania, pomiar liczby ocen demag na accepted/rejected step, FSAL wyłącznie tam, gdzie metoda i zależności pola na to pozwalają.

### P1 — planowanie CPU/Rayon/FFT

Równoległość operatorów lokalnych, Rayon i RustFFT nie może powodować konkurencyjnego planowania lub nadmiernej liczby zadań. Hypre nie uczestniczy w lane FDM CPU. Ryzykiem są migracje NUMA, thrashing cache i niestabilne czasy wynikające z rzeczywistej ścieżki Rayon/FFT.

**Naprawa:** jeden budżet wątków, affinity/NUMA policy, chunking aktywnych komórek, pomiar bandwidth i LLC misses.

## Audyt fizyczny

1. Zweryfikować znak precesji, definicję `gamma`, `mu0` i mianownik Gilbert dla kilku `alpha`.
2. Po wyłączeniu napędów i torque niekonserwatywnych energia przy `alpha>0` nie może rosnąć ponad tolerancję integratora.
3. Kontrolować `max(abs(|m|-1))` po każdym zaakceptowanym kroku i po reject/restore.
4. Sprawdzić `Ms=0`, inactive cells, granice obiektu, PBC, skoki materiałowe, harmoniczne linki exchange i warunki DMI.
5. Dla termiki sprawdzić skalowanie wariancji z `dt`, objętością komórki, `alpha`, temperaturą i użytym rachunkiem stochastycznym.

## Audyt numeryczny

- dla wspieranych deterministycznych polityk rejected step musi cofać stan, cache i liczniki outputów; adaptive + Brown noise jest obecnie odrzucane przez planner (`adaptive_fdm_rejects_brown_thermal_noise_until_sde_replay_is_qualified`), więc rollback RNG pozostaje bramką przyszłej kwalifikacji SDE;
- projekcja na sferę nie może obniżać rzędu metody;
- `dt_min`, `dt_max`, growth/shrink limiter i diagnostyka stagnacji muszą być jawne;
- kryterium równowagi zachowuje kanoniczne trzy kolejne świeże próbki `max_torque_Apm` poniżej progu; plateau energii pozostaje wyłącznie opcjonalnym sygnałem sterownika, zgodnie z `docs/physics/0580-canonical-relaxation-equilibrium-contract.md` (`discrete-realization`) i `crates/fullmag-runner/src/relaxation.rs` (`effective_max_torque_apm`);
- redukcje równoległe wymagają polityki deterministyczności i tolerancji.

## Plan optymalizacji

1. Profil rozdzielający exchange, demag, pola lokalne, RHS, stage update, normę błędu i output.
2. Usunięcie wszystkich alokacji z pętli accepted/rejected stage.
3. SoA, wektoryzacja SIMD i zwarte aktywne indeksy.
4. Cache współczynników geometry/material/PBC oraz planów FFT według provenance siatki.
5. Benchmark `time-to-solution at fixed error`, nie tylko `ns/step`.
6. Performance regression CI dla małej, średniej i dużej siatki.

## Minimalne testy akceptacyjne

- macrospin precession/damping;
- norm conservation przez długi przebieg;
- damping-only energy monotonicity;
- manufactured exchange mode z refinement study;
- pojedynczy RHS i pełna trajektoria porównane z wysokoprecyzyjnym oracle;
- stabilność wyników po zmianie liczby wątków;
- brak alokacji w steady state potwierdzony profilem.

## Ograniczenia

Raport nie deklaruje uzyskanego przyspieszenia ani skalowania NUMA bez benchmarku sprzętowego. Brak jawnego wzorca w kodzie traktowany jest jako luka dowodowa, a nie automatycznie jako brak implementacji.

(fdm-cpu-problem-statement)=
## Kontrakt publikacyjny lane FDM CPU

Audyt ocenia referencyjny krok LLG FDM CPU względem kanonicznych dokumentów fizycznych; nie ustanawia drugiej definicji równania.

(fdm-cpu-governing-equations)=
### Równania kanoniczne

Równanie LLG, konwencja $H_{\mathrm{eff}}$/`gamma_0` i norma `LLG-TD-MAX-ERR-V1` pozostają własnością `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`. Ta strona mapuje wyłącznie realizację lane i nie duplikuje wspólnej fizyki.

(fdm-cpu-symbols-and-si-units)=
### Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $H_{\mathrm{eff}}$ | efektywne pole magnetyczne używane przez RHS | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | bezwzględna stała żyromagnetyczna dla pola $H$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |

(fdm-cpu-assumptions-and-validity)=
### Założenia i zakres ważności

Wnioski statyczne obowiązują dla kodu wskazanego w indeksie. Wydajność i skalowanie wymagają osobnego dowodu sprzętowego.

(fdm-cpu-python-api)=
### Python API

Raport nie dodaje publicznego konstruktora. Poniższy scenariusz stage-first przechodzi przez publiczny DSL; launcher może go załadować w trybie lightweight, aby wykonać lowering ProblemIR i planowanie FDM CPU bez uruchamiania długiego solve:

```python
# %%
import fullmag as fm

nm = 1.0e-9
study = fm.study("llg_audit_fdm_cpu")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(32 * nm, 32 * nm, 8 * nm))
study.cell(4 * nm, 4 * nm, 4 * nm)
magnet = study.geometry(fm.Box(size=(24 * nm, 24 * nm, 4 * nm), name="audit_fdm_cpu"), name="audit_fdm_cpu")
magnet.Ms = 8.0e5
magnet.Aex = 13.0e-12
magnet.alpha = 0.1
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.demag()
study.stages.add_relax(stage_id="audit", algorithm="llg_overdamped", dt=5.0e-13, tolA=1.0e-4, max_steps=1)
```

(fdm-cpu-problem-ir)=
### ProblemIR

Raport nie zmienia `ProblemIR`; ocenia realizację istniejącego requested intent.

(fdm-cpu-round-trip-and-failure-semantics)=
### Round-trip i błędy

`requested intent` pozostaje oddzielony od `resolved execution`. `validation errors` muszą zachować authored intent, a `unsupported combinations` są jawnie odrzucane przez planner.

(fdm-cpu-discrete-realization)=
### Realizacja dyskretna

| Solver | CPU | GPU | Status na tej stronie |
|---|---|---|---|
| FDM | tak | nie | lane FDM CPU udokumentowany; FDM GPU ma osobny raport |
| FEM | nie | nie | lane FEM CPU/GPU mają osobne raporty |

(fdm-cpu-implementation-mapping)=
### Mapowanie implementacji

Live SoA integratory wywołują `effective_field_into_soa_ws_at_time`, a następnie `llg_rhs_soa_into`; nieużywany wrapper `llg_rhs_into_ws_zero_alloc` nie jest dowodem wykonania hot path.

(fdm-cpu-validation)=
### Walidacja

Wymagane są oracles fizyczne, parity oraz pełna macierz legalnych integratorów opisana w kontrakcie benchmarków.

(fdm-cpu-limitations)=
### Ograniczenia publikacyjne

Audyt statyczny nie jest dowodem wydajności ani kwalifikacji sprzętowej.

(fdm-cpu-scientific-bibliography)=
### Bibliografia naukowa

1. T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic materials,” *IEEE Transactions on Magnetics* 40, 3443–3449 (2004), https://doi.org/10.1109/TMAG.2004.836740.

(fdm-cpu-runner-remediation)=
### Uzupełnienie remediacji runnera

Po przeniesieniu regionalnego napędu do kanonicznego `observe()` runner CPU nie dolicza go ponownie do `e_ext` ani `e_total`. `regional_drive_energy` zachowuje osobne `e_drive` z lokalnym `M_s`, a `reconstruct_inactive_fdm_visual_effective_field` dodaje napęd tylko w nieaktywnych komórkach wizualizacji. Regresję obejmuje `regional_drive_produces_distinct_field_and_energy_outputs`.

(fdm-cpu-source-code-index)=
### Indeks kodu źródłowego

| Twierdzenie | Ścieżka | Symbol | Odpowiedzialność | Lane | Test/dowód | Status |
|---|---|---|---|---|---|---|
| Live effective field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `effective_field_into_soa_ws_at_time` | składa pole dla integratorów SoA | FDM CPU | call chain RK23/RK45 | dowód statyczny |
| Regionalne pole i energia | `crates/fullmag-engine/src/fdm/cpu/fields.rs`, `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `regional_field_drives_add_into_at_time`, `regional_field_drives_add_into_soa_at_time`, `compute_step_observables_soa_full` | wspólne składanie regionalnego napędu dla pola, RHS i energii | FDM CPU | `regional_drive_energy_is_reported_for_aos_and_soa_full_steps` | test parytetu potwierdzony |
| Live RHS LLG | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `llg_rhs_soa_into` | oblicza RHS z pola w trwałych buforach SoA | FDM CPU | `constant_field_live_soa_rhs_and_trajectory_match_analytic_llg` | implementacja i oracle potwierdzone; profil alokatora otwarty |
| Maksymalna norma adaptacyjna (AoS) | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `max_error_norm_buf` | maksimum błędu po aktywnych, swobodnych komórkach w buforze AoS | FDM CPU | `finite_error_reduction_uses_active_free_cells_for_aos_and_soa` | test redukcji potwierdzony |
| Maksymalna norma adaptacyjna (SoA) | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `max_error_norm_soa_buf` | maksimum błędu po aktywnych, swobodnych komórkach w buforze SoA | FDM CPU | `finite_error_reduction_uses_active_free_cells_for_aos_and_soa` | test redukcji potwierdzony |
| RK23 SoA | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `rk23_step_soa_state_buf` | adaptive i fixed-step używają trwałych buforów SoA | FDM CPU | `fixed_rk23_rk45_aos_and_soa_use_exact_dt_without_adaptive_suggestion` | fixed-step naprawiony; profil adaptive otwarty |
| RK45 SoA | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `rk45_step_soa_state_buf` | adaptive i fixed-step używają trwałych buforów SoA | FDM CPU | `fixed_rk23_rk45_aos_and_soa_use_exact_dt_without_adaptive_suggestion` | fixed-step naprawiony; profil adaptive otwarty |
| Exchange | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `exchange_field_add_into` | operator lokalny wyznaczający stiffness | FDM CPU | refinement `h_min` | hipoteza pomiarowa |
| Demag FFT | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `demag_field_add_into_soa_fft_backend` | kosztowny składnik pola per stage | FDM CPU | licznik ocen demag | hipoteza pomiarowa |
| Workspace FFT | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `FftWorkspace` | trwałe bufory i plany FFT | FDM CPU | sweep Rayon/FFT | dowód statyczny; koszt otwarty |
| Stop relaksacji | `crates/fullmag-runner/src/relaxation/convergence.rs` | `effective_max_torque_apm` | wybór świeżej metryki torque | FDM CPU | trzypróbkowy kontrakt stopu | dowód statyczny |
