# Recovery mastera po ponownym uruchomieniu WSL

Cel: zachować bieżącą sesję i wyniki, uruchomić `fullmag-master` na 3198 i sprawdzić w przeglądarce picker Quantity Source Airboxa bez Solve/Compute Fields.

## Uzgodniony podział

Ten branch odpowiada za jawne ponowne przyjęcie obecnego magazynu Linux po zmianie `st_dev`; zwykłe strażniki pozostają ścisłe. Branch `codex/docker-session-recovery-20261027` odpowiada za natywne odzyskanie zatrzymanego runtime i terminalnych runów. Nie edytujemy jego modułów runtime ani offline reconciliation. Grupa master pozostaje wyłącznie w zakresie tego zadania.

## Kontrakt

Legacy certyfikat nie ma UUID filesystemu. Readmisja nie udaje historycznego dowodu UUID: jawnie przyjmuje wskazany istniejący store. Zachowuje ścieżkę, inode, engine, owner token, image i provenance; dopuszcza wyłącznie przypiętą zmianę numeru urządzenia. Bieżący UUID zapisuje jako nową obserwację.

Przed publikacją wymagane są: zarejestrowane źródła/grupa, dokładne piny attempt/config, stopped backend/frontend i ich obrazy, brak innych aktywnych konsumentów magazynu, SHA surowych cert/marker/probe/sentinel/restart oraz natywnego ownera/process receipt. Operacja grupy i blokada OWNER muszą objąć ponowną walidację i oba zapisy. Readmisja nie zmienia natywnego OWNER, runów, leases ani journalu i nie ogłasza drain.

Najpierw zachować niezmienione bajty dowodów w control volume i manifest prepared. Potem opublikować identyczny certyfikat i marker zmienione tylko o host_device, wykonać readback i receipt committed. Przerwanie między zapisami pozostaje fail-closed; osobna przypięta kontynuacja nie może nadpisać archiwum. Zwykły start nadal odmawia rozbieżnych dokumentów. Po readmisji wymagany świeży zarządzany storage probe przed API, ponieważ stary probe przypina surowy certyfikat i namespace.

## Kolejność i dowody

1. Czysta walidacja readmisji i regresje Python: obcy token/inode/engine, dodatkowe różnice, symlink, zmiana bajtów po planie, brak/zmiana sentinel, błędne piny muszą blokować operację.
2. Przypięty kontroler readmisji z trwałym archiwum i wznowieniem; review przed mutacją. Bez kompilowania testów jednostkowych.
3. Zintegrowana natywna ścieżka odzyskania bez sztucznego stop journalu i bez Solve. Jeżeli brakuje obsługiwanej ścieżki, pozostawić blokadę i wskazać dokładną brakującą bramkę.
4. Build i start przez launcher Compose wybranego mastera; dowód źródeł, grupy, receiptu i świeżego probe. Zachować sesję i wyniki.
5. Przeglądarka: realny Airbox Quantity Source zawiera H_demag/H_eff/H_ext i wyklucza m. Zapisać disabled/reason niezależnie od obliczenia pól, screenshot i WebGL canvas/context/buffer.

Aktualny stan: diagnoza potwierdzona, brak mutacji runtime i certyfikatów; implementacja rozpoczęta. Dane buildu i receipty pozostają w Dockerze. Hostowy dokument zawiera wyłącznie plan operacyjny.

## Checkpoint walidatora

Commit `350cce8fd330c52461a87a7caeaca66b8f3bc4a8`: czysty planner i CAS readmisji. 18 regresji Python PASS; planner na rzeczywistych niezmienionych dowodach mastera PASS (wyłącznie odczyt). Żaden certyfikat, OWNER ani store nie został zmieniony. Kontroler publikacji i abrupt-stop nadal w implementacji.

## Checkpoint kontrolerów

