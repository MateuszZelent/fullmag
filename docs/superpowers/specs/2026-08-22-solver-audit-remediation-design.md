# Projekt naprawy audytu solverów FDM/FEM CPU/GPU

## Cel i granice

Celem jest usunięcie kolejno wszystkich problemów wskazanych w pakiecie
`docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1` oraz dostarczenie
bezpośrednich dowodów dla każdego findingu. Pakiet audytowy zawiera plany, nie
wyniki uruchomień. Aktualny stan źródła został więc sklasyfikowany niezależnie:
26 findingów jest potwierdzonych, 23 częściowo potwierdzone, 3 niezweryfikowane
i żaden nie został uznany za błędny.

Zakres obejmuje cztery osobne realizacje:

- FDM CPU — referencyjny lane `double`, layout AoS, SoA i persistent SoA;
- FDM GPU — CUDA z jawnym ABI, rezydencją urządzeniową i osobną kwalifikacją
  precyzji;
- FEM CPU — natywne MFEM/Hypre, jawne ownership/revision i bezpieczny rollback;
- FEM GPU — strict device lane oraz jawnie odrębny tryb hybrydowy.

Wspólny kontrakt fizyczny pozostaje ponad realizacjami. Nie przenosimy fizyki do
`dispatch.rs`, ogólnego `Context` ani do `mfem_bridge.cpp`; nie łączymy CPU i GPU
w jeden hot loop. Nie promujemy capability na podstawie testu źródłowego,
kompilacji lub planu bez świeżego, source-bound managed receipt.

## Stan wyjściowy i główne przyczyny

Największe blokady są przyczynowe, a nie kosmetyczne:

1. Adaptacja FDM CPU odrzuca próbę, ale nie przekazuje nowego `dt` do rzeczywistej
   pętli RK23/RK45. Dla `NaN`/`Inf` i przy `dt_min` może to oznaczać nieskończony
   retry lub niejawne zakończenie.
2. Deskryptor FDM CUDA ma szerszy nagłówek niż inicjalizacja Rust FFI; pola
   przestrzenne są pomijane, a wersja/rozmiar ABI nie są walidowane.
3. FSAL nie ma wspólnego źródła rewizji. Termika i źródła zależne od czasu mogą
   unieważnić `k_last`, lecz integrator nadal go używa.
4. Transakcje prób nie rozdzielają jasno stanu zaakceptowanego, stanu próby,
   RNG i publikacji obserwacji. FEM dodatkowo wykonuje pełne kopie dużych stanów
   przy każdej próbie.
5. Normy błędu i projekcje nie mają jawnej polityki. W FEM norma jest nodewise
   max bez masy, a w FDM etapy są normalizowane przed kolejnymi RHS bez
   identyfikacji tej realizacji tableau.
6. Graniczne operatory (DMI, termika, materiały, Airbox/PBC) mają lokalne wyjątki
   zamiast jednego kontraktu członkostwa i własności pola.
7. Istnieją częściowe optymalizacje, ale brak dowodu ich kosztu: pełne
   reductions/readback, snapshoty O(N), endpoint RHS, zerowany PBC warm-start,
   legacy sparse GPU i brak masek obserwacji.

## Zasady architektoniczne

### 1. Jeden kontrakt accepted-step

Każdy lane ma jawny cykl:

```text
accepted state + revision
  -> begin attempt (bez publikacji)
  -> obliczenia RHS/fields/observables
  -> accept: commit state, sources, RNG, histories, provenance
     albo reject/error/cancel: rollback wszystko, bez inkrementacji RNG
```

Stan próby nie może być widoczny przez field store ani finalne artefakty. Po
`Err`, `reject` i `cancel` digest zaakceptowanego stanu, rewizja źródeł i licznik
RNG muszą pozostać identyczne. Jedna zaakceptowana próba może zużyć dokładnie
jedną jednostkę strumienia termicznego.

### 2. Rewizje operatorów i źródeł

Wspólny opis próby niesie niemutowalne rewizje:

