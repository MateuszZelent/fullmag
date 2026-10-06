# P8-53BC — odmowa restartu podczas rzeczywistego solve

Status: **IN PROGRESS**, 06.10.2026. Poprzedni prerequisite:
[P8-53BB](53bb-frozen-active-run-prerequisite.md), commit
`5e3caefe62d23067907d6eb4eed8be9532ace0ff`.

## Bramka

Zweryfikować odmowę przez produkcyjny `NativeRestartPump` i
`ControlRoomGuard`, gdy rzeczywisty FDM CPU solver już działa. Osobne API,
scratch model, utrwalony pakiet i własne procesy; workspace użytkownika
pozostaje poza fixture. Publiczny restart nadal jest wyłączony.

Sam POST `/v2/platform/development-restart-requests` i odpowiedź 202 dowodzą
zapisania intentu, nie kontroli idle. Ogólny wynik `restart_preparation_refused`
nie identyfikuje przyczyny. Istniejący frozen active-run driver nie posiada
restartowego pumpa, a obecne native consumer cases nie obejmują realnego runu.

Dodawany diagnostic case `active-run` musi używać tego samego zarządzanego
API dla ownera, pumpa i rzeczywistego solvera. Nie wolno zastąpić solvera
sztucznym lease ani uznać odmowy z innej przyczyny za spełnienie bramki.

## Kryteria wyniku

1. Przed intentem: żywy własny proces solvera, `running`, `solver_steps > 0`,
   zapisane API instance/session/run.
2. Pump konsumuje intent. Dowód wskazuje konkretną odmowę aktywnego runu
   przy `owner.acquire`, nie dowolny błąd przygotowania. API już na tej
   wcześniejszej granicy wymaga idle scratch lub terminal run
   (`development_restart_not_safe`). Nie osłabiamy tej kontroli, aby dojść
   do późniejszego `acquire_cold_idle`; handoff nie powinien być staged.
3. Nie występuje wyjście starego API ani uruchomienie replacement.
4. Wynik intentu jest failed. Stare API, sesja i run pozostają te same,
   worker żyje. Po potwierdzonym failed wykonujemy nowy baseline licznika
   (`solver_steps_at_refusal`), a następnie wymagamy kolejnego wzrostu:
   `solver_steps_after > solver_steps_at_refusal >= solver_steps_before > 0`.
   Kroki wykonane tylko podczas obsługi intentu nie dowodzą kontynuacji
   po odmowie.
5. Każdy własny proces ma terminalny wait/exit albo jawne unknown.
   Deadline bez wymaganego postępu nie jest PASS.

Running i paused, deterministyczny wyścig Start/freezing oraz kwalifikacja
naukowa pozostają oddzielnymi dowodami. Ta fixture dotyczy już działającego
running runu i nie zamyka pozostałych bramek.

## Zakres źródłowy

Private control obecnie zamyka odrzucone połączenie (`reject(stream)`) bez
przekazania szczegółowego `ApiError`. Kod `development_restart_not_safe`
jest więc dowodem źródłowym, nie obserwacją z połączenia. Diagnostic musi
najpierw wykonać pozytywną kontrolę tego samego ownera na idle i abort oraz
potwierdzić readiness. Późniejsza odmowa przy running wymaga zapisania tej
granicy i postconditions; nie wolno deklarować zmierzonego kodu przyczyny,
którego protokół nie udostępnia. Wymóg dokładniejszej atrybucji pozostaje
otwarty, jeśli te dowody nie wykluczą innych przyczyn.

- Nowy child module `crates/fullmag-cli/src/control_room/development_active_run_probe.rs`.
- Minimalny dispatch w `control_room.rs`, bez poszerzania widoczności
  prywatnych typów i bez zmiany produkcyjnej polityki restartu.
- Managed driver, receipt i frozen binding: do podpięcia po ustaleniu
  kontraktu wejściowego native case.

Implementacja diagnostic nie jest jeszcze dowodem runtime. Wymagane są
produkcyjna kompilacja przez natywną zarządzaną receptę, review i rzeczywista
próba z wynikiem oraz custody. Kompilowanie Rust unit tests pozostaje zakazane.

## Managed wejście