- `6c388f394d7ce649c74f8b7a04e9bb008c05fb5d`: operator v2, autentyczny abrupt-stop proof, request v3, przygotowanie bez startu i kwalifikacja aliasów zarejestrowanych grup. Regresje hostowego recovery, wrappera i mapowania zielone; dwa P1 review poprawione i ponownie przejrzane.
- `feb092575b44ac075bd77457a45a1facf0dd8d78`: bridge v3, faktyczny binary capability gate i atomowy immutable proof. 19 testów runtime service i 5 istniejących bridge PASS. P2 publikacji po częściowym zapisie poprawiony. Native v3 dostarcza skoordynowany branch; jego integracja jest osobną wymaganą bramką.
- Kontroler readmisji: 15 regresji Python PASS; review wyścigu RELEASED i klasyfikacji unknown poprawione. Jeszcze bez wykonania na runtime.

Odczyt magazynu wykazał 17 runów: 2 cancelled, 3 failed, 10 succeeded i 2 accepted. Po audycie właścicieli wycofano propozycję anulowania dwóch przyjętych runów; nie zmieniamy ich statusu i nie rozszerzamy v3 do accepted. Zachowano inwentarz 1240 plików (około 1,55 GB), SHA 44 katalogów runów/artefaktów oraz metadane plików. Wstępny odczyt nie wykazał innego compute attempt niż bieżący catalog.

Kwalifikacja obcych konsumentów pozostaje ścisła: odrębne aliasy są dopuszczane dopiero po potwierdzeniu źródeł. Sześć aliasowych konsumentów spoza Fullmaga wymaga osobnego dowodu odrębności. Nie są zatrzymywane. Walidator kernelowego dowodu tylko do odczytu został dodany i przeszedł 19 regresji Python; pojedynczy rzeczywisty probe odrębnego mountu pliku zakończył się decyzją disjoint. Pełny dry-run pozostaje osobną bramką.

Master API, świeży probe i UI Airbox: nadal NOT VERIFIED; nie uruchomiono Solve ani Compute Fields i nie zmieniono certyfikatów, natywnego OWNER ani danych magazynu.

## Korekta po audycie właścicieli: zachować ręcznie przygotowane modele

Propozycja anulowania dwóch Accepted została wycofana przed wykonaniem. Jeden run pochodzi z celowo zachowanego podglądu głębi viewportu, drugi z podglądu Inspectora Airboxa w innym czacie. Ten drugi nadal jest wskazany przez checkpoint schedulera preparation. Nie ma podstaw uznać ich za zbędne; brak żywego kontenera nie oznacza porzucenia modelu. Oba mają typed manual-start policy, brak start_release.json, zero compute lease/admission i zakończone przygotowanie. Wszystkie dotychczasowe runy, statusy, checkpointy i wyniki pozostają niezmienione.

### Warianty i decyzja techniczna

Anulowanie zmienia intencję właścicieli; świeży store narusza zachowanie sesji, a pominięcie runów omija inventory. Pozostawienie mastera stopped jest bezpiecznym stanem do czasu kwalifikacji. W ramach autoryzowanej naprawy zachowującej sesję wybieramy osobny, wąski kontrakt v4 dla manual-held Accepted. Dotychczasowe v1/v2/v3 nie są rozluźniane.

### Request v4 i warunki przyjęcia

- schema runtime_service_container_recovery_request.v4; istniejące piny owner/config/launch/store/ledger/Docker namespace bezzmian.
- retained_terminal_runs: 0..128 pinów v3; retained_held_manual_runs: co najmniej jeden pin {run_id, run_intent_sha256, run_catalog_sha256, start_release: absent}. Cancelled list nieobecna; suma rozłącznych list dokładnie pokrywa inventory, łącznie najwyżej 128.
- Held wymaga poprawnej immutable manual policy, braku release, tasków Accepted/Blocked bez attempt/resource/resolved input/coordinator/artifact IDs. Cancellation intent, compute lease/admission/journal blokuje operację. Immutable CAS oraz terminalne preparation receipts/exit proofs/released leases są walidowane pod natywnymi blokadami.
- v3 validator nadal wymaga pełnego terminal inventory. Tylko wewnętrzny per-run validator i bounded inventory mogą być współdzielone z v4; nie wywołujemy v3 na niepełnym podzbiorze.
- Scheduler references są sprawdzane względem sumy obu list. Nie czyścimy checkpointów. Compute scheduler i API restore korzystają z istniejącego durable manual gate; recovery nie tworzy start_release ani nie odtwarza script/Compute/Fields.
- Oddzielny outcome retained_manual_held_runs_recovered; host, bridge, absence/replay i faktyczny native capability probe muszą jawnie obsługiwać v4. Brak wsparcia blokuje bez fallbacku.

