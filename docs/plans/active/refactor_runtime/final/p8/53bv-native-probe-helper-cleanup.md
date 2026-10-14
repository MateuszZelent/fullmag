# P8-53BV — lokalny drain helpera po zamknięciu API

Data: 14.10.2026. Baza `e0a69c483e068da818584bf703497ab46d3299d9`.
Status: **IN PROGRESS**. Dotyczy kontrolnej próby, nie promocji publicznego
restartu ani zmiany solvera.

## Obserwacja runtime

Próba `0fb5bed74c2743e28de9b5009a626d4b`, pakiet b08a5648,
owner bundle `12984ba740244e5e86d8878814069155`, zakończyła się failed,
zero checks. Native reason `restart_pump_outcome_unconfirmed` wystąpił przed
browser-ready i przed replacement API. Zarejestrowano start helpera 157744,
lecz jego wait brakował w terminalnym wyniku. API 127232 ma exit 1, frontend
128868 waited/exit 1. Brak obecnego PID helpera nie jest dowodem historycznego
wait; starego receiptu nie poprawiano ani nie zaliczano.

## Przyczyna utraconego cleanupu

`finalize_outcome` zamyka owned API przed drain pompy. Dotychczasowy drain
wywoływał `step_observed`, który może odczytać consumer status, wznowić attach
lub komunikować się z API. Po shutdown taka zależność może zawieść przed
anulowaniem helpera. Bounded review potwierdziło P1 tej ścieżki.

Nowe `NativeRestartPump::drain_candidate_preparation_for_probe` wywołuje
wyłącznie istniejący cancel/drain posiadanego helpera. Bounded pętla probe
nie odnawia readiness, nie wznawia obserwatora i nie korzysta z zamkniętego
API. Wciąż wymaga rzeczywistych terminalnych danych; unknown pozostaje
unknown. Review bieżącej poprawki: brak P0/P1. Rustfmt/parser i diff PASS.

Pierwotny błąd pompy był dotąd sprowadzany do is_err. Probe zachowuje teraz
error contexts w stderr, bez serializacji requestu, UI payloadu ani tokena.
To ma ustalić pierwotną przyczynę niedostępności readiness; sama poprawka
cleanupu jej nie dowodzi.

## Odbiór

Próba nowego managed native build-only zakończyła się terminalnie w preflight
z exit 2: Git zgłosił `short read while indexing` podczas odczytu zmienianych
plików. Kompilacja poprawki nie została potwierdzona. Nie uruchamiać duplikatu
po timeout obserwacji. Testy jednostkowe Rust/TS nie są kompilowane.
Ramka v2, pełny przebieg browser i A→B→C pozostają NOT VERIFIED runtime.
Publiczny restart pozostaje zablokowany; 3197 nie jest zatrzymywane.

## Aktualizacja checkoutu i kontroli provenance

Ponowny odczyt 14.10.2026: główny checkout, branch `master`, HEAD
`654f07f89742e152024d98fe5b061001d7f347de`. Git wskazuje siedem unmerged paths:
`openapi-v2-types.ts`, `openapi-v2.json`, `sceneModelTreeAdapter.ts`, `justfile`,
`just_storage_shell.sh`, `verify_control_room_sources.py` oraz
`verify_pinned_dataset_browser.py`. Nie są to zmiany tego przyrostu; nie
rozwiązywano ich ani nie ingerowano w index. Nowy build i próba runtime
muszą poczekać na spójny stan tych wejść. W momencie kontroli nie znaleziono
procesów cargo/rustc/fullmag/fullmag-api; nie zatrzymywano żadnego procesu.

Do fingerprintu managed handoff checks dodano produkcyjny
`development_restart.rs`: dotychczas obejmował probe, lecz pomijał samą pompę,
której cleanup zmienia ten punkt. Regresja modyfikuje bajty pompy w izolowanym
fixture i wymaga zmiany source identity. Nie jest dowodem wykonania Rust ani
naprawienia pierwotnego błędu pompy.

Zarządzane interpreted checks uruchomione przez
`python -B scripts/verify_development_handoff.py --repo-root C:\git\fullmag\fullmag`
zakończyły się exit 1 przed utworzeniem receiptu i wykonaniem testów.
Powód: `Storage marker belongs to another project or schema`.
Odczyt markera potwierdza schema `fullmag_storage_v1` oraz project root
`C:\git\fullmag`. Bieżący `resolve_layout` wyprowadza na Windows
`project = main_repo`, czyli `C:\git\fullmag\fullmag`, podczas gdy obowiązująca
governance wymaga katalogu nadrzędnego głównego checkoutu. To konkretna
rozbieżność implementacji i konfiguracji, niezależna od konfliktów w justfile.
Nie nadpisywano markera ani `.env`, nie inicjalizowano alternatywnego storage.
Źródło resolvera ma cudze zmiany w index; jego korekta wymaga uzgodnienia
z trwającą integracją zamiast nadpisania cudzego wariantu. Regresja fingerprintu
jest dodana, ale pozostaje **NOT RUN**. Kontrola AST i scoped diff nie zastępują
jej wykonania ani nowej kwalifikacji runtime.

