# Masterplan Backendu Fullmag

- Status: szkic resetu backends-first
- Właściciele: Fullmag core
- Ostatnia aktualizacja: 2026-07-05
- Zakres: własność backendów solverów, natywna implementacja kompilowana,
  orkiestracja Rust runnera, bramki walidacyjne i kolejność migracji po
  resecie układu źródeł z 2026-06-03.

## 1. Cel

Ten dokument zastępuje poprzedni kierunek backendowego masterplanu. Główna
korekta jest prosta:

`/home/kkingstoun/git/fullmag/fullmag/backends` jest kompilowanym rdzeniem
obliczeniowym Fullmag.

Drzewo backendów nie jest legacy i nie jest tymczasowym
drzewem źródeł do późniejszego przepisania. To poprawny kręgosłup
implementacyjny:

- `backends/fem` jest kanonicznym silnikiem FEM opartym o
  MFEM/hypre/libCEED.
- `backends/fdm` jest kanonicznym kompilowanym natywnym backendem FDM.
- Crate'y Rust, Python DSL, API i control room są budowane wokół tego
  natywnego rdzenia.

Katalog `native` pozostaje technicznym rootem CMake, wspólnych nagłówków i
pakowania, ale nie jest już rootem implementacji solverów. Poprzednia ścieżka
`native/backends/*` była poprawnym kodem produkcyjnym, lecz nazwa rootu była
myląca. Relokacja do `backends/*` jest rename/move tej samej implementacji, nie
zgodą na budowę drugiego solvera w innym miejscu.

## 2. Decyzja Resetu

Podejście do source-layout z 2026-06-03 wymieszało trzy różne cele:

1. podział przerośniętych plików Rust runnera,
2. doprecyzowanie własności źródeł natywnych backendów,
3. przedefiniowanie architektury solverów.

W efekcie powstało za dużo churnu i błędny sygnał architektoniczny: wyglądało
to tak, jakby produkcyjny FEM miał przejść do ścieżek Rust runnera
`solvers/fem/*`. Resetujemy ten kierunek.

Aktywna reguła po resecie:

- zmiany z błędnego kierunku Rust/source-layout/dokumentacji są traktowane jako
  materiał do selektywnego odzysku, a nie jako automatyczny kierunek migracji,
- zostają tylko jasno użyteczne zmiany testowe lub wspierające natywne backendy,
- plan odbudowujemy wokół `backends/*` jako źródła prawdy dla implementacji,
- stare zmiany wracają tylko wtedy, gdy wspierają ten plan backends-first.

## 3. Profesjonalna Organizacja Katalogów

Nie przenosimy kompilowanego kodu C++/CUDA/MFEM do `crates`.

`crates` oznacza pakiety Rust. Tam żyją runner, sys bindings, IR, API i
orkiestracja. Gdyby produkcyjny FEM/FDM trafił do `crates`, repozytorium
zaczęłoby sugerować, że kompilowany backend jest częścią implementacji Rust
albo że Rust runner jest właścicielem solvera. To jest dokładnie pomyłka, którą
resetujemy.

Profesjonalna organizacja zaczęła się od uporządkowania nazwy rootu backendów:
`native/backends` zostało relokowane do top-level `backends`. Ten rename jest
pierwszym porządkowym krokiem przed większymi refaktorami wewnątrz FEM/FDM,
żeby nie poprawiać tych samych ścieżek dwa razy.

Aktualny stan organizacyjny:

```text
backends/
  fdm/
  fem/
```

Ta relokacja ma być rename/move istniejącego drzewa `native/backends`, nie
przepisanie i nie druga implementacja. Semantycznie kod spod poprzedniej
ścieżki `native/backends` był już głównym backendem; po relokacji ta sama
implementacja żyje pod `backends`.

Odpowiedzialności wyglądają tak:

| Obszar | Poprzednia Ścieżka | Aktualna Ścieżka | Odpowiedzialność |
|---|---|---|---|
| Kompilowany FDM | `native/backends/fdm/*` | `backends/fdm/*` | produkcyjny natywny backend FDM, CUDA runtime, ABI, testy natywne |
| Kompilowany FEM | `native/backends/fem/*` | `backends/fem/*` | produkcyjny backend MFEM/hypre/libCEED CPU/GPU, ABI, testy natywne |
| Rust runner | `crates/fullmag-runner/*` | bez zmiany | orkiestracja, availability, wywołania natywne, artefakty, preview, proweniencja |
| Sys bindings | `crates/fullmag-fdm-sys/*`, `crates/fullmag-fem-sys/*` | bez zmiany | bindy do C ABI kompilowanych backendów |
| Rust reference | `crates/fullmag-engine/*` i wybrane moduły runnera | bez zmiany | walidacja, debug, jawne ścieżki referencyjne |

