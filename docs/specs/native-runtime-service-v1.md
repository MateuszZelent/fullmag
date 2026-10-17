# Natywna usługa runtime — kontrakt v1

Data: 03.10.2026. Status: implemented in source; runtime NOT VERIFIED.
Decyzja: [ADR 0049](../adr/0049-native-runtime-owner-control.md).

## Proces i konfiguracja

Program `fullmag-runtime-service --config <absolute-json-path>` nie wymaga
Docker, WSL ani Linux na Windows. Nie otwiera UI. Domyślny produktowy start,
discovery klienta i UI attach/detach pozostają osobną integracją P7-C.

Konfiguracja ma maksymalnie 64 KiB, odrzuca nieznane pola i wymaga:

| Pole | Kontrakt |
|---|---|
| schema_version | runtime_service_config.v1 |
| store_root | Absolutny root istniejącego SessionStore, bez parent traversal; ten sam co API. |
| target_id | Portable repository ID targetu lokalnego. |
| compute_pool_id / preparation_pool_id | Różne portable ID. |
| compute_resources | Niepuste jawne FmsSchedulerResourceOffer CPU/GPU. |
| preparation_resources | Niepuste jawne FmsPreparationResourceOffer. |
| worker_timeout_seconds / preparation_timeout_seconds | Dodatnie istniejące timeouty supervisorów. |
| heartbeat_interval_milliseconds | Dodatni interwał heartbeatów workera/preparera. |
| startup_timeout_seconds | Dodatni, maksymalnie 300 sekund na publisher i każdy boot/ready handshake. |
| drain_timeout_seconds | Dodatni deadline wspólnego drain obu schedulerów. |

Budżety są konfiguracją operatora, nie pomiarem sprzętu. Żadna domyślna oferta
nie udaje wykrytej pamięci ani GPU. ID zasobów solve i preparation są rozłączne;
operator musi przydzielić budżety mieszczące się we wspólnej pojemności hosta.
Scheduler compute ma max-concurrency=1, max-tasks=0 i brak automatycznych retry;
preparation ma osobny max-concurrency=1. Dostępność wykonania pozostaje określona
przez istniejący planner/worker; deklaracja GPU nie daje cichego fallbacku CPU.

## Stabilna konfiguracja aplikacji

Źródłowy `RuntimeServiceConfig::for_application` inicjalizuje raz albo
odczytuje `runtime-services/APPLICATION.json`. Launch guard poprzedza writer
lease, zgodnie z kolejnością service-ensure. Zajęty guard blokuje operację;
nie uprawnia do takeover ani restartu. Istniejący plik przechodzi ten sam
bounded reader i walidator oraz musi należeć do dokładnie wskazanego store
i targetu. Factory nie jest wtedy wywoływane, więc konfiguracja nie zmienia
się od chwilowo wolnej pamięci przy ponownym otwarciu UI.

Uszkodzona konfiguracja pozostaje zachowana. Brak konfiguracji z istniejącym
OWNER.lock, OWNER.json albo LAUNCH.json wymaga jawnej konfiguracji lub recovery.
Sam LAUNCH.lock jest trwałą blokadą tworzoną przez guard, nie zapisem intentu.
Nowy kandydat jest walidowany przed atomic publication w operacyjnym namespace.
Bezpośredni proces usługi poza service-ensure nie jest objęty tą serializacją.
Generator ofert i podłączenie tej metody do domyślnego packaged startup
pozostają do implementacji; runtime konkurencji i awarii jest NOT VERIFIED.

### Źródło konfiguracji w recovery

Jawna konfiguracja operatora przekazana do recovery pozostaje źródłem
konfiguracji usługi. Ścieżka `prepare_application_config(Some(...))` czyta
przypięte surowe bajty i nie tworzy `runtime-services/APPLICATION.json`;
recovery nie może wprowadzać drugiego, ukrytego źródła konfiguracji.

Manifest `runtime_service_recovery_archive.v1` zawiera pole
`application_binding` z dokładnie dwoma kluczami:

```json
{"mode":"external_only|persisted","raw_sha256":"<64 lowercase hex>"}
```

