# P8-53AT — jawna akcja restartu w banerze

Status, 04.10.2026: akcja UI zaimplementowana i sprawdzona w fokusowanej
regresji oraz izolowanej przeglądarce. Pełny restart natywnego Windows
pozostaje NOT VERIFIED. `restart_available=false` w zwykłym API pozostaje
granicą dostępności do odrębnego dowodu integracji.

## Wynik implementacji

`DevelopmentKernelHost` posiada jeden `DevelopmentRestartActionService`.
Baner subskrybuje serwis i udostępnia jawne `Restart backend`, jeżeli świeży
zasób potwierdza dostępność. `Check restart` uzgadnia istniejący request
po lost ACK; nie tworzy kolejnego POST. Serwis zachowuje kontroler i prywatny
token przez remount banera i publikację nowego kernela. P8-53AS nadal chroni
recordera wyniku, queued outcomes i flush dokumentu.

Po potwierdzonym odtworzeniu serwis zwalnia subskrypcję kontrolera i referencje
do starego kernela/ownerów. Zachowuje publiczny wynik oraz hash zastosowanych
źródeł. To kontrola lifecycle referencji; nie jest pomiarem GC, zużycia pamięci
ani dowodem braku wycieku. Niepotwierdzone cleanup, intent i hydration zachowują
kontroler zamiast uznawać go za zakończony.

## Obowiązujący kontrakt

- Jeden serwis lifecycle należący do trwałego hosta, współdzielony przez
  kolejne generacje kernela. Remount banera nie gubi tokenu ani request ID.
- Jawny przycisk w istniejącym `DevelopmentBackendBanner` korzysta z tego
  serwisu i typowanej fasady. Nie tworzy endpointu ani drugiego transportu.
- Start wymaga świeżego zasobu `ready`, `restart_available=true`, właściwego
  pina i aktualnego kernela. Stale/loading/error, brak hosta/pina, zajęty
  intent lub już zastosowane źródła nie uruchamiają POST.
- Serwis sprawdza rzeczywisty kontrakt zasobu `schema_version=1.0.0`, bezpieczną
  rewizję, obie tożsamości buildów i dokładne API/session/globalny epoch.
  Potwierdza wybranego kandydata przed capture oraz ponownie pod guardami.
- Serwis potwierdza aktualny status przed startem; capture nadal przechodzi
  wszystkie guardy. Nie stosuje niekompletnych formularzy automatycznie:
  `applyPendingChanges=false`. Odrębny niesave'owany dokument może zostać
  przeniesiony przez `carryUnsavedDocument=true`; queued outcomes nadal
  blokują capture do Save/flush zgodnie z P8-53AS.
- Budowanie ani pojawienie się `ready` nie uruchamia restartu. Klik nie
  wyłącza zabezpieczeń dla trwającej symulacji lub mutacji.
- `pending/unknown` oznacza ten sam trwały request. Jawne sprawdzenie
  statusu wywołuje `reconcile`, nie tworzy następnego POST ani tokenu.
- Confirmed restore wymaga hydration i publikacji pinu istniejącego hosta.
  Błąd hydration/publication zachowuje ochronę. Stary transport pozostaje
  retired po publikacji, także po późniejszym release ownerów.
- Retry po odrzuconym capture jest dozwolone tylko przy jawnie potwierdzonym
  cleanup i braku requestu. Typowany `DevelopmentRestartCaptureError`
  przekazuje ten dowód; nietypowane odrzucenie domyślnie jest niepotwierdzone.
  Samo wznowienie Host albo tekst błędu nie dowodzą zwolnienia wszystkich
  guardów. `captureCleanup=unconfirmed` blokuje nową próbę.

Pierwsze wejście jest kontrolą lifecycle w banerze kernela. Nie rejestruje
osobnego systemu komend w module. Przed ewentualnym dodaniem polecenia
do ribbon trzeba rozwiązać fakt, że wywołująca komenda może sama być
aktywną operacją registry podczas zdobywania handoff pause; nie wolno
pomijać tego guarda ani pozwolić dowolnym komendom działać w pauzie.

## Review i poprawka wymagana