Profesjonalne kryteria organizacji:

1. Top-level albo pseudo-top-level root backendów ma oznaczać kompilowany kod
   produkcyjny, nie język Rust.
2. `crates` pozostaje przestrzenią pakietów Rust.
3. `fdm` i `fem` są osobnymi domenami fizyczno-numerycznymi.
4. `cpu` i `gpu/cuda` są osobnymi realizacjami runtime.
5. `core`, `include`, `src`, `runtime`, `interactions`, `integrators`,
   `observables`, `transfer`, `state`, `tests` oznaczają odpowiedzialności, a
   nie przypadkowe kosze na pliki.
6. Testy source-layout i kontrakty muszą chronić tę strukturę przed powrotem do
   monolitów.
7. Nazwa katalogu nie może sugerować, że runner jest właścicielem produkcyjnych
   solverów.

Kolejność relokacji:

1. Ustabilizować dokumenty i testy, że poprzednie `native/backends` było
   poprawnym źródłem prawdy, a nie legacy.
2. Przygotować CMake, sys crates, skrypty runtime i dokumentację na ścieżki
   `backends/fdm` i `backends/fem`.
3. Przenieść katalogi przez jeden kontrolowany rename/move:
   `native/backends/fdm -> backends/fdm` i
   `native/backends/fem -> backends/fem`.
4. Zostawić krótki okres kompatybilności tylko tam, gdzie wymagają tego buildy
   albo zewnętrzne skrypty.
5. Usunąć stare aliasy `native/backends/*`, gdy build, runtime smoke i testy
   source-layout przejdą na nowych ścieżkach.

Po tej relokacji w dokumentach trzeba pisać:

- obecny backend: `backends/fem` albo `backends/fdm`,
- poprzednia ścieżka: `native/backends/fem` albo `native/backends/fdm`,
- nigdy: produkcyjny backend FEM/FDM pod `crates/fullmag-runner/src/solvers/*`.

## 4. Reguły Nienegocjowalne

1. `backends/fem` jest głównym drzewem implementacji FEM.
2. `backends/fdm` jest głównym drzewem kompilowanej implementacji FDM.
3. Rust runner nie jest właścicielem produkcyjnych operatorów FEM, weak forms,
   solve'ów Poissona, realizacji BEM/FMM, kerneli libCEED, polityki hypre,
   rezydencji CUDA ani hot loopów.
4. Rust runner jest właścicielem orkiestracji: przekazania obniżonego problemu,
   wyboru silnika, sprawdzania dostępności, wywołań natywnego ABI, zapisu
   artefaktów, routingu preview/resource, mapowania telemetrii i proweniencji.
5. Numeryka referencyjna w Rust jest ścieżką walidacyjną, debugową albo jawnie
   referencyjną CPU. Nie może po cichu stać się produkcyjnym natywnym backendem.
6. Funkcja backendu jest produkcyjna dopiero po przejściu właściwego poziomu
   walidacji: kontraktu źródeł/layoutu, dowodu kompilacji/unit, runtime smoke i
   walidacji fizyki.
7. Wymuszony GPU ma jasno failować, gdy brakuje wymagań GPU. Cichy fallback na
   CPU jest dozwolony tylko w jawnych trybach auto/niewymuszonych i musi być
   zapisany w proweniencji.
8. Publiczna semantyka żyje ponad natywnym rdzeniem. Natywne backendy wykonują
   semantykę, ale widoczne dla użytkownika wielkości, jednostki,
   requested/resolved strategy i status walidacji muszą być reprezentowane w
   IR, proweniencji runnera, zasobach API i powierzchniach UI.
9. Duże pliki dzielimy tylko po stabilnych granicach własności. Unikamy
   szerokich migracji drzewa źródeł, które zmieniają nazwy odpowiedzialności
   przed udowodnieniem zachowania runtime.
10. Słowo `legacy` nie może być używane wobec `backends/fem`, `backends/fdm`
    ani wobec poprzedniej ścieżki `native/backends/*` w kontekście
    architektury solverów. Historyczne aliasy można nazywać przejściowymi, ale
    natywne drzewa backendów są aktualnym kodem produkcyjnym.

## 5. Mapa Własności Backendu

Docelowy kierunek zależności:

```text
Python DSL / examples
  -> ProblemIR i planowanie
  -> orkiestracja Rust runnera
  -> kompilowana implementacja backends/*
  -> artefakty, telemetria, proweniencja
  -> zasoby API
  -> klienty i widoki control room
```

