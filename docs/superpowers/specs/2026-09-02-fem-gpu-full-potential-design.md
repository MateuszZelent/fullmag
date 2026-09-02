# Projekt pełnego wykorzystania FEM GPU/CUDA

- Data: 2026-09-02
- Status: do akceptacji przed implementacją
- Gałąź: `codex/fem-gpu-full-potential-20260902`
- Rewizja bazowa: `31f4e65e91f22bbe85ff5c6a06f03fc7ab63b755`
- Dokument wejściowy: `docs/audits/2026-09-02-fem-gpu-solver-audit.md`
- Lane: FEM GPU, z FEM CPU/double jako referencją semantyczną i numeryczną

## 1. Cel i kryterium ukończenia

Celem jest wdrożenie wszystkich pozycji faz 0–6 audytu, lecz promocja każdej
optymalizacji następuje osobno. Zmiana trafia do domyślnej ścieżki wyłącznie,
gdy przechodzi test poprawności, zachowuje jawne requested/resolved execution,
nie wprowadza cichego fallbacku GPU→CPU oraz poprawia właściwy pomiar p50/p95
albo usuwa potwierdzony koszt synchronizacji lub transferu bez regresji czasu.

„Pełny potencjał GPU” nie oznacza jednego bezwarunkowego kernela. Oznacza
zestaw kwalifikowanych realizacji wybieranych na podstawie histogramu operatora,
rozmiaru problemu i jawnej polityki wykonania. Wariant przegrywający A/B zostaje
usunięty albo pozostaje wyłącznie narzędziem diagnostycznym, nie dodatkową
abstrakcją produkcyjną.

Ukończenie całego programu wymaga:

1. czystej tożsamości źródła i wersjonowanych receiptów;
2. parity z FEM CPU/double i testów fizycznych właściwych dla operatora;
3. managed build/runtime przez repozytoryjne receptury `just`;
4. benchmarku pięciu powtórzeń z p50/p95 i identycznym ProblemIR/meshem;
5. profilu Nsight Systems/Compute dla zaakceptowanej rewizji;
6. braku niejawnych transferów, synchronizacji i fallbacków w strict GPU;
7. osobnej kwalifikacji wszystkich jawnie wspieranych integratorów RK;
8. niepogorszonej zbieżności oraz końcowych pól, energii i obserwabli.

## 2. Zakres oraz granice własności

Backend-neutralne równania, znaki, jednostki, obserwable i kryteria zbieżności
pozostają wspólne. Realizacje CPU i GPU są oddzielne. Produkcyjne operatory,
solvery, cache i stan urządzenia pozostają w `backends/fem`; runner odpowiada
wyłącznie za ABI, orkiestrację, artefakty i proweniencję.

Zmiany są dzielone według właścicieli:

- demag Poisson i sparse recovery;
- strategia demag FEM/BEM;
- Exchange;
- DMI;
- składanie `H_eff`;
- integratory czasu i transakcja attempted-step;
- relaksacja oraz jej preconditioner;
- frequency domain;
- runtime, residency, profiler, receipt i benchmark.

Nie dodajemy nowych przekrojowych pól do `Context` ani nowej fizyki do
`mfem_bridge.cpp`. Publiczna semantyka nie zmienia się bez osobnego przejścia
przez physics note, ProblemIR, capability matrix, API i round-trip UI.

## 3. Zamrożony baseline roboczego FEM/BEM

Wybrany wariant 2 obejmuje kopię nieśledzonej pracy FEM/BEM ze wspólnego
checkoutu. Poniższe SHA-256 wiążą dokładny materiał wejściowy; nie są dowodem
kompilacji ani działania runtime.

| Plik | SHA-256 |
|---|---|
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp` | `8FC1CA7ED78E59928FE322CF971CF8EA3C43B2B25F85B4575DF1E0957CA20969` |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu` | `94FF6A12D90FBDB6FE7C0E6E37472760D47535A06A888A263108C87259F23550` |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp` | `D9DF53F8CB4FB2B7C20F1933DBE603944F2BC7A17DB5DBE1B0B0E91892422AA7` |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `8980051C8A333B9D2ABD6F2E5B1E79DA27280CD8040DD4759F7C2ED96209FBF2` |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp` | `B3220BD0DB8D44512BB8FAB0CB63110575BD64D9AD1F71FF49E415AC8A52B87D` |
| `backends/fem/tests/demag_fem_bem_gpu_contract.cpp` | `FE4A06A0A49EC528E7940E2F09B4DB0C40843299E9419574BFEF9B3F23D4D9BB` |

