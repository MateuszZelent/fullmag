# Audyt solvera LLG — FDM GPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Data:** 2026-08-21  
**Metoda:** statyczny audyt ścieżki GPU, kontraktów planner/runtime, pamięci, synchronizacji, fizyki i numeryki. Rzeczywistą wydajność musi potwierdzić timeline na docelowym GPU.

## Werdykt

Najważniejszym kryterium nie jest obecność kerneli FDM, lecz pełna rezydencja kroku LLG na urządzeniu. Akcelerowany exchange lub demag przy hostowym RK, normie błędu, kryterium stopu i telemetryce może być wolniejszy od CPU dla małych i średnich siatek. Ścieżka nie jest produkcyjnym „FDM GPU LLG”, dopóki provenance nie potwierdza executed device dla każdego operatora, a profil nie wykazuje braku pełnych readbacków i barier per stage.

## Ustalenia priorytetowe

### P0 — requested GPU nie może oznaczać częściowego lub niejawnego CPU fallbacku

Planner i wynik muszą rozróżniać requested backend, resolved plan i faktycznie wykonane urządzenie dla RHS, demag, exchange, redukcji, integratora i outputu.

**Naprawa:** strict mode bez fallbacku, `executed_device_receipts`, test wymuszający brak dostępnego CPU adaptera oraz kontrola vendor/device/precision w CI sprzętowym.

### P0 — readback/synchronizacja per stage niszczy przyspieszenie

RK45 może wykonywać wiele ocen pola na krok. Odczyt pełnego `m`, `H_eff`, normy błędu albo torque po każdym stage serializuje kolejkę GPU i kosztuje więcej niż sama algebra LLG.

**Naprawa:** urządzeniowe redukcje, accept/reject i update `dt` na urządzeniu albo batchowany command graph; host otrzymuje wyłącznie mały rekord telemetryczny okresowo lub przy zdarzeniu.

### P1 — zbyt drobna granulacja kerneli

Oddzielny kernel dla każdego lokalnego składnika, cross-productu, stage update, normalizacji i redukcji zwiększa launch overhead oraz ruch global memory.

**Naprawa:** fusion pointwise LLG + lokalne pola + update, trwałe bufory, graph capture/command reuse, profil occupancy/register pressure zamiast bezwarunkowej maksymalnej fuzji.

### P1 — tworzenie buforów, planów FFT lub descriptorów w pętli

Każdy `create_buffer`, alokacja scratch albo plan FFT w hot path jest błędem architektonicznym.

**Naprawa:** cache według `(grid, device, precision, PBC, kernel shape)`, trwały workspace FFT, pool buforów stage i jednoznaczna invalidacja po zmianie siatki.

### P1 — adaptacyjny integrator wymaga redukcji skalowalnej względem N

Norma błędu musi być RMS/per-spin lub kątowa. Redukcja powinna być hierarchiczna na urządzeniu; atomiki do jednego skalara dla milionów komórek mogą stać się bottleneckiem i źródłem niedeterministyczności.

### P1 — precyzja i mixed precision nie mogą zmieniać fizyki

`f32` może wystarczać dla części algebraicznej, ale demag, redukcje energii, kryteria stopu i długie przebiegi mogą wymagać akumulacji `f64` lub compensated reduction.

**Naprawa:** jawny precision policy per operator, parity na poziomie RHS/stage/step/trajectory oraz brak silent promotion/demotion.

### P1 — rejected step i RNG muszą pozostać na urządzeniu

Przy termice odrzucony krok nie może konsumować innej sekwencji losowej bez jawnego kontraktu. Kopiowanie RNG state na host jest niedopuszczalne wydajnościowo.

## Audyt fizyczny

- identyczna konwencja `gamma`, `mu0`, `H_eff/B_eff` jak w referencji CPU;
- identyczny czynnik `1/(1+alpha^2)` i kolejność operacji dla damping/precession;
- kontrola normy po accepted/rejected step;
- poprawne maski inactive cells i brak dzielenia przez `Ms=0`;
- poprawne linki exchange, PBC i DMI na brzegach bloków/kernel tiles;
- termika: wariancja zależna od `dt` i objętości komórki, niezależna od sposobu batchowania RNG.

## Audyt numeryczny

1. Porównać CPU/GPU: pojedynczy składnik pola, pełne `H_eff`, RHS, jeden stage, jeden krok i trajektorię.
2. Sprawdzić, czy order adaptacyjnej metody zachowuje się po normalizacji i mixed precision.
3. Ustalić tolerancje redukcji niedeterministycznych.
4. Rejected step musi przywracać `m`, cache pól, RNG, `dt` i counters bez hostowej rekonstrukcji.
5. Stop criteria powinny używać urządzeniowych redukcji, nie pełnego readbacku.

## Plan optymalizacji

### Etap 1 — residency gate

- wszystkie state/stage/field buffers na GPU;
- zero pełnych D2H/H2D w steady-state step;
- strict executed-device receipt;
- timeline bez bariery między każdym małym kernelem.

### Etap 2 — koszt pola

- trwały FFT plan/workspace;
- ograniczenie liczby demag evaluations na osiągniętą dokładność;
- overlap możliwych pól lokalnych z przygotowaniem FFT;
- cache materiałów, linków i masek w formie przyjaznej coalescingowi.

### Etap 3 — algebra i redukcje

- kernel fusion oceniona profilem;
- SoA i wyrównane, zwarte bufory;
- hierarchical reductions i rzadsza telemetryka;
- graph capture albo persistent scheduling dla krótkich kroków.

## Obowiązkowe benchmarki

Raportować: kernels/step, launches/step, synchronizations/step, H2D/D2H bytes, FFT count, accepted/rejected ratio, occupancy, bandwidth, time-to-solution przy ustalonym błędzie oraz break-even size względem FDM CPU.

## Minimalne testy akceptacyjne

- macrospin dla kilku `alpha` i obu precyzji;
- norm/energy invariants przez długi przebieg;
- boundary/PBC fixture przekraczający granice bloków;
- CPU/GPU parity na każdym poziomie przepływu;
- test strict no-fallback;
- test bez readbacku pełnego pola przez zadany przedział kroków;
- termiczny reproducibility/statistical test.

## Ograniczenia

Bez profilu Nsight/rocprof/WebGPU timestamp queries nie można uczciwie podać przyspieszenia. Raport rozróżnia ryzyko architektoniczne od wyniku benchmarku.
