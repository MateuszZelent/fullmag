# Profil CUPTI dla przyjętego FEM GPU — plan implementacji

> **For agentic workers:** użyć `executing-plans` lub `subagent-driven-development`; wykonywać etapy wraz z właściwą weryfikacją, bez osobnego pytania o już zleconą implementację.

**Cel:** uzyskać ślad rzeczywistych wywołań CUDA, kerneli, transferów, synchronizacji i alokacji w tym samym accepted workerze SP4, z zachowaniem wyniku Zarr i niezmienionej fizyki.

**Architektura:** natywny, opcjonalnie dostępny kolektor w `backends/fem/gpu/cuda/runtime/`; cienkie C ABI i Rust RAII; jawny immutable parametr `cuda_trace` w istniejącej aktywacji. Brak osobnego procesu, endpointu, solvera lub obejścia admission.

**Technologie:** C++17, prywatne CUPTI12.9.79 / Activity API28 przy zachowanym CUDA12.6 solvera, Rust, istniejący Python launcher, Docker Compose grupy SP4. Historyczne ślady API24 pozostają czytelne.

**Specyfikacja:** `docs/superpowers/specs/2026-11-04-sp4-fem-accepted-profiling-design.md`, etap2.

## Ograniczenia

- Baza: master `c0159d673281bcbd61ce160efaccf62d84c6788c`, potwierdzony przez `git ls-remote`; istniejący worktree i grupa `fullmag-worktree-fullmag-a8342df1f0247d61`.
- Profil domyślnie nieaktywny; kompilacja obsługi przy dostępnych CUDA/CUPTI nie aktywuje API. CPU i nieobsługiwana wersja CUPTI mają jawny wynik unavailable.
- Nie zmieniać modelu, materiałów, siatki, m0, integratora, tolerancji, timestepów, operatorów ani zapisu naukowego. Nie dodawać `cudaDeviceSynchronize` dla pomiaru.
- Accepted trace wymaga native FEM strict/double z jawnym GPU i bez fallbacku; weryfikacja przed acceptance i ponownie po materializacji planu.
- Osobny wrapper `accepted_cuda_trace.v1`: CLI preset 512 MiB po kalibracji rozmiaru śladu SP4, z zachowaniem niezmienionych wrapperów i digestów 64/128 MiB. `max_duration_ms=60000`; limity ABI 4096..536870912 B i 1..120000 ms. Osiem prealokowanych buforów po 1 MiB; limit pliku nie powiększa puli RAM.
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
- [ ] CPU/Windows/brak prywatnego prefiksu API28: stub unavailable, bez obowiązkowej rezydencji GPU. CUDA Linux: osobne nagłówki i biblioteka z `FULLMAG_CUPTI_ROOT`, bez fallbacku do CUPTI12.6. Biblioteka ładowana wyłącznie przy opt-in, po absolutnej ścieżce; sprawdzane `cuptiGetVersion()==28`. Brak CUPTI nie blokuje nieprofilowanego solvera.
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

Kolejny etap zwiększa cap ABI, wrappera Rust, admission i analizatora do
512 MiB, a CLI dopuszcza dokładnie presety 64/128/512 MiB. Budżet nie jest
nieograniczony: admission nadal odejmuje pełny cap i 1 MiB receipt od lease
przed uruchomieniem solvera. Poprzedni accepted worker miał lease 7 GiB;
przy nowym cap pozostałoby 6 978 273 280 B na output solvera. To dowód dla
tego przydziału, a nie gwarancja minimalnego lease każdego przyszłego runu.
Test natywny ma przyjąć maksymalny cap bez alokowania pliku tej wielkości
i odrzucić cap+1; test admission sprawdza również rezerwację całego limitu.
Limit analizatora wynosi teraz 2 097 152 rekordy: nawet starsza natywna
koperta rekordu przekracza 256 B, więc mieści wszystkie rekordy dopuszczone
przez cap 512 MiB. Odczyt pozostaje liniowy; pamięć na przedziały czasowe
rośnie z ograniczoną liczbą rekordów. Regresja używa wirtualnego strumienia
1 000 001 rekordów metadata, bez zapisu dużego pliku na dysku.

## Dłuższy capture — awaria procesu 06.11.2026

Snapshot `f3919daaacc78151afd52f6f750f15ed8172d859f77596b8cd27a5f25119f8d5`
i biblioteka `bcd7d8b5ef83ef42d131c958a189d038ee866761701694960b8e73a2cc13e5f9`
przeszły managed build oraz krótki native contract
`5202c90a3acb43c580224a35eaa1a03f` (3,706 s). Wariant bez profilera ukończył
7 kroków / 50 fs i zapisał Zarr. Wariant z limitem 512 MiB zakończył proces
sygnałem 11 (`SIGSEGV`) po ostatnio obserwowanym kroku 3 / 7 fs.
Nie jest to zgłoszenie CUDA 719 ani potwierdzenie przyczyny starszej awarii.