| Warstwa | Główne Ścieżki | Odpowiedzialność |
|---|---|---|
| Publiczne authoring API | `packages/fullmag-py/src/fullmag/*`, `examples/*` | opis problemu, studies, mesh hints, solver hints |
| IR i planowanie | `crates/fullmag-ir/*`, `crates/fullmag-plan/*` | typowana semantyka backend-neutral i planowanie capability |
| Orkiestracja runnera | `crates/fullmag-runner/src/*` | materializacja decyzji kanonicznego plannera, natywne wywołania, artefakty, preview, proweniencja, wykrywanie managed runtime |
| Numeryka referencyjna Rust | `crates/fullmag-engine/src/*`, wybrane moduły referencyjne runnera | wyłącznie walidacja albo jawne wykonanie referencyjne |
| Natywny kompilowany rdzeń | `backends/fdm/*`, `backends/fem/*` | produkcyjne kernele, solvery, integracja, natywny stan, runtime CPU/GPU |
| Poprzednia ścieżka backendów | `native/backends/fdm/*`, `native/backends/fem/*` | historyczna ścieżka sprzed kontrolowanego rename/move, nie osobny backend |
| Sys crates | `crates/fullmag-fdm-sys/*`, `crates/fullmag-fem-sys/*` | bindy C ABI do natywnych backendów |
| Pakowanie runtime | `docker/*`, `scripts/export_fem_gpu_runtime.sh`, `.fullmag/runtimes/*`, `just ensure-managed-fem-runtime` | reprodukowalne paczki natywnego runtime |
| API/sesja | `crates/fullmag-api/*`, generowane OpenAPI, ręczne klienty | kontrakty zasobów, stan sesji, dostęp do artefaktów |
| Control room | `apps/control-room/*` | konsumpcja zasobów, wizualizacja, smoke validation |

## 6. Kanoniczne Drzewo Natywnych Backendów

To jest kręgosłup implementacji, który trzeba zachować i dopracowywać.

```text
backends/
  fdm/
    api/
    include/
    gpu/
    tests/

  fem/
    include/
    src/
    core/
    cpu/
    gpu/
    tests/
    examples/
```

Reguły dla tego drzewa:

- Nowa produkcyjna fizyka FEM trafia do `backends/fem`.
- Nowa produkcyjna fizyka CUDA/natywnego FDM trafia do `backends/fdm`.
- Wspólne natywne pojęcia FEM, takie jak deskryptory mesha, deskryptory
  materiałów, field buffers, własność stanu i natywne kontrakty backend-neutral,
  żyją w `backends/fem/core` albo `backends/fem/include`.
- Realizacja FEM CPU MFEM żyje pod `backends/fem/cpu/mfem`.
- Realizacja FEM GPU CUDA/libCEED/hypre-device żyje pod
  `backends/fem/gpu/cuda`.
- Testy natywne żyją przy kompilowanym backendzie, który chronią.
- Jeśli plik źródłowy jest za duży, dzielimy go wewnątrz tego samego natywnego
  właściciela backendu, zanim przeniesiemy odpowiedzialność do innego języka
  albo warstwy.

## 7. Architektura FEM

FEM oznacza integrację MFEM/hypre/libCEED z lane'ami wykonania CPU i GPU.

Produkcyjny stos FEM:

```text
Fullmag public problem
  -> semantyka IR/planner
  -> orkiestracja FEM runnera i natywne deskryptory ABI
  -> backends/fem
     -> ścieżka CPU MFEM/hypre
     -> ścieżka GPU MFEM/hypre/libCEED/CUDA
  -> artifacts/provenance/API/UI
```

Runner może zawierać:

- materializację pojedynczej decyzji kanonicznego plannera i mapowanie
  kompatybilności ABI, ale nie ponowny wybór algorytmu numerycznego,
- rekordy requested/resolved mode,
- sprawdzanie dostępności natywnego runtime,
- budowanie deskryptorów ABI,
- nazewnictwo ścieżek i artefaktów,
- mapowanie progress/status,
- routing preview i resource,
- fixtures testowe dowodzące, że orkiestracja nie omija natywnych właścicieli.

Runner nie może zawierać:

- produkcyjnej assembly MFEM,
- produkcyjnych weak forms FEM,
- produkcyjnej implementacji demag Poisson/BEM/FMM,
- produkcyjnych integratorów czasu FEM,
- produkcyjnych kerneli libCEED albo hypre-device,
- zdublowanych GPU-resident state machines.

`crates/fullmag-runner/src/native_fem.rs` i powiązane moduły runnera są
fasadami ABI i orkiestracji. Można je dzielić dla utrzymania kodu, ale ich nazwy
i dokumentacja muszą nadal mówić, że implementacja natywnego FEM żyje w
`backends/fem`.