Recepta: `just verify-windows-development-active-run-refusal <owner_bundle>`.
Wrapper wymaga Windows i dokładnego 32-znakowego lowercase hex bundle ID.
Git Bash syntax check i dry-run z poprawnym ID: PASS. `INVALID` został
odrzucony przed driverem, exit 2 wrappera (just exit 1).

Native stdin schema: `fullmag.development-cli-active-run-request.v1`,
z pinami owner bundle/manifest/source oraz ready build/source. Wynik:
`fullmag.development-cli-active-run-check.v1`. Rodzic dostarcza własną fixture
przez `FULLMAG_DEVELOPMENT_ACTIVE_RUN_SCRIPT`, zarządzany interpreter i
frozen `PYTHONPATH`. Native kontroler B uruchamia solver i API z tego samego
bundle A, podczas gdy przygotowany kandydat restartu pochodzi z B.
Interpreter i DSL z frozen B są osobno identyfikowane w receipt; nie
udajemy historycznego środowiska Pythona A.
Driver musi zweryfikować ABI/import przed startem; nie wolno użyć bieżącego
DSL jako cichego fallbacku.

Epoka intentu pochodzi z bieżącego
`GET /v2/platform/development-backend → workspace_identity.session_epoch`
(u64 odczytany pod transition lock), zgodnie z istniejącym frontendowym
producerem. Nie jest parsowana z prezentacyjnego scope epoch statusu i nie
jest wymyślana z czasu systemowego. Brak managed workspace identity musi
zakończyć diagnostic odmową.

## Review źródłowe w trakcie implementacji

- Baseline sprzed intentu nie wystarczał: kroki wykonane podczas refusal
  mogły dać false PASS po zatrzymaniu solvera. Dodano wymaganie osobnego
  `solver_steps_at_refusal` i strict advance po tym pomiarze; regresja ma
  odrzucać `after == at_refusal > before`.
- `CandidatePreparationStarted.helper_pid` jest PID-em selectora,
  obecnym już w verified candidate helpers. Odrzucanie membership blokowało
  prawidłową ścieżkę przed startem solvera. Wymagana jest membership i jeden
  terminalny record na helper PID, bez fikcyjnego czwartego helpera.
- Pin ready build to lowercase SHA-256 (64 znaki), nie 40 znaków.
- Parent budget diagnostic musi obejmować sumę ograniczonych etapów native;
  osobny budżet active case nie zmienia timeoutów produkcyjnego klienta API.

Te poprawki i źródłowe review nie ustanawiają PASS runtime. Kolejny wynik
musi pochodzić z pakietu zawierającego ten diagnostic.

## Stabilny przyrost i kompilacja

- Native moduł: SHA-256
  `90bec6cdd5fd8897396f9dbc3e24dd3672b39f235360e4c899f81f61e75adb0a`;
  `rustfmt --check` exit 0. Review stabilnego modułu i minimalnego dispatchu:
  brak pozostających actionable findings. Obcy hunk w consumer fixture
  pozostał poza zakresem.
- `python -B scripts/test_windows_active_run_refusal_contract.py`: PASS,
  w tym odmowa `after == at_refusal > before` i niepotwierdzonego exit.
  Istniejące readiness progress regresje: **9/9 PASS**. AST/help: PASS.
- Frozen binding obejmuje manifest, snapshot, interpreter, import i fixture;
  po próbie są ponownie sprawdzane. Parent budget active case: 360 s;
  readiness zachowuje 240 s.
- Managed build uruchomiony przez `just windows-backend-dev 3197`, handle
  `35972`, log `native-build-072bda1b6f53444f95d81b9f6519af30.log`.
  Źródła utrwalono w `source-snapshots/122fba05e6b9c12371c22f2e892becaf326e3f14cd02dd13072de3d36c287971/source`.
  Log potwierdza TEMP na R: i jedną trwałą kopię kompilatora na C:.
  Wynik kompilacji i realnej odmowy restartu pozostają do odczytania.

Pierwszy build (`072bda...`, handle 35972) zakończył się terminalnie exit 1:
jedyny compiler error `E0596` dotyczył `confirm_held(&mut self)` przy
niemutowalnej lokalnej deklaracji acquisition. Poprawiono ją na `let mut`;
review potwierdziło zgodność z sygnaturą. Finalny source hash modułu:
`734e2fc9ccd849f1756cdbbd65f068a79305af5edf9d48d4ac7d4d44c4ed3513`.