Zachowano 112192533 B częściowego NDJSON, ostatnie dostępne pole oraz receipt
wyjścia workera `attempt-422eb800fea64557b4775061497ead79`. Nie powstał końcowy
receipt trace ani Zarr. Core dump był wyłączony (limit 0); stack jest niedostępny.
Nie powtórzono aktywacji. PR pozostaje draft i nie ma kwalifikacji pełnego profilu.

Kolektor API24 odmawia bufora, gdy osiem slotów jest zajętych, oraz podczas
disable/flush. NVIDIA dokumentuje naprawę awarii po odmowie bufora w CUDA12.9
([release notes](https://docs.nvidia.com/cupti/12.9.1/release-notes/release-notes.html)).
To potwierdzona klasa ryzyka, lecz jeszcze nie przyczyna tej konkretnej próby.
Następna bramka dodaje jednorazowe komunikaty przy obu odmowach i gęsty workload
CUDA z długimi nazwami. Sama większa pula nie dowodzi bezpieczeństwa odmowy;
nie wolno przyjmować kompletności ani poprawy wydajności na podstawie partial.

Gęsta bramka przeszła na snapshocie
`ba37da787f4049464ee8d7f98c62599644009358cc65fad86fd7d08ad495f0c1`:
50000 launchy, 112513 rekordów, 144727169 B i wszystkie liczniki strat/błędów 0.
Native attempt `1d088345920941029eff9da68ce9094b` trwał 4,818 s; biblioteka
`7d8e7892c6aec7f46080771f7dd5bbb4865786d70ebd58cdb88110094a496c44`.
Nie odtworzyła więc nasycenia występującego w rzeczywistym SP4.

Jedna nowa próba SP4 z tą diagnostyką ponownie zakończyła się SIGSEGV po
kroku 3 / 7 fs. Receipt workera `attempt-d59e9b4851e843e7baa4b7fb24de4347`
zawiera `cuda_activity_trace: refusing buffer: all 8 slots occupied` tuż przed
awarią. Załadowana biblioteka CUPTI zwraca API24, zgodnie z dekoderem.
Potwierdzono odmowę bufora i powtórzenie tej samej klasy awarii opisanej przez
producenta; stos awarii nadal nie jest dostępny. Nie przenosi to diagnozy na
historyczny CUDA719. Zwiększenie limitu pliku nie naprawia odmowy bufora.

Obie ostatnie klatki odzyskano do osobnych Zarr v2 (step3, 7fs, m oraz9pól,
skalary, mesh, skrypty i13plików provenance). Zwykły czytnik Zarr2.18.3
potwierdził shape, wartości skalarów, SHA wszystkich pól i osadzonych plików.
Każdy artefakt ma `completed=false`, `full_trajectory=false` oraz sąsiedni `.py`;
nie jest końcowym wynikiem solvera ani dowodem odtworzenia UI.

Następny etap: oddzielnie przypięta CUPTI12.9.79/API28 z kontrolą wersji
załadowanej biblioteki, przy zachowaniu CUDA12.6 oraz MFEM/hypre solvera.
Wymagane są testy kontrolowanego wyczerpania puli, zgodnego dekodowania i
nowy accepted capture. Pełne profilowanie oraz merge PR408 nadal oczekują.

## Migracja API28 — checkpoint przed buildem

Zmiany źródłowe przypinają osobny redistributable CUPTI12.9.79 w końcowym
stage obrazu, z SHA archiwów amd64/arm64 i biblioteki w manifeście. CMake
wyprowadza nagłówki oraz bibliotekę z wybranego prefiksu przy każdej konfiguracji;
kolektor ładuje ją po absolutnej ścieżce dopiero przy opt-in i wymaga API28.
Dekoder używa Memcpy6, Synchronization2 i CudaEvent2, z jawnym włączeniem
metadanych event. CUDA oraz zależności FEM nie są podmieniane.

Review wykryło pozostawione wymaganie API24 w receipcie Rust oraz ryzyko
zachowania starego prefiksu przez cache CMake; oba poprawiono. Native contract
dodaje oddzielny proces odmawiający wszystkich buforów. Wymaga przeżycia
workloadu i poprawnego disable/flush; timeout obejmuje inicjalizację CUDA,
a rodzic ma limit oczekiwania i kończy oraz zbiera dokładnego potomka.

Wykonano 12 testów analizatora (w tym zgodność API28, odmowę niezgodnego
nagłówka i zachowanie odczytu API24), 8 istniejących testów Dockerfile/helpera,
kontrolę składni bloku instalacji oraz diff/whitespace. Wszystkie przeszły.
Testy Rust, kompilacja nowego obrazu/backendu, nowa bramka GPU i accepted
capture on/off pozostają **NOT VERIFIED**. Zmiany są jeszcze lokalne;
nie stwierdzono nowego przyspieszenia solvera ani naprawy CUDA719.

## API28 — managed build i bramka GPU

Managed toolchain `f8f5fa7f61c14a88a0a47dd0d75e3b22` oraz backend development
`204240d42cf8464fb788ef4c2c43b6e0` zakończyły się poprawnie. Snapshot źródeł:
`8e63ad05f9695dc7432169b340fbb71b1d5668d7097392d00b175093d04edb93`;
SHA biblioteki FEM:
`a12a7f79d48bf57eac169e14e8c6914f0c91f06c61d115e6a1a5c3be3e84e251`.
Instalator używa rzeczywistego pliku `LICENSE` z przypiętego archiwum NVIDIA;
pierwsza próba z nazwą `LICENSE.txt` została odrzucona, po czym ścieżkę poprawiono.

Native contract `1026bf919bcc4d018a2113fc3ad5cecd` przeszedł w 7,819 s.
Proces odmawiający wszystkich buforów przeżył 20 odmów i zakończył workload,
disable oraz flush bez błędu. Przed opt-in CUPTI nie było zmapowane;
po opt-in użyto dokładnie prywatnej biblioteki 12.9.79/API28.
Runtime i nagłówki CUDA pozostały 12.6. Gęsty capture zapisał 112513 rekordów
oraz 144679607 B; dropped, starvation, unknown, truncated, incomplete,
API/I/O errors i limit flags wyniosły zero.

To dowód bramki profilera, nie pełnego SP4 ani przyspieszenia solvera.
Nowa para accepted SP4 on/off nadal oczekuje. Limit 64 aktywacji wymaga
archiwizacji dwóch zakończonych rekordów; wszystkie ich wyniki i provenance
pozostają zachowane. Pierwszy managed apply odmówił bez przenoszenia danych,
ponieważ periodyczny heartbeat i znacznik transakcji rejestru zmieniały hash
planu. Kwalifikacja starszego, nieaktywnego SessionStore potwierdziła stabilny
inventory; poprawka archiwizacji ogranicza się do blokady i uwierzytelnionej
normalizacji zwolnionego writera rejestru. Offline inventory nie jest zmieniane.

## API28 — accepted SP4 on/off

Obie nowe próby zakończyły 7 kroków / 50 fs, z zachowanym Zarr, sąsiednim
skryptem i natywnymi polami. Off: batch `51b7a6c84acc4c0f806cb8499214754f`,
run `run-live-f31e643180618ec1ce932ab7e88061a73c8a5b7cbb9ce2d22a02990f624b2825`.
On: batch `d0e534c27ad8426eb65b163185e32203`,
run `run-live-145c0281823b659e72360075effe3f80a381b49530595a5024bb4d6497915475`.
Stan początkowy, siatka, snapshot i biblioteka były zgodne. Porównanie 18529
aktywnych wektorów m, wszystkich ośmiu energii i obu reprezentacji torque dało
dokładną różnicę zero. Mediana odstępu między callbackami kroków 3–7 wyniosła
0,656138232 s bez profilera i 0,657317392 s z nim. To pojedyncza para,
nie pomiar przyspieszenia solvera ani zajętości GPU.

API28 przeżyło rzeczywiste wyczerpanie puli i przekroczyło dawny punkt SIGSEGV
przy kroku 3. Ślad nadal jest **partial**: 289490 zapisanych rekordów,
153324796 B, `buffer_starvations=223992`, `dropped_records=447984`.
Ostatni licznik łączy lokalne odmowy z raportem CUPTI; nie oznacza niezależnie
zmierzonej liczby unikalnych utraconych zdarzeń. Pozostałe liczniki błędów,
unknown, truncated, incomplete oraz limit flags wyniosły zero. Receipt solvera
ma `completed` i exit 0; sterownik kwalifikacji zwrócił exit 3 z powodu
niepełnego profilu. Nie powtórzono Solve. SHA śladu:
`7a948a49e854433d8710ed4c010d861e4405ac71d32c0f231d35b783a78b9d6e`.

Następna diagnoza dotyczy cyklu i przepustowości ośmiu buforów po 1 MiB.
Nie wolno wnioskować o pełnych kosztach synchronizacji z utraconego śladu.
Pełny profil, historyczna awaria CUDA719, kwalifikacja całego SP4 oraz merge
PR408 pozostają otwarte.

Archiwizacja dwóch wcześniejszych zakończonych krótkich prób FEM
`2bb59ed9491c49049298224bcd92e2a8` i `6ed0d8783cd74a848b7624b64c39ed50`
zakończyła się zgodnie z przypiętymi planami. Oba receipty potwierdzają
`records_deleted=false` i `solve_replayed=false`; wyniki zostały zachowane.
Poprawka rejestru przeszła 8 testów referencji, 12 testów admission oraz
niezależne review bez blokujących uwag. Starsze relaksacje, których layout
nie jest obsługiwany przez tę ścieżkę archiwizacji, pozostawiono nietknięte.

## Diagnoza presji buforów po API28

Branch zaktualizowano do mastera `d7eb6fc848c890c2ca42c3dacacdc04f77f6087b`
przez merge `997cc51b6fa0dc7553c04a8a2a337f28ddb3602c`; 8 testów nowej
ścieżki odzyskiwania brakującego stanu przeszło. Zapisane próby nadal odnoszą
się do swojego wcześniejszego, jawnego snapshotu.

Jednoprzebiegowy odczyt partial potwierdził SHA i 289490 rekordów. Zawiera
97998 kerneli, 164172 runtime API, 18070 transferów oraz tylko 4 kernele reset
i 3 accept, mimo 7 ukończonych kroków. Są to dolne granice zaobserwowanych
zdarzeń, nie pełne koszty ani wykorzystanie GPU. Sam NDJSON nie wyjaśnia,
który właściciel przetrzymuje osiem buforów.

Według [API CUPTI12.9.1](https://docs.nvidia.com/cupti/12.9.1/api/group__CUPTI__ACTIVITY__API.html)
zwracanie gotowych buforów może zależeć od heurystyk workera. Domyślny tryb
per-thread jest wyłączony; nie należy przypisywać awarii liczbie wątków bez
pomiaru. Writer Fullmaga ma ograniczone oczekiwanie 2 ms, więc nie znaleziono
trwałego zablokowania wyłącznie przez utratę powiadomienia.

Instrumentacja nie zmienia wielkości puli, ABI, publicznych liczników, formatu
śladu, ani żadnych wywołań CUDA/CUPTI. Rejestruje osobno pełną pulę i odmowy
po zamknięciu capture. Przy potęgach dwójki liczby odmów zapisuje obserwacje
stanów z istniejących nieudanych CAS do stałej tablicy 64 próbek; log powstaje
dopiero po zakończeniu callbacków i join wątków. Liczniki gotowych/przetworzonych
buforów oraz czas `process_buffer` mają rozróżnić CUPTI-owned `FILLING` od
kolejki `READY` po stronie writera. Czas obejmuje dekodowanie, JSON, zapis i
odczyt licznika strat CUPTI, więc nie izoluje kosztu serializacji. Próbki nie
są atomowymi snapshotami ani rozkładem częstości.

Review nie wykazało blokujących uwag. Wymagane następne dowody: managed build,
istniejąca bramka natywna, jedna instrumentowana próba z zachowaniem Zarr,
a dopiero po odczycie stanów wybór poprawki. Nie należy automatycznie zwiększać
puli ani powtarzać zakończonych prób bez nowej hipotezy i przypiętego snapshotu.

## Próba instrumentowana i utrwalanie diagnostyki

Managed iteration `d4782c5b6225408b9fcceb95f9beae63` zbudowała snapshot
`e39ca6b8634abc364b06badc81b8caf273d65986b947c3f2031acda712410611`.
Bramka GPU `fcdb452f57634a04ace5c8a323016f66` przeszła: 112513 rekordów
gęstego testu, brak strat/błędów, zakończony test odmowy bufora. Potwierdzenia
pakietu, log bramki i ich hashe zachowano w katalogu diagnostycznym na WSL.

Jedna próba `4c62138efd0449feba46c4004b2bca00`, run
`run-live-c18d7d1a9b6e916da22a64c65661e0ecdb3f422c68e191e915afd713a63abf14`,
zakończyła 7 kroków / 50 fs i walidację strict FEM GPU double bez fallbacku.
Zarr, sąsiedni `main.py`, natywne pola oraz provenance są zachowane.
Ślad ponownie jest partial: 289600 rekordów, 153202435 B, 224560 odmów;
API/I/O/unknown/truncated/incomplete/limit flags wynoszą zero. Sterownik
kwalifikacji zwrócił exit 3 z powodu partial, proces solvera zakończył się exit 0.

Ta próba **nie rozstrzyga właściciela zajętych buforów**. Nowe próbki wypisane
na stderr nie zostały utrwalone: `accepted_study_supervisor` zbiera stderr,
ale loguje go tylko po nieudanym procesie. Ponadto osobny scheduler nie
inicjalizuje subskrybenta `tracing`. Korekta dostarczenia diagnostyki musi więc
przekazać wyłącznie ograniczone, rozpoznane wiersze `buffer_pressure` oraz
`buffer_processing` do istniejącego stderr schedulera, z run/task/receipt ID.
`runtime_service_main::logged_command` zachowuje ten strumień w
`runtime-services/<token>/compute.stderr.log`. Zwykłe udane biegi bez tych
wierszy pozostają ciche; obsługa błędów solvera pozostaje bez zmian.
Przed kolejną próbą wymagane są regresje filtrowania/limitów, managed rebuild
i sprawdzenie rzeczywistego logu. Nie uznano utraconej diagnostyki za pomiar.

Archiwizacja starej aktywacji `8911aa047f8c484fb55fb7a6ecf7939a` zwolniła
jeden slot bez kasowania rekordów lub powtórzenia Solve. Ostatnia retencja
cache `dfbc123997934acda05cafc2b0dcb90d` odmówiła z exit 75, ponieważ lock
runtime cache był zajęty. Po zakończeniu biegu i odczycie pustej listy właścicieli
tej blokady ponowiona kwalifikowana retencja `0f4416e500fb4117b428ec42ff4c0793`
zakończyła się `succeeded`, exit 0; zachowano aktywną grupę i wyniki.
CI dla wysłanego `15ae60b04e8c29ec7dc7555dba2547626d725dfe` ma cztery zielone
workflow; nie obejmuje późniejszego merge997 ani obecnych zmian diagnostyki.

## Dostarczone próbki presji i hipoteza okresowego flush

Commit `2c8e5b66cddcb7027073fec0d291cd5b04701681` został zbudowany przez
iteration `c3f8f0b3edab4cdf94dc542e499b45e3`, snapshot
`807c898216f84e5dbf874ab953e8ee6c4ff34b42a0e418b8e03b4f0028d1fb94`.
Bramka GPU `93cb9945226a4eb8a53420fa44794bbc` przeszła bez strat. Próba
`71a9ce6c0ef1400d8056584c6ee2ec12` ukończyła 7 kroków / 50 fs; Zarr,
sąsiedni skrypt, pola i provenance zachowano. Jej ślad pozostał partial:
289598 rekordów, 152864150 B, 224550 odmów, bez błędów API/I/O i limit flags.

Tym razem rekord schedulera powiązany z run/task/receipt został odczytany
i zachowany na WSL w `cuda-buffer-pressure.json` (SHA
`945317a63891a31f887d549d3a284addf607183968c10c6232d6e4c1fcee6654`).
Wszystkie 18 próbek miało 8 slotów FILLING, 0 READY, 0 PROCESSING oraz
completed=processed=20. Po końcowym flush przetworzono 28 buforów,
29357248 surowych bajtów; łączny czas przetwarzania wyniósł 0,933931105 s.
W obserwowanych momentach buforami zarządzało CUPTI, bez kolejki do writera.
Nie jest to dowód rozkładu stanów przez cały capture ani przyczyny CUDA719.

Następna hipoteza: `cuptiActivityFlushPeriod(10)` omija heurystyki budzenia
workera i zwraca pełne, skompletowane bufory okresowo. Pula pozostaje 8 × 1 MiB;
solver nie dostaje nowej jawnej synchronizacji CUDA. Teardown przywraca `0`,
również po błędzie startu; błąd przywrócenia oznacza api_error i poison.
Review nie wykazało blokujących uwag. Skuteczność wymaga kolejnej natywnej
bramki i kompletnego, ograniczonego capture SP4, z zerową utratą i zachowanym
Zarr. Nie jest jeszcze potwierdzona i nie stanowi przyspieszenia solvera.

CI dla `2c8e5b66` ujawniło błąd fixture nowego testu prefiksów: kontynuacja
literału Rust usuwała testowaną spację. Pozostałe 87 testów runtime-service
przeszło. Fixture zastąpiono jawnie łączonymi literałami `concat!`; nowy wynik
CI pozostaje wymagany. Zachowanie produkcyjnego filtra nie wymagało zmiany.

## Wynik próby okresowego flush — hipoteza niewystarczająca

Iteration `4af8319981f949f39069e4eba74eb71c` zbudowała snapshot
`d9e47b99053b325790f6eb0fbc9a686f202c558dcad42dc813cc2beaa0565a59`.
Bramka `4654e8205ec84d0e99c56a927d56396c` przeszła, w tym 112513 rekordów
gęstego testu bez strat. Wszystkie cztery workflow CI commita
`1975961e1891580c9e07323309352649e6dc8e48` zakończyły się sukcesem.

Próba `a066ece62e694dbba84817459688dd0d`, run
`run-live-b5cd253944a2fb5e0679057c6732acc1737d399d6c5d1755aafe1642159c5b6c`,
ukończyła 7 kroków / 50 fs; strict GPU qualification przeszła, a Zarr,
sąsiedni skrypt i pola/provenance zostały zachowane. Profil pozostał partial:
289601 rekordów, 153387349 B, 224542 odmowy bufora. Pozostałe liczniki błędów
i limitów wynoszą zero. Sterownik kwalifikacji zwrócił exit 3, solver exit 0.
Wszystkie 18 próbek ponownie pokazuje FILLING=8, READY=PROCESSING=0 oraz
completed=processed=20. Końcowo przetworzono 28 buforów i 29357488 B,
w czasie 1,061491420 s. Ustawienie FlushPeriod(10) nie wystarczyło.

Następna hipoteza po review: zwykły `FlushAll(0)` z istniejącego watchdoga,
ponieważ może zwracać także częściowo pełne bufory z kompletnymi rekordami.
FILLING nie dowodzi kompletności rekordów. Watchdog ma pozostać jedynym
właścicielem zwykłego i końcowego flush; nie może trzymać mutexów podczas
wywołania CUPTI. Stop czeka na już trwający flush i standardowy teardown;
błąd przerywa capture i zachowuje api_error. Regresja musi wykazać dostarczenie
rekordu z małego workloadu przed Stop, z ograniczonym czasem oczekiwania.
Następnie wymagane są dotychczasowe bramki natywne oraz SP4 bez strat.
To plan kolejnego doświadczenia, nie potwierdzona poprawka ani zysk GPU.

Retencja etapu `d3bc984cd1164a3e8a23dceab3a407bb` zakończyła się sukcesem.
Zachowano wyniki, aktualny pakiet, rollback i aktywną grupę Compose.

Implementacja kolejnego doświadczenia zastępuje FlushPeriod zwykłym
FlushAll(0) co 10 ms w istniejącym watchdogu. Nie zmienia puli ani ABI.
Diagnostyka końcowa zawiera liczbę, błędy i czas zwykłych flush. Review wykryło
wyścig Stop/deadline; klasyfikację przywrócono pod wspólny wait_mutex,
zachowując wywołania CUPTI poza blokadą. Ponowne review potwierdziło poprawkę.
Nowa polityka wymaga wykonania bramki natywnej i nowego capture SP4;
dotychczasowe zielone CI nie potwierdza jej działania.

## Watchdog: odzyskanie grupy, kompletność danych i błąd zegara

Naprawy odzyskiwania zapisano w commitach `36ccfddae106514ae1e47f1f4c886fc2a25f8426`,
`4ff8d5b2a` i `6467227cc06a79f391a1387009194996d4545c88`. Zakres: osierocony
restart idle, prywatny ledger, uwierzytelnienie współdzielonych konsumentów oraz
aliasów WSL przez tożsamość katalogu. 85 testów przeszło; cztery workflow CI
commita646 zakończyły się sukcesem. Oddzielna poprawka inwentarza historii
zachowuje referencje i hash piny rootu `host-device-reattest` (20 testów).

Offline recovery `15d8774e0c0c47a9b249bf6ab39a0c91` zwolniło wyłącznie
osierocony active, bez zmiany pierwotnego outcome i wyników. Development
`ea617af18421428f8b38e457d11c64a9` opublikował snapshot
`fc4b3151b4b14fce1e02d63f0ff25ea85f0942459e69e01edc9fa23b391f63e4` oraz
bibliotekę `ffeb417a4d9ebcc5f537a50741ce55253fed5946712bcad10f3b3dfc3e95b965`.
Native contract `4466fc899ae740d1aa1807db1e489e81` przeszedł w 2,334529 s:
rekord kernela dostarczony przed Stop, 112513 rekordów gęstego testu bez strat.
Retencja `a35216a7918841ecbb23a8a6b4a1358c` zachowała current i rollback.

Run `run-live-870ef66608a750f17169c4aa0b05eda3b61a698ad5676461120c574ebf76d1f9`
ukończył 7 kroków / 50 fs w strict GPU double. Zarr, sąsiedni `main.py`, pola,
receipty i ślad zachowano na WSL w `sp4-diagnostics/gpu-cupti-probe-1e050d0487474d52ae1526f98d1629dd`.
Ślad SHA `33d84b5612139ee9435e709da4b73202ad124bc8b31d136c4f53676eebf8a55d`
ma 513396 rekordów, 272200276 B, zero strat, błędów API/I/O i limit flags.
To potwierdza kompletność zapisu po zmianie flush, nie poprawność osi czasu.

Analiza wykryła skoki CPU timestampów −54,735600 s i +57,465048 s w tym samym
wątku CUDA. 30376 rekordów wypada poza zapisanym oknem; ostatni kernel accept
leży 1,150 s po końcu capture. Niezależny monotoniczny czas callbacków
potwierdza niezgodność zegara, a kolejność kernel→stream synchronize przeczy
interpretacji jako rzeczywistej kolejki GPU. Czasów przyciętej osi nie wolno
używać do kwalifikacji ani twierdzeń o wykorzystaniu GPU/przyspieszeniu.

Zliczenia według jednoznacznych korelacji reset→accept potwierdzają 408–522
wywołania cudaStreamSynchronize i 618–790 małych kopii D2H na krok. Ich koszt
wymaga powtórzenia pomiaru po naprawie zegara. CUPTI12.9 używa domyślnie
CLOCK_REALTIME na Linux; następna poprawka zarejestruje CLOCK_MONOTONIC_RAW
przed enable i użyje tego samego zegara dla granic capture, z osobną bramką
zgodności czasu. Referencja: https://docs.nvidia.com/cupti/12.9/api/group__CUPTI__ACTIVITY__API.html

Kolejny restart hosta zatrzymał obie usługi z exit255 (2026-11-06 20:14 UTC).
Próba kontrolna trace-off nie ma nowej aktywacji ani katalogu wynikowego;
ostatnia aktywacja nadal wskazuje zakończony trace-on. Matched on/off, koszt
synchronizacji i przyspieszenie pozostają NOT VERIFIED. Pełne SP4 A/B czterech
solverów i porównanie z MuMax3 GPU nie są ukończone.

## Bramka czasu i kolejne wznowienie — 06.11.2026

Master `914c04ac93b64d16268c62978b44b155c0609f10` dołączono bez konfliktów
w merge `b508e1a476bb9c36512b5684eb51782af7f3ce65`. Zachowano lokalne zmiany
profilera i 44 niewersjonowane wejścia SP4.

Czytnik zachowuje historyczne nagłówki CUPTI24/28, ale kwalifikuje czas
oddzielnie. Nowy nagłówek API28 wymaga dokładnej pary
`clock_source=clock_monotonic_raw`, `timestamp_callback_registered=true`.
Pełny capture, poprawne rekordy w jego granicach oraz czas capture mieszczący
się w monotonicznym czasie hosta są konieczne do `timing_qualification=passed`.
Tolerancja porównania dwóch zegarów hosta wynosi 1 ms; nie rozszerza okna GPU.
18 testów czytnika przeszło, w tym odrzucenie liczby1 zamiast boolean true.

Ponowny odczyt niezmienionego śladu watchdog potwierdził 30376 rekordów poza
oknem, maksymalnie 37,304835085 s przed i 1,651652545 s po granicach. Capture
25,317092049 s przekracza host wall23,108236555 s. Osobny raport na WSL:
`sp4-diagnostics/cupti-watchdog-reanalysis-clock-qualification-20261106.json`.
Sterownik kolejnych prób wymaga nowej bramki; jego poprzednia wersja pozostaje
w sąsiednim pliku `sp4_run_cupti_resume_validation_probe_20261106.before-monotonic-clock.py`.
Nowy SHA sterownika: `ec403153140fd1e4732ce281a4272354c323e8fc8004382f93b7665b270b3bcc`.

Native callback CLOCK_MONOTONIC_RAW przeszedł review źródeł; build i test na
GPU pozostają NOT VERIFIED. Zarządzany resume `2222ee63f8964ff3951b395593d9606f`
odmówił przed startem usług: operacja nie odziedziczyła prywatnego layoutu.
Oryginalny helper potwierdził READY/LOGGED i czeka z blokadą na terminal.
Naprawa wymaga zachowania jego własności oraz failure-only finalizacji;
wyniki, usługi i poprzednie pokwitowania pozostają zachowane.

Finalizacja odmowy jest zaimplementowana w
`917f58524256cad5d3c390f6b7e6436979ea1eb7`: 74 testy przeszły, w tym rzeczywisty
flock/CAS, ponowienie częściowej publikacji, zachowanie verified oraz odmowy
przy zmianie dowodów. Preview i apply przypiętego żądania
`8c7d6e6cbe61110b0ce9f4397937e6ead7a193e190b180956ef88ec273f5c68b`
zakończyły się kodem0. Wynik operacji to `failed-confirmed`; oryginalny helper
sam zwolnił active i zakończył się. Pokwitowanie na WSL:
`sp4-diagnostics/resume-layout-refusal-2222ee63f8964ff3951b395593d9606f.json`,
SHA `570564713b16a1650c0ffc6815ec8222e6859f94ea2479ce3cc91c4162b5fe1b`.

Plain resume dziedziczy teraz zapisany layout przed frontend seed i startem
usług. Test pełnego dispatchera najpierw odtworzył dokładną odmowę (RED),
następnie sprawdził utrwalenie group-volume-v1 i start obu usług (GREEN).
Ten sam test zachowuje wariant legacy i odrzuca brakujący/nieznany pin grupy;
16 testów pending-resume przeszło. Nie jest to jeszcze dowód startu runtime.

## Zegar natywny zweryfikowany; stary właściciel blokuje admission

Resume `82568ed9e17d4d9bba1769583bd558ca` zbudował pakiet ze źródeł
`af5b58a325fe5511cf07470bf87a931cca5ce3fc` i trzech zmienionych plików zegara.
Snapshot: `9654c9a5992f5949b1041b79915447c75f318c67c257d31b86df9eff682268b7`.
Biblioteka FEM: `27e289b4a19b0cb9d5b172cbff4877cc368b472cbbb568a6c6743af98fd6173e`.
Build zakończył się kodem0 w 467,941 s. Native contract
`6464969b3c7d4ffc81e5c214b83671d0` przeszedł: compile1,706322 s, test2,382864 s.
Gęsty capture ma 112513 rekordów, zero strat i błędów. Niezależne granice
CLOCK_MONOTONIC_RAW oraz wszystkie rekordy czasowe mieszczą się w oknie.
Pliki dowodowe i SHA zapisano na WSL w
`sp4-diagnostics/cupti-monotonic-native-6464969b3c7d4ffc81e5c214b83671d0`.

Admission runtime odmówił po buildzie: `native service target/build mismatch;
attach refused`. OWNER nadal opisuje dawny Ready z commita646/snapshotfc4,
a nowa inkarnacja kontenera nie posiada jego procesu. Istniejący zarządzany
`stop-bootstrap-volume` zakończył się sukcesem jako
`2d620c62dcac467aa638d63400133604`: zatrzymał wyłącznie diagnostyczny backend,
zachowując OWNER, sesje, lease i frontend. Nowy process receipt ma
`shutdown_unknown`, SHA `1cf43a6e2ccdc40e75b2b6825c7f7f9dd7e6b9a0b041d5b9460aa8460a0e5cbe`.

Przegląd wykazał brak kontynuacji pomiędzy tym stopem a container recovery:
stop celowo nie zapisuje niepotwierdzonego `service_owner`, natomiast recovery
wymaga go w bieżącym process receipt. Nie wolno go dopisywać ani usuwać OWNER.
Następny etap: jawny dowód wiążący istniejący stop-bootstrap, diagnostyczny
fence, oryginalne bajty OWNER/LAUNCH/config/process i zatrzymany frontend;
zachować natywny format V5 oraz pełne piny terminal/held/history. Samo
odzyskanie kontrolera nie kwalifikuje symulacji. SP4 on/off z poprawionym
zegarem, przyspieszenie i pełne porównanie fizyki pozostają NOT VERIFIED.

## Kontynuacja po diagnostycznym stopie

Inwentaryzacja bieżącego store zmienia wcześniejsze założenie o V5: jest
21 runów terminalnych (19 succeeded, 2 failed), bez held-manual i bez historii
retry. Wszystkie 21 lease solvera i 21 preparation są released; epoki wynoszą1.
Właściwy istniejący request native to V3 z pełną listą terminalną. Nie wolno
tworzyć pustych list held/history, aby wymusić V4/V5.

- [x] `docker_volume_bootstrap_recovery.py`: wspólny, tylko odczytowy walidator
  jawnie przypiętego stopu. Wiąże terminal operacji, preflight, oryginalny
  proces/fence, resume/development/Compose oraz cztery surowe dokumenty native.
  Zachowuje rozróżnienie hash surowego sidecaru / hash kanonicznego terminala.
  Testy mutacji dowodów, obcych tożsamości i niepełnego stopu.
- [ ] Zarządzany stop dokładnej inkarnacji frontendu pod blokadą grupy:
  niezmienny intent przed sygnałem, kontrola ID/StartedAt/backendu i dowodów
  przed/po, ponowienie przez obserwację. Brak modyfikacji OWNER lub receiptów
  native. Pełny store/ledger census musi przejść przed usuwaniem kontenerów.
- [x] Jawny wariant hostowego abrupt proof z dodatkowym dowodem bootstrap.
  Ten sam walidator przy przygotowaniu, odczycie, ponowieniu i granicy mutacji;
  zwykła walidacja `service_owner` pozostaje obowiązkowa w starych wariantach.
  Request native V3, bez zmiany semantyki zakończonych runów lub limitów CAS.
- [ ] Review, regresje i managed preview/apply na dokładnej grupie. Dopiero
  potem build/start oraz nowy pomiar GPU ON/OFF z pełnym Zarr i zgodnością
  energii/torque. Nigdy nie zastępować odzyskania nowym pustym store.

Oryginalne dowody stopu wyeksportowano do WSL:
`sp4-diagnostics/bootstrap-stop-2d620c62dcac467aa638d63400133604`.
SHA surowego stop-terminal: `d207ad238492ce3f9a826eb7d0d676e40db44a34bf01ff86fe987709c43292e6`.
SHA operation-terminal: `cf24d4ca959ed45c349e301bd9fc754f3a8741a9e49115085a7909f1ee462a76`.
Zachowany OWNER nadal ma SHA `aa01987d1b38f8f1246f424879380889472ad789350ad6096fe306ed1a73aeac`.

Stan źródłowy proof/preparer: 22 testy bootstrap, 11 preparera, 16 ogólnego
container recovery i 39 abrupt recovery przeszły. Review wykryło dwa błędy
przed mutacją: hybrydowy journal pod starszą autoryzacją oraz błędny LAUNCH
odrzucany dopiero przez native. Poprawiono je i dodano regresje. Wyjątek wymaga
autoryzacji abrupt, a LAUNCH musi mieć stan spawned/ready i dokładny PID ownera.

Odczytowe sprawdzenie rzeczywistego store/ledgera przeszło: 3476 plików,
21 terminalnych runów, snapshot ledgera
`06fc27705d67c06db72dc2ced68df9c510618aa047708edfc260b848ba891df6`.
To niezależny wynik; pełna izolacja od obcych konsumentów nadal blokuje mutację.
Poprawkę wyboru worktree w resolverze zapisano jako
`77c93411a677634959e85580582b354822754245` (39 testów i review, push do PR408).
Kolejna warstwa sondy fizycznej ma jawne ograniczenie do mastera. Wśród
niezakwalifikowanych konsumentów są działające usługi `containers_admin2`
oraz starsze zatrzymane grupy Fullmag. Nie zatrzymano ich i nie zmieniono
ich receiptów; trwa implementacja jawnego kontekstu worktree dla tej sondy.