Audyt wejściowy ma SHA-256
`64A3AC03AA5E04485D83E0B7348B74BE25F396617CC066EF91CB76469628B85B`,
a wcześniejszy projekt operatora FEM/BEM
`6C978A7805D806DF80F0801B9C3C685E2A56FF3541987158B21E2F4D86B5D674`.

Śledzone, brudne pliki ze wspólnego checkoutu nie są kopiowane automatycznie.
Każdy wymagany fragment zostanie odzyskany dopiero po sprawdzeniu diffu i
przypisaniu do konkretnego testu lub kontraktu tej gałęzi.

## 4. Architektura wykonania

### 4.1 Trwały stan GPU

Każdy operator posiada setup wykonywany przy zmianie mesha, materiału albo
polityki oraz lekki apply wykonywany w hot loopie. Setup tworzy deskryptory
cuSPARSE/HYPRE/libCEED, bufory robocze, precomputed geometry, mapy redukcji i
wersję stanu. Apply nie alokuje, nie odbudowuje sparsity i nie wykonuje
hostowego odczytu skalaru, jeśli wynik nie jest potrzebny do decyzji na CPU.

Stan integratora i stan obserwacji są rozdzielone. Próba kroku zapisuje wyniki
do bufora kandydata; accept atomowo publikuje czas, magnetyzację, cache,
kontroler i telemetrykę, a reject pozostawia ostatni zaakceptowany stan bez
częściowej publikacji.

### 4.2 Strumienie i zależności

Fullmag posiada jawny strumień obliczeniowy. Adapter HYPRE ma pobierać faktyczny
strumień biblioteki, ustanawiać zależność wejściową i wyjściową eventami oraz
nie zakładać, że default stream synchronizuje `cudaStreamNonBlocking`.
Hostowy fence jest dozwolony tylko dla jawnej decyzji hostowej, eksportu lub
diagnostyki i musi zwiększać licznik receiptu.

### 4.3 Wybór kernela sparse

Setup klasyfikuje rozkład długości wierszy i porównuje kandydatów:
scalar-row, subwarp, warp, cuSPARSE SpMV oraz trzykolumnowy SpMM XYZ. Wybór jest
wersjonowany i zapisany w proweniencji. Nie zakładamy, że warp-per-row wygrywa
dla krótkich wierszy FEM. Exchange otrzymuje oddzielny wariant akumulacji FP64
oraz wariant o kontrolowanym błędzie; mixed precision nie może zmienić
semantyki bez walidacji i iterative refinement.

### 4.4 DMI i składanie pola

Field-only DMI nie oblicza energii. Stałe gradienty i objętości tetów są
precomputed. Energia używa redukcji blokowej/device-wide z wariantem
deterministycznym dla kwalifikacji. Assembly pola porównuje obecną atomikę z
coloringiem lub segmented reduction. Degeneraty i wartości niefinityczne są
liczone i obsługiwane fail-closed.

`H_eff` ma jeden plan akumulacji. Fuzja obejmuje tylko zgodne lokalne operatory
i nie zaciera granic właścicieli ani opcjonalności obserwabli. Kosztowny
operator może pozostać osobnym wywołaniem, gdy poprawia to reużycie cache lub
profilowanie.

### 4.5 FEM/BEM ACA

Faza near/far, mapowanie paneli i batchowanie są trwałym setupem. Apply reużywa
mapy i bufory. ACA otrzymuje adaptacyjne mapowanie pracy według rang i rozmiaru
bloków; małe bloki mogą być batchowane. Dwa solve'y FEM/BEM używają tego samego
kontraktu stream interop i warunkowej walidacji residuum. Niezależne `A*x-b`
jest wykonywane po błędzie raportowanej zbieżności, wymuszeniu polityką albo w
trybie kwalifikacyjnym, nie bezwarunkowo w każdym poprawnym solve.

### 4.6 Sterowanie krokami

Najpierw wprowadzamy maskę output/control, bity ważności cache i odroczone
snapshoty. Następnie przenosimy normy błędu, kontroler PI oraz decyzję
accept/reject na urządzenie. Host dostaje pojedynczy, jawny punkt decyzji albo
wersjonowaną kolejkę wyników; bufor skalarów jest double-buffered, aby kolejne
próby nie nadpisywały danych jeszcze konsumowanych.

CUDA Graphs z conditional nodes są eksperymentem dopiero po usunięciu
niezgodnych alokacji, callbacków i ukrytych synchronizacji. Graf nie może
utrudniać rollbacku, cancel ani publikacji receiptów.

