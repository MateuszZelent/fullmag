# Audyt solvera LLG — FDM CPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Data:** 2026-08-21  
**Metoda:** audyt statyczny architektury, fizyki, numeryki, testów i hot path; zalecenia wydajnościowe wymagają potwierdzenia profilem na reprezentatywnym CPU.

## Werdykt

FDM CPU pozostaje referencyjną ścieżką poprawności, ale nie może być traktowany jako wzorzec wydajności bez osobnego profilu kosztu pól, algebry LLG, redukcji i alokacji. Konwencja `H_eff`/`gamma_0` oraz maksymalna norma błędu są już rozstrzygnięte przez kanoniczny kontrakt i implementację; otwarte pozostają pomiary alokacji, kosztu demag, stiffness i polityki wątków.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Konwencja LLG | potwierdzone, wysoka | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `ExchangeLlgProblem::llg_rhs_from_field_at` | `sot_macrospin_is_converted_to_rhs_with_gilbert_projection` w tym samym module |
| Maksymalna norma adaptacyjna | potwierdzone, wysoka | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `max_error_norm_buf`, `max_error_norm_soa_buf` | `direct_cpu_entry_points_propagate_injected_nonfinite_error_norm` |
| Brak alokacji w RHS | częściowo potwierdzone, wysoka | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `llg_rhs_into_ws_zero_alloc`; `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `rk23_step_soa_state_buf`, `rk45_step_soa_state_buf` | profil alokatora dla steady state; wynik sprzętowy nadal wymagany |
| Stiffness exchange | luka pomiarowa, średnia | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `exchange_field_add_into` | refinement `h_min` i time-to-error dla każdego legalnego integratora |
| Koszt demag per stage | luka pomiarowa, średnia | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` — `rk23_step_soa_state_buf`, `rk45_step_soa_state_buf`; `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `demag_field_add_into_soa_fft_backend` | licznik `demag_solves` i profil accepted/rejected step |
| Oversubscription CPU/FFT | luka pomiarowa, niska | `crates/fullmag-engine/src/fdm/cpu/fft.rs` — `FftWorkspace`; `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs` — `RustFftBackend` | sweep liczby wątków z affinity, bandwidth i LLC misses |
| Stop relaksacji | potwierdzone, wysoka | `crates/fullmag-runner/src/relaxation.rs` — `effective_max_torque_apm`; `crates/fullmag-runner/src/types.rs` — `relaxation_torque_confirmation_count` | kontrakty zakończenia w `crates/fullmag-runner/src/dispatch.rs` |

### Stan potwierdzony — kanoniczna konwencja LLG

Konwencja nie jest otwartą decyzją: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md` (identyfikator `LLG-TD-POLICY-V1`) oraz `docs/physics/llg_conventions.md` (sekcja `Gamma Convention`) definiują `H_eff` w A/m, `gamma_0` w m/(A s) i mianownik Gilberta `1/(1+alpha^2)`. Implementacja FDM CPU realizuje ją w `crates/fullmag-engine/src/fdm/cpu/fields.rs` (`ExchangeLlgProblem::llg_rhs_from_field_at`). Ustalenie audytowe brzmi więc: zachować ten kontrakt i jego testy, a nie dodawać drugi enum konwencji.

### Stan potwierdzony — kanoniczna maksymalna norma błędu

`LLG-TD-MAX-ERR-V1` wymaga maksimum wektorowego błędu po aktywnych komórkach, a nie RMS. Właścicielami implementacji są `crates/fullmag-engine/src/fdm/cpu/integrators.rs` (`max_error_norm_buf`, `max_error_norm_soa_buf`). Maksimum chroni przed rozcieńczeniem lokalnego dużego błędu wraz ze wzrostem siatki. Test refinement ma potwierdzać zachowanie tej normy; nie wolno zastępować jej RMS bez wcześniejszej zmiany kanonicznego kontraktu fizycznego.

### P1 — alokacje i kopie w `step/RHS` są niedopuszczalne w steady state

RK23/RK45 wymagają kilku buforów stage. `Vec`, `clone`, `to_vec`, tworzenie masek lub scratch w każdej ocenie pola zwiększa koszt i presję na allocator/cache.

**Naprawa:** trwały workspace na sesję/siatkę, SoA (`mx`, `my`, `mz`), ping-pong state, prealokowane `k1..ks`, `m_trial`, `H_eff`, redukcje i listy aktywnych komórek.

### P1 — explicit RK jest stabilnościowo ograniczony przez exchange

Dla najmniejszego kroku przestrzennego stabilny krok jawny skaluje się w przybliżeniu jak `h_min^2`. Samo przyspieszenie RHS nie rozwiązuje problemu time-to-solution dla bardzo drobnych siatek.

**Naprawa:** benchmark dokładność–czas dla RK23/RK45/Heun oraz kwalifikacja tangent-plane, semi-implicit lub IMEX dla stiff exchange.

### P1 — ponowna ewaluacja demag dominuje wielostopniowy integrator

Demag FFT jest zwykle najdroższym składnikiem. Każdy dodatkowy stage oznacza kolejną transformację, dlatego optymalizacja musi minimalizować liczbę ocen pola na osiągniętą dokładność, a nie tylko czas pojedynczego kroku.

**Naprawa:** trwałe plany FFT i work areas, brak replanowania, pomiar liczby ocen demag na accepted/rejected step, FSAL wyłącznie tam, gdzie metoda i zależności pola na to pozwalają.

### P1 — oversubscription CPU/FFT

Równoległość operatorów lokalnych i biblioteki FFT/Hypre nie może niezależnie tworzyć pełnych pul wątków. Powoduje to migracje NUMA, thrashing i niestabilne czasy.

**Naprawa:** jeden budżet wątków, affinity/NUMA policy, chunking aktywnych komórek, pomiar bandwidth i LLC misses.

## Audyt fizyczny

1. Zweryfikować znak precesji, definicję `gamma`, `mu0` i mianownik Gilbert dla kilku `alpha`.
2. Po wyłączeniu napędów i torque niekonserwatywnych energia przy `alpha>0` nie może rosnąć ponad tolerancję integratora.
3. Kontrolować `max(abs(|m|-1))` po każdym zaakceptowanym kroku i po reject/restore.
4. Sprawdzić `Ms=0`, inactive cells, granice obiektu, PBC, skoki materiałowe, harmoniczne linki exchange i warunki DMI.
5. Dla termiki sprawdzić skalowanie wariancji z `dt`, objętością komórki, `alpha`, temperaturą i użytym rachunkiem stochastycznym.

## Audyt numeryczny

- rejected step musi cofać stan, cache, RNG i liczniki outputów;
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
