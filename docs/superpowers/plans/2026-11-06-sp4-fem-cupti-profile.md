# Profil CUPTI dla przyjętego FEM GPU — plan implementacji

> **For agentic workers:** użyć `executing-plans` lub `subagent-driven-development`; wykonywać etapy wraz z właściwą weryfikacją, bez osobnego pytania o już zleconą implementację.

**Cel:** uzyskać ślad rzeczywistych wywołań CUDA, kerneli, transferów, synchronizacji i alokacji w tym samym accepted workerze SP4, z zachowaniem wyniku Zarr i niezmienionej fizyki.

**Architektura:** natywny, opcjonalnie dostępny kolektor w `backends/fem/gpu/cuda/runtime/`; cienkie C ABI i Rust RAII; jawny immutable parametr `cuda_trace` w istniejącej aktywacji. Brak osobnego procesu, endpointu, solvera lub obejścia admission.

**Technologie:** C++17, CUPTI Activity API 24 z CUDA12.6, Rust, istniejący Python launcher, Docker Compose grupy SP4.

**Specyfikacja:** `docs/superpowers/specs/2026-11-04-sp4-fem-accepted-profiling-design.md`, etap2.

## Ograniczenia

- Baza: master `c0159d673281bcbd61ce160efaccf62d84c6788c`, potwierdzony przez `git ls-remote`; istniejący worktree i grupa `fullmag-worktree-fullmag-a8342df1f0247d61`.
- Profil domyślnie nieaktywny; kompilacja obsługi przy dostępnych CUDA/CUPTI nie aktywuje API. CPU i nieobsługiwana wersja CUPTI mają jawny wynik unavailable.
- Nie zmieniać modelu, materiałów, siatki, m0, integratora, tolerancji, timestepów, operatorów ani zapisu naukowego. Nie dodawać `cudaDeviceSynchronize` dla pomiaru.
- Accepted trace wymaga native FEM strict/double z jawnym GPU i bez fallbacku; weryfikacja przed acceptance i ponownie po materializacji planu.
- Osobny wrapper `accepted_cuda_trace.v1`: `max_bytes=67108864`, `max_duration_ms=60000`; CLI preset, limity ABI 4096..268435456 B i 1..120000 ms. Osiem prealokowanych buforów po1MiB.
- Wynik: ograniczony NDJSON `worker_cuda_trace.v1.ndjson` oraz immutable `worker_cuda_trace.v1.json` w dokładnym attempt output directory. Żadnych serializowanych wskaźników do CUPTI; adresy alokacji tylko jako liczby diagnostyczne.
- Receipt wiąże config digest, accepted attempt identity, PID, GPU UUID, outcome solvera, status/limity/dropped/overhead i SHA pliku. Brak receipt albo przekroczony limit oznacza partial/failed trace, nie pełny dowód.
- Wszystkie buildy w stałym backendzie właściwej grupy przez launcher; wejścia44, Zarr, ledger i cudze zmiany pozostają chronione.

## Priorytety review

- Błąd/Stop solvera: zamknąć capture, zachować częściowe dane i pierwotny błąd.
- Przekroczenie limitu lub brak bufora: ograniczyć zapis/pamięć i jawnie policzyć utratę; nie blokować solvera bez końca.
- Równoległy callback i watchdog: jeden właściciel, brak use-after-free, zamknięcie callbacków przed uwolnieniem buforów.
- Włączony parametr przy CPU/FDM/auto/unsupported: odmowa bez cichego przejścia na inną metodę.
- Replay request_id z innym trace: odrębna tożsamość i konflikt, nigdy drugi Solve.

## Etap1 — kolektor natywny

Właściciel: bounded worker. Pliki: nowe `native/include/fullmag_fem_cuda_trace.h`, `backends/fem/gpu/cuda/runtime/cuda_activity_trace.cpp` i pomocnicze pliki w tym katalogu; `backends/fem/CMakeLists.txt`; nowy `backends/fem/tests/cuda_activity_trace_contract.cpp`.

