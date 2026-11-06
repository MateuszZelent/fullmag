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
- Osobny wrapper `accepted_cuda_trace.v1`: pierwotny CLI preset64MiB; po pomiarze SP4 podnieść domyślny limit do128MiB, zachowując walidację i niezmienione hashe historycznych wrapperów64MiB. `max_duration_ms=60000`; limity ABI4096..268435456 B i1..120000ms. Osiem prealokowanych buforów po1MiB.
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

## Pierwsza para accepted SP4 — 06.11.2026

Commit `011a37da31a6bf9a97e16d5d3ce3c930310ea796` przeszedł wszystkie
cztery workflow CI PR408. Log potwierdza wykonanie nowych testów Rust w obu
binariach API, w tym regresji grupowego dostępu do NDJSON.

Zarządzana iteracja `1819e86b12c649c2aee71034270cad26` zbudowała snapshot
`f92f25ea5b622278c1c43e7a762628946587b64495bada7cd43041efe74ebcca` i bibliotekę
`fe546e9710afc2ba98055bb4b2136a0d55bbe1f6573443c570f82b8c2627d4a6`.
Native contract `d02abd5d88b2418ca155358404be05af` przeszedł z kodem0.

Oba accepted workery FEM GPU strict/double ukończyły7 kroków do50fs.
Zachowano oryginalne Zarr (table-only), sąsiednie `main.py`, native, identity,
provenance oraz hashe na WSL. Wejścia i biblioteka były identyczne.

- Trace-off: `run-live-a36f951390422c3b4cd626a703cb25bbb7e80cf7e866c4575c4227101def6bf5`.
- Trace-on: `run-live-fe3b8310e7ac6c69eefbfd104c9d5842a1ffa9bd77bccb56cef64597b565c3b4`.
- Magnetyzacja18529 aktywnych wektorów: max/rms różnicy0.
- Osiem energii i torque: różnica0.
- Mediana kroków3–7: off0,586621s, on0,604162s. Jedna para; opis narzutu,
  bez wniosku o przyspieszeniu solvera.

Ślad on jest **partial**, poprawnie odrzucony jako pełny dowód: zapisano
138712 rekordów /67108535B, osiągnięto limit64MiB, odrzucono6586 rekordów,
832 rekordy były nierozpoznane/bez timestampów,342 nazwy ucięto. Błędy API,
I/O i brak wolnych buforów:0. Solver zakończył się poprawnie; nie powtarzano
tej aktywacji. Wymagane przed merge: poprawa dekodowania/nazw, większy
ograniczony preset z kompatybilnością historycznych digestów, testy i nowy
matched capture. Pełne SP4 CPU/GPU i MuMax3 pozostają poza dowodem50fs.

## Korekta kompletności śladu i błąd bramki natywnej

Czytnik rozróżnia teraz metadane CUDA event bez czasu wykonania od niepełnych
rekordów czasowych. Limit nazwy wzrósł do 2048 bajtów, a preset CLI do 128 MiB;
historyczny preset 64 MiB zachowuje swój digest i możliwość odczytu.
Testy źródeł: 157 testów launchera i 8 analizatora przeszło; analiza całego
historycznego śladu 138712 rekordów daje identyczny wynik jak poprzedni czytnik.

Build snapshotu `13b512a132dd2a0d9d0023907a6513c31a37f9b292533c1ee41f18b9b08287bd`
zakończył kompilację, lecz bramka `3f79a673daf5453da2a71cecc420d24d` odrzuciła
start capture. Publikacja została zatrzymana, kandydat i log zachowane.
Poprawka próbowała jawnie włączać `CUPTI_ACTIVITY_KIND_CUDA_EVENT`; w tej
generacji API metadane przychodzą z `SYNCHRONIZATION`, a osobne włączanie jest
niedozwolone ([CUPTI Activity API](https://docs.nvidia.com/cupti/12.8.1/api/group__CUPTI__ACTIVITY__API.html)).
Przywrócono siedem jawnie włączanych rodzajów, zachowując dekodowanie metadanych;
dodano ograniczony komunikat kind/result przy błędzie włączenia. Test natywny
wymaga rzeczywistego rekordu event oraz nieuciętej długiej nazwy kernela.
Ponowny managed build przeszedł: resume `412b084ba8bf449a818edff429b1afb5`,
snapshot `15bf5f412e60c5b8e4627c6c3ec99748d7efa7267b9d191452b513672a07b049`,
biblioteka `041153fc88ebaf7a0ffcf671cbe173f34895855f49329811d38d1f7ab978cb5a`.
Native gate `b34991744a0c4ecb889297dd4960de13` zakończył się kodem 0
(test 4,369 s). Preflight potwierdził ten pakiet i dokładny powiązany resume;
nie uruchomiono kolejnego Solve.

Analiza rekordów poprzedniego śladu według timestampów między kernelami
`reset_attempt_control_packet` wykazała 23 130 850 B przed pierwszą próbą
i 36 711 181 B w pierwszej próbie. Estymacja siedmiu takich kroków to
280 441 429 B, przed narzutem nowych pól. Nie jest to pomiar kompletnego
capture. Limit 128 MiB jest za mały; przed kolejną parą trzeba zwiększyć
ograniczony budżet i zachować zgodność poprzednich wrapperów. Accepted capture
poprawionej wersji pozostaje do weryfikacji.
