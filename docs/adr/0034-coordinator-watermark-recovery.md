# ADR 0034: Watermark koordynatora i fail-closed recovery

- Status: accepted
- Data: 2026-09-25
- Decydenci: Fullmag core
- Powiązany plan: `docs/plans/active/refactor_runtime/final/03-plan-refaktoryzacji.md` (P3-B, P5-B)
- Powiązany kontrakt: `docs/adr/0025-persistent-runtime-and-observation-sources.md`

## Kontekst

Coordinator journal zapisuje każdy command/event razem z checkpointem. Recovery
sprawdza tożsamość claimu i ciągłość sequence, a catalog przechowuje bieżący
lifecycle taska. Brak transitionów jest obecnie odmową. Katalog nie zachowuje
jednak watermarku ostatniego zapisu, więc po usunięciu całej historii pusty
journal nie dowodzi, czy stream nigdy nie opublikował komendy, czy utracił
wszystkie wpisy.

P5-B wymaga, aby replay, restart i ownership epoch nie ponawiały fizycznego
wykonania po cichu. Recovery nie może interpretować braku plików jako
autoryzacji do nowego `Prepare`.

## Decyzja

1. Coordinator journal pozostaje źródłem prawdy o kolejności komend, zdarzeń i
checkpointów. Run catalog przechowuje wyłącznie watermark projekcyjny
(`command_sequence`, `event_sequence`) dla bieżącego/ostatniego attemptu.
2. Watermark w catalogu jest opcjonalny dla zgodności istniejących stores.
`None` nie uprawnia do rozpoczęcia ani wznowienia pustego streamu. Przed
publikacją pierwszego commandu z nowego claimu runtime-control zapisuje
zweryfikowany initial checkpoint (`coordinator_genesis`) wraz z `Some(0, 0)` po potwierdzeniu
identity taska i aktywnego lease. Genesis jest niemutowalny w obrębie epoch;
nowy attempt wymaga wyższego ownership epoch.
3. Po publikacji transitionu adapter odtwarza pełny, ciągły journal i naprawia
catalog. Jeśli catalog jest w tyle, kompletny journal może go podnieść. Jeśli
catalog wskazuje sequence większe niż istniejąca historia, recovery odmawia.
Wartość nie może maleć w obrębie tego samego attemptu/epoch.
4. Journal jest zapisywany przed projekcją catalogu. Błąd projekcji zwraca
błąd publikacji i pozostawia pending transition; retry tego samego envelope
replayuje journal i ponawia reconciliation. Command nie może zostać
przekazany do transportu przed sukcesem obu kroków.
5. Pusty journal można odtworzyć tylko z poprawnego genesis dopasowanego do
run/task/attempt/epoch/lease i watermarkiem `(0,0)`. Legacy task bez genesis
pozostaje odmową. Jeśli watermark jest dodatni, genesis nie zastępuje
utraconych transitionów. Recovery nie tworzy genesis z samego braku wpisów.
6. `heartbeat_sequence` jest monotoniczną wersją liveness tego samego lease,
   a nie nowym właścicielem taska. Fencing właściciela pozostaje związany z
   run/task/attempt/ownership epoch/resource/lease token. Snapshot claimu może
   publikować pod aktywnym lease o równej lub wyższej sekwencji heartbeat tylko
   wtedy, gdy wszystkie niezmienne pola właściciela, kind i budget są zgodne.
7. Lokalny supervisor procesu odnawia lease wyłącznie podczas obserwacji
   żywego potomka. Chwilowy `StoreWriterBusy` jest ponawiany; utrata tokenu,
   epoch, aktywnego stanu lub inny błąd kończy potomka przed zwrotem. Terminalny
   lifecycle wyłącza timer, ale release następuje dopiero po potwierdzonym exit.
8. Publikacja artefaktów sprawdza i wiąże bieżącą wersję lease pod tym samym
   writer lockiem. Heartbeat nie może przypadkowo unieważnić publikacji tego
   samego właściciela, a release lub nowe ownership nadal ją odrzucają.