`external_only` oznacza, że `raw_sha256` jest równy `config_sha256` receiptu,
a `APPLICATION.json` ma pozostać nieobecny. Replay odrzuca obecność tego pliku.
`persisted` oznacza regularny, bezpiecznie odczytany `APPLICATION.json`, którego
surowe bajty mają dokładnie wskazany hash. Oba warianty są sprawdzane pod
pełnym zestawem recovery locków, przed utworzeniem archiwum lub prepared intent.

Manifest bez `application_binding` zachowuje historyczny, bardziej restrykcyjny
kontrakt i wymaga obecnego `APPLICATION.json`. Brak tego pola zachowuje 12
obowiązkowych wpisów `archived_files` oraz dopuszcza wyłącznie istniejące logi
listy producerów opisanej niżej; jego integralność obejmuje istniejący
`archived_evidence_sha256`. Walidacja konfiguracji i replay pozostają fail-closed.

## Własność i kolejność

Jedna blokada runtime-services/OWNER.lock obejmuje cały store. Jest stabilnym
native file lock, nie plikiem PID. OWNER.json zawiera ostatni obserwowany stan,
token instancji/procesu, host/PID/target, generacje pul, adres sterowania i dzieci.
Starting/ready/draining/unknown po utracie blokady wymagają kontrolowanego recovery.
Nie kasować ownera ani lease’ów w celu obejścia tej odmowy.

1. Walidacja konfiguracji, pełnej tożsamości source-pinned buildu i binariów.
2. Zajęcie ownera; publikacja compute/preparation przez CAS generacji.
3. Start obu schedulerów z --startup-gate stdin-v1 i --owner-control stdin-v1.
4. Oba boot events zgodne z PID/owner/rolą/protokołem/commit/snapshot.
5. Bajt 0x01 zwalnia początkową bramkę obu schedulerów; dopiero wtedy otwierają store.
6. Oba ready events zgodne także z pool ID i generacją; owner ready.
7. UI jest klientem; jego zamknięcie nie zamyka writerów schedulerów.

Po początkowej bramce kolejny bajt 0x01 żąda drain. EOF przed bramką odrzuca
startup; EOF po niej drenuje i kończy scheduler błędem. Logi dzieci pozostają
w runtime-services/<owner-token>; odczyt eventów jest ograniczony do 64 KiB
początku lub końca pliku. Retencja wieloletnich logów pozostaje do integracji.

## Prywatny kanał sterowania

Usługa nasłuchuje wyłącznie na losowym porcie IPv4 loopback. Adres jest w
owner descriptor. Klient wysyła JSON zakończony LF, maksymalnie 4096 bajtów:

```json
{"schema_version":"runtime_service_control.v1","owner_token":"<token-z-descriptora>","command":"drain"}
```

Nieznane pola, wersja, polecenie i obcy token są odrzucane. Timeout klienta
nie jest dowodem zatrzymania. Odpowiedź draining potwierdza żądanie; terminalne
zakończenie potwierdza dopiero owner drained wraz z wynikami obu procesów.
Ready w pliku nie dowodzi żywego ownera. Odczytowe discovery używa polecenia
`status` z tokenem ownera oraz świeżym losowym `nonce` (1–128 znaków ASCII:
litery, cyfry, myślnik lub podkreślenie):

```json
{"schema_version":"runtime_service_control.v1","owner_token":"<token-z-descriptora>","command":"status","nonce":"<nowe-losowe-wyzwanie>"}
```

Odpowiedź `runtime_service_status.v1` zawiera to samo `nonce` i `owner` z
pamięci procesu posiadającego native lock. Status nie zamyka admission.
Klient musi sprawdzić nonce, owner/process-start token, target, pełny
commit/snapshot oraz stan ready i obie generacje przed attach. Mismatch lub
brak odpowiedzi nie pozwala na attach ani automatyczny restart.
Descriptor opisuje ostatnią obserwację schedulera/pul, odświeżaną w pętli;
odpowiedź nie kwalifikuje solvera ani sprzętu. Serwer obsługuje status w pętli
ready. Podczas startup/drain timeout nie oznacza zakończenia usługi.
Launcher/UI jeszcze nie korzystają z tego kanału.

Odczytowy klient CLI: `fullmag runtime service-status --store <absolute-root>
--target <target-id> [--timeout-seconds 3]`. Porównuje target i pełny
commit/snapshot ze swoim buildem, owner/process-start token, PID/host, adres
oraz obie tożsamości/generacje pul. Przy zgodnym ready zwraca JSON
`runtime_service_discovery.v1`; błędy kończą komendę bez restartu/takeover.
Wspólny deadline connect/write/read wynosi 1–30 sekund; descriptor i response
mają limit 256 KiB. To diagnostyczny klient przyszłego attach, bez zmiany
domyślnego zachowania UI i bez dowodu atomowej żywotności schedulerów.

