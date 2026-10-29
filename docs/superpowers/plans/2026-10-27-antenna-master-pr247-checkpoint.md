# Antena i Universe: integracja mastera oraz PR #247 — 27.10.2026

Status: master zintegrowany; build, kontrakty i odczyt Saved sprawdzone. Odbiór PR, CI oraz rzeczywisty browser/WebGL pozostają osobnymi bramkami.
To checkpoint przyrostu implementacji, nie zamknięcie E0–E12.

## Zakres i baza

Istniejący worktree `/home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011`,
branch `codex/antenna-transport-e2e-20261011`,
[PR #247](https://github.com/MateuszZelent/fullmag/pull/247) do `master`.
Pobrany i zintegrowany `origin/master`:
`38ffb49bf4f8dabfdf2b4921903c88183bb9f84e`.
Commit integracji: `a11a5cba11035d2d54abca649782d10fcebb1b7d`.
Zachowano lokalne zmiany anteny oraz oryginalny artefakt FMS poza indeksem.
Pełne kopie źródeł, indeksu i diffów pozostają w control volume, w
`verification/master-pr-integration-20261027/`; zachowany stash:
`02f01f18537ce9b06e461ab548c90655e06e9b8b`.

## Zachowanie aplikacji

- `schemas/runtime.rs::StageExecutionRecordResource` udostępnia opcjonalne
  `antenna_inspection`: `retained`, `absent` albo `unknown` z reason code.
  `antenna_inspection.rs::inspection_discovery_metadata` sprawdza rejestr lub
  istniejący rekord; nie kwalifikuje payloadów numerycznych. Handler
  `simulation/runtime.rs::get_stage_execution` zachowuje fence sesji i rewizji.
- `artifactInspectionAvailability.ts::artifactInspectionAvailability` wymaga
  zgodnych session/epoch/request scope/run/runtime stage/authored stage.
  Inspector oraz `useArtifactFieldOverlay` odczytują katalog pól dopiero dla
  potwierdzonego właściciela `retained`. Brak wyniku nie staje się pustym
  katalogiem ani fallbackiem do pola innej sesji.
- `ArtifactInspectionSource.tsx` pokazuje stan wykonania i dostępność wyniku
  osobno. `LayoutController.ts::openSavedResults` atomowo otwiera Results → Saved.
  `ResultsNavigatorModule.tsx` korzysta z tego samego stanu layoutu, także przed
  pierwszym zamontowaniem panelu. Zmiana wyboru nie uruchamia Solve.
- Nośniki V/J przewodnika i H otoczenia pozostają osobne. Wybór Universe nie
  zmienia zapisanej domeny wyniku na Global. Zapisany H używa własnej topologii,
  a zgodna jawna publikacja live zachowuje pierwszeństwo.
- Integracja zachowuje masterowe poprawki Inspectorów, ograniczone cache,
  metadane przygotowania i read-only retry dowodów. Naprawiono brakujący import
  `quantityCatalogEntrySupportsAirbox`; zaktualizowano regresje komponentów.

## Build i kontrakt wygenerowany

Jedyna grupa DEV:
`fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1`, port 3203.
Build odbył się w tym samym backendzie `cc32cb682ae5`, z zachowaniem frontendu
`0dacc07deb1e`, obrazu, mountów i cache. Nie użyto hostowego Cargo/CMake ani
oddzielnego kontenera budującego.

Recepta z wybranego worktree:
`FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples just docker-dev-restart-idle 37062974a42f4ad4aec3976df9dfafe6 66401b85878924fb0ca043cad95c27b219264e52e78461de7535f014d947ca9c <worktree> 3203 true`.
Zmienna procesu zachowuje wcześniejszą zgodę na zapis wyników w `examples`;
nie zmieniono wspólnego `.env`.

Attempt `94ca9bf8ff37455a939d416150c3b10a`: succeeded, exit 0.
Źródło: commit integracji + WIP, snapshot
`cc9916130a4b98f0b3c35915de4a9ef930dcfc7090c9264e9aa04d509e61e649`.
Wersja `0.1.0-dev.20261027.ga11a5cba1103.dirty.scc9916130a4b+9796`.
Make 1479984 ms; bramki `linux-native-v1` i `worker-cgroup` PASS, API gotowe.
Receipty: `iteration/attempts/94ca9bf8ff37455a939d416150c3b10a/` w control volume.

Następnie `just docker-dev-codegen <worktree>` zakończył się succeeded.
Kanoniczny receipt:
`backend/codegen/openapi-v2/dc38a50cfd8760689f7bf4ebe01313ee9d58db3ecad7b2f5a3af1b6af2d64b3e.json`.
OpenAPI SHA256: `f2469c172e1d009a3b12b32bf6faa40d1ca5594b01a98424c7b14ac785f265d5`.
Zmiany wygenerowanych typów TS i Python odpowiadają wyłącznie discovery.
Późniejszy import frontendu i korekty jego testów działają przez HMR; nie
przypisujemy im źródłowego snapshotu wcześniejszej kompilacji backendu.

## Zachowanie danych i rzeczywisty odczyt

Po buildzie GET `/v2/sessions/current/simulation/stages/execution` zwrócił 200.
Ta sama próba `run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496`
pozostała Failed, a jej etap `script-execution-2df97d99b6b88a3c58d0b135696e390a819e720b84d6311f4f6d0a62a8969bec`
ma `antenna_inspection={state:absent, reason_code:no_retained_inspection}`.
Nie podstawiono pod nią starszego zapisanego wyniku.

Porównanie before/after potwierdziło identyczne scene oraz logiczną sesję,
wszystkie 1391 plików pełnego zapisanego runu, 43 katalogi runów i oba pliki
odzyskanego rozwiązania. Zero dodanych, usuniętych lub zmienionych plików;
zero aktywnych zadań. Dowód:
`verification/inspection-availability-20261027/runtime-preservation-review.json`,
SHA256 `f83740001b3647842bb9b6c97a20ca14bda5989ab39c3345cd4dc903de1cdb39`.

## Weryfikacja frontendu po integracji

Na rzeczywistych źródłach po codegen i poprawce importu przeszło 330/330
wybranych testów Vitest w 23 plikach. Trzy interpretowane kontrole:
Universe Inspector 27/27, selekcja pola 68/68, powierzchnia 39/39.
Pełny typecheck, lint 27 plików i kontrola architektury PASS (exit 0).
`summary.json` SHA256: `483ba0452159e345c65d8801746a180e481cc1268cc0b6d89d0104ab3936307a`.
Dokładne polecenia i logi pozostają w wolumenie
frontendu: `verification/final-antenna-frontend-20261027/commands.json`.

Odczytowy harness rzeczywistych komponentów i API:
`node /state/development/verification/final-antenna-frontend-20261027/verify.mjs --expect-absent --saved-flow`.
Wynik: `retained_absence_gate=passed`, `saved_flow=passed`, 16 GET / wszystkie
200, zero błędów, zero mutacji API, zero dodatkowych requestów i renderów
w oknie idle. Przejście Airbox → Browse saved results → Saved → run5654 →
odzyskane rozwiązanie rev1 → H_ant → Inspect ustawiło zapisany H w prezentacji
Airbox. Wiersz przed Inspect pokazał H, A/m i 1145×3. Nie wysłano błędnego
katalogu stage dla bieżącej próby Failed; nie uruchomiono kolejnego Solve.
Dowód: `verification/final-antenna-frontend-20261027/report.json`.
SHA256 raportu: `b39f646d86ef2e8ced703fa406858ab93619d8fe1a40bb1e07254398c9a2d34f`.
To test TestDom + prawdziwy HTTP, bez kwalifikacji rzeczywistej przeglądarki.
Trzech nowych regresji Rust discovery nie kompilowano lokalnie; dodano ich
wykonanie do istniejącego workflow bootstrap CI. Wynik CI wymaga osobnej
oceny dla HEAD wypchniętego PR.

## Granice odbioru i retencja

Odzyskany wynik `run-5654db21201dd6c660f7ecae78baf8588477fe2a7d90480d9d64b30e4d050080`
ma surowe V/J/H; H zawiera 1145 wektorów A/m na siatce 6428 Tet4.
Lifecycle tego runu nadal Failed; odzyskanie danych nie czyni wykonania
Succeeded ani bazy pola zakwalifikowanej do LLG. Wcześniejsza kontrola
zamrożonych wejść i wspólnych próbek H wykazała zgodność bajtową; nie jest
niezależnym dowodem poprawności fizyki, zbieżności ani odtworzenia publikacji.

Przeglądarka/WebGL nadal NOT VERIFIED: automatyczna kontrola URL zablokowała
odczyt starej karty będącej stroną błędu z niedozwolonym protokołem. Nie
obchodzono tej odmowy inną kartą, powierzchnią przeglądarki lub CDP.
TestDom i HTTP nie zastępują screenshotu, kontroli canvas ani WebGL.
Przekrój poprzeczny w UI, kwalifikowana baza → DC Relax/AC Run,
spin-wave response oraz pełne porównanie BORIS pozostają otwarte.

Retencja zarządzanego buildu: deferred (`outside-startup`). Zachowano bieżący
pakiet, rollback, aktywny cache, wyniki, logi i receipty. Nie usuwano kontenerów,
wolumenów ani danych użytkownika. Po buildzie dostępne logicznie w Dockerze
321285468160 B; nie jest to gwarantowana niezależna pula od hosta.
Skill `fullmag-build-stage-cleanup` nie jest dostępny; zastosowano reguły
retencji governance. Ponowna ocena dopiero po wykazaniu zbędności i referencji
rollback. Worktree i grupa pozostają do dalszej pracy oraz review PR.


## Pierwszy CI i korekty kontraktów po integracji

Dla HEAD `d4255dad0034ea785316ccfe4191f781948b6510` zakończyły się 32 kontrole:
14 success, 8 failure i 10 skipped. Nie uznano początkowych lokalnych 330
przypadków za dowód przejścia całego CI. Przejrzano pełne logi nieudanych jobów.
Wszystkie poniższe poprawki dotyczą testów, fixture, audytu i selektora smoke;
produkcja solvera, API, bramki providera, tolerancje i runtime pozostają bez zmian.

| Rodzina nieudanych kontroli | Potwierdzona przyczyna i poprawka | Weryfikacja lokalna |
|---|---|---|
| source-contracts | Test klasyfikacji tworzył komunikat przez `invalid`, który dodaje prefiks, a oczekiwał dosłownego tekstu bez prefiksu. Fixture używa jawnego `RunError`; dokładne asercje i obsługa nieznanych statusów zachowane. | Parser Rust PASS; wykonanie Rust oczekuje na CI. Pierwszy CI miał 1820 PASS i tę jedną awarię. |
| rust-contracts, checkpoint-windows-contracts | Jeden test `quantities.rs` podawał `Value` zamiast nowego `SharedJson`. Dodano `.into()` wyłącznie w fixture. | Parser Rust i diff PASS; testów Rust lokalnie nie kompilowano. |
| terminal-artifact-attestation Ubuntu, python-contracts | Trzy stare konteksty testowe nie implementowały terminal-observation preflight i nowego context managera. Uzupełniono mocki i dokładne asercje wywołań. | 296 przypadków Python: 293 PASS, 3 oczekiwane skips; przed poprawką odtworzono dwie awarie. |
| modal-observables, control-room-contracts | Fixture nie uwzględniały jawnego admission podglądu, jednego właściciela statusu stopki, atomowej kolejki kolory+macierze oraz rozstrzygniętego providera i projekcji tensora. Zachowano odmowy, dodano sześć negatywnych regresji. | Rodziny skupione 37 + 109 + 96 PASS; pełny typecheck, lint 12 zmienionych plików i architecture PASS. |
| browser-fixture-smoke | Kontrola geometrii szukała starego natywnego selecta zamiast wspólnego comboboxa z aktualną etykietą. | Parser i odczytowy SSR/AST kontrakt selektora PASS; rzeczywisty smoke przeglądarkowy oczekuje na nowy CI. |

Jeden pełny przebieg Vitest na zamrożonych źródłach zakończył się: 873/874
pliki oraz 9127/9128 testów PASS, exit 1, 438,88 s. Jedyny błąd tego przebiegu
nie dotyczył kodu produktu: cross-app test próbował otworzyć
`apps/web/dev-server.mjs` w cieniu zawierającym tylko Control Room.
Istniejący test obsługuje `FULLMAG_TEST_SOURCE_ROOT`; przy jawnym pinie do
readonly `/opt/fullmag/source` cała ta rodzina przeszła 12/12 (exit 0).
Nie zmieniono testu ani launchera, nie wyłączono przypadku i nie powtarzano
873 niezmienionych zielonych plików. Osobno finalny SHA fixture jednostki
`A/m^2` sprawdzono w 56/56 przypadkach capabilities. Nie przedstawiamy tych
przebiegów jako jednego pełnego wykonania z exit 0.

Dokładne logi/komendy/SHA są w wolumenie frontendu pod
`verification/pr247-ci-20261027/`: `full-frontend-tests.log`,
`post-full-focused.json`, `root-final-checks/summary.json`,
`provider-tensor-planar-review.json` oraz `selector-contract.json`.
Pełne logi i raporty backendu są w control volume pod tą samą ścieżką:
`terminal-artifact-fixture-review.json` SHA256
`22b3aba3c525a3f43435d4754ed4b8d6adb75be4e8eef89c6d534dde59f08f50`,
`rust-checkpoint-fixture-review.json` SHA256
`8acae5052788d5a93c03eb62c3abc6f8ced788a0cbc3fbcd366fdfbedf833819`.

Następna bramka: nowy push i ponowny CI dla jego dokładnego HEAD. Nie zmieniono
wyników ani nie uruchomiono Solve lub nowego buildu produkcji wyłącznie dla
fixture. Odbiór rzeczywistego Saved viewportu i pełny E0–E12 pozostają otwarte.

Niezależnie ponownie przejrzano przyszły przekrój Saved. Plan oraz przegląd
ponownego użycia istniejącego FMVP z obowiązkową maską są w control volume
`verification/antenna-saved-planar-design-current-20261027/`. To wyłącznie
projekt: brak próbki musi pozostać brakiem, norma następuje po interpolacji
wektora, cztery piny właściciela i maska muszą być spójne przed prezentacją.
Nie wdrożono w tym przyroście nowego endpointu, codec ani przekroju UI.


## Drugi CI i kolejne korekty fixture

Dla wypchniętego HEAD `c76eaf2e0bf782c8e5b0c0807be7e38e77e275f0`
potwierdzono w pełnych logach CI: source-contracts 1821 PASS, 0 FAIL,
1 ignored; Control Room 873 pliki PASS, 1 skipped, 9117 testów PASS,
13 skipped oraz osobne 3 microbench PASS. Przeszły także generated API,
browser-fixture-smoke i inspector-actions-browser-smoke. To dowody CI dla
wskazanego commita, a nie kwalifikacja rzeczywistego Saved viewportu.
Ostatni dostępny odczyt całego zestawu: 19 success, 2 failure,
10 skipped, 1 in progress; nie przedstawiamy go jako wyniku końcowego.

Pozostałe zakończone błędy dotyczyły fixture Python i testu start-policy Rust.
W tej korekcie nie zmieniono produkcyjnego runtime, parserów, bramki Compute,
solverów ani tolerancji:

- testy retained recreation uwzględniają opcjonalny odczyt rejestru cancelled
  activation i sprawdzają dokładne wywołanie;
- frontend resume odtwarza aktualny przypadek OOM, zachowuje backend/package/
  process/incarnation fences, odrzuca non-OOM i sprawdza brak buildu oraz
  zmiany generacji; prawdziwy helper resume pozostaje wykonywany;
- test shell uznaje zwykłe `--stop-only`, które już generuje justfile;
  niekompletne piny i shell injection pozostają odrzucane;
- test źródła siatki odrzuca nie-NPZ, zgodnie z istniejącym owner-bound API,
  zamiast twierdzić, że wszystkie importy siatki są niedostępne;
- test inspekcji akceptuje oba kanoniczne tryby `manual`/`automatic`, a jako
  błędne sprawdza null, obcy schemat, nieznany tryb i dodatkowe pole.
  Durable exact Compute release i produkcyjny kod workera są niezmienione.

Lokalne dowody: cztery rodziny Python 64 + 14 + 5 + 15 = 98 PASS,
0 FAIL, 0 SKIP; pojedynczy test nie-NPZ 1 PASS. Parser Python i parser Rust
(rustfmt emit stdout) PASS. Testów Rust nie kompilowano i nie uruchamiano
lokalnie. Niezależny przegląd polityki startu: 0 Required/Blocker.
Dowody w control volume pod `verification/pr247-ci-c76e-20261027/`:
`frozen-four-fixtures-final-review.json` SHA256
`c36b9021a8693db9945d0fbd1c815878eade0447ea2dbc0492642efbec6f373e`,
`start-policy-review.json`, `start-policy-source-check.json`,
`non-npz-source-focused.json` oraz pełne logi.

Szerszy lokalny przegląd Python ujawnił ograniczenia środowiska (brak montażu
wspólnej `.git`, różnice UID/cache oraz timeouty cięższych fixture).
Nie zmieniono produkcji ani nie podmieniono metadanych Git w celu ich ukrycia.
Pełny nowy CI jest nadal wymagany. Windows gh zwrócił HTTP 401; ważności
logowania nie zakładamy. Odczyt `git ls-remote` potwierdził branch PR na c76e
oraz nowszy master `cc91b2550767e73f3b059ff94fdff466a77e46ef`.
Wyniki, FMS, cache, grupa 3203 i pełny zakres E0–E12 pozostają zachowane.


## Zapis fragmentu i druga aktualizacja mastera

Poprawki powyższych fixture zapisano w
`bb0afabe56c4d451b4ed666899bf3dff72c5a07a`.
Master `cc91b2550767e73f3b059ff94fdff466a77e46ef` scalono bez konfliktów
w `226ec9f7e5afd50d18b7c65cb73b251f4a61cfa8` i wypchnięto do gałęzi PR.
Systemowy odczyt GitHub CLI potwierdził ważne logowanie keyring; wcześniejszy
HTTP 401 wystąpił w ograniczonym środowisku polecenia i nie dowodził wygaśnięcia
systemowego logowania. Nie było potrzeby resetowania danych uwierzytelnienia.

Podczas tej operacji master przesunął się do
`0e5d179d42e70d7f94662f1e8f40ceb93f140f7a` (m.in. prepared FEM observations,
compute-fields evaluation, dokumentacja lokalna i shared build storage).
Integracja wymagała pięciu rozstrzygnięć konfliktów: zachowanie obu recept
justfile, obu akcji CLI, sumy list testów z zachowaniem scope/oracle,
spójnych subpath mountów cache oraz regresji Next config z obu gałęzi.
Wąska regresja launchera: 56/56 PASS, parser justfile i Python PASS;
Next config 21/21 PASS i ESLint PASS. Logi w control volume:
`verification/pr247-master0e5d-20261027/`, frontend:
`verification/master-merge-0e5d179d-20261027/`.
Zintegrowane źródła nie oznaczają uruchomienia nowej polityki cache ani nowego
pakietu runtime. Nie wykonano cleanup, migracji storage, restartu ani Solve.
Testy i przegląd nie zastępują wymaganego nowego CI oraz buildu runtime.

Test cache po scaleniu: 21/21 PASS oraz macierz subpath 10/10 PASS;
wszystkie regresje obu rodziców zachowane. Niezależny przegląd launchera:
0 Required/Blocker, 68 modułów stanowi sumę obu list. Raporty:
`verification/pr247-master0e5d-20261027/backend-cache-conflict-review.json`
(SHA256 `11c2d37913430efaa96927e937dcf7b9d45aa787e312aa7647aa3060f7fb8e10`)
oraz `verification/master-merge-0e5d179d-20261027/launcher-merge-review.json`.


## CI po integracji 62f222 oraz próba runtime

HEAD `62f222f732bd6c44056673ad0320ff8ab9134c2e` jest wypchnięty i PR #247
ma stan MERGEABLE. Ostatni odczyt CI: 20 success, 1 failure, 10 skipped,
1 in progress. Python przeszedł; cały job Rust nadal trwa, a jego krok polityki inspekcji zamkniętej pętli przeszedł. Jedyny zakończony
błąd source-contracts to losowy fixture
`mixed_domain_plan_digest_survives_permuted_full_request_roundtrip`:
MeshIR serializuje mapę jakości w kolejności BTreeMap, a test szukał fragmentu
HashMap o losowej kolejności. Awaria następowała przed kontrolą digestu.
Korekta porządkuje tylko mapę wzorca testowego; oba kierunki permutacji,
zgodność planu/digestu i odmowa zmienionego wejścia pozostają. Parser rustfmt
i diff check PASS; testów Rust lokalnie nie kompilowano ani nie uruchamiano.
Pełny log: `verification/pr247-ci-62f222-20261027/source-contracts-122368971209.log`
w control volume. SHA256 poprawionego pliku:
`bbf5115d3b675d24a1f9f526b822ee24fe9eed12ff03d231db905bbb0c660f79`.

Zarządzany restart własnej grupy nie uruchomił buildu: po poprawnym drainie
Docker odmówił nowego PID 1 z NVIDIA prestart `ldconfig terminated with signal 9`.
Attempt `c037af6df84448b1ba6576157b822914`, wynik
`outcome-unknown-resources-retained`. Backend jest stopped/PID 0/exit128,
frontend stopped/exit0; kontenery, pakiet, cache i wyniki zachowane.
Dowód `backend-drain.json`: state drained, process receipt SHA256
`34949a31456d06d5b5238b74b777ebd4bc0522e597367a0f792bf5989f9d5f38`.
Stan przed próbą: 1391 plików wynikowych, 43 katalogi runów, 2 pliki
odzyskanego rozwiązania, zero aktywnych zadań. Snapshot i checker:
`verification/master-runtime-62f222-20261027/`.

Nie zastosowano ręcznego startu ani zastępczego checkpointu. Niezależny audyt
wykazał, że dotychczasowy prestart recovery wymaga saved-authoring checkpoint;
ta próba prawidłowo użyła terminal-session-preflight i drain. Dla niej brakuje
obsługi tego wariantu dowodów. Potrzebne są osobny proof, exact config/container/
history CAS, kontrola braku nowej publikacji, preview i przypięta kontynuacja.
Nie przedstawiamy nieudanego restartu jako buildu ani działającego API.


## Kolejny master i granice recovery terminalnego

Korektę deterministycznego fixture zapisano i wypchnięto jako
`7ae277614211434ad850702e85e9c4d9df2b2ccb`. Nowy CI tego HEAD blokuje
konflikt z kolejnym masterem, przypiętym do
`2fcd70b860341238fce82a67320587d446aaa38d` (helper source pinning,
automatyczna retencja oraz attestation zapieczętowanych shared binaries).
Integracja tej wersji jest oddzielona od aktywacji recovery lub migracji grupy.

Istnieje natywny read-only co do lifecycle/publikacji dowód
`runtime service-inspect-terminal-run`, który bierze blokady host→store,
sprawdza terminalny katalog, lease, admission i exit receipts oraz zwraca
`mutations_applied:false` i `solve_replayed:false`. Może potwierdzić run62d;
nie zastępuje sprawdzenia całej grupy i dwóch held intentów. Wariant terminalnego
prestartu wymaga ponadto grupowego no-active proof, niezmienionych held intentów
bez start_release, rzeczywistego baseline oraz exact drain/container/config CAS.
Nie wolno wstecznie tworzyć saved-authoring checkpointu dla próby c037.

Sterownik WSL odpowiada (`nvidia-smi`: RTX3070 Laptop, driver596.21, 34MiB
z8192MiB GPU). Po awarii WSL pokazał 13888080KiB MemAvailable; backend miał
limit8GiB i OOMKilled=false. Te obserwacje nie dowodzą przyczyny SIGKILL hooka
ani stanu pamięci w chwili jego zabicia. Nie zwiększono limitów, nie zmieniono
sterowników i nie restartowano współdzielonego Dockera/WSL. Obserwacje oraz
warianty diagnostyki zapisano w istniejącym control volume jako
`verification/master-runtime-62f222-20261027/nvidia-prestart-diagnostics.json`.


## Weryfikacja integracji 2fcd bez uruchamiania aplikacji

Cztery konflikty rozwiązano zachowując terminal observation, device access,
completion gate, walidację pod własnym lease oraz nowe piny helpera. Listy
kontroli są sumą obu gałęzi; stare warianty scope/oracle pozostają.
Przy uruchomieniu kontroli offline wykryto brak trasy przez just_storage_shell:
istniejący CLI obsługiwał offline, lecz ścisły wrapper go nie dopuszczał.
Nie obchodzono tej odmowy. Dodano wąską receptę
`docker-dev-offline-check <source_root> <module>`: dokładnie jeden moduł
`test_[A-Za-z0-9_]+`, exec strukturalnych argumentów, bez eval, z odmową
łączenia z live scope/oracle i shell injection.

Rzeczywiste wykonania nowej recepty w zarządzanych helperach tej samej grupy:

| Moduł | Przypadki | Pominięte | Exit |
|---|---:|---:|---:|
| test_just_orphan_recovery_shell | 19 | 0 | 0 |
| test_docker_volume_checks | 27 | 0 | 0 |
| test_docker_startup_script | 31 | 0 | 0 |
| test_docker_helper_source | 13 | 0 | 0 |
| test_docker_native_failed_recreate | 64 | 0 | 0 |
| test_docker_volume_pending_resume | 14 | 0 | 0 |
| test_docker_volume_retained_device_lifecycle | 5 | 0 | 0 |
| test_fullmag_docker_runtime | 124 | 3 | 0 |
| test_docker_backend_dev | 91 | 0 | 0 |

Razem 388 przypadków: 385 PASS, 3 oczekiwane skips, 0 FAIL. Każdy receipt
potwierdza `source_inputs_stable:true`, źródło readonly i control writable.
Helpery nie mają GPU, sieci, docker socket ani mountów danych użytkownika;
nie uruchomiono backendu, API, natywnego buildu lub Solve.
Dowody w control volume:
`verification/master-runtime-62f222-20261027/offline-test_*.json`.
Parsery Python/embedded Python/justfile, `bash -n` i diff check PASS.
To weryfikacja kontraktów źródłowych, nie runtime qualification.

Projekt recovery terminalnej sesji zapisano osobno w
`2026-10-27-terminal-session-prestart-recovery-proposal.md`.
Kod nowego wariantu, jego natywny proof/preview, reconcile i rzeczywisty
managed restart pozostają do wykonania. Nie uznano planu za implementację.


## Opublikowana integracja i potwierdzenie source-contracts

Integracja i ograniczona recepta offline zostały zapisane oraz wypchnięte w
`830857cce55c5dd10f51124b37b9c6c6260e77eb`. PR #247 pozostaje otwarty;
nie wykonano merge do mastera. Dla tego dokładnego HEAD kontrola
source-contracts zakończyła się wynikiem 1821 PASS, 0 FAIL, 1 ignored.
Potwierdza to także korektę losowej kolejności fixture digestu. Pełny log
joba 122446243508 zachowano w control volume:
`verification/pr247-ci-830857-20261027/source-contracts-122446243508.log`.
Pozostałe kontrole CI trzeba ocenić oddzielnie; ostatni odczyt joba Rust
122446861761 wskazał ukończony krok polityki closed-loop oraz trwający krok
shared accepted-inspection. Nie oznaczono całego joba jako zaliczonego.

Ponowny odczyt Docker potwierdził backend stopped/exit128/PID0, frontend
stopped/exit0 oraz żywy oryginalny helper c037. Wpis rejestru worktree
zaktualizowano przez `worktree-finish ... review`, bez cleanup lub retencji.
Kod terminal-only recovery jest w implementacji i niezależnym review; przed
prawdziwym proof/apply wymagane są testy oraz usunięcie wykrytych błędów
kształtu held intent i rozdzielenie niezmiennych danych naukowych od legalnie
nowej, zweryfikowanej generacji runtime po rebuildzie. Nie wykonano retry.


## Terminal-only recovery — kod i regresje

Dodano osobny wariant `fullmag.docker-terminal-prestart-reconciliation.v1`,
który korzysta z autentykowanego drainu i terminalnego runu zamiast
saved-authoring checkpointu. Pierwszy development370 pozostał
failed-confirmed; obecny pakiet wiąże dokładna udana iteracja
`94ca9bf8ff37455a939d416150c3b10a` wraz z niezmiennym terminal receipt
i identycznym `iteration/verified.json`. Nie przepisano historii startu.

Zachowano stary wariant v1 bez zmian. Nowy request przypina kontroler, moduł,
kontenery, pełne stany Docker, OCI error, bazowy receipt i prior publication,
operator baseline oraz natywny dowód i pełny inventory historii. Completion
oddziela niezmienne dane naukowe od nowego pakietu, który musi przejść
istniejące kwalifikacje `_finish`. Nie nadaje Compute ani nie odtwarza Solve.

Kanoniczne kontrole offline: 23 nowe + 18 legacy + 39 reconcile = 80 PASS,
0 FAIL; źródła stabilne. Osobno rejestr źródeł: 27 PASS i receipt potwierdzający
hash nowego modułu. AST oraz embedded Python i diff check PASS. Testów
Rust nie kompilowano lokalnie. Raport źródeł w control volume:
`verification/terminal-prestart-recovery-20261027/source-final-report.json`,
SHA256 `11f87d4bc524db1879df5b26cd18e11a89be4077df78123357de197129432504`.

Wykryte podczas review błędy regex, pola specification, namespace, prior
publication i legalnej zmiany generacji usunięto przed native proof. Kontrola
rzeczywistych metadanych receipt/provenance: 12 porównań PASS, ale nie
zastępuje ponownego hashowania pakietu. Diagnostyczny pomiar magazynu:
15917 zwykłych plików / 537825612 B; mieści się w jawnych limitach proofu.

Na tym checkpointcie natywny prepare, kanoniczny preview, reconcile oraz
restart nadal NOT VERIFIED. Backend i frontend zatrzymane; oryginalny helper
zachowuje lease. Nie wykonano cleanup, nowego Solve ani zmiany profilu GPU
aplikacji. CPU ABI w helperze służy wyłącznie natywnemu odczytowi metadanych
bez GPU; zgodność loadera wymaga rzeczywistego wykonania.


## Rzeczywista walidacja dokumentu Compose i obserwacja native prepare

Fragment recovery zapisano lokalnie w
`98f36cbcb2456588949fa7bcdffff611e0d369a5`. Przed uruchomieniem helpera
rzeczywisty `docker compose config` odtworzył błąd brakujących deklaracji
wolumenów. Uzupełniono wyłącznie deklaracje istniejących named volumes jako
`external:true` i dokładne `name`; bindy i subpath pozostały bez zmian.
Ten sam schema check przeszedł z exit0, a 23 regresje zmienionego modułu
przeszły ponownie przy stabilnych źródłach. Niezależny przegląd delty:
0 Blocker/Required. Dowody w control volume:
`verification/terminal-prestart-recovery-20261027/compose-schema-root-review.json`
oraz `offline-terminal-external-volumes.json`. Starszy raport 80 PASS
odnosi się do swoich wskazanych SHA; nie podmieniono go nowym wynikiem.

Diagnostyczny prepare uruchomił rzeczywisty helper bez GPU i API. Klient
przekroczył 180s obserwacji; stan należy traktować jako unknown, a nie
terminalną awarię helpera. Ponowny odczyt potwierdził żywy kontener i postęp
po kolejnych plikach pakietu. Nie uruchomiono nowej próby; dołączono obserwację
logów tej samej instancji. `native-prepare-observation.json` zachowuje dokładny
ID i StartedAt. Backend i frontend są nadal stopped, owner c037 zachowuje
lease, nie wykonano reconcile, startup ani Solve. Wynik native prepare
i kanoniczny preview nadal wymagają oceny.


## Zakończenie pierwszego native prepare i przyczyna odmowy adaptera

Pierwszy helper
`9af23076362959b8c874e0ec27cab7a80f14c7a5bb65d50083c8a5646ff7c2cb`
zakończył działanie i nie istnieje już w Dockerze (zarządzane auto-rm).
Obserwator zachował jego błąd:
`host-bound solver lease has no exact released host row`. Kod wyjścia samego
procesu helpera nie został bezpośrednio odczytany przed auto-rm; exit0
obserwatora logów nie jest sukcesem dowodu. Raport końcowy:
`verification/terminal-prestart-recovery-20261027/native-helper-first-result.json`.
Nie powtórzono próby aplikacji ani nie zwolniono ownera c037.

Adapter nie przekazał `FULLMAG_SESSION_STORAGE_PROFILE`;
`HostResourceLedger::store_id` użył canonical-path fallback zamiast tożsamości
Linux native. Poprawny profil wymaga także prawdziwego dowodu bieżącej mount
namespace oraz sześciu pól środowiska. Wszystkie sześć istnieje jednoznacznie
w actual.Config.Env zachowanego backendu. Samo dopisanie profilu nie zastępuje
pełnego native admission. Nie zmieniono natywnej bramki ani rekordów ledgeru.

Istniejący wzorzec `docker_candidate_history.py` / `linux_native_probe.run(True,
evidence_path=...)` pozwala użyć prywatnego dowodu pod aliasem RW, z overlay
RO wyłącznie pliku `.linux-native-probe.json`. Źródłowy certyfikat, owner,
sentinele i oryginalny probe pozostają zachowane. Jest to plan naprawy
adaptera; dopuszczenie tego wariantu przez rzeczywisty native CLI nadal
NOT VERIFIED. Nie przejęto overlay kandydata, publikacji provenance ani
NVIDIA runtime z tamtego narzędzia.

Pierwszy helper miał limit 0,25 CPU i odziedziczony healthcheck aplikacji,
który zgłaszał brak API co kilka sekund. Plan poprawki obejmuje osobny
healthcheck wyłączony wyłącznie dla diagnostyki, limit 1 CPU i 600s obserwacji,
przy zachowaniu pełnego hashowania. Nie zmienia limitów ani profilu backendu.
Kontrakt nadpisania healthcheck opisują
[Docker Compose docs](https://docs.docker.com/reference/compose-file/services/#healthcheck).
Samo ustawienie tych parametrów nie dowodzi przyspieszenia.

Po próbie ponownie porównano z rzeczywistym baseline: wszystkie 43 katalogi,
1391 plików zapisanego runu i oba pliki odzyskanego rozwiązania są identyczne;
writer advisory jest released. Raport `post-first-native-science-preservation.json`
SHA256 `0a7dcf8a1ef90b68f9c7b65e43751096caf20fda538f9b09941df3a48d5f79a5`.
Rozwiązanie odszukano po unikalnym hashu manifestu oraz sprawdzonych run_id /
solution_set_id. Początkowy dodatkowy skrypt diagnostyczny błędnie założył,
że API ID jest katalogiem plików; ten błędny raport zachowano jako
`post-first-native-wrong-solution-path.json`, a nie jako dowód utraty danych.
Właściwy katalog to `solutions/c55c330557585ca3329a08eb80fa9574302d75ebe67f98900780fba724103bf6`.


## Drugi native prepare: prawdziwy namespace zaliczony, parser czasu wymaga poprawki

Poprawka prywatnego admission ma niezależny review bez Blocker/Required
i 29/29 interpretowanych regresji (UID65532 i odmowa UID1001).
Produkcja SHA256 `f87e02ef48b31240de765a181c51402d7a5ad0392da7ec0bdd643f81d518661c`,
test `3883e6c92f9810a85a189ce270d103a8ee1ee9db8fb88387783277f7fad7c779`.
Receipt `offline-private-namespace-uid-final.json` i raport
`private-namespace-uid-fixture-review.json` znajdują się w katalogu kontroli
`verification/terminal-prestart-recovery-20261027/`. To dowody adaptera,
nie zastępstwo natywnego prepare ani WebGL.

Drugi prepare zakończył się po 48,345 s. Rzeczywisty probe uzyskał
`native-inspected`; oryginalne owner/certificate/sentinel/probe pozostały
identyczne. Dowód namespace SHA256
`2586a8af80f8d35f0bd0bfbad08995216ed921f32536ff535939a5f692fa5a49`.
Natywny CLI przeszedł, potem porównano store, held intents i sealed package.
Ostateczna walidacja advisory writer odmówiła na
`datetime.fromisoformat('2026-10-27T21:18:59.543852683+00:00')` w Pythonie3.10.
Cały prepare pozostaje **FAILED**, mimo wcześniejszych zaliczonych kontroli.
Helper `fullmag-terminal-proof-4fbf41ee952e4993b4602ba7c0a9d98a` nie istnieje
(po zarządzanym auto-rm); backend/frontend nadal stopped z wcześniejszym StartedAt.
Nie wykonano reconcile, restartu ani Solve; owner c037 zachowuje lease.
Raport: `native-helper-second-result.json`, pełny błąd: `native-prepare-second-status.json`.

Poprawka obejmuje parser nanosekund w adapterze, bez obcięcia do mikrosekund
i bez zmiany natywnej bramki. Dokumentacja
[Python3.10 datetime](https://docs.python.org/3.10/library/datetime.html) opisuje
węższy zakres `fromisoformat`;
[RFC3339](https://www.rfc-editor.org/info/rfc3339/) dopuszcza ułamek sekund.
Samo przejście na nowy Python nie jest przyjętym rozwiązaniem: obcięcie ułamka
mogłoby zaakceptować odwróconą kolejność znaczników w tej samej mikrosekundzie.


## Natywny prepare po korekcie czasu — PASS

Parser dokładnych nanosekund oraz regresja odwrócenia 1 ns w tej samej
mikrosekundzie przeszły niezależny review bez Blocker/Required.
32/32 interpretowane testy PASS, exit0, 24,695 s, source inputs stable.
Receipt `verification/terminal-prestart-recovery-20261027/offline-writer-time-32-final.json`
SHA256 `a62e49f24a2edf9cf6f07dcc931da981a8c8082349caa77d2b5b19259e369f0e`.
Finalne źródła: moduł
`50d72091be223afde66447cf8fb6e916db90028ca9058984d545c870058329a6`,
test `15fddad60f111181bb2392f1e8ba12a15853b65d96543e5fcc2ae12a0c6055c8`.

Trzeci rzeczywisty prepare uzyskał succeeded po 45,108 s. Observation
zachowuje ten sam storage binding
`f9628a472d4bb5be8d890065a1c5a29ebcb9db095b52fd695aa2d496d5b4415e`,
sealed package receipt
`441a4457c2930d742ebe3ab636a2b2af7b3cca24fde19a1b8cfb2319b1320151`,
operator baseline i oba held intents. Brak aktywnych rezerwacji.
Request `verification/terminal-prestart-recovery-20261027/request-third.json`
SHA256 `34dd8aaf384a77e35edc3ab0e18102d4d080a0da7c3fe26da5da3441b9df9967`.
Pełny wynik `native-prepare-third-status.json` w tym samym katalogu.
Nie wykonano jeszcze reconcile, restartu ani Solve; właściciel c037 i stare
StartedAt obu usług pozostają. Następny krok: kanoniczny preview przez
`just docker-dev-reconcile-iteration`, potem apply i pojedyncze managed resume.

Kontrola hosta potwierdziła około 69,16 GiB wolnego D:, powyżej dotychczasowej
bramki 32 GiB. To pomiar pojemności, nie obietnica rozmiaru kolejnego buildu.


## Zapis poprawki i utrwalenie regresji CI

Commit `837cc5ce8b5fb23114dd96e9cddebe52104b76b4` zapisuje poprawkę private
namespace i dokładnego parsera czasu wraz z 32 regresjami oraz raportem.
Kanoniczny `just docker-dev-reconcile-iteration ... true` zakończył się exit0,
`state=validated-only` dla dokładnego request-third SHA
`34dd8aaf384a77e35edc3ab0e18102d4d080a0da7c3fe26da5da3441b9df9967`.
Zastosowanie recovery jest osobną operacją; ten wynik nie jest dowodem
wznowienia aplikacji ani nowego Solve.

Do istniejącego kroku Docker contracts w bootstrap CI dopięto trzy istniejące
entrypointy: `test_docker_volume_prestart_recovery`,
`test_docker_terminal_prestart_recovery` i `test_docker_volume_reconcile`.
Nie zmieniono job permissions ani wymaganych bramek. Przegląd dokładnych
trzech linii i entrypointów bez Blocker/Required. Lokalna próba uruchomienia
`test_bootstrap_workflow_contract` nie doszła do testów: zachowany obraz
nie ma PyYAML. Istniejący workflow CI instaluje przypięte PyYAML przed jego
własnym testem. Nie zmieniono obrazu ani wymagań dla tej korekty; wynik
walidacji workflow w nowym CI pozostaje wymagany.


## Resume po recovery: backend działa, frontend wymaga odrębnej naprawy

Dla źródeł `c1d0abd675060a3dc5835708f9e85449cc54f40b` kanoniczne apply
terminal-only recovery zakończyło się `failed-confirmed`, bez zmiany historii
naukowej. Terminal c037 ma SHA256
`fd81c95e39a30641cbb74ef3eb971362308ae188872ba9796b82b0ebbe307a3b`.
Uruchomiono dokładnie jeden managed resume:
`42c26e8726dd472780391b98cde2a33b`. Build backendu zakończył się exit0
po 1463739 ms. API health i status zwracają 200, oryginalna scena rev1,
logiczna sesja i terminalny run62d pozostały zachowane. Nie wykonano Solve.

Nowy sealed package receipt ma SHA256
`6bb4a36e630c21dfd1301b65b16dc8b12474a6dbb1eb284b55096b328dd2733c`,
provenance `8278e8437bac6eaade84705f2f5f39812ab9ee4a8160f9ea9d469712c38220ac`.
Backend to ten sam kontener
`cc32cb682ae597e3f6c5e52c5e4372fbfa85a8ec1219bf830e3391b94a43bd1b`,
StartedAt `2026-10-27T21:32:20.056049729Z`. Obraz zachowany.
Rzeczywista natywna kontrola działającego API przez niezmieniony adapter50d
przeszła po 51,101 s: wszystkie dane naukowe, baseline i dwa held intents
zachowane, zero aktywnych rezerwacji. To odczyt/preservation proof,
nie kwalifikacja fizyki ani zakończenie całego resume.

Frontend zakończył się exit1 (bez OOM): jego zamrożony source commit
`540677ddb19452c5ffbdbb63db93c006da950c2f` i seed zależności nie odpowiadają
aktualnym źródłom. Resume42 ma zatem stan
`outcome-unknown-resources-retained`; owner i dane pozostają zachowane.
Nie wolno przedstawić udanego buildu backendu jako sukcesu aplikacji.
Naprawa musi użyć failure-only reconcile oraz jawnego frontend-only refresh,
z zachowaniem backendu i przypiętym rozdzieleniem źródeł aplikacji i helpera.
Nie osłabiono `_source_matches` ani nie skasowano frozen manifestu.
Przegląd przygotowanej poprawki wykazał też konieczność obsługi pinów
przez ścisły wrapper recepty `just`; stan naprawy pozostaje NOT VERIFIED.

Po uruchomieniu nowego API sprawdzono 19 GET przez kanoniczną ścieżkę Saved:
discovery, revision, member, artifacts, trzy datasets, pełne FMDS V/J/H,
geometrię, topologię i support. Wszystkie odpowiedzi 200. Sprawdzono exact
owner/revision/descriptor, zakresy, sumy kontrolne i skończoność danych.
H: 1145x3 A/m, J: 7424x3 A/m^2 na nośniku cell-local, V: 677x1 V.
Surowe payloady są identyczne z zachowanym wynikiem; H ma SHA256
`39a339762e9a80c5374cef4218a93fc48a4b37d77d4091884f4f91edea1ba115`.
Odzyskany run5654 nadal Failed/unassessed i inspection-only.
Geometria H: 1145 węzłów i 6428 Tet4; sprawdzono binarne body i maskę,
nie nadano nowej kwalifikacji representation lub naukowej.

Dowody są w control volume pod
`verification/terminal-prestart-recovery-20261027/`:
`post-build-api-observation.json`, `post-build-live-native-observation.json`,
`post-build-saved-metadata.json`, `post-build-saved-datasets.json`,
`post-build-saved-fields-and-geometry.json`,
`post-build-saved-binary-read-summary.json` oraz zachowane binarne body.
Rzeczywiste renderowanie Saved/WebGL i przekrój UI pozostają NOT VERIFIED.

CI dla c1: Python nie przeszedł jednego nowo włączonego testu, który używał
nieistniejącego `/workspace` na runnerze GitHub przed wejściem w mock.
Minimalna poprawka fixture wskazuje rzeczywisty checkout i zachowuje wszystkie
asercje source refusal/frontend-only/no producer. Stary przypadek odtworzył
błąd; kandydat przeszedł 39/39 interpretowanych przypadków przy diagnostycznie
wymuszonym braku `/workspace`. Scratch diagnostyki znajduje się w exec control
volume, ponieważ kontenerowe `/tmp` ma noexec; nie zmieniono mount policy.
Dowód `ci-boris-source-fixture-diagnostic-exec.json` SHA256
`23fa8d2c5e9f7db8d2eda8be4e178b14a1a7fd09920aa0cb37394d5dbe38023c`.
To lokalny interpreted diagnostic, nie nowy zielony CI. Rust job122483372274 (workflow40587504104)
pozostaje w toku na ostatnim odczycie. PR #247 pozostaje otwarty i niescalony;
pełny zakres E0-E12, kwalifikowana baza/LLG, BORIS i publikacja są otwarte.