9. Operator cancel jest trwałą komendą `Stop` związaną z aktualnym claimem.
   Identyczny replay zachowuje command identity; konflikt przyczyny jest
   odrzucany. Potwierdzone zatrzymanie procesu publikuje `Stopped`, ustawia
   terminalne `Cancelled` i dopiero wtedy pozwala zwolnić najnowszy lease.
   Jeżeli terminalny sukces został trwale opublikowany wcześniej, ma
   pierwszeństwo nad późnym żądaniem anulowania.
10. Odpowiedź przyjętego `Stop` zwraca rewizję katalogu uzyskaną z tej samej
    publikacji journalu i projekcji. Nie wykonuje osobnego odczytu po commicie,
    którego błąd mógłby ukryć skuteczną mutację. Idempotentny replay zwraca
    rewizję odzyskaną wraz z tym samym durable coordinator snapshotem.
11. `Stop` może przeprowadzić `Preparing` do `Stopping`, jeżeli journal zawiera
    trwały `Start` dla dokładnego claimu. Supervisor odtwarza ten stan przed
    spawnem. Brak `Started` oznacza publikację `Stopped` bez utworzenia procesu,
    terminalne `Cancelled` oraz release dokładnego lease i globalnego slotu.
12. Automatyczny retry jest dozwolony tylko po potwierdzonym wyjściu procesu i
    przy braku prywatnego katalogu dokładnego attemptu. Sam pending `Start` nie
    jest dowodem rozpoczęcia efektu; istniejąca rezerwacja attemptu oznacza stan
    niejednoznaczny, zachowuje lease i wymaga rekoncyliacji.
13. Limit automatycznych retry jest jawny, domyślnie wynosi zero i obejmuje
    wszystkie trwałe decyzje `Retry` dla taska w runie. Każda decyzja przechodzi
    przez istniejący attempt/epoch fence. Task wraca do `Queued`; supervisor nie
    wybiera w tej samej operacji nowego attemptu.
14. Decyzja automatycznego retry jest publikowana przed release lease. Po
    restarcie jedna decyzja dopasowana do terminalnego task/attempt/epoch
    uprawnia supervisor do odczytu i zwolnienia zachowanego aktywnego lease oraz
    idempotentnego zastosowania decyzji przed jakimkolwiek spawnem. Brak decyzji
    nie jest dowodem śmierci workera i nie uprawnia do takeover.
15. Supervisor publikuje niezmienny `worker_process_exit_receipt.v1` natychmiast
    po `wait`/reap potomka i przed zdarzeniem terminalnym, decyzją retry lub
    release. Receipt wiąże run/task/attempt/epoch, resource/token, dokładną
    sekwencję ostatniego heartbeat lease, PID i — gdy system go udostępnia —
    token startu procesu, status exit, timeout/Stop oraz ograniczoną przyczynę
    błędu. Tylko taki receipt, przy martwym właścicielu lokalnego slotu, pozwala
    restartowi przejąć orphan reconciliation sprzed decyzji. Sam brak PID,
    nieaktualny heartbeat lub wiek lease nadal nie stanowi dowodu zakończenia.
16. Recovery receiptu zawsze poprzedza spawn. Odtwarza dokładny claim z
    zachowanego aktywnego lease, replayuje istniejący journal, a następnie
    domyka sukces, anulowanie lub nieudany exit. Retry nadal wymaga braku
    katalogu efektu i jawnego limitu; decyzja jest zapisywana przed release.
    Receipt nie uprawnia do zmiany resource, lane'u, attemptu ani epochu.
17. Jeżeli obserwacja procesu albo zapis receiptu zawiedzie przed trwałym
    dowodem wyjścia, supervisor zachowuje globalny slot i lease fail-closed.
    Chwilowy konflikt writer lock jest ponawiany tylko dla idempotentnych
    odczytów durable store i zapisu CAS/receiptu. Błąd pollingu heartbeat lub
    `Stop` powoduje kill i reap potomka; potwierdzony wynik oraz przyczyna są
    następnie publikowane w receipcie zamiast zwolnienia slotu bez dowodu.
18. Jeden bounded scheduler może przyjąć statyczną listę typowanych ofert
    zasobów. Admission wszystkich aktualnie wolnych zasobów pozostaje
    centralne, a nadzory workerów mogą działać równolegle pod wspólnym
    `max_concurrency` i limitem tasków. Główny proces sam zapisuje checkpoint
    fairness. Każde wyjście, także po błędzie, musi dołączyć aktywne nadzory;
    nie wolno odłączyć workera ani uznać samego zakończenia nici za release.