### Odbiór

Źródłowe regresje negatywne obejmą automatic policy, release, claimed/queued task, cancellation intent, input CAS drift, niepełny inventory, aktywne zasoby i błędne checkpoint references. Lokalny zakaz kompilacji unit tests pozostaje; użytkownik dopuścił wymagane testy tej skoordynowanej naprawy wyłącznie w GitHub CI, co potwierdzono przez odczyt bezpośredniej odpowiedzi.

Po zarządzanym starcie trzeba osobno potwierdzić: te same 17 runów, dwa nadal Accepted/manual-held, identyczne wyniki i checkpointy, ten sam model/sesja, waiting_for_solve, brak release i brak Compute/Solve. Preparation jest przez istniejącą politykę dopuszczone, więc jego ewentualny ponowny start wymaga osobnej obserwacji; nie będzie przedstawiany jako brak jakiejkolwiek pracy. Dopiero potem kontrola Quantity Source Airboxa i WebGL.

## Checkpoint wspólnej ścieżki host/bridge

Przed odrębną integracją host/bridge dodano kernelowy dowód odrębności obcych bindów, archiwizowany pod operacją grupy przed mutacją, i użyto wspólnego obserwatora zatrzymanego bridge. Review nie wykazało nowych P1/P2. Regresje Python helpera: 19 PASS; kontrolera readmisji po poprawkach opaque EngineID, RFC3339Nano na Python 3.10 oraz braku /state we frontendzie: 23 PASS; abrupt-stop: 19 PASS. Wcześniejsze zielone suite pozostały aktualne dla niezmienionych modułów. Nie wykonano publikacji readmisji ani odzyskania native runtime.

Wariant v4 jest kolejnym etapem: rzeczywisty zestaw terminalnych referencji CAS przekracza agregat 128 MiB v3, więc v4 wymaga własnego ograniczonego budżetu agregatu 1 GiB przy zachowaniu limitu pojedynczego obiektu 128 MiB i niezmienionych limitów v1/v2/v3. Katalog całego store oraz CAS muszą być sprawdzane względem sumy terminalnych i held runów. Niepodłączony moduł v4 nie należy do pierwszego PR host/bridge.

Pełny rzeczywisty dry-run kontrolera readmisji zatrzymał się bez zapisów na działających obcych kontenerach z literalnymi ścieżkami Windows w Docker Mounts.Source. Bieżący adapter nie kwalifikuje tych ścieżek na Linux/WSL. Bramka pozostaje fail-closed; należy dodać osobny kwalifikowany adapter albo uzyskać naturalne zatrzymanie tych konsumentów przed execute. Nie jest to podstawa do ich zatrzymania lub pominięcia.

## Checkpoint v4 przed CI

Etap host/bridge zapisano w `b19d561f1c7a709902a17693039df59bdd7f5998`; po integracji bazy master wynikowy HEAD to `6f2f233db7be7b4a8a87f5bf4e01a53724a2d508`, PR #301. Readmission nadal nie została wykonana.

Natywne v4 dodano jako osobny etap źródeł: pełny union inventory/CAS/checkpointów, fixed budget 1 GiB, manual-held validator, outcome/replay/absence i pure capabilities. Niezależne review sześciu plików Rust nie wykazało P1/P2. Przygotowano 16 nowych testów; lokalnie wykonano wyłącznie parser/formatowanie oraz kontrole źródeł i diff. Kompilacja i wykonanie testów Rust wymagają osobnego CI; nie są zgłaszane jako PASS. Workflow zawiera osobną bramkę held module i testów manual_held.

Ponowna kontrola magazynu po tych pracach: identyczne metadane wszystkich 1240 plików oraz SHA-256 44 katalogów, zero driftu. Przygotowano lokalne piny 15 terminalnych i 2 held runów; żaden status, release ani checkpoint nie został zmieniony.