CLI `fullmag runtime service-ensure --config <absolute-json-path>` serializuje
decyzję przez natywny LAUNCH.lock i zapisuje intent/PID w LAUNCH.json. Przy
nieznanym wcześniejszym starcie bez terminalnego ownera odmawia nowego spawn.
Do procesu przekazuje unikalną, zsynchronizowaną kopię konfiguracji. Status
zawiera `configuration` z pamięci usługi; ensure wymaga jej pełnej zgodności.
Usługa używa jednego deadline startup dla wszystkich faz; launcher dodaje
10 sekund na utworzenie/załadowanie procesu. Timeout zachowuje proces i intent,
bez kill/restart/takeover. Polecenie wymaga już zainicjalizowanego store.

CLI UI i desktop sidecar używają read-only `prepare_for_authoring`, który
sprawdza build/UUID API oraz jego accepted-store binding przy jawnej
FULLMAG_RUNTIME_SERVICE_CONFIG. Otwierają okno przed `start()` dołączenia.
Konfiguracja compute jest czytana dopiero w posiadanym wątku dołączenia:
jej brak, błąd lub niezgodny service store nie zamyka authoringu, nie
uruchamia obcego store i nie ustanawia gotowości obliczeń. Niezgodność
samego API pozostaje błędem preflight. Root usługi musi odpowiadać resolverowi
accepted store API; local-live store jest odrzucany przed inicjalizacją.

Wątek powtarza pin API/store przed zapisem konfiguracji, przed nowym startem
i po attach. Zamknięcie okna ustawia cancellation i joinuje obserwatora
przed zakończeniem API. Cancellation jest kooperatywna; nie zabija/drainuje
usługi, nie usuwa markerów i nie ogłasza terminalnego sukcesu. Proces już
uruchomiony zachowuje persistent ownership, PID i intent. Błąd/timeout nie
uruchamia retry ani replacement; API status i log pozostają źródłem obserwacji.

Brak konfiguracji pozostawia authoring bez wątku/store/resource offers.
Strict `ensure_for_application` pozostaje helperem synchronicznego start/attach,
poza trasą otwarcia UI. Reuse zgodnego API pozwala na authoring, ale wyłącza automatyczny attach
(`ApiNotOwned`). Brak poprawnie skonfigurowanego accepted-store wyłącza
attach (`AcceptedStoreUnavailable`), bez zmiany miejsca danych lub fallbacku.
Domyślne zasoby produktu, generated diagnostics UI i całościowy cutover
execution nadal wymagają implementacji i kwalifikacji.

HTTP platform OpenAPI zwraca runtime-only x-fullmag-runtime-store-binding:
schema_version=runtime_store_binding.v1, kind=accepted_runs i binding SHA-256
kanonicznej lokalizacji accepted store albo null. Static generator nie emituje
runtime state. Binding nie zawiera ścieżki i nie jest portable scientific ID.
Klient aplikacji sprawdza go wraz z build identity przed inicjalizacją i ensure.
Brak/mismatch/null odmawia attach. Kontrolę powtarza się po starcie usługi.
Binding jest obserwacją, nie lease instancji; CLI nadal odmawia reuse API,
dopóki instancja nie zostanie przypięta również w kolejnych żądaniach klienta.

