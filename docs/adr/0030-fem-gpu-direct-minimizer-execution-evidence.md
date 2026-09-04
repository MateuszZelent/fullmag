# ADR 0030 — Dowód wykonania FEM GPU dla direct minimizerów

- Status: proposed
- Data: 2026-09-04
- Właściciele decyzji: Fullmag FEM, runtime, artefakty i kwalifikacja
- Zakres pierwszego wdrożenia: FEM GPU, `nonlinear_cg`, `double`, strict device
- Powiązany kontrakt algorytmu: `docs/adr/0018-algorithm-specific-relaxation-contract.md`
- Specyfikacja wykonawcza:
  `docs/superpowers/specs/2026-09-04-fem-gpu-ncg-receipt-v2-snapshot-v3-design.md`

## Kontekst

Task 3 programu FEM GPU świadomie mierzy `nonlinear_cg`. Natywny backend
wykonuje ten algorytm w CUDA, lecz aktualny runner żąda końcowego strict GPU
receipt tylko dla ścieżki RK. Istniejący receipt ABI v1 identyfikuje integrator
RK, a performance snapshot ABI v2 nie zawiera rodzaju wykonania, algorytmu,
modelu prób ani identyfikatora wiążącego oba rekordy.

Obecny transfer audit rozdziela compute, control-scalar i exchange interop, ale
receipt v1 publikuje wyłącznie liczniki compute. Odrzucona albo nieudana próba
może wyczyścić transient evidence przed jego zalatchowaniem. Direct minimizer
ma ponadto formalną ścieżkę do CPU, gdy wymagany stan GPU nie został
zaalokowany. Te luki uniemożliwiają kwalifikację NCG przez zmianę samego
warunku w runnerze.

Chronione niezmienniki to:

- jedna semantyka `Relaxation(nonlinear_cg)` ponad backendami;
- osobne realizacje FEM CPU i FEM GPU;
- jawne requested, resolved i executed execution;
- brak cichego fallbacku strict GPU do CPU;
- atomowy lifecycle próby i rollbacku;
- append-only C ABI;
- rozdzielenie source, runtime, parity, performance i physics evidence;
- natywna własność hot loopu w `backends/fem`, a własność publikacji artefaktów
  w runnerze.

## Decyzja

### 1. Task 3 nadal mierzy NCG

Kwalifikującym algorytmem pozostaje `nonlinear_cg`. Benchmark RK może istnieć
osobno, ale nie zastępuje baseline'u direct minimizera.

### 2. Wprowadzamy nowe append-only ABI

Dodajemy osobne symbole i struktury:

- `fullmag_fem_gpu_execution_receipt_v2`;
- `fullmag_fem_backend_gpu_execution_receipt_v2()`;
- `fullmag_fem_gpu_performance_snapshot_v3`;
- `fullmag_fem_backend_gpu_performance_snapshot_v3()`.

`fullmag_fem_gpu_execution_receipt_v1`,
`fullmag_fem_gpu_performance_snapshot_v1`,
`fullmag_fem_gpu_performance_snapshot_v2` i ich symbole pozostają binarnie i
semantycznie niezmienione. Endpoint receipt v1 zwraca `UNAVAILABLE` dla NCG;
nie projektuje NCG jako pozornego Heuna.

### 3. Receipt v2 identyfikuje wykonanie

Receipt v2 rozdziela stabilnymi enumami:

- `execution_kind = direct_minimizer`;
- `relaxation_algorithm = nonlinear_cg`;
- `attempt_model = outer_step_with_armijo_candidates`;
- `control_policy = bounded_host_scalar_control`;
- terminal outcome;
- generation ID wspólny z performance snapshotem.

Runner otwiera natywną generation przed pętlą etapu, zamyka compute po
ustaleniu terminalnego statusu i zamyka observation po natywnych
snapshotach/exportach. Te wywołania wyznaczają wyłącznie granice lifecycle;
plan operatorów i liczniki nadal powstają w backendzie.

Receipt publikuje required, resolved i executed operator masks, w tym osobne
bity direct minimizera, NCG update, retraction, line search, Armijo energy i
opcjonalnego preconditionera. Brak wymaganego bitu, host/unknown operator,
fallback albo zabroniony transfer zatruwa strict receipt.