Badanie adaptera Windows wykazało potrzebę natywnej atestacji wolumenu, reparse/hardlinków oraz backing images. Nie wprowadzono niekwalifikowanej translacji ścieżek. Koordynator nie ma ownership pięciu blokujących grup; pytanie o rozszerzenie kontaktu z ich właścicielami pozostaje oczekujące. Nie zatrzymano żadnej z nich.

## Integracja hosta i weryfikacja natywnego v4

PR #301 scalono jako `953753d4cfa537f230dc618583733449f7f12892` po sukcesie wszystkich workflow. Główny checkout `master` zaktualizowano fast-forward; obca zmiana submodule została zachowana. Nie uruchomiono buildu aplikacji ani runtime.

Natywne v4 zapisano jako `748273aeda0a223e45e75905b0f4cbc9c827e2b6` i skierowano do PR #302. Workflow bootstrap 3024 (`40604607571`) zakończył się success; jawne terminal recovery, retained manual-held oraz accepted Compute start-gates przeszły w GitHub CI. To dowód dla tego commita, a nie dla rzeczywistego store lub późniejszych zmian hosta.

Rzeczywisty snapshot tylko do odczytu wykazał brak published artifact refs w dotychczasowym hostowym zbiorze CAS. Poprawka ma uwzględniać wyłącznie przypięte katalogi artefaktów i zgodne task/attempt/epoch/resource/released-lease, bez zbierania dowolnych referencji z payloadów. Kolejna próba nie opublikowała proof i zakończyła helper; jego limit 64 MiB nie pozwala materializować całego obiektu 81 MiB. Kontrola CAS otrzymuje ograniczony odczyt strumieniowy, zachowując hashowanie, limity i identity-before/after. Wynik pełnego snapshotu nadal wymaga potwierdzenia.

Historyczne ownership pięciu blokujących grup ustalono w trzech sesjach Claude Code. Kontakt przez Claude Desktop zablokował błąd integracji narzędzia GUI; nie użyto nieudokumentowanego IPC, nie wznowiono sesji i nie zatrzymano grup. Użytkownik zezwolił na rozszerzoną koordynację, ale nie na stop/restart. Przekazanie pytania do właścicieli pozostaje wymaganą informacją do wyznaczenia okna recovery.

### Wynik końcowego snapshotu hosta v4

Po kontrolowanej zbiórce published artifact refs i strumieniowym SHA rzeczywisty isolated readonly helper zakończył się kodem 0, bez stderr. Pełny snapshot obejmuje 17 runów i 1240 plików; nie opublikowano recovery ani nie zapisano native store, nie uruchomiono aplikacji. Piny pozostają podzielone na 15 terminalnych i 2 held runy.

Regresje po ostatnich zmianach: abrupt-stop 24, prepare wrapper 8, bridge v3/v4 15, legacy container recovery 13, legacy runtime bridge 5 — wszystkie PASS. Test strumieniowego hashowania obejmuje 81 MiB przy limicie pamięci subprocessu 64 MiB, drift mtime i oversized object. Niezależne review protokołu i snapshotu nie wykazało dalszych P1/P2 po naprawie obecności held field przy v3.

Adapter Windows–WSL ma osobny ownership w skoordynowanym zadaniu sprzątania Dockera, które otrzymało bezpośrednie polecenie użytkownika dokończenia tego adaptera bez przerywania innych zadań. Ten etap nie zawiera niekwalifikowanego adaptera ani migracji; małe call sites zostaną uzgodnione po jego kwalifikacji. Recovery mastera, build/start i browser Airbox nadal NOT VERIFIED.

## Checkpoint strażnika aliasów przed wpięciem Windows

PR #302 scalono jako `2c67d8f904b1dede9268bbbc8bf6257cbe33aa4f`; main i zachowany worktree przeszły fast-forward do tego wyniku. Następna kontrola ujawniła dwie luki hostowego guarda: znany surowy alias store nie był porównywany jako chroniona ścieżka, a ścieżki namespace Docker Desktop mogły przejść porównanie leksykalne jako lokalny POSIX. Reprodukcje wykazały brak wymaganej odmowy przed poprawką.