## 7.1 Architektura FEM Frequency-Domain I Eigenmodes

Produkcyjne FEM frequency-domain obejmuje dwa różne produkty:
`modal_eigen` i `driven_response`. Współdzielą kontrakt operatora z
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`, ale nie
mogą wzajemnie promować swojej dostępności ani walidacji. W szczególności
działający driven GPU nie jest dowodem modal GPU.

Produkcyjne eigenmodes dla dużych obiektów nie mogą opierać się na pełnej dense
diagonalizacji. Dense Cartesian i tangent solvery są małymi oracle CPU/double,
nie produkcyjnym odpowiednikiem solvera wybranego widma. Docelowy publiczny
kontrakt pozostaje zapytaniem:

```text
frequency_min_hz <= f <= frequency_max_hz
count = maksymalna liczba modów do zwrócenia
```

Kontrakt przechodzi przez Python DSL, ProblemIR, planner, runtime, artefakty,
API i control room bez degradacji do `lowest`. Produkcyjna realizacja CPU używa
MFEM z PETSc/SLEPc: pełny descriptor albo certyfikowany Schur `MatShell`,
Krylov-Schur/Arnoldi oraz jawny transform spektralny z celem odpowiadającym
`sigma=i*omega_target`. Shifted systems należą do PETSc/hypre. Produkcyjna
realizacja GPU używa tych samych kontraktów przez PETSc CUDA vectors,
device-capable `MatShell`/`MatNest`, hypre device i SLEPc na urządzeniu.

Runner przekazuje deskryptor okna i pojedynczy wybrany engine, odbiera wyniki,
mapuje progress oraz publikuje artefakty i proweniencję. Nie może wybierać
innego solvera, implementować assembly MFEM ani posiadać PETSc/SLEPc/hypre
state. Control room pokazuje requested/resolved engine, DOF, zakres, count,
scalar representation, spectral transform, shifted-solve telemetry, pełny
residual, residency, converged-mode count i stop reason.

## 7.2 Architektura FEM Frequency-Domain Solver Tree

### 7.2.1 Docelowe silniki i ABI kompatybilności

Każdy zaakceptowany solve kończy planowanie dokładnie jednym engine:

```text
dense_cartesian_reference
dense_tangent_reference
cpu_sparse_direct
cpu_host_krylov
full_coupled_field_split
schur_reduced
modal_reduced
gpu_operator_host_krylov
gpu_device_krylov
gpu_modal_device_krylov
```

`validation`, `production_cpu` i `production_gpu` są obecnymi legacy ABI
lanes, nie nazwami algorytmu. Adapter kompatybilności ogranicza kandydatów
zgodnie z lane'em, po czym canonical planner publikuje jeden engine i
`selection_reason`. `production_gpu` nie dowodzi device residency. Obecny
driven GPU odpowiada `gpu_operator_host_krylov`, dopóki pełny kontrakt nie
udowodni `gpu_device_krylov`. Wąski dense K0 GPU modal validation nie jest
ogólnym `gpu_modal_device_krylov`.

### 7.2.2 Deterministyczny planner legality-before-heuristics

`FrequencySolvePlanner` wykonuje kolejno:

1. walidację fizyki, fazy, equilibrium, BC/gauge i certyfikatów mesha;
2. rozwiązanie jawnie requested device, precision i solver method;
3. odrzucenie niedostępnych strict requests albo zapis legalnego, jawnego
   non-strict fallbacku;
4. zbudowanie kandydatów legalnych dla dokładnego produktu i algebry;
5. filtrowanie przez certyfikaty keyed by problem signature i limit pamięci;
6. heurystyki wydajności wyłącznie wśród legalnych kandydatów;
7. emisję dokładnie jednego engine i jednego powodu wyboru.

Strict device, precision i method są twardymi ograniczeniami. Strict GPU nie
spada na CPU, strict `single` nie staje się `double`, a wymuszony engine nie
staje się `auto`. Non-strict fallback jest legalny tylko dla identycznego
kontraktu fizycznego i musi publikować requested/resolved wartości,
`fallback_used=true` oraz `fallback_reason` przed solve'em.

Niezmienne:

```text
prefer_existing_host_krylov nie zmienia CPU na GPU;
forced GPU nie może zostać wyprzedzony przez CPU sparse-direct;
nonzero-k demag nie wybiera operatora K0;
Schur wymaga certyfikatu keyed by exact problem signature;
modal-reduced wymaga completeness i niezależnych full/direct sample checks;
accepted plan zawiera dokładnie jeden engine i selection reason.
```

### 7.2.3 Kontrakty CPU i GPU

CPU production engines żyją pod `backends/fem/cpu/frequency_domain/`:

- `cpu_sparse_direct`: PETSc AIJ, `KSPPREONLY/PCLU`, pełny true residual;
- `cpu_host_krylov`: host GMRES/FGMRES dla legalnego assembled/matrix-free
  operatora;
- `full_coupled_field_split`: PETSc `MatNest`/`PCFIELDSPLIT` z hypre Poisson;
- `schur_reduced`: PETSc/SLEPc `MatShell` dopiero po certyfikacji i z
  rekonstrukcją pełnego residualu;
- `modal_reduced`: modal/rational/recycling sweep z completeness i sample
  checks;
- wybrane widmo modal: pełny descriptor albo certyfikowany Schur przez SLEPc.

GPU production engines żyją pod
`backends/fem/gpu/cuda/frequency_domain/` i są library-first:

```text
MFEM/libCEED/CUDA operator apply
PETSc CUDA vectors and MatShell/MatNest
hypre device Poisson/shifted preconditioner
PETSc KSP GMRES/FGMRES for driven response
SLEPc Krylov-Schur/Arnoldi for modal spectrum
```

Host orchestration i ograniczone scalar reductions są dozwolone. Claim
device-resident zabrania per-iteration migracji wektorów lub macierzy H2D/D2H
oraz hostowego dot/norm/axpy, Arnoldi/Hessenberg i preconditioner state. Custom
Krylov może powstać dopiero po zapisanym benchmarku/profilerze pokazującym, że
stos PETSc/SLEPc/hypre/libCEED nie spełnia kontraktu.

`gpu_operator_host_krylov` pozostaje uczciwą osobną nazwą: operator może być
CUDA, ale vectors, Krylov state, orthogonalization, residual control i redukcje
są hostowe. Nie wolno raportować go jako `gpu_device_krylov`.

### 7.2.4 Własność źródeł

Docelowy layout:

```text
backends/fem/include/frequency_domain/
  algebra/
  planner/
  diagnostics/
  certificates/