### 4.7 Relaksacja

Nowy preconditioner realizuje backend-neutralny kontrakt
`(M + wK)^{-1} M`. Setup macierzy i solvera jest reużywany, apply działa na
GPU. Porównujemy `None`, `Diagonal` i `exchange-mass` na liczbie kroków,
czasie do tolerancji, końcowej energii i stanie. Manufactured SPD oraz CPU
double są oracle. Strategia nie jest domyślna, dopóki nie wygra pełnego
time-to-tolerance bez regresji jakości.

### 4.8 Frequency domain i multi-GPU

PETSc/SLEPc 3.25 jest oddzielną migracją produkcyjnego modal GPU. Małe układy
porównują obecną ścieżkę, CPU LAPACK, MFEM batched i cuSOLVER; dispatch używa
pomiaru crossover, nie marketingowej reguły „GPU zawsze”. Sekwencyjne metryki
końcowe otrzymują redukcję równoległą, jeśli profil potwierdzi znaczący koszt.

Multi-GPU zaczyna się dopiero po zamknięciu single-GPU. Wymaga jawnego bindingu
rank→device, GPU-aware MPI bez host stagingu, braku fallbacku i osobnych
receiptów per rank. Promocja wymaga strong/weak scaling z efektywnością,
komunikacją i poprawnością; samo uruchomienie na dwóch GPU nie jest bramą.

## 5. Sekwencja TDD i bramy faz

Każdy punkt rozpoczyna test czerwony: kontrakt źródłowy tylko dla struktury,
test numeryczny dla semantyki oraz managed runtime dla twierdzeń GPU.

### Faza 0 — baseline

- włączyć skopiowany FEM/BEM do śledzonej rewizji i jawnego CMake;
- rozszerzyć receipt o fazy, transfery, fence, setup/apply i wybór kernela;
- naprawić kontrakt benchmarku oraz przypięcie source/runtime manifest;
- zebrać CPU oracle, aktualny GPU p50/p95 i Nsight całego publicznego kroku.

Brama: identyczny workload i kompletne artefakty; bez tego kolejne wyniki mają
status diagnostyczny.

### Faza 1 — quick wins

- DMI field-only energy skip, redukcja energii, degeneraty i enqueue errors;
- FEM/BEM stream interop i warunkowa walidacja;
- accepted finalization, profiler i receipt bez zbędnych fence;
- usunięcie driftu strategii benchmarku relaksacji.

Brama: parity pól/energii, fail-closed oraz nie gorsze p50/p95.

### Faza 2 — sparse, fuzja i pamięć

- kwalifikowany wybór SpMV/SpMM;
- Exchange accuracy A/B;
- plan akumulacji `H_eff`;
- precomputed DMI i redukcja konfliktów;
- adaptacyjne ACA i batching.

Brama: osobne mikrobenchmarki i poprawa pełnego workloadu; brak promocji na
podstawie samego mikrobenchmarku.

### Faza 3 — device-side step control

- maski output/control, validity bits, deferred snapshots;
- device norm/PI/accept/reject i transakcyjny commit/rollback;
- conditional graphs dopiero po analizie capture compatibility;
- pełna macierz wszystkich explicit RK, fixed/adaptive, accept/reject.

Brama: identyczne decyzje kontrolera w tolerancji kontraktu, brak publikacji
odrzuconego stanu i mierzalny spadek host-sync/launch overhead.

### Faza 4 — preconditioner i stos

- manufactured SPD i GPU apply `exchange-mass`;
- time-to-tolerance `None/Diagonal/exchange-mass`;
- osobne obrazy A/B dla MFEM 4.10+, HYPRE 3.2 i opcjonalnie CUDA 13.3;
- mixed precision tylko z FP64 residual validation/refinement.

Brama: wygrany czas do tolerancji i pełna walidacja fizyczna. Upgrade zależności
nie może być połączony w jednym niepodzielnym commicie z algorytmem.

### Faza 5 — frequency domain

- migracja PETSc/SLEPc 3.25;
- A/B solverów małych układów;
- redukcja `final_metrics`, jeśli profil ją uzasadnia.

Brama: modal/driven kwalifikowane oddzielnie, zgodne widmo/odpowiedź i wygrany
czas dla każdego zakresu rozmiaru.

### Faza 6 — multi-GPU

- device binding, GPU-aware MPI i per-rank provenance;
- test braku host stagingu i braku fallbacku;
- strong/weak scaling.

