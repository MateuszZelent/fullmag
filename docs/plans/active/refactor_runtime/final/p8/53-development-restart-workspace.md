# P8-53 — bezpieczne zastosowanie nowego backendu w workspace

[P8-53AV](53av-asynchronous-candidate-preparation.md) zamyka pozytywny cykl
gotowości pompy między dwoma zweryfikowanymi buildami: 13 kontroli, pierwszy
krok 17 ms, odnowienie i wygaśnięcie lease, reuse kandydata, odebrane własne
procesy. Realny build z UI zakończył się Ready bez restartu workspace.
[P8-53AW](53aw-candidate-preparation-fault-gates.md) zamyka rzeczywiste
fault gates helpera: 10/10 kontroli oraz 13/13 regresji pompy na poprawionym
pakiecie. [P8-53AX](53ax-owner-scope-loss-during-preparation.md) potwierdza
utratę owner scope podczas pracy rzeczywistego selektora: 18/18 kontroli,
terminalne PID/kody oraz brak przejęcia spóźnionego wyniku i replacement.
Pełny restart z niepustym modelem i
publiczne udostępnienie nadal pozostają otwarte. Poniżej wcześniejsze stany.

[P8-53AU](53au-private-consumer-readiness.md) przygotowuje prywatne, wygasające
potwierdzenie gotowości konsumenta przez kanał ownera. Status nie odnawia
ważności; pompa zachowuje kandydata po lost ACK i ogranicza selekcję dla tej
samej tożsamości. Build zarejestrowanej kopii weryfikacyjnej PASS; prywatny
protokół: 40 kontroli i 3/3 procesy odebrane. Regresja konsumenta empty/scene:
39 kontroli i 20/20 procesów odebranych. Cykl gotowości pompy między różnymi
buildami i pełny native/browser flow pozostają otwarte. Dowody dotyczą
opisanej bazy i zmian AU; publiczne `restart_available=false`.

[P8-53AT](53at-development-restart-action.md) dodaje jawne wejście z banera
do trwałego serwisu Host. Pending/unknown uzgadnia ten sam request; błędu
cleanup nie uznaje za zakończony na podstawie wznowionego Host. Akcja 25 grup,
kontroler 41 grup, Host 6 grup, lint 10 plików, API hygiene i browser 12/12 PASS.
Wspólne typowanie nadal zgłasza 5 niezależnych błędów Start/About. Pełny lint,
dostępność API oraz natywny restart z niepustą sceną pozostają otwarte;
`restart_available=false` i procenty planu bez awansu. Poniżej wcześniejsze
checkpointy dokumentują stan w chwili ich wykonania.

[P8-53AS](53as-run-outcome-handoff.md) rezerwuje opóźniony recorder wyniku
przed trackerem i thumbnail. Capture/guard/restore nie omijają kolejki
ani flushu; po pauzie obserwacja jest rozpatrywana dokładnie raz.
Regresja 5 grup, browser 9/9, lint 6 plików i API hygiene PASS.
Wspólne typowanie/pełny lint blokują niezależne zmiany Start/About.
Komenda UI i pełny natywny restart pozostają otwarte; `restart_available=false`.

[P8-53AR](53ar-mounted-kernel-handoff.md) podłącza pauzę i publikację do
zamontowanego KernelProvider, chroni stare i nowe registry/transport/cache
oraz potwierdza zmianę pinu dopiero po mount. Browser fixture 13/13 PASS;
host 6 grup i transport 13 grup PASS. Komenda UI oraz pełny natywny restart
z niepustym modelem i szkicami pozostają otwarte; `restart_available=false`.

[P8-53AQ](53aq-workspace-owners-and-client-cache.md) dodaje dokładną tożsamość
workspace, guard dokumentu, adapter właścicieli oraz odrębny cache klientów.
Natywny build i 24 kontrole API PASS; frontend: 39 grup koordynatora,
9 grup cache, 31/31 browser owners oraz workspace/WebGL PASS.
Produkcyjna wymiana kernela i pełna
hydration pozostają otwarte; `restart_available=false`.

[P8-53AP](53ap-frontend-restart-reconciliation.md) dodaje fasadę token-bound
statusu i koordynator pojedynczego intentu UI. Lost ACK prowadzi do odczytu
tego samego requestu, a błędne Ready nie zwalnia ochrony szkiców. Interpretowane
sprawdzenia koordynatora PASS; konkretni ownerzy i pełna hydration UI pozostają
otwarte. `restart_available=false`.

[P8-53AO](53ao-native-restart-consumer.md) podłącza konsumenta w pętli CLI,
zweryfikowany wybór EXE i pauzę/rebind observers. Build Windows, 39 kontroli
konsumenta, 6 kontroli pauzy oraz 20 kontroli transportu PASS. Hydration UI,
warm service, fault injection i pełny Windows/browser flow pozostają otwarte;
`restart_available=false`.