Drugi managed build: handle `50659`, log
`native-build-4d2fd88ed01e4c0ba0fa823eb4f8e7db.log`, snapshot directory
`88be84d4a023d9d936a117161e46896fab7e9abf0a63280abf322db557df4d99`.
Wersja źródeł: `0.1.0-dev.20261006.g5e3caefe62d2.dirty.sd0520c96c717+9775`.
Stan końcowy tej próby pozostaje do odczytania; nie uruchomiono drugiego
buildu, dopóki pierwszy handle nie potwierdził terminalnego błędu.

Drugi build: **PASS, exit 0**. Cargo API/CLI: 40,04 s; desktop: 48,16 s
(czasy samych etapów, bez preflightu i przygotowania wejść).
Manifest SHA-256: `3122465a06427f3ab044abe9bc1e16d1f0d313c7d3988d4a0633823c1196fb5f`.
Backend source: `d88abc71b4b8de4986accb4bb57d0da15daacf8007e7755d36f606f153657240`.
Source snapshot: `d0520c96c71738cf232d518ceed4eb6e8c394ee199322d44c29f17fd25f282c6`.
Manifest potwierdza TEMP na R: i `compiler_inputs_enabled=false` (źródła na C:).

Realna próba uruchomiona przez
`just verify-windows-development-active-run-refusal efc0a57a5be44d8894eee537d9b86298`,
handle `27088`. Jej stan końcowy pozostaje do odczytania; sukces buildu nie
ustanawia PASS tej bramki.

Pierwsza runtime próba: receipt `6833925b93c54255b013357f6db50041`,
**failed, exit 1**, przed startem solvera. Pierwotny native błąd:
`active-run owner acquisition did not observe empty idle state`.
`WorkspaceResponse::NoSession` ma `state=no_session` i `session_epoch`
bez zagnieżdżonego `identity`; diagnostic szukał epoki w tym nieistniejącym
obiekcie. Odczyt poprawiono zgodnie z serializowanym typem.

Driver dodatkowo zamaskował pierwotny błąd wymaganiem solver-start frame
przed zebraniem reszty custody. Ta ścieżka błędu wymaga osobnej poprawki:
brak solvera przed startem jest dopuszczalny w failed trace, nigdy w PASS.
W logu helper PID 79864 ma waited/exit 0. Python probe PID 111644 i
initializer PID 113460: waited, exit 0; native CLI PID 70788: waited, exit 1.
API PID 114492 nie ma wyemitowanego terminalnego wait. Niezależny odczyt
Windows potwierdził jego brak i zamknięty listener 63030; nie dopisujemy
historycznego wait do receiptu. Custody pozostaje niepotwierdzone w nim.

Poprawka drivera wczesnej awarii: wszystkie dostępne API/helper frames są
zbierane przed zgłoszeniem błędu CLI. Zero solver-start jest dopuszczalne
tylko dla błędu/timeout; PASS nadal wymaga jednej poprawnej ramki i pełnego
wyniku. Pierwotny `Error:` jest zachowany w ograniczonym komunikacie,
a niepotwierdzone procesy mają `waited=false, outcome=unknown`.
Nowa regresja active-run: PASS; istniejące readiness 9/9 pozostają PASS.

Trzeci managed build po poprawce acquisition: handle `89777`, log
`native-build-ef2290a70e0a40fc8b48fba1868f12ff.log`, snapshot directory
`4c646876d996306ebbbd8f2460ccb2c127ae3c10181a2d6aaffac29db41b2558`.
Wersja `0.1.0-dev.20261006.g5e3caefe62d2.dirty.sbfecf5160910+9775`.
Wynik tej próby oraz kolejnego runtime pozostają niepotwierdzone.

Trzeci build: **PASS, exit 0**. Cargo API/CLI: 37,69 s; desktop: 49,19 s.
Pakiet używany w ponowionej próbie:

- Manifest: `38982e6065dd92e92b2c3b4db8b49c0eec7fd195d80ec1ac0ac0e3b2a0c25931`.
- Backend source: `9f471261db63f09a53590e8a1dc550e4720a063bad06ed4696ac586dfbaae402`.
- Source snapshot: `bfecf5160910e8d4b35fc6463ad2601e57c8a984ef0179f91561ce6395fcd7bb`.