Niezależne review źródeł wykryło P2: obserwator PendingForms może rzucić
podczas release, gdy pozostałe zwolnienia już wznowiły Host. Wnioskowanie
o zakończonym cleanup z komunikatu kontrolera i `paused=false` pozwalało
porzucić niepotwierdzonego właściciela i ponowić capture.

Poprawka dodaje jawny wynik cleanup do kontrolera i typowany błąd właściciela.
Odrzucenie przed zdobyciem guardów jest potwierdzone; błędu obserwatora
przy prepare/release nie uznajemy za potwierdzone zwolnienie. Serwis używa
tego dowodu, nie tekstu komunikatu. Review korekty nie pozostawiło Required
findings w sprawdzonym diffie. Reviewer nie uruchamiał osobnej próby runtime.
Finalna przeglądarka dodatkowo potwierdziła ten błąd obserwatora: Host był
wznowiony, ale nowy capture/GET/POST pozostał zablokowany.

## Dowody końcowe

Wszystkie poniższe wykonania mają terminalny receipt. Testów jednostkowych
nie kompilowano ani nie uruchamiano. Bazowy HEAD snapshotów:
`6c0c76551b6095b064e996cbb4c80a4ba7952aa9`, z diffem P8-53AT i zachowanymi
równoległymi zmianami Start/About. Ścieżki receiptów poniżej są względem:
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/`.

| Recepta | Wynik i zakres | Receipt |
|---|---|---|
| `verify-control-room-development-restart-action` | PASS, 25 grup; rzeczywisty serwis/kontroler/Host, kontrolowany adapter właścicieli i typowane protokoły API | `windows-control-room-source-check/development-restart-action-check/66f11b1c74f348daad7c372cf817cafc/receipt.json` |
| `verify-control-room-development-restart` | PASS, 41 grup kontrolera i kontraktu ścieżek | `windows-control-room-source-check/development-restart-check/b8cae36c28554d11a82512b3a23d2932/receipt.json` |
| `verify-control-room-development-kernel-host` | PASS, 6 grup Host; adapter w tym driverze jest stubem, rzeczywista akcja sprawdzona osobno | `windows-control-room-source-check/development-kernel-host-check/1c8a3ea06a4648edbdb67a26ba2167e0/receipt.json` |
| `lint-control-room-development-restart-action` | PASS, zamknięty zakres 10 plików P8-53AT; nie jest pełnym lintem repo | `windows-control-room-source-check/development-restart-action-lint/2cc052ce271e49ff9064a294394cbb3e/receipt.json` |
| `check-control-room-api-hygiene` | PASS | `windows-control-room-source-check/api-hygiene/6327fa035a9a4323bf157055c0b3238f/receipt.json` |
| `check-control-room-production-source` | FAILED, exit 2, 5 diagnostyk poza P8-53AT | `windows-control-room-source-check/production-source/8c0cbcfeb362489da1135f001232206c/receipt.json` |
| `verify-development-restart-action-browser` | PASS, 12/12; Chrome, własny port 3254, `owned_server_terminal=true` | `windows-control-room-browser-fixture/development-restart-action-browser/9d92e77643484a2baf415c8378a580e3/receipt.json` |

Trzy regresje źródłowe wykonały się na niezmiennym digescie
`ae89e4bd13751eede286ef2e7c9205a0846c8807e2d9ea96a6cfd91a92f8eea4`.
Finalny lint, typowanie, API hygiene i browser mają digest
`cf57b76fe54f11e974a0a3e3929dde00c624f346e0e19f58927d46a9fb08418e`.
Między tymi snapshotami zmieniono bootstrap i nullable zapis w stronie fixture;
produkcyjny serwis, kontroler, Host i właściciele nie zmieniły się. Każdy receipt
ma zgodny digest przed/po i `source_changed_during_run=false`.

Pięć błędów produkcyjnego typowania to brak importu `RecentIndexState`
w `ProjectInspector.tsx` oraz cztery użycia `institution` nieobecnego
w `ExtendedAuthor` w Start/About. Snapshot nie ma diagnostyk w plikach
P8-53AT. Te równoległe zmiany zachowano; wspólna bramka TypeScript nie jest PASS.
Pełny lint również pozostaje otwarty; scoped lint nie zastępuje tej bramki.

### Zakres próby przeglądarkowej

Izolowana strona używa produkcyjnego KernelProvider, Host, serwisu,
kontrolera, konkretnych PendingForms/dokumentu/layoutu, banera, resource hooka
i typowanego klienta. HTTP jest kontrolowane; scena i dokument są puste
(`session_id=null`, epoch 0). Dowód obejmuje:

1. Odmowę dla niedostępnej capability oraz stale refresh; `ready` samo nie wysyła POST.
2. Odmowę przy rzeczywiście brudnym PendingForm, bez wywołania Apply/Reset,
   i możliwość późniejszego jawnego retry po rozwiązaniu formularza.
3. Lost ACK: jeden POST, pauzę i inert dzieci, ten sam request/token przy GET
   oraz zachowanie lokalnego pola podczas oczekiwania.
4. Remount banera bez utraty serwisu/requestu; fresh mount, ownerzy i pin URL
   przed potwierdzonym restore; stary zwykły klient odrzuca odczyt bez sieci.
5. Drugi jawny restart do innego źródła: ten sam serwis, generacja 2, nowy pin,
   łącznie dwa POST i trzy zgodne token-bound odczyty.
6. Zmianę kandydata podczas chronionego capture i błąd obserwatora release:
   niepotwierdzone cleanup nie pozwala zdobyć nowej rezerwacji ani wysłać POST,
   również po usunięciu obserwatora i przy wznowionym Host.
7. Brak page/console errors i nieoczekiwanych API requests.

JSON i obejrzany screenshot znajdują się w podkatalogu `browser/` receiptu,
w plikach `development-restart-action.json` i `.png`. Token nie jest zapisany
w raporcie; raport zawiera tylko wynik porównania. Własny serwer fixture został
zakończony. Workspace użytkownika na 3197 nie został zatrzymany.

Fixture nie dowodzi restartu EXE, konsumenta natywnego, odtworzenia niepustej
sceny/dokumentu, trwałości pliku, nauki, WebGL ani wydajności pamięci.

### Nieudane próby zachowane w storage

- `development-restart-action-check/4f10e550f0a140e3a2faa2ca9dc0535f`:
  błąd helpera drivera pomijał override stale/error. Poprawiono forwarding;
  wcześniejszy wynik nie jest PASS. Finalne 25 grup obejmuje poprawkę P2.
- `development-restart-action-lint/bd901578302545fd87c33a5723efaf73`:
  dwa błędy mutacji globalnego fetch podczas renderu fixture. Bootstrap
  przeniesiono do subskrypcji external store przed mount kernela, z cleanup
  poprzedniego fetch przy ostatnim unsubscribe; nie wyłączono reguł lintu.
- `production-source/eb93c2fa11cc41bd942fb29afe86a301`: jeden błąd nullable
  w fixture i pięć niezależnych błędów Start/About. Poprawiono własny nullable
  zapis; finalna bramka nadal zgłasza pięć niezależnych błędów.

Parser obu helperów Python, discovery zamkniętych recept i scoped
`git diff --check` przeszły. Pełny diff zgłaszał obcy dodatkowy pusty wiersz
w `aboutFullmag.ts`; nie modyfikowano go w tym zadaniu.

## Otwarte bramki i następny krok

1. Wyznaczyć dostępność w API na podstawie rzeczywistego owned transportu,
   aktywnego konsumenta i zweryfikowanego gotowego pakietu. Sam heartbeat,
   istnienie pliku lub `ready` nie może podnieść `restart_available`.
2. Wykonać zarządzany Windows/browser roundtrip z niepustą sceną, regionami,
   materiałem i odrębnym dokumentem projektu: owner process exit, świeże API,
   session/globalny epoch, hydration oraz drugi restart.
3. Dokończyć wspólne produkcyjne typowanie/pełny lint po rozwiązaniu równoległego
   Start/About; odrębnie zachować warm-service, fault/power-loss i release gates.

Akcja UI nie upoważnia do samodzielnego podniesienia capability w API.
Procenty P0–P8 nie awansują na podstawie izolowanego flow. Pełny plan pozostaje
aktywnym celem; zakres P8-53 nie oznacza zakończenia całej refaktoryzacji.

## Lokalny checkpoint

Commit implementacji na `master`:
`6fac7904d27da16aaec382ea0c1fc519293d8e27`
(`feat: connect guarded development restart action`). Obejmuje 18 plików:
serwis/Host/właścicieli/kontroler/baner, fokusowane drivery i fixture,
zamknięte recepty oraz dokumentację. Osobno sprawdzony staged scope był zgodny
z tym przyrostem; staged diff i lokalne linki dokumentacji PASS, commit exit 0.
Nie dołączono równoległego Start/About, zmian Python/storage ani submodułu.
Commit jest lokalny; publikacja źródeł na publicznym remote nadal jest
zablokowana przez wcześniejszą odmowę automatycznej kontroli uprawnień.

## Następna bramka — odczyt dostępności i aktualny pakiet

Odczyt kodu potwierdził brak wejścia liveness konsumenta w `AppState`.
`router_v2/handlers/platform/development_backend.rs::observe` waliduje
generację, worktree, hashe i świeżość statusu watchera, ale nadal ustawia
`restart_available=false`. Konfiguracja request transportu sprawdza
coordinator/token/Origin; akceptacja requestu pozostaje intencją.
Launcher przekazuje tę konfigurację przed utworzeniem `NativeRestartPump`,
więc nie dowodzi ona działającej pętli konsumenta.

Właściwy owner jest potwierdzany przez PID/port/API UUID/token hash/build.
Po otrzymaniu requestu selector weryfikuje źródła, manifest i zapieczętowany
pakiet oraz ponownie odczytuje status. Transakcja wymaga prywatnego guarda,
zgodnego accepted store i cold-idle proof; skonfigurowany warm service
odmawia tej trasy. Są to dowody zdobywane po żądaniu, nie gotowa capability
przed kliknięciem. Nie podniesiono publicznego flagu.

Następny przyrost powinien wprowadzić wygasające potwierdzenie gotowości
konsumenta przez istniejący prywatny, uwierzytelniony kanał ownera. Musi być
przypięte do API UUID, generacji/worktree i zweryfikowanej tożsamości
kandydata. Dostępność wymaga również świeżego watchera i różnych źródeł
current/ready. Brak potwierdzenia, wygaśnięcie, zmiana ownera/kandydata
i warm-service pozostają odmową. Zmiana dostępności musi wpływać na ETag;
304 nie może utrzymać wygasłego `true`. To zakres następnej implementacji,
nie już wykonany protokół ani kwalifikacja.

Pełna próba browser/native wymaga dedykowanej recepty z osobnym web portem,
wymuszonym wolnym API portem, fresh accepted-store scope i własnym launcherem.
Zmiana wyłącznie portu UI nie gwarantuje izolacji: resolver API może ponownie
użyć zgodnego procesu. Natywny verifier konsumenta już tworzy własny scope
i port; istniejący browser 3254 nadal ma kontrolowane HTTP. W odczytanym
zakresie nie ma jeszcze recepty łączącej oba dowody.

### Odzyskanie pozostawionego procesu próbnego

Pierwszy aktualny build odmówił preflight przy niezamkniętym runtime record.
Manager 261044, launcher 41724 i watcher 229292 były nieobecne; port 3197
był zamknięty. Pierwsze `windows-runtime-recover` słusznie odmówiło z powodu
żywego API 249132.

Pochodzenie tego API potwierdzono przez nieudany receipt
`development-backend-api-checks/checks/a03bd1275a7d4d74ab8108536a877b65/receipt.json`:
parent CLI 237276 miał exit 1, a replacement API 249132 miało `outcome=unknown`.
Zgadzały się parent PID, dokładny EXE z bundle
`3ce0f1a6852543eabc545bbc08da369b` oraz czas utworzenia 04.10.2026 10:21:03.
Parent już nie działał. Tożsamości nie wywnioskowano wyłącznie ze ścieżki.

Pierwszy warunek czasu odmówił zakończenia: CIM podawał
`10:21:03.1424340+02:00`, uchwyt procesu `10:21:03.1424348+02:00`.
Po odczycie zmierzonej różnicy 8 ticków ponownie sprawdzono obie dokładne
wartości, PID, parent i EXE. Zakończono tylko ten proces próbny i potwierdzono
jego exit/nieobecność. Nie zmieniono starego `outcome=unknown` na PASS ani
graceful exit; kapsuły, fences, owner descriptor i dane próby zachowano.

Ponowne zarządzane recovery przeszło z potwierdzonym brakiem managera,
natywnych EXE i watcherów oraz zamkniętym portem. Zachowany oryginał:
`C:/git/fullmag/storage/runtimes/fullmag-0950f4dca4ffe38f/native-runtime-prior-fff4efc399d04177aa78ea655667267b.json`,
SHA256 `9b6e50df2b9358a8d70061fd30bb29a9d36a95fbe8e4a0707abb8c1e78205789`.
Kanoniczny `native-workspace-status.json` zawiera terminalne recovery
z 04.10.2026 23:00:05 +02:00. Recovery nie odtwarza modelu użytkownika.

### Aktualne dowody natywne i ponowne typowanie

`just windows-workspace-build dev dev 3197 auto`: PASS, exit 0, terminalny
`windows-native-fdm-cpu-dev/build-status.json`, 21:00:35–21:09:16 UTC.
Build commit `80e2b612e9075035ee386ac8dd89d3a809bbf6c9`, dirty snapshot
`301c3a008ad0630fe19f4173e31c354bf6035f485e3a3c92cf71e201f4cd5837`,
backend source `cde0a9179b666aff69194523acd41f4faeb6a27e2e04dc4325d1d938b5857e1a`,
raw manifest SHA256
`2201ea4d1b22caa19e34855c3f3480dff3d804b7a76a9cc67f0b26cc2569e9c9`.
Profil `backend-dev`, CLI/API/desktop zbudowane; unit tests nie kompilowano.

`just verify-windows-development-restart-consumer`: PASS, 39 kontroli,
wszystkie 20 własnych procesów odebrane. Receipt:
`development-backend-api-checks/checks/197139232b2f463c81d4ca1923254633/receipt.json`.
HEAD próby `e012c8c46c6d5c62fcd2fde45009b1a59eaf971b`; backend source przed/po
jest zgodny z powyższym manifestem. Zakres obejmuje własny publiczny request,
empty/scene, natywnego konsumenta, dokładny payload UI, fresh API/session,
odmowę starego pina, brak ponownego wykonania i edytowalność po odtworzeniu.
Nie jest to dowód hydration produkcyjnych paneli, browser/native flow ani nauki.

Ponowne produkcyjne typowanie po równoległych zmianach nadal ma 5 wymienionych
błędów Start/About, exit 2, bez diagnostyk P8-53AT. Receipt:
`windows-control-room-source-check/production-source/920a915c052140cc8b7b2ed8b7e9518a/receipt.json`,
niezmienny digest
`de85d482e16287dbbd3349a29c639384da37509b135316aef8d029604777ecfc`.
Pierwszy pełny lint nie rozpoczął wykonania: odrębny aktywny owner 33840
zajmował blokadę checkoutu. Po potwierdzeniu zakończenia tego procesu ponowiono
tę samą zarządzaną receptę, bez porzucania blokady ani tworzenia innego targetu.
Pełny lint zakończył się exit 1: 9 ostrzeżeń nieużywanych importów w równoległych
`AboutInspector.tsx` (1) i `AboutSection.tsx` (8), bez błędów i diagnostyk
P8-53AT. Polityka `--max-warnings=0` słusznie odmawia PASS. Receipt:
`windows-control-room-source-check/lint/978e10404a3141eaab855bb0ece04a31/receipt.json`,
HEAD `e012c8c46c6d5c62fcd2fde45009b1a59eaf971b`, niezmienny digest
`de85d482e16287dbbd3349a29c639384da37509b135316aef8d029604777ecfc`.
Wcześniejszy scoped lint 10 własnych plików pozostaje odrębnym PASS;
równoległych plików Start/About nie poprawiano w tym przyroście.