backends/fem/src/frequency_domain/
  backend-neutral contracts and shared support only

backends/fem/cpu/frequency_domain/
  engines/
  operators/
  preconditioners/
  modal/
  validation/

backends/fem/gpu/cuda/frequency_domain/
  engines/
  operators/
  preconditioners/
  residency/
  modal/
```

Runner jest tylko właścicielem orchestration, ABI, cancellation/progress,
artefaktów i proweniencji. Nie posiada production MFEM assembly, PETSc/SLEPc
setup, CPU solver loops ani GPU Krylov state i nie wykonuje drugiego wyboru po
plannerze.

Stan obecny nie spełnia jeszcze tego targetu. Header planner ma siedem
zgrubnych lane'ów, nie jest jedyną trasą runtime i obecnie może rozważyć CPU
sparse-direct przed GPU intent oraz traktować `prefer_existing_host_krylov`
jako sygnał `requested_gpu`. ABI nadal publikuje trzy legacy lanes. Duży
`backends/fem/src/frequency_domain/driven_response_solver.cpp` nadal miesza
routing i numerykę, a runner nadal wykonuje część method rejection/resolution.
`gpu_device_krylov.hpp` ma kontrakty i probe'y, lecz jawnie raportuje
`production_loop_available=false`. Te fakty są contract gaps, nie dowodem
docelowej architektury. Ich naprawa jest późniejszym behavior-preserving
refaktorem i implementacją, nie częścią tego dokumentacyjnego patcha.

## 7.3 Workflow pola anteny mikrofalowej

Kanoniczny kontrakt fizyczny dla anten microstrip/CPW z profilem zmiennym
wzdłuż przepływu prądu definiuje
`docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`.

Pierwszy produkcyjny `AntennaFieldSolve` jest workflow natywnego FEM CPU:

```text
backends/fem/cpu/mfem/workflows/antenna_field_solve
  -> siatka przewodników i markery terminali
  -> H1: div(sigma grad V) = 0
  -> normalizowane J per 1 A
  -> adaptacyjny trójwymiarowy Biot-Savart
  -> antenna_field_solution.v1
  -> projekcje na targety FDM/FEM