### 4. Jednostką transakcji jest outer attempt

Jedno wywołanie natywnego kroku NCG jest outer attempt. Kandydaci Armijo są
zdarzeniami zagnieżdżonymi i nie zamykają receiptu. Rejected, failed,
cancelled i paused muszą najpierw zamknąć transfer audit i zalatchować dowody,
a dopiero potem wyczyścić stan transient.

Terminalne torque confirmation, zerowy gradient i
`representability_stationary` są poprawnymi completed observations bez
zaakceptowanego kroku. Mogą mieć ważny runtime receipt, ale nie kwalifikują
performance artifact.

### 5. Nie tworzymy trzeciego systemu liczników

Performance snapshot v3 jest nową, spójną projekcją istniejących właścicieli:

- `GpuPerformanceCounterState` i snapshot v1 pozostają źródłem liczników
  physical/accepted, pracy odrzuconej, control D2H i kosztów operatorów;
- execution receipt runtime pozostaje źródłem planu, masek, lifecycle,
  naruszeń i faz v2;
- transfer audit pozostaje źródłem kategorii compute, control i exchange.

Nowy tail v3 dodaje identity, generation binding, dokładne liczniki kandydatów,
terminal outcomes, residency transitions, transfer masks i coverage mask.
Implementacja może rozszerzyć wewnętrzne struktury tych właścicieli, ale nie
może utrzymywać równoległych, rozjeżdżających się kopii tych samych liczników.

### 6. Natywny snapshot i publikacja pliku mają różnych właścicieli

Natywny snapshot v3 zamyka zakres obliczeń oraz backendowych snapshot/export
do hosta. Nie mierzy zapisu JSON, flush systemu plików ani własnego zapisu.

Runner publikuje osobny immutable publication receipt, który wiąże SHA-256
snapshotu v3 z bundle/source/problem/mesh/device identity, statusem flush i
czasem publikacji. Benchmark wymaga obu plików. Zapobiega to rekurencyjnemu
„mierzeniu zapisu artefaktu przez artefakt” i zachowuje własność artifact
pipeline w runnerze.

### 7. Strict NCG dopuszcza tylko jawne sterowanie skalarne

`execution_class=device_resident` opisuje stan i operatory. Bieżąca
implementacja NCG może równolegle raportować
`control_policy=bounded_host_scalar_control`.

W strict NCG:

- hot-loop compute H2D/D2H/host-sync muszą wynosić zero;
- exchange interop H2D/D2H/host-sync muszą wynosić zero;
- host/unknown operator masks i fallback count muszą wynosić zero;
- control-scalar D2H oraz control fences są dozwolone wyłącznie jawnie i w
  budżecie wyprowadzonym z liczby kandydatów, refinementów i finalizacji;
- setup oraz terminalny snapshot są osobnymi kategoriami;
- nieznany albo niesklasyfikowany transfer jest naruszeniem.

### 8. Pierwszy rollout obejmuje wyłącznie NCG

PG-BB może współdzielić framework, ale zachowuje status `NOT VERIFIED`, dopóki
nie otrzyma własnej identity, candidate lifecycle, fault injection i managed
qualification. Nie wolno reklamować pierwszej implementacji jako pokrycia
wszystkich direct minimizerów.

### 9. Rozdzielamy dwa validatory

Runner posiada:

- runtime validator: sprawdza lane, identity, maski, fallback, transfery,
  lifecycle i terminal outcome; może zaakceptować zero accepted steps;
- performance validator: dodatkowo wymaga `Completed`, co najmniej jednego
  zaakceptowanego kroku, snapshotu v3, zgodnego generation ID, dozwolonego
  budżetu control plane i kompletnego publication receipt.

Cancelled, paused, failed i completed observation bez accepted step nie
publikują kwalifikującego performance artifact i nie są zamieniane w inny
status przez validator wydajności.

## Rozważone alternatywy

1. **Zmienić Task 3 z NCG na RK.** Odrzucono, ponieważ zmieniłoby to badany
   workload i nie zamknęłoby luki dowodowej direct minimizera.