Poprawka dodaje raw alias i jego przodków/potomków do wczesnej ochrony przed resolverem; Docker Desktop drive namespaces wymagają odrębnej atestacji, bez lokalnego fallbacku. Review ujawniło dodatkowo wariant `//`; jest odrzucany jako niekanoniczny przed każdym resolverem. Readmission 25/25 i abrupt-stop 25/25 PASS, niezależny review bez otwartych P1/P2. Wyjątek dokładnie uwierzytelnionego własnego helpera oraz obecne canonical/kernel proof pozostają zachowane. To checkpoint fail-closed; nie kwalifikuje jeszcze adaptera Windows.

Adapter drugiego zadania ma już wykonalny odczyt actual mount przez same-UID, cap-drop-ALL observer i pełne VPD83 GUID jako powiązanie VHDX, lecz nadal wymaga negatywnych testów oraz kwalifikacji całości. Nie ma zgody na stop/restart cudzych grup, a migracje pozostają na ich kolejne świadome uruchomienie.

Podczas dalszych odczytów silnik Docker stał się niedostępny. Jeden odczyt `info` potwierdził brak połączenia; ten wątek nie wysłał stop/restart/down/start usług. Stare PID/incarnation/backing observations nie kwalifikują przyszłego wykonania po tej zmianie stanu. Przed runtime wymagane są świeże dowody; sesja i wyniki pozostają bez mutacji z tego zadania.

## 28.10: osobny kontrakt izolowanego snapshotu

Użytkownik jawnie zlecił naprawić blokadę i uruchomić mastera bez zatrzymywania
innych grup. Wybór: ADR0073, nowa zweryfikowana kopia zamiast rozluźniania
Windows guards. Stary store/OWNER/certyfikaty pozostają bez zmian.

- [ ] Native readonly retained-snapshot validation CLI i CI (worker Luna).
- [ ] Typed namespace receipt/resolver oraz testy (skoordynowany czat sprzątania).
- [ ] Bezpieczna kopia danych + manifest i hostowy operator jednej grupy.
- [ ] Podpięcie namespace, admission kopii i native gate przed API.
- [ ] Review, wymagane CI, integracja mastera.
- [ ] Rzeczywiste recovery/master build/start, porównanie historii i UI Airbox.

To plan, nie wykonana migracja. Nie wykonano snapshotu ani nowego startu.


## Checkpoint izolowanego importu i wyboru modelu — 28.10

PR #307 zawiera nową oddzielną authority: pełna kopia pod source WRITER/OWNER
oraz wyłącznym OFD SQLite lock, nowy namespace/ledger, hashe faktycznych payloadów
przed natywną walidacją readonly i OWNER/API. Stare admission/reattach nie są
rozluźniane. Oryginał pozostaje niezmieniony, dwa held runy zachowują manual gate.

Historia activation potwierdza ostatni succeeded `31e9e383af124fa680392b583c7c0a49`
(request `master-ui-preview-20261026`, źródło `examples/airbox_inspector_mixed.py`,
SHA `cf0e9604ba159e4b5c67e4d55903d13de8da2f61689ac1f1e9778ad497517fdc`,
backend `822ce222f6d3117ecee7da37d65d3333901928a9fc3645726ae22b3cd3c24826`,
development attempt `9fcc2458f15a4318ad2f59c8c445c206`). Odpowiada immutable
RunIntent `run-live-b781c7576b7635f5aa93ebcc93723be13aa91537bfb958c7a137d79ff4e71dca`.
Późniejszy YIG `0e4ed56cdff64a09bbdc9be367e8b918` ma failed-confirmed
`live_retirement_busy` przed mutacją. Nie traktujemy activation/current jako
successful ani nie wybieramy modelu wyłącznie według wieku pliku.

Kwalifikacja kopii, końcowego admission, buildu, GPU i browser nadal NOT VERIFIED.
Nie zatrzymano innych grup. Nie uruchomiono Solve ani Compute Fields.