API nadaje procesowi losowy, stały przez jego życie UUID i zwraca go w nagłówku
`x-fullmag-api-instance`, również przy odmowie. Opcjonalny nagłówek żądania
o tej samej nazwie musi mieć dokładnie jedną wartość zgodną z procesem.
Mismatch, niepoprawna lub wielokrotna wartość daje HTTP 409 z kodem
`API_INSTANCE_MISMATCH` przed dispatch handlera. Brak nagłówka zachowuje
dotychczasowy kontrakt nieprzypiętych klientów. UUID nie jest tokenem autoryzacji.
Launcher wymaga jednego kanonicznego niezerowego UUID w odpowiedzi handshake
i identycznej instancji przed oraz po ensure. Nie zatrzymuje usługi po odmowie.
CLI i desktop przekazują UUID bezpośrednio do `/workspace` przez parametr
`fullmag_api_instance`, bez redirectu strony głównej gubiącego query. Także bez
konfiguracji usługi launcher wymaga zgodnego buildu i UUID API; authoring nie
otrzymuje przez to fikcyjnych zasobów compute/preparation.
ControlRoomApi przechwytuje pin raz i dodaje go do wspólnego fetch dla JSON
i binary. Brak lub inny nagłówek odpowiedzi powoduje trwałą lokalną odmowę
kolejnych żądań tego klienta, bez retry/adopcji nowego procesu. Nowe uruchomienie
z launchera ustanawia nowe powiązanie. Nie zapisuje się pin w persisted state.
Realtime oferuje obok `fullmag.live.v1` towarzyszący subprotocol
`fullmag.api-instance.<UUID>`; middleware odrzuca mismatch i duplikaty przed
upgrade. Serwer wybiera nadal podstawowy `fullmag.live.v1`. Reconnect zachowuje
pin i nie przejmuje replacement API. Nieprzypięte standalone klienty pozostają
zgodne; pełny runtime/browser odbiór wymaga bieżącego buildu, nie starej sesji UI.
Przypięty realtime przed connect/reconnect sprawdza cienki resource health przez
tę samą facade, z timeoutem 3 sekund. Mismatch zatrzymuje reconnect; błąd
przejściowy zachowuje politykę ponawiania z tym samym pin. Close unieważnia
oczekujący preflight i zapobiega otwarciu socketu po unmount.

Oba admissions zamyka się przed oczekiwaniem na procesy. Aktywne workery kończą
się według supervisor/lease/receipt. Wyczerpanie 5-sekundowego retry dla
konkretnego `StoreWriterBusy` podczas okresowego uzgadniania host ledgeru
odracza discovery, recovery adoption i nowe admission w tej iteracji. Nie
zwalnia rezerwacji, nie omija dowodów ani nie kończy procesu schedulera.
Już nadzorowane workery zachowują własny nadzór; pętla nadal odbiera ich
zakończenia i obsługuje drain. Kolejna iteracja ponawia idempotentne
uzgadnianie. Odroczenie nie zużywa limitu pustych iteracji schedulera.
Inne błędy uzgadniania pozostają fatalne; nie są zamieniane w pusty ledger
ani zgodę na nowe obliczenia. Ten wyjątek nie obejmuje błędów zapisów
checkpointu lub zakończenia aktywnego workera.

W fazie pracy cykliczny sampler zachowuje istniejący lease inventory także
przy błędzie próbkowania. Wyłącznie typowany konflikt `StoreWriterBusy` może
pominąć najwyżej pięć kolejnych cykli; szósty kończy się dotychczasową ścieżką
Unknown/drain. Pierwsza próbka wymagana do startu pozostaje fail-closed.
Odmowa admission przez ledger lub typowany konflikt przy jej obserwacji
może być tolerowany przez najwyżej 60 sekund czasu monotonicznego. Nie
przedłuża to ważności snapshotu: ledger nadal odmawia nowych rezerwacji na
podstawie starej lub niezgodnej próbki. Błędy schematu, danych i generacji
zwracane jako błędy pozostają fatalne. Wznowienie poprawnej obserwacji zeruje
budżet odroczenia. Drain i błędy kanału sterowania nadal wymagają dołączenia
trwającego samplera przed zakończeniem pętli.

Błąd jednego schedulera drenuje drugi,
lecz owner kończy jako failed/unknown, nigdy jako poprawny drained.

## Eksport i dowody

### Domyślny budżet natywnej aplikacji

Generator w `fullmag-runtime-control::local_resources` przyjmuje zmierzoną
pojemność hosta i absolutny root. Rezerwuje co najmniej 25% CPU, wolnej RAM
i miejsca na dysku (zaokrąglenie rezerwy w górę), a resztę dzieli na dwa równe
sloty compute/preparation (zaokrąglenie w dół). Zerowy komponent slotu odmawia
konfiguracji. Oferta compute ma kind CPU i zero pamięci GPU; jawne GPU nie
otrzymuje przez to CPU fallbacku. Są to limity admission, nie OS hard limits.
Przy jednym logicznym CPU oba sloty mają po 375 cpu_millis; większe żądanie
pozostaje bez pasującej oferty. Konfiguracja wymaga canonical accepted store
i stabilnej publikacji przez `for_application` przy przyszłej integracji startu.
Sam generator nie uruchamia usługi ani nie kwalifikuje lane'u.

