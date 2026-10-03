# P8-53 — bezpieczne zastosowanie nowego backendu w workspace

## Cel zatwierdzony przez użytkownika

Jedno `just windows-ui dev` uruchamia HMR frontendu i obserwację backendu.
Po kompilacji UI pokazuje „Nowy backend gotowy” oraz przycisk restartu.
Restart nie może przerwać aktywnej symulacji ani utracić niezapisanych szkiców;
zapisany stan projektu i workspace ma zostać odtworzony. P8-52 realizuje
kompilację i separację EXE. Niniejszy krok dodaje pełny lifecycle w UI.

## Ustalenia źródłowe na wejściu do P8-53

1. Watcher publikuje `backend-watch-status.json`, ale obecnie nie ma jego
   publicznego zasobu v2, facade, resource hook ani konsumenta UI.
2. API UUID jest przypięty na czas startu. Zwykły reconnect lub odświeżenie
   URL ze starym pinem nie może adoptować replacement API.
3. `ProjectDocumentController.save()` zapisuje archiwum dokumentu projektu
   przez Tauri albo download. Ten kontrakt jest odrębny od runtime session.
   Sam zapis dokumentu nie dowodzi odtworzenia geometrii i aktywnej sesji.
4. Eksport `.fms` profile `resume` zapisuje stan runtime i `ui_state`, ale
   import `resume` kończy się 409 `checkpoint_restore_unsupported`. Pozostałe
   tryby importu tworzą sesję tylko do odczytu. Żadna z tych tras nie dowodzi
   odtworzenia edytowalnego projektu. Potrzebny jest osobny handoff authoring.
5. `PendingFormRegistry` chroni aktywny Inspector, a KernelProvider czyści go
   przy disconnect. Przed restartem trzeba rozwiązać szkice, a nie liczyć na
   ich guard po utracie połączenia.
6. ADR 0049 ustanawia niezależnego ownera zaakceptowanych obliczeń; nie wolno
   zastąpić go pozostawieniem starego, osieroconego API.
7. `submit_command` zapisuje Queued i enqueue pod
   `current_live_session_transition`; dequeue runnera korzysta z tej samej
   blokady. Restart potrzebuje wspólnej bramki mutacji, zamykanej przed
   uzyskaniem tej blokady. Kolejność: permit mutacji → transition → snapshot
   i ledger/queue. Sam odczyt statusu przed restartem pozostawia wyścig Start.
8. Rezydentny service sam skanuje accepted store i może uruchomić compute lub
   preparation bez udziału API. Ma prywatny `drain`, lecz obecny klient
   `runtime_service_client` nie udostępnia potwierdzonego drain handshake.
   Istnienie descriptoru/locku albo błąd obserwacji musi blokować restart
   do czasu odrębnego rozwiązania tej granicy; `NotConfigured` nie dowodzi
   braku ownera. Nie zatrzymujemy go jako skutku ubocznego zamknięcia UI.
9. API tworzy `current_live_state=None` przed związaniem listenera. Restore
   authoring należy wykonać przed `listen`, z pełnej sceny w świeżym scratch
   shellu, z nową tożsamością sesji i `run=None`. Nie przenosimy starych komend,
   preparation, pól solvera ani statusu wykonania. Requested intent pozostaje
   w scenie; resolved execution poprzedniego uruchomienia nie staje się
   wynikiem nowego procesu.
10. Adapter sceny do `ScriptBuilderState` jest projekcją stratną. Nie wolno
    odtwarzać z niego sceny: m.in. selections, couplings, constraints, outputs,
    requested device/precision i informacje edytora wymagają kanonicznego
    dokumentu. Adapter przy restore jest ponownie wyprowadzany ze sceny.

## Decyzja i granice

- Status buildu staje się cienkim zasobem platformowym v2 włączanym wyłącznie
  przez natywny launcher dev. Zawiera stan, bieżącą i gotową tożsamość buildu
  oraz powód blokady; nie ujawnia hostowych ścieżek ani tokenów procesu.
- React używa generated transport, centralnej facade i jednego resource hook.
  UI nie czyta storage ani nie zabija procesów.
- Przycisk wykonuje kontrolowaną komendę restartu. Launcher jest właścicielem
  handoffu oraz procesów. Nie ma automatycznego restartu po samym buildzie.