- `state_revision` — zaakceptowana magnetyzacja i maska;
- `material_revision` — `Ms`, `alpha`, `A`, DMI i regiony;
- `source_revision` — termika, STT/SOT, Oersted i zewnętrzne źródła;
- `time_revision` — czas oraz identyfikator segmentu źródła;
- `operator_revision` — mesh/geometry/PBC i backend operatorów.

FSAL, ABM history, demag/preconditioner cache i workspace mogą być użyte tylko,
gdy wszystkie wymagane rewizje są zgodne. Zmiana rewizji unieważnia cache przed
RHS, a nie po jego użyciu.

### 3. Fail-closed i provenance

Forced GPU nigdy nie przechodzi na CPU. Tryb `auto` może wybrać fallback tylko,
gdy zapisze `requested`, `resolved`, `executed`, `resolution_mode` i
`fallback_reason`. FEM GPU strict odrzuca każdy operator z hostowym hot loopem;
hybrid jest osobnym, jawnie wybranym trybem kompatybilności.

Każdy receipt kwalifikacyjny zawiera commit, tree/diff hash, komendę, obraz
runtime, urządzenie, precyzję, zakres, tolerancje, identyfikatory operatorów,
liczniki transferów/synchronizacji oraz hash artefaktów. Brak lub niezgodność
receiptu oznacza `unvalidated`, nie produkcję.

### 4. Wspólny kontrakt fizyczny, osobna realizacja

Równania, znaki, jednostki, maski i observables są zdefiniowane w
`docs/physics/` oraz kontraktach backend-neutral. FDM i FEM implementują je osobno
z odpowiednim storage/location. Capability jest kluczem
`interaction × representation × layout × precision × device`, a nie nazwą
solverowego trybu.

## Fale implementacji

### Fala P0 — poprawność sterowania krokiem i ABI

#### FDM CPU (`FDM-CPU-NUM-001`)

Najpierw powstają czerwone testy dla RK23/RK45, AoS/SoA/persistent-SoA:
odrzucenie z wymuszonym błędem, `NaN`, `Inf`, `dt_min`, timeout retry i
niezmieniony accepted state. Następnie decyzja adaptacyjna zostaje podłączona do
jednej kontrolowanej pętli prób, z typowanymi powodami `DtMinExhausted` i
`NonFiniteError`, monotonicznym `dt_next` oraz telemetryką próby.

#### FDM GPU ABI (`FDM-GPU-ABI-001`)

Dodany zostaje wersjonowany `abi_version`/`struct_size` oraz sentinel/layout
contract test wykonywany po stronie C i Rust. Inicjalizacja Rust wypełnia każdy
field opisany w nagłówku, w tym pola przestrzenne materiałów, DMI, zewnętrznych
źródeł i masek. Niezgodny rozmiar lub wersja kończy się błędem przed utworzeniem
backendu. Test źródłowy nie zastępuje kompilacji CUDA ani managed runtime.

#### FDM GPU FSAL (`FDM-GPU-NUM-003`)

FSAL otrzymuje centralny warunek ważności oparty o rewizje stanu, czasu i źródeł.
Po zmianie termiki, dynamicznego źródła, transportu lub odrzuceniu wymagającym
nowej próby `k_last` jest odrzucony. Testy porównują RHS, decyzję i trajektorię z
oracle bez FSAL.

#### FEM GPU rezydencja (`FEM-GPU-ARCH-001`, `PERF-001`, `PERF-009`)

Planner i runtime rozróżniają `strict_device` oraz `hybrid_host_poisson`.
Strict wymaga per-operator receiptu lokalizacji, precyzji, rewizji i liczby
transferów; hostowy solver w strict kończy się typed error. Hybrid pozostaje
dostępny tylko po jawnym wyborze i ma własną kwalifikację parity/break-even.

### Fala 2 — transakcje i rollback

FDM CPU/GPU oraz FEM CPU/GPU dostają fault-injection na każdym miejscu po
`begin_attempt`. Testy sprawdzają digest magnetyzacji, pól, historii, Poissona,
RNG i publikacji. FEM zastępuje pełne kopie prób minimalnym, prealokowanym
checkpointem lub journalem; koszt bajtów i alokacji jest mierzony, nie zakładany.