[P8-53AN](53an-ui-restart-request-transport.md) dodaje trwałe żądanie z trzema
niezależnymi właścicielami UI oraz wspólny koordynator natywny.
Zarządzany build Windows, 20 kontroli transportu, 398 kontroli koordynatora
oraz generacja/production TypeScript/API hygiene PASS. Konsument w pętli
produkcyjnej, świeży pin i hydration paneli pozostają otwarte;
`restart_available` nadal jest `false`.

[P8-53AM](53am-pending-form-transition.md) chroni wszystkie zarejestrowane
szkice i trwające Apply/Reset podczas przejścia. Produkcyjny New Problem nie
czyści danych przy otwarciu/Cancel i odróżnia pozytywny ACK od błędu finalizacji.
Browser: 23 grupy PASS; source, lint i API hygiene PASS. Transport restartu
i hydration pozostają otwarte. Dokument projektu i scena sesji są odrębnymi
składnikami kapsuły P8-53U; ich automatyczna synchronizacja nie jest warunkiem
restartu. Następny krok to podłączenie payloadu UI do natywnego koordynatora.

[P8-53AL](53al-project-authoring-archive.md) dodaje jawną aktualizację archiwum
projektu z dokumentu sceny, z kontrolą ID/revision i zachowaniem assets,
metadanych oraz historii źródła. Natywne API: 25 kontroli PASS; kontroler
w przeglądarce: 15 grup PASS. Niekompletny szkic nie udaje wykonywalnego
Pythona. Powiązanie projektu z sesją, PendingForms i pełny restart UI
pozostają otwarte. Usunięto wcześniejszą zależność kernel→Start.

[P8-53AK](53ak-project-document-handoff.md) dodaje capture i walidowane
odtworzenie odrębnego dokumentu projektu w kontrolerze. Natywne otwarcie
archiwum: 11 kontroli PASS; browser: 9 grup PASS, TypeScript i lint PASS.
Dirty/persisted revision zachowane po walidacji. Transport restartu, aktualność
archiwum względem sceny i hydration całego workspace pozostają otwarte.


[P8-53AJ](53aj-native-replacement-supervisor.md) dodaje uruchomienie
replacement przez natywnego koordynatora, odtworzenie kapsuły i completion
po przejęciu custody nowego Child. Build i 398 kontroli runtime PASS;
wszystkie 142 procesy próby odebrano. Potwierdzono również inny build i lost ACK.
UI, dokument projektu, drugi restart i Compute pozostają otwarte.
Nieudana wcześniejsza próba pozostaje odseparowana z zamkniętym magazynem.


[P8-53AI](53ai-owned-api-commit-exit-supervisor.md) integruje custody Child
z launcherem oraz commit/wait/readback z produkcyjnym supervisorem.
Build i 306 kontroli przeszły, wszystkie 104 procesy odebrano. Replacement
spawn, hydration UI i fault-injection pozostają otwarte; restart nadal niedostępny.

[P8-53AH](53ah-cross-build-next-idle.md) wiąże cold-idle proof ze zweryfikowaną
tożsamością API po podmianie buildu. Natywny build i 300 kontroli przeszły;
wszystkie 104 procesy odebrano. Następne przejęcie, reservation/recheck i jawny
abort działają także między buildami. To nie jest drugi restart ani supervisor
produkcyjny; Compute i hydration UI nadal otwarte, procent planu bez awansu.

[P8-53AG](53ag-cross-build-candidate-owner.md) oddziela oczekiwaną tożsamość
replacement API od kompilacji launchera przez pełną weryfikację kandydata.
284 natywne kontrole potwierdzają również rzeczywisty przebieg z dwoma różnymi
buildami; wszystkie 101 procesów odebrano. Produkcyjny supervisor, kolejny live
restart, Compute i hydration UI pozostają otwarte; `restart_available=false`.

[P8-53AF](53af-native-completion-client.md) dodaje produkcyjnego natywnego
klienta ownera dla `complete_cold`. 227 kontroli potwierdza odmowę obcego PID,
rozbieżnej sceny i fałszywego ACK oraz rzeczywiste completion w obu wariantach
ACK/lost-ACK starego API; wszystkie 68 procesów odebrano. Produkcyjny supervisor,
Compute, powtórny live restart i hydration UI pozostają otwarte.

[P8-53AE](53ae-live-cold-completion.md) podłącza dziennik completion do
prywatnego ownera nowego API. 215 natywnych kontroli potwierdza odtworzenie
sceny z assetem, odmowę błędnych pinów, retirement markerów i HTTP mutację po
completion; wszystkie 60 procesów sondy odebrano. 124 kontrole interpretowane
przeszły. Produkcyjny koordynator, Compute, powtórny live restart, warm service
i hydration UI pozostają otwarte; `restart_available` pozostaje `false`.