Ponowiony runtime: ta sama managed recepta i A bundle,
nowy handle `40721`. Wynik pozostaje do odczytania.

Druga runtime próba: receipt `13c4be5661e34099be714e2fbe86dd80`,
**failed, exit 1**. Empty acquire/abort oraz przygotowanie B przeszły;
solver B PID 107964 zakończył się przed publikacją runu, ponieważ zgodność
API wymaga równości wkompilowanego commita i snapshotu CLI/API.
API A miało PID 44332, port 22773. Niezależny odczyt potwierdził brak obu
procesów i zamknięty listener; terminalnych wait fixture nie wyemitowała.
Helpery PID 100776, 25644, 47824 mają terminalne exit 0 w receipt.

Poprawka odtwarza właściwy scenariusz starego działającego runtime:
solver `fullmag.exe` jest siblingiem API w tym samym verified bundle A,
przygotowanym przez `launch.configure_candidate_command`. Usunięto
`FULLMAG_ATTACHED_SESSION_ID`, aby nie omijać kontroli zgodności. Solver
ma własny state directory. Receipt osobno zapisuje EXE/path/hash/source A
oraz interpreter/source/import/fixture B; po próbie ponownie waliduje bundle A.
Nie zmieniono kontroli zgodności produkcyjnego CLI/API.

Po zmianie: active-run kontrakt PASS, readiness 9/9 PASS, rustfmt check PASS.
Czwarty managed build: handle `19212`, log
`native-build-ac30032ee46f4a979f9733a61a2c04ad.log`, snapshot directory
`a65297df327c84c2690b88513d8618a34f2928412a8ddf7067a82ddf606f8606`.
Wynik tej kompilacji i realnej odmowy restartu pozostają do odczytania.

Czwarty build: **PASS, exit 0**. Cargo API/CLI: 38,02 s; desktop: 50,19 s.
Manifest: `faea964e4f312ae6775d3c441c1db82434ade7c434ac70230fa1bbb62294caa4`.
Backend: `a167dba0882b7ebaf578cc287551d5e5fd19c9353a30e3ca444967cfc00190a5`.
Snapshot: `ccfcf8d036ba123ef1349915c5a3587fd66e2ee7b9ba09459dd11ec305956063`.

Trzecia runtime próba (handle 12717): receipt
`37b80a282ae04b85b363e75d189512ec`, **failed, exit 1**, przed startem solvera.
Selector zakończył się unavailable, a diagnostic osiągnął candidate deadline.
Ogólny komunikat helpera nie zachowuje dokładniejszej przyczyny.
Niezależnie potwierdzono niespełnioną bramkę pojemności tego samego selectora:
EXE wymagają 240 144 896 B, headroom 67 108 864 B, razem 307 253 760 B;
dostępne było około 150 MB. Nie obniżamy tego progu i nie przenosimy
trwałego bundle na ulotny RAM-disk.

Po zakończeniu handle potwierdzono brak API PID 114492 i helpera PID 57548
oraz zamknięty listener 30816. Runtime pozostaje **NOT VERIFIED**.

## Konkretna propozycja odzyskania miejsca

Do akceptacji operatora wskazano wyłącznie
`storage/builds/fullmag-0950f4dca4ffe38f/windows-native-fdm-cpu-dev/compiler-inputs`:
7578 plików, 310 510 987 B logicznych danych, bez reparse points.
Przykładowy `Cargo.toml` ma jeden hardlink według fsutil; rzeczywisty odzysk
musi zostać zmierzony po usunięciu, nie jest gwarantowany przez sumę długości.
Brak aktywnego Cargo/rustc i zakończone własne próby.

Marker `record.json`: schema `fullmag.windows-compiler-inputs.v1`,
snapshot `a65297df327c84c2690b88513d8618a34f2928412a8ddf7067a82ddf606f8606`,
inventory `2709b813bf98ebea9c57bc24b1a46b5ef6fd3832f5c345671185f3baa1052c60`.
Oryginalny source snapshot/record, EXE, receipts, logi, sesje i target/cache
Cargo pozostają zachowane. Usunięcie całej odtwarzalnej kopii wymaga
odpowiedzi operatora; samo oczekiwanie nie jest zgodą.