19. Jawny tryb rezydentnego discovery może kontynuować skany po okresie bez
    gotowych tasków wyłącznie dla źródła store i trwałej tożsamości puli.
    `--max-tasks 0` oznacza brak limitu tylko przy `--resident true`; proces
    ograniczony nadal wymaga dodatniego limitu. Run z opublikowanym katalogiem,
    lecz bez preparation receiptu pozostaje chwilowo niegotowy; scheduler nie
    może go zakolejkować ani zakończyć całej usługi. Obecny, ale błędny receipt
    pozostaje błędem fail-closed.
20. Rezydentny scheduler obsługuje `SIGINT`/`SIGTERM` na Unix oraz
    `CTRL_C`/`CTRL_BREAK` na Windows. Po żądaniu zatrzymania nie przyjmuje
    nowych tasków, dołącza już aktywne nadzory, zapisuje ich checkpointy i
    kończy ze statusem `drained`. Worker Windows działa w osobnej grupie
    procesu, aby sygnał grupy schedulera nie przerwał pracy objętej drain.
21. Centralna granica zgodności claimu odrzuca ofertę solvera z niepełnym
    budżetem przed durable admission. CPU i GPU wymagają dodatnich
    `cpu_millis`, `memory_bytes` i `storage_bytes`; CPU wymaga zerowego
    `gpu_memory_bytes`, a GPU dodatniego `gpu_memory_bytes`. Ogólna walidacja
    `ResourceBudget` pozostaje szersza, ponieważ ten typ obsługuje także zasoby
    Storage i Meshing.
22. Scheduler, supervisor i worker stosują jedną pięciosekundową politykę
    ponawiania `StoreWriterBusy`. Kolejne próby otrzymują deterministyczny
    jitter zależny od procesu, wątku i numeru próby, aby konkurenci nie
    pozostawali w lockstep. Retry nie obejmuje innego błędu i nie zmienia
    tożsamości operacji, commandu, eventu, claimu ani oczekiwanej sekwencji.
23. Rezydentny scheduler może użyć trwałego `scheduler_resource_pool.v1`
    zamiast ofert procesu. Snapshot ma identyfikator puli, dodatnią i ciągłą
    generację oraz unikalne typowane oferty. Publikator zapisuje następną
    generację przez compare-and-swap; pusta lista jawnie oznacza brak nowych
    admission. Scheduler kluczuje aktywne nadzory stabilnym `resource_id`.
    Usunięcie zasobu blokuje kolejne admission, lecz nie unieważnia istniejącego
    lease i nie odłącza workera. Zmiana rodzaju lub budżetu aktywnego zasobu,
    cofnięcie generacji, zmiana payloadu bez nowej generacji albo zniknięcie już
    opublikowanej puli kończą usługę fail-closed.
24. Publikator puli może wyprowadzić lokalny snapshot z bieżącej dostępnej
    pojemności hosta. CPU, RAM i storage są po odjęciu jawnych rezerw dzielone
    między wszystkie publikowane oferty; nie wolno przypisać całej wspólnej
    pojemności każdemu GPU. UUID i wolny VRAM pochodzą z `nvidia-smi`.
    Wymagany GPU bez poprawnego pomiaru blokuje publikację. `dry-run` wykonuje
    ten sam pomiar i walidację bez zmiany trwałej generacji.
25. `run_spec.v2` wiąże requested execution z jawnym
    `minimum_resources` dla CPU, RAM, VRAM i storage. CPU wymaga zerowego
    VRAM, GPU dodatniego VRAM, a wszystkie warianty dodatnich CPU, RAM i
    storage. Scheduler porównuje pełny budżet oraz klasę urządzenia przed
    pierwszą mutacją queue/claim/admission. Niespełniająca oferta pozostawia
    task w dotychczasowym stanie. `run_spec.v1` pozostaje czytelny bez tego
    pola, ale nie może go zawierać; nowe zapisy używają wyłącznie v2.