`prepare_packaged_application_service` wymaga zgodności rozpoznanego native
Windows installation root z rootem API. Przed otwarciem accepted store
sprawdza build/kontrakt/binding i UUID API, następnie przygotowuje jawny config
lub persisted domyślne oferty, a na końcu ponownie sprawdza UUID. Explicit
config ma pierwszeństwo i nie pozwala na fallback do generatora przy błędzie.
Wynik jest obserwacją z konfiguracją, nie ready ani lease API. Metoda nie
startuje procesu; launcher musi sprawdzić API również po ensure. Domyślne
uruchomienie UI pozostaje niepodłączone do tej metody do czasu jawnego
resource statusu usługi i obsługi niedostępności bez blokowania authoringu.

### Artefakty i kwalifikacja

Wewnętrzny `application_service_status::observe` zwraca thin typed status bez
inicjalizacji store lub startu procesu. Ready wymaga live config-aware probe,
pozostałe stany ownera są ostatnim zapisem, nie dowodem liveness. Obcy target,
pool/build, błąd odczytu lub OWNER.lock bez deskryptora dają niepewną obserwację.
Konfiguracja i owner używają shared bounded regular-file reader: lokalny FS,
guarded path, metadata ścieżki i uchwytu, Unix nonblocking/no-follow,
Windows final-reparse open/rejection i limit payloadu. Root/przodkowie muszą
pozostać zaufane. RPC deadline nie jest deadline sterownika dysku.
Źródła API rejestrują `GET /v2/platform/runtime-service` jako niezależny od
sesji zasób JSON `application_service_status.v1`: configured, state oraz reason
(code/message). Brak konfiguracji nie tworzy store; orphan metadata wybiera
odczyt z jawnym błędem zamiast udawać not_configured. Explicit config ma
pierwszeństwo także przy błędzie. Publiczny message pochodzi wyłącznie ze
stałej mapy reason code, bez host paths i surowych błędów operacyjnych.
Strong ETag jest hashem serializowanego publicznego body; If-None-Match daje
304 z no-cache. Status nie jest kwalifikacją solvera ani zgodą na wymuszone GPU.
Kompilacja, canonical OpenAPI, generated transport i UI nadal wymagają
weryfikacji; rejestracja źródeł nie dowodzi działającego endpointu.

Operational lock/descriptor/logs nie zawierają korzeni naukowych CAS i nie są
pakowane do FMS. Import nie przejmuje katalogu runtime-services i zachowuje
wymóg pustego staging store. Nie resetuje to żadnej istniejącej sesji.

Wymagane dowody runtime: single-owner conflict, boot mismatch przed admission,
ready obu schedulerów, zamknięcie UI podczas runu, reconnect, drain obu przy
awarii jednego, invalid token bez mutacji, service crash → EOF drain, restart
bez automatycznego przejęcia unknown, Windows bez konsoli i osobno Linux.
Kontrole parsera i pakowania nie zastępują tych bramek ani kwalifikacji fizyki.

Publikatory oraz obaj schedulery i ich workery wymagają zgodnej tożsamości
commita/snapshotu przekazanej przez ownera. Deadline publikatora lub drain
nie zabija niepotwierdzonego procesu: owner zapisuje unknown z PID dziecka,
pozostawia lease’y i blokuje automatyczny restart. Częściowa publikacja puli
zachowuje faktycznie odczytane generacje, także gdy druga publikacja zawiodła.
Ready przygotowania nie zależy od wolnego slotu: jest ogłaszane przed recovery
aktywnych lease’ów. Timeouty pracy/drain mają limit jednego roku, heartbeat
maksymalnie godzinę; nie zmieniają semantyki solvera ani Stop zadania.

Terminalny odczyt obu pul i zapis ownera odbywają się po drain pod native writer
transaction SessionStore. Drained wymaga istniejących pul o zgodnym ID, generacji
i pełnym zestawie zasobów. Znany brak/mismatch daje failed, błąd obserwacji daje
unknown; oba stany kończą proces usługi błędem. Status dziecka unknown oznacza
brak potwierdzonej obserwacji i nie jest deklaracją running ani exited.