[P8-53AD](53ad-completion-journal-and-repeated-store-cycle.md) dodaje trwały
dziennik zakończenia i odmowę admission przy częściowym retirement. Produkcyjny
primitive przeszedł dwa cykle magazynu i 13 nowych kontroli; cała natywna
bramka: 199 sprawdzeń, 60 odebranych procesów. Live owner completion oraz
odtworzenie UI pozostają do podłączenia.

[P8-53AC](53ac-lost-ack-and-candidate-restore.md) potwierdza natywne uzgodnienie
zatwierdzenia po utracie ACK oraz odtworzenie sceny w nowym API kandydata.
186 kontroli przeszło; wszystkie 60 procesów sondy odebrano. Fence pozostaje
zamknięty. Koordynator produkcyjny, zakończenie lifecycle, warm drain i hydration
UI są nadal otwarte; `restart_available` pozostaje `false`.

[P8-53AA](53aa-durable-handoff-acceptance.md) dodaje jednorazowe trwałe
zatwierdzenie pod WRITER i blokuje zwykły abort po poprawnym lub uszkodzonym
zapisie. Build i 129 kontroli natywnych przeszły. Konsument zatwierdzenia
w owner-control i graceful shutdown potwierdzono następnie w P8-53AB/AC;
pełny restart pozostaje otwarty.

[P8-53Z](53z-scoped-accepted-store-positive-idle.md) zapewnia osobny magazyn
UUID wewnątrz obecnego storage i pozytywny przebieg przejęcia, stagingu,
readbacku oraz cold idle dla pustego workspace i modelu. Zarządzany build
i 121 kontroli natywnych przeszły. Atomowy commit i pełny restart pozostają otwarte.

[P8-53Y](53y-precommit-capsule-readback.md) podłącza natywny ponowny odczyt
kapsuły/kandydata przed przygotowaniem commit. Kontrole interpretowane (110)
i natywne (113) przeszły. Odczyt nie zatwierdza shutdown ani restore.

[P8-53X](53x-cold-accepted-store-reservation.md) dodaje rezerwację istniejącego
zimnego magazynu, wspólną z bezpośrednim przejmowaniem ownera service.
Zarządzany build i 110 sprawdzeń natywnych przeszły; pełny restart pozostaje
NOT VERIFIED do atomowego commit, replacement i hydration UI.

## Cel zatwierdzony przez użytkownika

Checkpoint backendowej instalacji sceny przed listenerem i jego dowody:
[P8-53K](53k-prelisten-authoring-restore.md). Nie zamyka pełnego restartu workspace.
Przekazanie wejścia przez natywny CLI, verified capsule/bundle preparation
i dowody tego przyrostu: [P8-53L](53l-launcher-authoring-input.md).
Prywatna tożsamość po restore: [P8-53M](53m-restored-authoring-provenance.md).
Inventory brakującego globalnego fence: [P8-53N](53n-global-idle-fence-inventory.md).
Implementacja durable admission fence i dowód idle drain: [P8-53O](53o-durable-admission-fence.md).
Recovery preparation ograniczone do własnej puli: [P8-53P](53p-preparation-recovery-pool-scope.md).
Prywatny kanał przejęcia authoring i dowód freeze/abort: [P8-53Q](53q-private-owner-acquisition.md).
Body HTTP, wspólne UUID, retry idle fence i stałe ścieżki świeżego startu: [P8-53R](53r-native-development-reliability.md).
Owner początkowego API w natywnym CLI i klient acquire/abort: [P8-53S](53s-native-launcher-owner.md).
Aktualne potwierdzenie przejęcia bez przedłużania timeoutu: [P8-53T](53t-acquisition-live-confirmation.md).
Staging przejęcia ze scoped payloadem UI i pusta kapsuła: [P8-53U](53u-acquired-workspace-capsule.md).
Konsument kapsuły w natywnym launcherze: [P8-53V](53v-native-cli-capsule-consumer.md).
Bramka globalnego idle i jej odrębne dowody: [P8-53W](53w-staged-global-idle-consumer.md).

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

Aktualizacja 04.10.2026: [P8-53AB](53ab-private-cold-commit-graceful-exit.md)
łączy prywatne przejęcie, semantycznie zweryfikowaną kapsułę, cold-idle fence
i trwałe zatwierdzenie z graceful exit własnego API. Zarządzany build i 139
natywnych kontroli przeszły. Nie jest to jeszcze replacement ani odtworzenie
workspace; pełny restart i `restart_available` pozostają niedostępne.

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
zrealizowane w [P8-53B](53b-development-build-status.md). Historyczne
automatyczne odliczanie 120 sekund zastąpił [P8-54](54-manual-native-build-snapshot.md):
backend buduje się wyłącznie na jawne żądanie z frozen snapshotu. Heartbeat
pozostaje; gotowy build nadal nie oznacza dostępnego restartu.