26. `run_spec.v2` dopuszcza addytywne `scheduling_priority` od `-1000` do
    `1000`; domyślne zero nie jest serializowane, więc wcześniejsze fingerprinty
    pozostają stabilne. Scheduler wybiera wyższy priorytet przed niższym, a
    trwały kursor round-robin działa w obrębie tej samej klasy. Dodatni
    `--max-queued-runs`, nie mniejszy niż concurrency, ogranicza lokalne okno
    dependency-ready runów i raportuje peak kolejki oraz liczbę odsuniętych.
    Niematerializowany albo zależnościowo zablokowany run nie zajmuje okna;
    run poza oknem nie jest mutowany.
27. Publiczny Submit ma dodatni globalny limit nieterminalnych accepted runów,
    rozstrzygany raz przy starcie API. Idempotentny replay jest rozstrzygany
    przed admission. Kontrola pojemności i publikacja nowego intentu używają
    jednego writer locka; pełny backlog zwraca `429/run_backlog_full` bez
    `run_intent.json`. Brak katalogu i katalog z taskiem nieterminalnym zajmują
    miejsce. Niepusty katalog zwalnia miejsce dopiero wtedy, gdy wszystkie
    taski są `Succeeded`, `Failed`, `Cancelled` lub `Interrupted`.
28. Checkpoint każdego wpisu journalu jest atomowym watermarkiem obu strumieni.
    Pod jednym writer lockiem store wymaga dokładnego kolejnego prefiksu
    command/event. Równoległa publikacja drugiego strumienia unieważnia stary
    checkpoint i wymaga recovery przed ponowieniem dokładnego envelope.
29. Heartbeat supervisora jest trwałą komendą `Heartbeat`. Fizyczny
    `heartbeat_sequence` lease zwiększa się dopiero po worker-originated
    `HeartbeatAck` dla tej samej wartości. Żywy PID bez ACK nie odnawia lease.
30. `worker_protocol.v3` dodaje nieterminalne `Completing`. Po tym zdarzeniu
    worker drenuje prefiks komend, supervisor nie publikuje następnego heartbeat,
    a nowy `Stop` jest odrzucany. Dopiero potem worker publikuje outputy i
    `Completed`.
31. Trwały `Stop` nie zabija poprawnie działającego workera. Worker oznacza go
    jako applied, przerywa kontrolowany side effect i publikuje `Stopped`.
    Supervisor po obserwacji Stop wyłącza heartbeat, czeka na exit i zwalnia
    lease dopiero po terminalnej rekoncyliacji.
32. Dokładny nadal aktywny lease może przyjąć końcową, już potwierdzoną
    sekwencję heartbeat po terminalnym zdarzeniu, ale przed release. Wyjątek
    służy wyłącznie domknięciu ACK; admission terminalnego taska i nowy
    ownership nadal są odrzucane.
33. `stop_requested` w receipcie opisuje intencję operatora, nie wynik procesu.
    Niezerowy exit zawsze zachowuje `failure_reason`; Stop nie może zamienić
    awarii workera w potwierdzone anulowanie.
34. Publiczne `fullmag run-json` przyjmuje wyłącznie kompletny immutable
    accepted-run request i wykonuje Submit, opcjonalną materializację oraz
    readback przez HTTP API v2. Nie wolno mu wywoływać solvera bezpośrednio.
    Dawna ścieżka kanonicznego `ProblemIR` pozostaje czasowo dostępna wyłącznie
    jako ukryte `run-problem-json-direct` dla repozytoryjnych bramek naukowych i
    diagnostycznych. Ukryte `submit-run-json` jest aliasem zgodności publicznego
    transportu; oba mosty usuwa Fullmag core po migracji wszystkich zarządzanych
    bramek na accepted RunSpec i po jednym cyklu wydania bez zewnętrznego użycia.

## Konsekwencje

- `FmsTaskCatalogEntry` otrzymuje addytywne, opcjonalne pole watermarku. Nie
  zmienia się OpenAPI, Python DSL, `ProblemIR`, fizyka, requested execution ani
  zachowanie UI.
- Legacy catalog bez watermarku/genesis pozostaje czytelny. Gdy ma kompletny
  journal, recovery może wyliczyć i zapisać watermark; pusty journal bez
  genesis pozostaje odmową.