- Najpierw resolve Apply/Save/Cancel dla lokalnych szkiców. Brak wiarygodnej
  kontroli dirty state blokuje restart; nie stosujemy cichego Discard.
- Serwer blokuje restart przy running/paused, queued/accepted/dispatched,
  aktywnym preparation/mesh i unknown. UI disabled nie zastępuje serwerowej
  kontroli ani ochrony przed wyścigiem kolejnego Start.
- Handoff zachowuje kanoniczny `SceneDocument`, adapter edytora, requested
  execution, stan UI i odrębną tożsamość dokumentu projektu. Nie jest wznowieniem
  checkpointu solvera: odtwarza edytowalny model i stan authoring w bezczynnym
  workspace. Wyniki pozostają przy oryginalnej provenance. Zapis znajduje się w kanonicznym runtime root,
  z UUID, hashami, powiązaniem source/API/session oraz terminalnym stanem.
- Nowy API ma nowy UUID. Jawny, jednorazowy handoff restartu pozwala uzyskać
  nowy pin po restore; ogólny reconnect nadal nie adoptuje replacement.
- Nieudany build pozostawia stare UI; nieudany restore zachowuje kopię stanu
  i pokazuje błąd. Nie wolno oznaczać resetu pustego UI jako sukcesu odtworzenia.

## Zadania i odbiór

| Zadanie | Pliki/granica | Dowód |
|---|---|---|
| Status i komenda dev | API platform handler/schema, router, OpenAPI; launcher/watch resource | Generated kontrakt, produkcyjny source check, brak ścieżek/tokenów w odpowiedzi |
| Guard mutacji/admission | API middleware/lifecycle, authoritative run/preparation resources | Restart rejected przy aktywnym solve oraz wyścigu Start; brak shutdown |
| Zapis handoffu | Kanoniczny SceneDocument i adapter authoring, natywny supervisor | Niepusty snapshot, hash, source/session binding, atomowy terminalny receipt; bez obietnicy resume solvera |
| Guard szkiców i banner | Kernel commands, PendingFormRegistry, ProjectDocumentController, resource hook i shell | Apply/Save/Cancel, utrzymane szkice przy Cancel/failure; jedna subskrypcja |
| Restore i nowy pin | Launcher, CLI/desktop, API-instance bootstrap, kernel hydration | Ten sam model/regiony/materialy; odtworzony viewport/UI; świeży UUID, bez stale adoption |
| Fault gates | Przebieg Windows i browser | Aktywny solve blokuje; błąd buildu/restore nie gubi kopii; drugi klient/owner nie przejmuje |

## Stan — 03.10.2026

P8-53 jest w realizacji. Dostępna jest wewnętrzna warstwa zapisu i odczytu
handoffu authoring w `scripts/windows/development_handoff.py`: pełny JSON sceny,
osobne dane edytora/workspace/dokumentu projektu, binding API/session/epoch/
generation/source/target build, hashe snapshotu i składników, kopiowane assety
oraz atomowy receipt `staged` → `restored` albo `failed`.

Recepta `just verify-windows-development-handoff` przeszła 19 interpretowanych
regresji, bez skipów i kompilacji testów. Receipt `bb21349eb99040399881e2cf8e6b2ec5`
ma exit 0 i ten sam hash źródeł przed/po:
`17b16140caf92f9ba64e564ed72be2e358bc4ff4da3af3121a29dfbbe12de259`.
Szczegóły zakresu są w [checkpointcie handoffu](53a-authoring-handoff-persistence.md).

Prymityw nie jest jeszcze konsumentem API ani launchera. Wymaga przekazania
wszystkich referencji do plików przez semantycznego właściciela sceny.
Nie zatrzymuje procesów i nie dowodzi odtworzenia workspace w nowym API.
Zasób statusu buildu v2, jego generated kontrakt i typowana fasada są już
zrealizowane w [P8-53B](53b-development-build-status.md). Watcher ma domyślne
120 sekund bez zmian źródeł oraz heartbeat; gotowy build nadal nie oznacza
dostępnego restartu.

Pozostają: resource hook/banner i komenda v2, admission/drain, kontrola szkiców, restore przed
listen, nowy pin oraz rzeczywisty przebieg Windows/browser. Nie zwiększamy
procentu całego planu na podstawie samego zapisu handoffu.
