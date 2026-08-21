# Audyt solvera LLG — FDM CPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Data:** 2026-08-21  
**Metoda:** audyt statyczny architektury, fizyki, numeryki, testów i hot path; zalecenia wydajnościowe wymagają potwierdzenia profilem na reprezentatywnym CPU.

## Werdykt

FDM CPU powinien pozostać referencyjną ścieżką poprawności, ale nie może być traktowany jako wzorzec wydajności bez osobnego profilu kosztu pól, algebry LLG, redukcji i alokacji. Główne ryzyka to rozproszenie kontraktu LLG między warstwami authoring/planner/runtime, brak twardego gate dla konwencji `gamma` i `mu0`, możliwość zależności adaptacyjnej normy błędu od liczby aktywnych komórek oraz ponowne tworzenie danych tymczasowych w wielostopniowych integratorach.

## Ustalenia priorytetowe

### P0/P1 — konwencja LLG musi mieć jednego właściciela

Należy jawnie udokumentować, czy solver przyjmuje pole `H_eff` w A/m i `gamma0` w m/(A s), czy pole `B_eff` w T i `gamma` w rad/(s T). Dopuszczenie obu skal bez typowanego kontraktu grozi błędem rzędu `mu0`.

**Naprawa:** jeden kanoniczny RHS, jawny typ/enum konwencji, test jednorodnego spinu w stałym polu oraz przegląd czynnika `1/(1+alpha^2)`.

### P1 — adaptacyjna norma błędu nie może zależeć od rozmiaru siatki

Surowa globalna norma L2 rośnie z liczbą komórek i powoduje inne kroki czasu po samym zagęszczeniu przestrzennym. Norma powinna być RMS/per-spin albo kątowa na sferze z jawnym `atol/rtol`.

**Test:** ten sam gładki stan na kolejnych siatkach przy identycznym błędzie przestrzennym powinien dawać porównywalny harmonogram kroków.

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
- kryterium relaksacji powinno łączyć torque, `dm/dt`, zmianę energii i minimalne okno czasu;
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