- Recovery odrzuca ciągły journal krótszy niż zapisany watermark. Pusty journal
  bez poprawnego genesis pozostaje odmową; przy genesis wymaga watermarku zero.
  Odzyskanie utraconego payloadu nie jest automatyczne.
- Sam watermark nie zastępuje fenced admission, bootstrapu, supervisora,
  transportu, reconciliation efektów workera ani dowodu zwolnienia zasobów.
- Heartbeat procesu potwierdza liveness lokalnego procesu i utrzymanie lease.
  Nie jest dowodem postępu solvera, poprawności fizyki ani kwalifikacji lane'u.
- Ukryty direct runner nie jest publicznym kontraktem, accepted-runtime proof
  ani podstawą do omijania schedulera, claimu, lease'u i provenance. Jego
  artefakty zachowują znaczenie wyłącznie w zakresie konkretnej wewnętrznej
  bramki, która go uruchamia.
- Receipt procesu jest dowodem wyłącznie tego, że supervisor zreapował dokładny
  proces potomny przypisany do fenced claimu. Nie jest scientific receiptem,
  dowodem zwolnienia pamięci urządzenia na zdalnym hoście ani kwalifikacją
  pozostałych lane'ów.
- `Stopping` oznacza trwałe żądanie, a `Cancelled` potwierdzony terminalny
  wynik koordynatora. Samo kliknięcie UI ani wysłanie HTTP nie dowodzi wyjścia
  procesu i nie uprawnia do zwolnienia lease.
- Statyczna oraz dynamiczna pula wielu zasobów, rezydentne store-discovery i
  jawny drain
  zmniejszają potrzebę uruchamiania procesu per zasób i per okres pracy.
  Brak limitu tasków jest bezpieczny wyłącznie w trybie rezydentnym z obsługą
  sygnału. Trwały snapshot członkostwa nie jest automatycznym discovery hostów,
  limitem publicznego Submitu, rozproszonym backpressure ani lock managerem.
- `run_spec.v2` określa minimalne zapotrzebowanie przyjętego runu, a scheduler
  odrzuca zbyt małą ofertę przed mutacją taska. Kontrakt nie sumuje obciążenia
  wielu tasków i nie dowodzi egzekwowania limitów przez system operacyjny,
  kontener ani urządzenie GPU. Legacy `run_spec.v1` zachowuje poprzednie
  zachowanie i nie jest automatycznie wzbogacany przez zgadywanie wymagań.
- Lokalny snapshot jest chwilowym pomiarem dostępnej pojemności, a nie
  egzekwowaniem limitu przez OS, kontener lub sterownik. Nie jest discovery
  hostów zdalnych ani klastrowym resource managerem.
- Jitter poprawia liveness lokalnej kontencji, lecz nie zastępuje kolejki
  rozproszonej ani nie uprawnia do ponowienia nieidempotentnego side effectu.
  Po przekroczeniu deadline'u store nadal zwraca dokładny błąd fail-closed.
- Limit publicznego Submitu chroni pojedynczy trwały store przed nieograniczonym
  backlogiem, lecz nie jest limitem per-project/per-tenant ani rozproszonym
  quota managerem. Obiekty CAS zweryfikowane przed atomowym admission mogą po
  `429` pozostać nieosiągalne i podlegają bezpiecznej polityce GC.
- Lease potwierdza teraz liveness widziane przez proces workera, a nie tylko
  poll PID przez supervisora. Nadal nie jest dowodem postępu solvera ani
  zwolnienia urządzenia na innym hoście.
- `Completing` wyznacza zamknięcie control plane przed `Completed`. Publiczny
  cancel przegrywający ten fence otrzymuje odmowę zamiast pozornego sukcesu.

## Obowiązki implementacyjne

- Addytywne typy `FmsCoordinatorWatermark` i `FmsCoordinatorGenesis`; genesis
  wiąże wyzerowany typed checkpoint z run/task/attempt/epoch/lease.
- `commit_coordinator_genesis` wymaga aktywnego taska oraz dokładnego aktywnego
  resource lease i publikuje checkpoint przed dispatch.
- `commit_transition` po trwałym zapisie journalu wykonuje reconciliation
  lifecycle, observation i watermarku. `recover_coordinator` odrzuca watermark
  wyższy od kompletnej historii.