## Kontrolowane recovery pustego store — wymagany kontrakt

Stan 16.10.2026: wymaganie implementacyjne; runtime NOT VERIFIED. Jawna lokalna
komenda `fullmag runtime service-recover` ma osobny zakres od `service-ensure`.
Nie wolno wywoływać jej automatycznie po timeout ani błędzie healthchecka.

Operacja przypina dokładny SHA-256 konfiguracji i oryginalnych bajtów
`OWNER.json`, owner token, process-start token, target, historyczny commit,
snapshot oraz obie tożsamości i generacje pul. Wymaga zgodnego poprzedniego
zapisu launch, a nowy lub niepewny launch blokuje odzyskanie. Tożsamość programu
wykonującego recovery jest odnotowana osobno od tożsamości starego ownera.

Kolejność blokad musi być zgodna z istniejącymi startup/launch/store/host-ledger
transakcjami. Pod nimi trzeba potwierdzić jednocześnie:

- wolną stabilną natywną blokadę starego ownera; nie wystarcza brak PID ani
  stary heartbeat;
- dokładnie dwa zgodne schedulery compute/preparation z terminalnym
  `exited_success` oraz ograniczonymi, przypiętymi journalami `stdin-v1 drained`;
- brak runów, batch intentów (również bez utworzonych runów), zadań recovery,
  kolejek, manifestów, pinów i aktywnych lease;
- zgodność aktualnych pul z przypiętymi generacjami;
- brak aktywnego host inventory writera oraz brak niezwolnionych rezerwacji
  hosta, również tentative, committed i quarantined; odmowa nie zwalnia ich
  automatycznie. Historyczne rekordy `released` mogą pozostać wyłącznie po
  walidacji przypiętych, trwałych dowodów zwolnienia. Cała historia pozostaje
  niezmieniona, a host writer jest trzymany od walidacji do końca recovery.

Przed publikacją zachowujemy niezmienione bytes konfiguracji, ownera, launch
oraz dowodów quiescence w operacyjnym namespace `runtime-services`. Nie są
one naukowym CAS ani nowym store. Trwały intent wiąże digest żądania ze starymi
pinami i oczekiwanym terminalnym wynikiem. Publikacja zmienia wyłącznie stan
potwierdzonego starego ownera na `Failed` i zachowuje jego tożsamość. Nie kasuje
ani nie zastępuje owner locka i nie tworzy nowej puli CPU/GPU.

Powtórzenie identycznego żądania jest idempotentne. Po niepewnej publikacji
odczyt pod tymi samymi blokadami rozstrzyga wyłącznie zgodny intent i dokładny
oczekiwany wynik; każdy inny owner, config, launch lub digest blokuje operację.
Udane recovery nie jest readiness: dopiero osobny zwykły start może utworzyć
nowego ownera i wykonać rzeczywisty probe dla jego generacji.

Wymagane dowody obejmują: odmowę przy aktywnych blokadach i pracy, mismatch
pinów, brak lub niezgodność journali, awarie przed i po publikacji ownera,
identyczny replay, zachowanie wszystkich starych dowodów oraz rzeczywisty
start i wykonanie GPU po odzyskaniu. Zielony source check nie potwierdza tych
bramek runtime.

Jawny interfejs CLI (implementacja i runtime nadal wymagają kwalifikacji):

```text
fullmag runtime service-recover --config <absolute-config> \
  --request <readonly-request.json> --request-sha256 <raw-sha256>
```

Żądanie `runtime_service_recovery_request.v1` zawiera `request_id`,
`config_sha256`, `owner_sha256`, `launch_sha256` oraz pełny typowany
`expected_owner`. Digesty przypinają oryginalne bajty plików; porównanie
semantyczne konfiguracji jest dodatkowym warunkiem, nie zamiennikiem tego pinu.