Resource hook i jeden banner workspace są zaimplementowane; konsument używa
generated facade oraz klucza cache przypiętego do klienta API. Banner zajmuje
własne miejsce nad workspace, zamiast zasłaniać dock/Inspector. Produkcyjne
typowanie i higiena API przeszły; browser na 3197 potwierdził położenie bannera
oraz schowanie/przywrócenie Inspektora w pustej sesji. Nie jest to jeszcze
przebieg restartu i odtworzenia niepustego modelu.

[P8-53C](53c-mutation-admission.md) dodaje admission przed transition, również
dla mutujących odczytów, oraz cancellation-safe freeze. Jego konsument restartu
nie jest jeszcze podłączony. Pozostają: komenda v2, drain, kontrola szkiców,
restore przed listen, nowy pin oraz rzeczywisty przebieg Windows/browser.
Nie zwiększamy procentu całego planu na podstawie tych częściowych dowodów.

[P8-53D](53d-native-owner-recovery.md) usuwa blokadę porzuconego owner record
przez sprawdzony recovery z zachowaniem oryginalnych bajtów. Po recovery
produkcyjny build Windows i 24 sprawdzenia natywnego API przeszły. Pełny
kontrolowany restart i jego fault gates pozostają otwarte.

Po scaleniu `origin/master` (`90cf0198a9550976e5d187c2eca276a25953defc`)
przywrócono tylko własne poprawki z zachowanej kopii stash
`145b21d093913126c48bdd29cd72a4ff606ac63c`; nowy ekran startowy pozostał
w aktualnej wersji. Ponownie przeszły produkcyjne typowanie, lint, higiena API
i React Doctor (5 zmienionych plików, bez zgłoszeń):

- typowanie: `f699742633c849dc9a07fc90fb6cede2`;
- lint: `acd61345780f4e96b423cccded56b473`;
- API: `0b79060ba6f8410cb14f7173a6f4040b`;
- React Doctor: `3fe3c6c061214f7eb68d10ef9a21d51a`.

Receipty znajdują się w profilu `windows-control-room-source-check`.
Szczegóły są w [P8-53F](53f-development-banner-source-integration.md).
Poprzednie uruchomienie `just windows-ui dev` na 3197 (handle 95546)
zakończyło się z exit 0; watcher opublikował `stopped`. Późniejsze dowody
źródłowe nie zastępują ponownego sprawdzenia w przeglądarce po scaleniu.

[P8-53E](53e-semantic-scene-assets.md) dodaje semantyczną inwentaryzację plików
sceny, zapis v2 z zachowaniem formatów i odczyt przepinający referencje na
zweryfikowane kopie, także przy kolejnym handoffie. Końcowa zarządzana seria
wykonała 72 interpretowane regresje, bez skipów (receipt
`589fc55b04ef43c899273e6fae820c64`, exit 0). Nieznane asset-id bez registry
blokują restart zamiast deklarować niepełny snapshot jako sukces. Warstwa
nie jest jeszcze wywoływana przez komendę API ani launcher.

[P8-53G](53g-start-command-registration.md) usuwa podwójną rejestrację
komend Start Screen, która blokowała aktualny dev frontend błędem 500.
HMR przywrócił ekran na 3197 bez restartu backendu; przejścia Home/Templates
oraz kontrole TypeScript/lint/API/React Doctor przeszły. To dowód uruchomienia
UI, a nie kontrolowanego odtworzenia modelu po restarcie.

[P8-53H](53h-workspace-acquisition-and-confirmed-drain.md) dodaje prywatny
owner-authenticated terminalny drain obu schedulerów. Własny pusty service
przeszedł tę granicę, a natywny verifier zakończył 31 sprawdzeń z exit 0.
Prywatne przejęcie sceny jest nadal w realizacji. Nie jest to jeszcze
koordynatorem restartu: accepted-work gate, zapis/restore i nowy pin API
pozostają do podłączenia. `restart_available` nadal jest `false`.

[P8-53I](53i-stable-authoring-acquisition.md) dodaje prywatny guard stabilnej
sceny, kolejki i ledgera. Rozpoznaje rzeczywiste terminalne kształty mesha,
w tym ready/active i failed FDM, bez ogólnego dopuszczenia aktywnej pracy.
Końcowy native build i 31 sprawdzeń API/service przeszły. Sam guard nie ma
jeszcze wykonującego go koordynatora; runtime wyścigów Start i pełne restore
pozostają NOT VERIFIED.