- [ ] Najpierw wykonywalny native contract: poprawne rekordy runtime/driver/kernel/copy/memset/sync/memory; invalid fd/limity, drugi start, powtórny stop, ograniczenie bajtów/czasu i czytelne partial.
- [ ] C ABI: `available_v1() -> int`; `start_v1(int fd, uint64_t max_bytes, uint32_t max_duration_ms, uint64_t *token) -> int`; `stop_v1(uint64_t token, fullmag_fem_cuda_trace_stats_v1 *stats) -> int`. Statusy jak `FULLMAG_FEM_OK/ERR_*`. Caller posiada fd; kolektor duplikuje pusty regularny plik. Token nie jest wskaźnikiem.
- [ ] Stats: 14 pól `uint64_t`: schema_version, cupti_version, start_timestamp_ns, end_timestamp_ns, records_written, bytes_written, dropped_records, buffer_starvations, unknown_records, truncated_names, incomplete_records, api_errors, io_errors, limit_flags. Bity limit_flags:1 bytes,2 duration. Rozmiar112B.
- [ ] CPU/Windows/inna wersja niż API24: stub unavailable, bez obowiązkowej rezydencji GPU. CUDA Linux: użyć zainstalowanych oficjalnych headers/sample12.6 i dostępnego `CUDA::cupti`; brak CUPTI nie blokuje nieprofilowanego solvera.
- [ ] Jeden capture na proces, deadline watchdog wyłącza aktywności i opróżnia bufory poza callbackiem; stop budzi/łączy watchdog i zwraca statystyki. Brak resetu CUDA lub wyciszania błędów solvera.
- [ ] Native trace posiada wersjonowany nagłówek, timestamp domain CUPTI ns, rodzaje aktywności, correlation/stream/context/thread/device IDs, bajty i nazwy. Truncation/niekompletne timestampy są jawne.

## Etap2 — przyjęcie i lifecycle

Właściciel: root. Pliki: bindings w `crates/fullmag-fem-sys/src/lib.rs`; nowy cienki wrapper runnera; `accepted_profile_admission.rs` i nowy `accepted_cuda_trace_admission.rs`; nowy moduł worker receipt/capture oraz `accepted_fem_study_worker.rs`; istniejące `docker_startup.rs` i live preparation; Python startup/run-script/CLI oraz ich testy.

- [ ] Testy RED admission: unknown fields/schema/limity, CPU/FDM/auto, dokładny plan, immutable request digest/replay i domyślny brak trace.
- [ ] Przenieść immutable wrapper przez istniejący startup→RunSpec; osobny parametr/hash, niezależny od `solver_profile`.
- [ ] Przed solverem otworzyć nowy plik, uruchomić kolektor po strict GPU preflight. Po wyniku zatrzymać, fsync/hash i zapisać receipt; przy błędzie diagnostyki zachować outcome solvera i zgłosić niepełny profil. RAII zamyka także nieoczekiwane wyjście.
- [ ] Testy lifecycle używają fake capture dla success/failure/cancel/drop, bez wymagania GPU w zwykłym CI.
- [ ] Dodać czytnik/analyzer ograniczony receipt/hash/size/attempt; raportować czas API, unie kerneli, transfery, sync, alokacje, dropped i narzut. Nie sumować nakładających się okien.

## Etap3 — build, runtime i integracja

- [ ] Podpiąć nowy native contract do zarządzanej recepty, zachowując dowody biblioteki i snapshotu. Test RED/GREEN w właściwej grupie.
- [ ] Wykonać jeden SP4 GPU50fs trace-on i porównać z zachowanym trace-off z tej samej biblioteki. Każdy bieg ma własny oryginalny Zarr, skrypt, native oraz trace na WSL.
- [ ] Sprawdzić m,8energii, torque, accepted/rejected, czas końcowy i tożsamość. Zmierzyć narzut capture; ślad z dropped/limit nie jest kompletnym profilem.
- [ ] Review, spójne commity, PR/CI/merge, lokalny master fast-forward, retencja. Worktree pozostaje aktywny, dopóki całe SP4 i środowisko są potrzebne.
- [ ] Wyniki profilu wybierają następną optymalizację i diagnostykę CUDA719; sam profil nie kończy pełnego SP4 A/B dla4solverów ani porównania z MuMax3 GPU.