Publiczny receipt `runtime_service_recovery.v1` wiąże `request_id`,
`request_sha256`, `config_sha256`, `target_id`, `status=recovered`,
`outcome=failed`, `owner_sha256_before`, `owner_state_after=failed` oraz
`owner_sha256_after`. `archived_evidence_path` i `archived_evidence_sha256`
przypinają manifest archiwum, a `archived_files` mapuje ograniczony zestaw
oryginalnych plików na ich raw SHA-256. Logiczny inventory ma 12 obowiązkowych wpisów:
`OWNER.json`, stabilny owner lock, `LAUNCH.json`, launch lock, startup gate,
journale stdout obu schedulerów, cztery dokumenty zasobów/stanu przypiętych
pul oraz `configuration.json`. Jeżeli scheduler zakończył się z
`status=drained`, `shutdown_requested=true` i `pool_checkpoint_sequence=0`,
checkpoint może nie istnieć: dokładna ścieżka trafia wtedy do
`archived_absent_sources` z powodem `scheduler_checkpoint_not_published`,
bez tworzenia pliku lub syntetycznego hasha. Natywna walidacja wiąże tę
nieobecność z właściwym journalem i odrzuca brak po opublikowaniu checkpointu;
suma `archived_files` i `archived_absent_sources` nadal musi pokrywać cały
logiczny inventory. Archiwum może zawierać także wyłącznie rzeczywiście
istniejące pliki z zamkniętej listy producerów: stdout i stderr publisherów
`compute-publisher` i `preparation-publisher` oraz stderr obu schedulerów.
Każdy taki plik jest regularny, bounded, odczytany bez podążania za linkiem i
zachowany z raw SHA-256; wildcard ani nieznane nazwy są odrzucane. Klucze
dokumentów runtime pozostają ścieżkami względem SessionStore; zarezerwowany
`configuration.json` oznacza wyłącznie plik w archiwum, zawierający dokładne
bajty zewnętrznej konfiguracji.
Manifest wymaga `config_sha256` zgodnego z requestem i tym plikiem. Brakujący,
dodatkowy lub zmieniony wpis odrzuca również replay. Archiwalny owner zawsze
ma digest `owner_sha256_before`, a jego bieżący odpowiednik może przejść tylko
do dokładnie przypiętego `owner_sha256_after`.

Osobne pola
`historical_build_commit`/`historical_build_snapshot` oraz
`executor_build_commit`/`executor_build_snapshot` zachowują rozdział starego
ownera i programu odzyskującego. `created_at` i `completed_at` opisują operację.
Stan `prepared` jest wyłącznie trwałym etapem wewnętrznego intentu; helper
Docker nie uznaje go za zakończone recovery.

Autoryzacja hosta `fullmag.docker-runtime-recovery-authorization.v1` dodaje
piny runu, dokładnych kontenerów i obrazów, certyfikatu storage i attestation
mountów. Natywna komenda nie interpretuje pochodzenia Docker: pozostaje jedynym
właścicielem blokad i mutacji SessionStore. Tylko jawny tryb
`recreate --recover-idle-failure <authorization.json>` przekazuje ten request;
zwykły start i `service-ensure` nie wykonują recovery.

## Boot-relative ordering of compute-node samples

Kolejność próbek tego samego node i bootu korzysta dodatkowo z prywatnego
`boot_monotonic_ns`, pobieranego z zegara monotonicznego względem uruchomienia
systemu. Wartość nie trafia do JSON snapshotu: v4 ledger zapisuje ją w
niemutowalnym, content-addressed rekordzie `compute_node_sample_order.v2` pod
`runtime-state/cas/snapshot-order-v2`,
opublikowanym przed wskazaniem snapshotu jako bieżącego, a ten sam bounded GC
usuwa wyłącznie nieosiągalne rekordy. Rekord wiąże digest pełnego snapshotu,
`node_id` i `boot_id`; wcześniejsza walidacja snapshotu wiąże również jego
owner stamp. Konflikt bytes dla tego samego digestu jest odrzucany.

`collected_at` pozostaje czasem UTC używanym do freshness i admission. Brak
rekordu oznacza snapshot zapisany przez starszego writera i zachowuje ścisłe
porównanie UTC; starszy rekord z poprzedniego katalogu `snapshot-order` jest
celowo ignorowany. Istniejący v2 uszkodzony, podlinkowany albo niedopasowany rekord
zamyka ledger błędem; system nie tworzy syntetycznego watermarku ani nie
porównuje zegarów między różnymi `boot_id`.

Dowód bieżącej ścieżki Docker dotyczy Linux `CLOCK_BOOTTIME`. Native Windows
boot identity i tick-source pozostają osobną kwalifikacją; ten kontrakt nie
ogłasza ich równoważności bez takiego dowodu.