## Korekta resolvera i terminalna kontrola handoff

Wąska poprawka working tree przywraca `project = main_repo.parent` na obu
platformach i usuwa wyjątek dopuszczający storage wewnątrz checkoutu.
Pozostałe staged zmiany resolvera (Cargo intermediate directory i frontend
container root) zachowano; index nie był modyfikowany. Markera, `.env`,
cache i istniejących danych nie zmieniano. Read-only resolve ponownie zwraca
`C:\git\fullmag` jako project root, `C:\git\fullmag\storage` jako storage
i `C:\git\fullmag\worktrees` jako worktrees root. Bounded review: brak P0/P1.
AST oraz scoped diff check PASS.

Receipt `c0981454e6f14d51963be88fc3f228b8` jest terminalny: **FAILED, exit 1**,
210 testów, zero skips, source before=after
`f52a1d629238200893a318b7c2303e50806801661fe32a62970f9be329fb948e`.
Regresja fingerprintu pompy przeszła. Dwa błędy subcases dotyczą nowych pól
antenowych odrzucanych przez scene asset collector; dwa failure subcases
dotyczą shell guard z exit 127 zamiast 2 przy nierozwiązanej integracji
`just_storage_shell.sh`. Wyniku całego zestawu nie zaliczono.

Checker otrzymał osobny, ograniczony wybór `--suite storage`, uruchamiający
wyłącznie istniejący `test_fullmag_storage.py` z tym samym resolverem,
blokadą, kontrolą źródeł i terminalnym receipt. Domyślny zestaw handoff jest
zachowany; arbitralny suite odrzucany przed resolverem. Fingerprint obejmuje
także fixtures storage. Receipt `033ec368861f4120aab63927a9971ad2`:
**completed, exit 0**, 46 testów, dwa Linux-only skips, 44 wykonane PASS.
Source before=after:
`b12e611436f1106a61779ded5e4765aa07814b2ceb6dabc929b0d86c37e5c529`.
To odbiór resolvera i istniejących regresji storage; nie jest nowym buildem
ani dowodem runtime restartu. P8 i runtime v2 pozostają otwarte.

Końcowy readback Git po tej kontroli nie wskazuje już unmerged paths.
Powyższy wykaz konfliktów dokumentuje wcześniejszą obserwację, nie bieżącą
blokadę. Zachowano obcy staged index; nie wykonywano commita integracji.

## Nowy build po integracji i błąd logowania

Obca integracja zakończyła się commitem
`e116a156e1a094c0fe300ac94d26fb8bb9c44f23`; index był pusty. Zarządzany
`just windows-workspace-build dev dev 3197 true` miał handle 23301 i log
`native-build-cc60b31cd98649968f4789ddb63a4b2d.log` w kanonicznym profilu.
Snapshot źródeł utrwalono jako
`fae9215d708074b88962bf5be9e619ac10505e01b0b18407748dd56ec132093b`.
Build używa trwałej kopii kompilatora, TEMP na R; nadal nie wolno deklarować
wszystkich danych buildu na RAM-disku. Zsynchronizował pakiet Python do
wersji `0.1.0.dev20261014+ge116a156e1a0.dirty.se10319ec3f64`.

Próba zakończyła się terminalnie: wrapper exit 1, just recipe exit 2,
build-status `interrupted` bez child exit_code. Przed Cargo logowanie
pnpm podniosło `UnicodeEncodeError` dla U+2009 w terminalu charmap.
W surowym logu pozostaje także warning `ERR_PNPM_EPERM` podczas pobierania
hookified; naprawa kodowania nie dowodzi naprawienia tej odrębnej odmowy.
Readback nie znalazł już PID 167460 ani instalatora pnpm, lecz nie zmieniano
starego receiptu na completed ani nie dopisywano historycznego wait.

`_run_logged_command` zachowuje raw bytes w logu, a wyłącznie tekst konsoli
dostosowuje do jej encoding przez `backslashreplace`. Dodano regresję real
child → UTF-8 pipe/log → strict cp1252 console, wymagającą rzeczywistego exit 0
i identycznych bytes logu. Managed storage check
`ceefe507a7fb41c497a1205ef1df90f5`: **completed, exit 0**, 47 testów,
dwa Linux-only skips, 45 wykonane PASS. Source before=after
`02996dcb1d8c2ef3fefc2355738363ae0dbf520166b690adc016380be252459c`.
Bounded review poprawki logowania: brak P0/P1. Production build nadal
NOT VERIFIED; po tej poprawce potrzebna jest nowa zarządzana próba.
