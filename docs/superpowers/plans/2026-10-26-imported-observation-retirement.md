# Zamknięcie importowanej obserwacji bez zmiany historii wykonania

## Problem i zakres

Import FMS normalizuje widok do `Completed` / `imported_read_only`, również gdy historyczne wykonanie zakończyło się `Failed`. Bieżący widok nie jest właścicielem tamtego wykonania. Dotychczasowe retirement wymagało jednocześnie natywnego statusu runtime, terminalnego katalogu i dowodów zwolnienia zasobów. Utożsamienie widoku z natywnym sukcesem byłoby błędem.

Poprawka dotyczy wyłącznie prywatnego zamknięcia bieżącej obserwacji. Zwykłe owner restart/drain nadal odrzuca `imported_read_only`. Nie zmieniamy fizyki, solvera, RunIntent, lease, katalogu zadań ani bramki Solve.

## Kontrakt

- Native proof v2 i response v1 pozostają dotychczasową ścieżką.
- Obserwacja otrzymuje proof v3 / response v2 oraz `terminal_outcome = observation_closed`. Oddzielne evidence zachowuje `historical_terminal_outcome` i rewizję katalogu, identyfikatory importu/sesji/runu, hash snapshotu oraz prefiksowaną accepted closure.
- Dowód obserwacji nie może zawierać native accepted proof ani listy zwolnionych rezerwacji. Nie stanowi potwierdzenia sukcesu solvera lub zwolnienia zasobów.
- Źródłem jest wyłącznie dokładny prywatny katalog importera z niesymlinkowanymi, ograniczonymi plikami. Bieżące tożsamości, ścieżki skryptu/artefaktów i kanoniczna scena muszą zgadzać się ze snapshotem importera.
- Kanoniczny `load_imported_study_evidence` weryfikuje detached records i CAS. Transakcja odczytu trwa przez ponowną walidację evidence i synchroniczne czyszczenie wskaźnika. Przed publikacją i replay pozostają blokady admission/transition, pusta kolejka lokalnych komend i terminalny ledger.
- Import bez accepted closure, aktywny/nieznany lifecycle, zmieniony snapshot/CAS, niezgodny poprzednik lub inna tożsamość powodują odmowę.
- Archiwum zachowuje dotychczasowe dokumenty sceny, skryptu i typowanego stanu UI. Cross-incarnation replay nadal wymaga dokładnego poprzednika.

## Mapa źródeł

| Plik | Właściciel kontraktu |
|---|---|
| `crates/fullmag-api/src/imported_observation_retirement.rs` | prywatne źródło importera i walidacja closure pod read fence |
| `crates/fullmag-api/src/live_retirement.rs` | rozłączne authority native/import, wersje dowodów, archiwizacja i replay |
| `crates/fullmag-api/src/router_v2/handlers/platform/development_restart.rs` | wyjątek tylko dla retirement, bez poszerzenia normalnego restartu |
| `scripts/docker_startup_script.py` | zgodne wersje transportu, integralność evidence i przypięty poprzednik |
| `scripts/test_docker_live_retirement.py` | interpretowane regresje transportu |
| `justfile` | opcjonalne udostępnienie istniejącego preflightu zachowania nieuruchomionych Study przy stopie |

## Weryfikacja 26.10.2026

50 interpretowanych kontroli transportu przeszło w kontenerze backendu. Obejmują zachowanie historii Failed/Interrupted/Completed, odmowę mieszania native/observation, wiązanie digestów i tożsamości oraz uszkodzone typy historii w odpowiedzi i manifeście replay. Review wykrył `TypeError` dla listy/słownika zamiast statusu; poprawka i regresje są uwzględnione. Parser Rust przeszedł; testów jednostkowych Rust nie kompilowano.

Rzeczywisty zarządzany build/start aplikacji: `0743c2f8394340f0811cb31f3795ce25`, stan `succeeded`. Grupa `fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1`, konfiguracja `32366b722187be889f86ead5413237ee9018217f71d7c0c3af34780039eb51a1`. Toolchain był cache-hit. Nowy obraz backendu: `sha256:882c856430282311964ba0613e1fa5af39d8e0dd8050319cf890d9b682ac0a8e`. Obraz zawiera dokładnie te same bajty helpera co źródła.

Zwykła iteracja `defe327356bc45fb9a1a1bd40be36b8e` odmówiła restartu z powodu dwóch accepted Studies. Następnie istniejący preflight `allow_prepared_session` potwierdził ich nieuruchomione bramki, a stop `b0d4ee5f026d4d4ca133cb049773ba41` przeszedł. Oba Study pozostały accepted. Nie było Solve ani anulowania w ramach stopu.

Po buildzie API było zdrowe z pustym bieżącym workspace. Prywatny import i snapshot 4 406 696 B pozostały zachowane; oryginalny katalog Failed nadal ma rewizję 673 i SHA256 `a6463a8ebddf1c58532b09d8604d0550b355b36d49f64d7d90f6e421e2a83367`. Nie wykonano rzeczywistego HTTP retirement/replay v3, ponieważ bieżąca obserwacja nie była już otwarta po restarcie. Ta kwalifikacja pozostaje **NOT VERIFIED** i nie może być zastąpiona zielonym buildem.

Logi i częściowe dowody są w wolumenie kontrolnym grupy pod `verification/imported-observation-retirement-20261026/`. Nie usuwano wyników ani cache. Skill `fullmag-build-stage-cleanup` był niedostępny; dane pozostawiono do osobnej, opartej na referencjach kwalifikacji retencji.