```

Reguły własności:

1. Numeryka przewodnictwa, normalizacji prądu, kwadratury Biota-Savarta i
   projekcji targetu żyje w `backends/fem`, nie w Rust runnerze.
2. `crates/fullmag-runner` orkiestruje ABI, cache, artefakty, progress i
   proweniencję. Obecne przybliżenie w `antenna_fields.rs` jest ścieżką
   kompatybilności `legacy_infinite_strip_biot_savart`, a nie fundamentem
   nowego solvera.
3. Field solve i późniejszy LLG mają osobne requested/resolved execution.
   Precompute FEM CPU dla LLG FDM jest jawnym transferem stanu między
   dyskretyzacjami, nigdy ukrytym hybrydowym wywołaniem.
4. FDM CPU reference jest oracle konsumpcji gotowej mapy, nie właścicielem
   produkcyjnego solve'u geometrii przewodnika.
5. Produkcyjna konsumpcja CUDA FDM żyje pod
   `backends/fdm/gpu/cuda/interactions/antenna_drive`.
6. Konsumpcja FEM CPU/GPU żyje w osobnych właścicielach
   `backends/fem/cpu/mfem/interactions/antenna_drive` i
   `backends/fem/gpu/cuda/interactions/antenna_drive`.
7. Mapa pola per 1 A pozostaje rezydentna podczas LLG; host readback jest
   dozwolony tylko w kadencji output/diagnostics.
8. Harmonic MQS i full-wave Maxwell są osobnymi przyszłymi rodzinami solverów.
   Nie wolno promować Tier 1 na podstawie dostępności częstotliwościowego
   solvera LLG ani odwrotnie.

Minimalna drabina walidacji obejmuje analityczny przewód, bilans terminali CPW,
trzy poziomy zbieżności siatki i kwadratury, położenie peaków widma k,
FDM/FEM transfer oraz parity CPU/GPU w double. Build i runtime proof natywnego
FEM używa container-backed `just`; docelowe skupione recipes to
`verify-fem-antenna-field-runtime` i `verify-fem-antenna-drive-runtime`.

## 7.4 Własność Workflow Relaksacji

Kanoniczny kontrakt równowagi jest zdefiniowany w
`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`. Wszystkie
lane'y publikują dokładny residual zaakceptowanego stanu
`max_torque_Apm = max |m x H_eff|` w `A/m`; `max_torque_T` jest równoważną
reprezentacją w `T`, a `max_rhs_norm_per_s` osobną wielkością dynamiczną w
`1/s`. Runner nie rekonstruuje torque z RHS i nie wnioskuje zakończenia z
próbkowanych artefaktów.

Własność algorytmów pozostaje rozdzielona:

- `llg_overdamped` używa właściwego dla lane'u LLG/RK i jako jedyny posiada
  `dynamics`, `dt` oraz lokalny zegar relaksacji w sekundach;
- PG-BB i NCG FDM mają osobne realizacje CPU/reference i CUDA, ale wspólny
  fizyczny metric `mu0 Ms V`; ich krok line search ma jednostkę `m/A` i nie
  jest czasem;
- PG-BB i NCG FEM są własnością `backends/fem/cpu/mfem/relaxation` oraz
  `backends/fem/gpu/cuda/relaxation`; runner ogranicza się do ABI,
  requested/resolved provenance, telemetrii i artefaktów;
- TPI jest wyłącznie rozwojową realizacją CPU/MFEM. Tryb `strict` i wymuszony
  GPU odrzucają request; `extended` może rozwiązać go do CPU/MFEM z jawną
  diagnostyką. Nie istnieje ukryty fallback GPU->CPU.

Domyślne publiczne parametry to `1e-4 A/m` oraz `50000` kroków. Osiągnięcie
budżetu kroków/czasu kończy stage bez zbieżności; stagnacja numeryczna kończy
go jako failed/non-converged. Status, reason, metric kind/value/unit i próg są
własnością wykonania i muszą przejść bez reinterpretacji przez IR, API i UI.

## 8. Architektura FDM

FDM ma dwie różne role, które muszą pozostać jawne:

- natywny kompilowany backend FDM pod `backends/fdm`,
- wsparcie Rust CPU/reference używane do walidacji, uruchomień bez GPU i
  parity checks.

Natywny backend FDM jest produkcyjną ścieżką kompilowaną. Kod Rust CPU reference
nie może być przedstawiany jako zamiennik natywnego FDM. Jeśli funkcja jest
potrzebna w obu miejscach, najpierw definiujemy wspólny kontrakt, a potem
realizujemy go osobno w backendzie natywnym i lane referencyjnym.

Dopracowania natywnego FDM CUDA są dozwolone, ale powinny być wąskie:

- dzielić przerośnięte pliki CUDA runtime po granicach własności runtime,
- utrzymywać kompatybilność ABI widoczną przez testy natywne,
- utrzymywać stabilne artefakty i preview,
- unikać równoległych implementacji hot-loop behavior CUDA w Rust.

## 9. Strategia Demagnetyzacji

`Demag()` pozostaje publicznym terminem fizycznym. Strategia specyficzna dla
backendu jest realizacją requested/resolved pod tym terminem.

FEM demag musi rozróżniać:

| Oś | Przykłady |
|---|---|
| Model fizyczny | Poisson airbox, FEM/BEM Fredkin-Koehler, BEM, FMM, mapped exterior shell |
| Topologia mesha | shared magnetic+air domain, body-only magnetic mesh, periodic shared-domain unit cell |
| Wariant brzegowy | Dirichlet airbox, Robin airbox, periodic reduced Poisson, open-boundary BEM |
| Realizacja runtime | MFEM/hypre CPU, MFEM/hypre GPU, libCEED/CUDA operators, dense reference BEM, compressed BEM/H2/FMM, explicit debug fallback |

Własność implementacji:

- słownik modeli i proweniencja requested/resolved mogą żyć w Rust runnerze albo
  na poziomie IR planning,
- produkcyjna realizacja FEM demag żyje w `backends/fem`,
- właściciele CPU MFEM demag żyją pod
  `backends/fem/cpu/mfem/interactions`,
- właściciele GPU demag żyją pod `backends/fem/gpu/cuda/demag_poisson`
  albo pod przyszłym jawnym natywnym właścicielem GPU BEM/FMM,
- ścisłe requesty GPU nie mogą po cichu spadać do CPU Poisson.

## 10. Polityka Refaktoru Runnera

Runner nadal wymaga sprzątania, zwłaszcza wokół `dispatch.rs`, ale split musi
być backends-first.

Dopuszczalne miejsca docelowe w runnerze:

```text
crates/fullmag-runner/src/
  solver_runtime/        wybór silnika, availability, fallback, proweniencja
  fdm/                   istniejąca fasada orkiestracji FDM, można zawężać
  fem/                   istniejąca fasada orkiestracji FEM, można zawężać
  native_fem/            opcjonalny split fasady ABI/orkiestracji natywnego FEM
  interactive_runtime/   orkiestracja sesji/live, nie kernele solvera