- `SessionStore::commit_run_catalog` nie pozwala usunąć ani obniżyć watermarku
  dla tego samego epoch; może wyczyścić zakończony attempt, ale nowy attempt
  resetuje watermark wyłącznie po zwiększeniu epoch.
- Ogólny `commit_run_catalog` nie może wstawić ani zmienić genesis. Tylko
  dedykowana publikacja `commit_coordinator_genesis` przechodzi przez aktywny
  task/lease fence; obejmuje to pierwszy zapis katalogu.
- Regresje sprawdzają odzyskanie świeżego genesis bez transitionów, awans
  watermarku po command i event, replay bez podwójnego awansu, repair catalogu
  w tyle oraz odmowę po utracie wpisów wskazanych przez watermark.
- Regresje procesu sprawdzają dodatnią sekwencję heartbeat, retry kontencji
  writera, zatrzymanie timera po terminalnym lifecycle, publikację pod nowszym
  heartbeat oraz release dokładnej ostatniej wersji lease po exit.
- Regresje anulowania sprawdzają trwałość i replay `Stop`, konflikt przyczyny,
  potwierdzony exit potomka, rozdzielenie timeout/cancel, terminalne
  `Cancelled`, odrzucenie późnego `Completed` oraz anulowanie po trwałym
  `Start`, ale przed `Started`, bez spawnu procesu potomnego.
- Process E2E buduje supervisor i worker, zatrzymuje potomka po trwałym
  `Started`, sprawdza `Cancelled`, release ostatniego lease, brak artefaktów
  sukcesu i pozostawiony pending `Start`; osobna trasa potwierdza nadal sukces.
- Regresja automatycznego retry wymusza wyjście workera po zweryfikowaniu
  pending `Start`, ale przed rezerwacją effect directory. Sprawdza trwałą
  decyzję, powrót taska do `Queued`, brak lease i artefaktów.
- Regresja restartowa wymusza twarde wyjście procesu supervisora po journalu decyzji, lecz przed
  release, a drugi proces musi dokończyć release/apply bez dostępu do binarium
  workera.
- Regresja wcześniejszego orphan window wymusza twarde wyjście supervisora po
  potwierdzonym exit i trwałym `worker_process_exit_receipt.v1`, ale przed
  terminalnym eventem i decyzją. Restart otrzymuje nieistniejące binarium
  workera; musi utworzyć dokładnie jedną decyzję, zwolnić exact lease i ustawić
  task na `Queued` bez spawnu. Store/archiwum osobno sprawdzają fencing,
  idempotencję, reachability oraz roundtrip `.fms` receiptu.
- Regresja statycznej puli uruchamia jeden scheduler z dwiema ofertami CPU,
  wymaga jednoczesnego `Running`, terminalnego sukcesu obu tasków, dwóch
  dokładnych `resource_id` w summary i braku aktywnych lease. Osobna regresja
  zachowuje same-resource fencing dwóch procesów pod kontencją writera.
- Regresja rezydentnego discovery uruchamia scheduler przed utworzeniem
  ostatniego runu, potwierdza przeżycie pustego okresu, następnie publikuje i
  materializuje nowy run. Ten sam proces ma wykonać trzeci task, zapisać trzeci
  checkpoint puli i zakończyć się dopiero po osiągnięciu `max_tasks`.
- Regresja drain uruchamia scheduler bez limitu tasków, czeka na `Running`,
  wysyła sygnał zatrzymania i wymaga sukcesu aktywnego workera, zwolnienia
  lease, pozostawienia drugiego taska w `Accepted` oraz summary
  `status=drained`, `shutdown_requested=true`, `max_tasks=null`.
- Regresje centralnej zgodności ofert sprawdzają każdy brakujący wymiar budżetu
  CPU/GPU oraz poprawne oferty obu klas przed jakimkolwiek zapisem admission.
- Dwie kolejne regresje statycznej puli i osobna regresja z wymuszoną kontencją
  muszą potwierdzić overlap, terminalny sukces i zwolnienie obu lease'ów na
  identycznym źródle.
- Regresja dynamicznej puli publikuje kolejno pustą generację, zasób A oraz
  zasób B. Usuwa A podczas `Running`, wymaga dokończenia dokładnego lease A,
  przyjęcia drugiego taska na B, terminalnego sukcesu obu tasków i braku
  aktywnych lease'ów. Osobne regresje zachowują statyczną pulę i resident run
  discovery.