2. **Rozszerzyć istniejące struktury v1/v2 w miejscu.** Odrzucono, ponieważ
   zmieniłoby layout lub znaczenie opublikowanego C ABI.
3. **Odtworzyć dowód z metadata, stdout albo trace Nsight.** Odrzucono,
   ponieważ żadna z tych powierzchni nie jest atomowym, natywnym dowodem
   wykonania, a trace nie obejmuje wszystkich terminalnych ścieżek.
4. **Zapisywać końcowe pliki bezpośrednio z backendu.** Odrzucono, ponieważ
   naruszałoby własność artifact pipeline i nie rozwiązywałoby
   samoreferencyjnego pomiaru publikacji.

## Konsekwencje

- Task 3 pozostaje `NOT VERIFIED` po samych zmianach source/ABI.
- `production_executable` ani `validated` nie wynikają z obecności kerneli,
  buildu, receiptu lub Nsight osobno.
- `ProblemIR`, Python DSL i równania NCG nie zmieniają się. Nowe pola są
  resolved runtime evidence, nie nowym wejściem fizycznym.
- OpenAPI i generated clients zmieniają się tylko wtedy, gdy receipt v2 lub
  snapshot v3 zostaną wystawione jako publiczny zasób sesji. Pierwszy rollout
  może pozostać artifact-only.
- Runner nie przejmuje solver logic, a backend nie przejmuje filesystemowego
  artifact pipeline.
- Dokładnie pięć powtórzeń baseline'u i pojedynczy capture Nsight pozostają
  osobnymi dowodami.

## Obowiązki implementacyjne

1. Dodać layouty, enumy i symbole ABI z testami `sizeof`, `alignof`, `offsetof`
   oraz zachowania starych symboli.
2. Dodać natywne begin/compute-close/observation-close oraz neutralny GPU
   execution plan dla NCG bez maskowania go jako RK.
3. Naprawić transactional lifecycle i monotoniczne latching naruszeń dla
   accepted/rejected/failed/cancelled paths.
4. Zintegrować NCG i direct-energy helpers z candidate events oraz licznikami
   physical/accepted.
5. Zablokować strict direct-minimizer CPU fallback przed wywołaniem CPU.
6. Dodać mapowanie Rust, dwa validatory i status-aware finalization.
7. Publikować snapshot v3 oraz publication receipt dopiero po właściwych
   terminalnych granicach.
8. Zaostrzyć benchmark do dokładnie pięciu powtórzeń i utrzymać NCG.
9. Rozszerzyć Nsight o identity, binding, ordered phases i unclassified
   transfer/sync rejection.
10. Zaktualizować physics/runtime notes, backend masterplan, capability matrix
    i pakiet dokumentacji Tasku 3 bez promocji statusu przed dowodem.

## Migracja i rollback

Nowe endpointy są addytywne. Starsi konsumenci nadal używają v1/v2.
Konsumenci NCG muszą wymagać v2/v3 i nie mogą degradować do v1/v2, metadata ani
stdout. Brak nowych symboli oznacza `UNAVAILABLE`/`NOT VERIFIED`, nie
rekonstrukcję danych.

Rollback polega na wyłączeniu capability strict receipt v2 dla NCG i usunięciu
nowych konsumentów. Stare ABI oraz stary benchmark RK pozostają działające.
Nie wolno przywrócić cichego CPU fallbacku ani fałszywego receiptu Heun.

## Testy i walidacja

Kolejne, niezastępowalne poziomy dowodu:

1. source/ABI: layout, symbole, state machine i negatywne fault injection;
2. managed runtime: rzeczywisty CUDA NCG, device identity, zero fallbacku;
3. terminal status: accepted, stationary, cancelled, paused i failed;
4. parity: ten sam ProblemIR, mesh, precision, tolerancje i CPU/double oracle;
5. performance: dokładnie pięć powtórzeń, p50/p95 i komplet v2/v3/publication;
6. Nsight: pełny ordered capture i brak niesklasyfikowanych transferów;
7. physics: energie, torque, Armijo proof i właściwe standard problems.

Dopiero komplet wymagany przez workload może zmienić jego status z
`NOT VERIFIED`.