```

Reguły:

- Nie wprowadzamy `solvers/fem/workflows/*` jako produkcyjnych właścicieli
  workflow FEM.
- Jeśli przyszłe nazewnictwo `solvers/*` wróci, musi być udokumentowane jako
  wyłącznie orkiestracja runnera, nigdy jako kompilowana implementacja solvera.
- Preferujemy małe, odwracalne ekstrakcje runnera, które zachowują zachowanie i
  wołają istniejące natywne API.
- Każda ekstrakcja runnera potrzebuje skupionego testu, który dowodzi własności
  bez kodowania błędnej architektury.

## 11. Drabina Walidacji

Każde twierdzenie o backendzie musi podać poziom walidacji.

| Poziom | Znaczenie | Dowód |
|---|---|---|
| Source/layout contract | własność i granice zależności są chronione | testy source-layout natywne albo Rust |
| Compile/unit proof | kod buduje się i skupione testy zachowania przechodzą | `cargo test`, CMake build, `ctest` |
| Runtime smoke | faktyczny natywny runtime ładuje i wykonuje zamierzony lane | managed FEM runtime smoke, CUDA FDM smoke |
| Physics validation | wynik numeryczny jest sprawdzony względem celu analitycznego, referencyjnego albo zewnętrznego solvera | DMI fixtures, demag convergence, energy/field parity, porównania COMSOL/mumax/BORIS/TetraX gdzie właściwe |
| Product/API proof | wynik backendu dochodzi poprawnie do zasobów widocznych dla użytkownika | testy API resource, generowane OpenAPI/client checks, control-room smoke |

Nie używamy niższego poziomu walidacji do twierdzenia, że wyższy poziom jest
zamknięty.

## 12. Natychmiastowy Plan Pracy

### Faza 0: Ustabilizować Drzewo Po Relokacji

- Traktować wcześniejsze zmiany z błędnego kierunku jako materiał do
  selektywnego odzysku, nie jako zaakceptowaną migrację.
- Zostawić split testów `source_facade` natywnego FEM tylko wtedy, gdy kompiluje
  się i nadal pokrywa te same reguły własności źródeł.
- Nie przywracać zmian Rust runnera `solvers/fem/*`, dopóki ten masterplan nie
  ma zgodnych testów własności.
- Usunąć albo przepisać dokumenty, które nazywają `backends/fem`,
  `backends/fdm` albo poprzednią ścieżkę `native/backends/*` legacy.
- Utrzymać patch relokacyjny jako rename/move bez zmian fizyki:
  `native/backends/fdm -> backends/fdm` i
  `native/backends/fem -> backends/fem`.
- Zaktualizować CMake, sys crates, Docker/runtime scripts, dokumentację i testy
  source-layout dla aktualnych ścieżek.
- Uruchomić compile/unit proof dla natywnych testów oraz minimalny runtime smoke
  tam, gdzie relokacja dotyka ścieżek runtime.
- Dopiero po przejściu tych bramek wygasić stare aliasy `native/backends/*`.

### Faza 1: Audyt Rzeczywistości Backendów Po Relokacji

- Artefakt audytu: `docs/architecture/backend-post-relocation-audit-2026-06-03.md`.
- Zinwentaryzować `backends/fem` po subsystemach: `core`, `cpu/mfem`,
  `gpu/cuda`, `src`, `include`, `tests`.
- Zinwentaryzować `backends/fdm` po subsystemach: API, include, CUDA
  runtime, interactions, demag, tests.
- Oznaczyć, które natywne pliki są duże dlatego, że są prawdziwymi fasadami, a
  które dlatego, że mają zbyt dużo odpowiedzialności.
- Napisać kontrakty chroniące obecną poprawną własność przed przenoszeniem kodu.

### Faza 2: Najpierw Wzmocnić Natywny FEM

- Trzymać prace implementacyjne FEM wewnątrz `backends/fem`.
- Dzielić tylko wewnątrz właścicieli natywnego FEM.
- Zachować semantykę CPU/GPU MFEM/hypre/libCEED.
- Dodawać source-layout i physics contracts przed przenoszeniem kodu operatorów.
- Dowodzić zmian runtime ścieżką managed FEM runtime, nie tylko unit testami.

### Faza 3: Ostrożnie Dopracować Natywny FDM

- Refaktorować natywny CUDA FDM tylko wokół istniejących granic runtime.
- Utrzymać stabilne natywne ABI i sys bindings.
- Używać natywnych testów FDM do dowodu własności źródeł i zachowania ABI.
- Trzymać kod Rust FDM CPU/reference jawnie oznaczony jako reference/baseline.

### Faza 4: Wyczyścić Rust Runner Wokół Natywnego ABI

- Zmniejszać `dispatch.rs` przez ekstrakcję orkiestracji, nie implementacji
  solvera.
- Dzielić `native_fem.rs` tylko na ABI, availability, plan lowering i runtime
  call helpers.
- Zachować stabilne publiczne zachowanie runnera.
- Dodać testy sprawdzające, że ścieżki runnera wołają natywnych właścicieli
  zamiast duplikować natywną fizykę.

### Faza 5: Podłączyć Powierzchnie Produktowe

- Upewnić się, że requested/resolved backend strategy dochodzi do artefaktów,
  zasobów sesji, generowanego OpenAPI, ręcznych klientów i widoków control room.
- Trzymać browser smoke i testy API związane z realną semantyką gotowości
  backendu.
- Nie ukrywać przed użytkownikiem natywnego fallbacku ani decyzji o
  niedostępnym runtime.

## 13. Reguły Selektywnego Odzysku

Przy odzyskiwaniu zmian z wcześniejszego błędnego kierunku:

1. Oglądać jedną rodzinę ścieżek naraz.
2. Przywracać tylko zmiany, które czynią architekturę backends-first bardziej
   prawdziwą.
3. Odrzucać zmiany, które przenoszą produkcyjną własność FEM do ścieżek Rust
   runnera.
4. Preferować zmiany testowe/wspierające natywne backendy przed przenoszeniem
   implementacji.
5. Po każdej odzyskanej rodzinie uruchomić najmniejszy właściwy test.
6. Dodać krótką notatkę w tym dokumencie albo ADR, gdy wcześniej odłożona
   zmiana zostaje świadomie przywrócona.

## 14. Kryteria Zamknięcia Tego Masterplanu

Kierunek backendu jest z powrotem poprawny, gdy:

- zaakceptowane dokumenty mówią, że `backends/*` jest kompilowanym rdzeniem
  backendu po pierwszej relokacji bez przepisywania,
- `backends/fem` jest konsekwentnie opisany jako kanoniczna implementacja
  MFEM/hypre/libCEED,
- dokumenty Rust runnera opisują wyłącznie orkiestrację i wywołania ABI,
- żadna zaakceptowana ścieżka docelowa nie sugeruje równoległej implementacji FEM
  poza `backends/fem`,
- żaden zaakceptowany plan nie przenosi kompilowanego kodu FEM/FDM do `crates`,
- testy source-layout chronią natywną własność bez wymuszania błędnych ścieżek
  Rust,
- walidacja runtime pozostaje oddzielona od lokalnej walidacji kontraktów.