### Fala 3 — numeryka i fizyka

- FDM: `ProjectionPolicy`/realization ID, order oracle dla Heun/RK4/RK23/RK45,
  reset ABM3 przed predyktorem, naturalny ghost closure DMI, lokalne `Ms/alpha`
  w wariancie termicznym i AoS/SoA parity.
- FEM: mass-weighted RMS z aktywnym denominatorem, normalizowany plateau energii,
  planowanie przez `h_min`/stiffness, PBC reduced warm-start z resetem po błędzie,
  FSAL zależny od rewizji oraz typed material membership.
- GPU: jawna polityka FP64/FP32/mixed; FP32 nie dziedziczy dowodu FP64. Error
  norm, projekcja, stop reason i accepted trajectory muszą mieć CPU oracle.

### Fala 4 — optymalizacja dowodowa

Po czerwonych testach i profilach poprawiane są: `EvaluationRequest`, maski i
stride obserwacji, endpoint RHS, host readback/adaptive PI, persistent FFT/
preconditioner/workspace, matrix-free/partial assembly i ewentualne CUDA Graph.
Każda optymalizacja ma przed/po profil, licznik launch/transfer/sync, pamięć i
time-to-accuracy. Hipoteza bez profilu pozostaje `NOT VERIFIED`.

### Fala 5 — kwalifikacja

Uruchamiana jest manifest-driven macierz przez recepty repo `justfile`: FDM CPU,
FDM CUDA, FEM CPU i FEM strict GPU, z osobnymi precision/device/layout/
interaction/oracle/refinement/restart/retry scopes. Native FEM/CUDA buduje się i
uruchamia wyłącznie przez managed/container recipes. Capability matrix jest
aktualizowana dopiero na podstawie immutable receipts; niewykonane zakresy
pozostają jawnie nieprodukcyjne.

## Plan testów i bramki

Każdy finding ma test czerwony, zmianę minimalną i test regresyjny. Minimalne
bramki źródłowe obejmują kontrakty Rust/Python/C++ i `git diff --check`. Bramki
runtime obejmują między innymi:

- `just verify-fdm-time-domain-native-contract`;
- `just verify-fem-time-domain-native-contract`;
- `just verify-fem-llg-time-domain-qualification`;
- `just verify-fem-llg-time-domain-qualification-gpu`;
- `just verify-fem-gpu-performance-regression`;
- właściwe `ensure-managed-fem-runtime`, build i headless runs;
- Compute Sanitizer/Nsight tylko dla aktualnego, source-bound artefaktu.

Brak zasobów sprzętowych, obrazu lub miejsca nie jest dowodem poprawności ani
błędu solvera. W takim przypadku raportujemy dokładny blocker i pozostawiamy
status `NOT VERIFIED`.

## Kryteria akceptacji

Projekt jest ukończony dopiero wtedy, gdy dla każdego z 52 findingów istnieje
wiersz w końcowym raporcie z:

1. aktualną przyczyną i ścieżką/symbolem źródłowym;
2. testem regresyjnym lub wyjaśnieniem, dlaczego finding jest niezweryfikowany;
3. wynikiem właściwej bramki o zakresie równym findingowi;
4. source-bound receiptem dla roszczeń CPU/GPU/runtime;
5. jawnym statusem `CONFIRMED`, `PARTIALLY CONFIRMED`, `NOT VERIFIED` albo
   `CLOSED`, bez promowania brakującego dowodu.

Nie wolno oznaczyć celu jako ukończonego po samym przejściu testów jednostkowych,
kompilacji, obecności recepty lub planu audytowego.

## Poza zakresem

Nie zmieniamy niezwiązanej zmiany `external_solvers/3`, nie wykonujemy resetu,
clean/stash ani szerokiego reformatowania. Nie dodajemy nowych interakcji,
backendów ani UI. Zmiany w dokumentacji fizycznej ograniczają się do aktualizacji
kontraktu, source-map i statusu dowodów potrzebnych do naprawy.