Brama: określony próg efektywności zostanie ustalony z baseline single-GPU przed
promocją; nie będzie dopisywany po obejrzeniu wyniku.

## 6. Kontrakt benchmarku i dowodów

Porównanie zachowuje identyczną geometrię, mesh/topologię, ProblemIR, seed,
precision, tolerancje, stan początkowy, requested execution i źródło. Każdy
wariant ma warm-up oraz co najmniej pięć mierzonych powtórzeń. Raport zawiera
p50/p95 całości i faz, liczbę iteracji, accepted/rejected steps, transfery,
fence, launch count, peak memory, GPU UUID/driver/toolkit i pełne SHA źródła.

Correctness gate poprzedza interpretację wydajności. Dla dynamiki porównujemy
wektorowy stan i obserwable w tych samych czasach fizycznych, a nie tylko liczbę
kroków. Dla relaksacji porównujemy czas do tej samej tolerancji, końcową energię
i magnetyzację. Dla demag sprawdzamy pole, energię, residuum i zbieżność mesh.

Obowiązkowe receptury będą rozwijane wokół istniejących punktów:

- `just rebuild-fem-runtime`;
- `just ensure-managed-fem-runtime`;
- `just capture-fem-gpu-nsight`;
- `just verify-fem-gpu-performance-regression`;
- `just verify-fem-gpu-demag-performance-benchmark`;
- `just verify-fem-gpu-relaxation-preconditioner-qualification`;
- właściwe managed kontrakty RK, FEM/BEM i frequency domain.

Hostowe CMake/Cargo lub bezpośredni binarny smoke nie są dowodem końcowym.

## 7. Obsługa błędów i fallback

- forced GPU failuje przed wykonaniem, jeśli operator, precision, biblioteka,
  stream interop lub topologia nie spełniają kontraktu;
- błąd CUDA po każdym enqueue jest przypisany do fazy i publikowany w failed
  attempt, bez nadpisania ostatniego accepted receipt;
- NaN/Inf, degeneraty i niespójne residuum mają liczniki oraz stabilne tokeny;
- wariant autotuningu może spaść do kwalifikowanego wariantu GPU, ale nie do
  CPU; requested/resolved variant trafia do proweniencji;
- anulowanie zachowuje ostatni zaakceptowany stan i nie publikuje częściowego
  snapshotu.

## 8. Dokumentacja i publikacja

Przed pierwszą zmianą numeryczną aktualizujemy właściwe `docs/physics/*` wraz z
równaniami, symbolami SI, realizacjami FEM CPU/GPU, precision, walidacją,
path+symbol source map i statusem dowodów. Zmiany czysto wykonawcze bez nowej
publicznej semantyki nie zmieniają Python DSL ani ProblemIR, lecz aktualizują
requested/resolved runtime, receipt i capability evidence tam, gdzie to
widoczne.

Każde twierdzenie pozostaje rozdzielone na source/contract, managed runtime,
profil wydajności i poprawność fizyczną. Brak dowodu oznacza `NOT VERIFIED`, a
nie przewidywany sukces.

## 9. Strategia commitów i integracji

Commity są małe i odwracalne: najpierw czerwony test/fixture, następnie minimalna
implementacja i kwalifikacja. Import roboczego FEM/BEM, infrastruktura pomiaru,
każdy operator, kontroler kroków, upgrade zależności oraz multi-GPU pozostają
osobnymi seriami. Po każdej fazie następuje review i decyzja promote/reject.

Do `master` trafiają wyłącznie zmiany z przejściem odpowiednich bram. Wyniki
częściowe mogą być zintegrowane, jeśli są kompletne w swoim kontrakcie i nie
aktywują niezakwalifikowanej ścieżki domyślnie.

## 10. Decyzje wymagające akceptacji użytkownika

Ten projekt przyjmuje, że:

1. implementujemy fazami i integrujemy tylko wygrane, zakwalifikowane warianty;
2. skopiowany nieśledzony FEM/BEM jest baseline'em do dalszej naprawy;
3. upgrade CUDA/MFEM/HYPRE/PETSc/SLEPc odbywa się w osobnych obrazach A/B;
4. multi-GPU nie blokuje wcześniejszej integracji ukończonego single-GPU;
5. estymaty przyspieszenia pozostają hipotezami do czasu managed benchmarku.

Po akceptacji tego dokumentu powstanie szczegółowy plan wykonawczy z kolejnością
plików, testów, receptur `just`, checkpointów review i kryteriami rollbacku.