## Checkpoint źródłowy — 06.11.2026, 03:41 UTC

Implementacja kolektora, C ABI/Rust RAII, admission i launchera jest przygotowana.
Czytnik `scripts/analyze_accepted_cuda_trace.py` wymaga tożsamości run/attempt,
PID oraz UUID GPU, weryfikuje started receipt, config i SHA/rozmiar śladu.
Raportuje unie przedziałów i kierunki transferów; nie przedstawia ich jako
sprzętowego wykorzystania GPU. Limit śladu oraz 1 MiB na receipt są wydzielane
z lease storage przed utworzeniem próby.

Wykonane testy źródłowe: 220 testów launchera, 25 testów helpera native contracts,
13 testów jego integracji, 10 testów polityki Make i 6 testów czytnika.
Test Make wykonano istniejącym Pythonem 3.10 z zainstalowanym `tomli` jako
adapterem `tomllib`; niczego nie instalowano na hoście. Testy nie uruchamiały
kompilatora ani GPU. Kontrola diff/whitespace przeszła.

Review wykryło i poprawiono odrzucanie parametru w workerze, ciche traktowanie
`null` jako braku profilu, podwójne wydatkowanie limitu storage, niespójność
fixture lease i liczenia przedziałów/utraty w analizatorze. W kolektorze
poprawiono nieistniejące pole Kernel9 i nazwę API timestampu według zainstalowanych
nagłówków CUDA12.6, synchronizację warunku Stop, blokadę ponownego użycia po
nieudanym flush, atomową kontrolę pustego FD i wynik niedostępnego testu.
Test stuba zwraca77: CTest oznacza go jako skipped, a jawna bramka zarządzana
odmawia kwalifikacji. Native contract ma własny alarm60s także przy wykonaniu
bez CTest.

Kompilacja Rust/C++, native contract, accepted trace oraz porównanie on/off na
nowej bibliotece pozostają **NOT VERIFIED**. Nie przypisano tej zmianie żadnego
przyspieszenia solvera. Testy Rust są objęte istniejącymi filtrami CI
`accepted_solver_profile::`, `docker_startup::tests` i worker parameter tests;
do CI dodano czytnik Python. Po weryfikacji runtime należy uzupełnić ten wpis
o dokładne snapshot/library/attempt i wyniki porównania.

## Pierwszy build i native contract — 06.11.2026, 03:57 UTC

Zarządzany build Rust/C++ przeszedł w stałym backendzie grupy SP4. Native contract
`fem-cuda-activity-trace` przeszedł z kodem0: kompilacja1,418s, test4,962s.
Sprawdzał rzeczywiste rodzaje aktywności, limity i ponawiane cykle capture/stop.

- Development: `244deed8846543289e25c697d84859ff`.
- Config: `d1d3b434079a557338ef10f505b4985da7d670778f5049b11ab4a25ce96debfd`.
- Snapshot: `be6333e69681f59af07a861889a6a5c510b58095a554d16f8968de89d84d3f7f`.
- Biblioteka: `23680e9e999dbe0f0ed89ce325ba43598cc619cb451bd8cccfc871371f96b5ec`.
- Native test attempt: `853ea8ec4f76482ab4b6f7b3919b5540`.
- Log SHA256: `1f4864ec811a0c0b465947e8d0ef2ec0b20e8d1753643cea9e47cefeef813561`.

Po tym buildzie zmieniono wyłącznie tworzenie NDJSON z0600 na0660, aby plik
był czytelny przez grupę zarządzanego mountu WSL tak jak pozostałe artefakty
workera; nie zmieniano uprawnień istniejących plików. Dodano regresję Rust.
Ta korekta wymaga kolejnego buildu przed SP4. Testy Rust w CI i accepted
trace-on/off z oryginalnym Zarr są nadal do wykonania. Brak pomiaru
przyspieszenia solvera.