- Regresje `run_spec.v2` sprawdzają obowiązkowe minima, zgodność CPU/GPU oraz
  odczyt legacy v1. Regresje schedulera sprawdzają każdy zbyt mały wymiar,
  brak mutacji taska po odmowie i późniejsze wykonanie przez wystarczającą
  ofertę.
- Managed próba discovery uruchamia binarkę w trybie `dry-run`, potwierdza
  dodatnie CPU/RAM/storage, jawny status GPU oraz niepokrywający się podział
  wspólnej pojemności. Osobne process E2E publikuje snapshot, wykonuje admission
  FDM CPU, uruchamia task i wymaga zwolnienia dokładnego lease.
- Managed próba publicznego Submitu wypełnia limit, wymaga replayu `200`,
  odmowy nowego payloadu `429` bez intentu, terminalizuje część backlogu i
  wymaga późniejszego `201` dla dokładnie tego samego odrzuconego payloadu.
- Managed process E2E wymaga dla każdego sukcesu dokładnej, niepustej pary
  `Heartbeat`/`HeartbeatAck`, jednego `Completing` przed `Completed`, pustego
  pending inboxu i released lease z końcową sekwencją ACK. Osobny przebieg
  publikuje publiczny `Stop` podczas `Running` i wymaga applied Stop,
  worker-originated `Stopped`, poprawnego exit receiptu oraz release lease.

## Migracja i rollback

`None` jest zachowane przy odczycie starych catalogów. Pierwszy kompletny
recovery istniejącego journalu może wypełnić watermark. Wartości nie wolno
usuwać podczas rollbacku; starszy reader ignoruje addytywne pole. Nie
przeprowadzać migracji przez zgadywanie stanu pustego journalu.

Wywołania repozytoryjne dawnego direct `run-json` przechodzą na ukryte
`run-problem-json-direct`, a bramki accepted-runtime na publiczne `run-json`.
Rollback może przywrócić nazwę aliasu accepted transportu, lecz nie może
ponownie wystawić bezpośredniego wykonania jako publicznego `run-json`.

## Walidacja i status

Source/contract gates są oddzielone od procesu workera i kwalifikacji solvera.
Testy integracyjne wymagają managed build runnera. Kontrakt `run_spec.v2`,
scheduler i readback OpenAPI przechodzą source-only check; zapisane regresje
minimum zasobów pozostają `NOT RUN` podczas aktywnego zakazu kompilowania testów
jednostkowych. Pełne lokalne process E2E sukcesu, anulowania żywego procesu,
anulowania przed spawnem i orphan recovery
sprzed decyzji ograniczonego FDM CPU przechodzą. Przechodzą również bounded
statyczna pula dwóch zasobów, rezydentne discovery runu utworzonego po starcie
schedulera, kontrolowany drain procesu bez limitu tasków oraz monotoniczną
dynamiczną pulę A → B z zachowaniem aktywnego lease. Lokalny discovery dry-run
CPU/RAM/storage/VRAM oraz procesowe E2E publikacji, admission, workera FDM CPU i
zwolnienia dokładnego lease także przechodzą. Produkcyjne `run-json` wykonuje
immutable Submit/materialization/readback przez publiczne API v2. Bezpośrednia
ścieżka ProblemIR jest ukrytym narzędziem repozytoryjnym, a poprzednia nazwa
accepted transportu pozostaje ukrytym aliasem przejściowym. Immutable priority i
lokalne ograniczone okno kolejki mają process E2E dla pięciu runów. Atomowy
limit publicznego Submitu ma osobny dowód `200/429/201` i nie publikuje intentu
po odmowie. `worker_protocol.v3` ma procesowy dowód rzeczywistych
`HeartbeatAck`, bariery `Completing` oraz worker-originated `Stopped` dla
lokalnego FDM CPU/double/strict (receipt
`ee5c9689c1af4be7b11797c3815d960b`). P5-B pozostaje otwarte dla transportu
cross-host, dowodu braku równoległego starego workera i zwolnienia urządzenia
na pozostałych lane'ach.
