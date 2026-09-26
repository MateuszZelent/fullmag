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
- `Stopping` oznacza trwałe żądanie, a `Cancelled` potwierdzony terminalny
  wynik koordynatora. Samo kliknięcie UI ani wysłanie HTTP nie dowodzi wyjścia
  procesu i nie uprawnia do zwolnienia lease.

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

## Migracja i rollback

`None` jest zachowane przy odczycie starych catalogów. Pierwszy kompletny
recovery istniejącego journalu może wypełnić watermark. Wartości nie wolno
usuwać podczas rollbacku; starszy reader ignoruje addytywne pole. Nie
przeprowadzać migracji przez zgadywanie stanu pustego journalu.

## Walidacja i status

Source/contract gates są oddzielone od procesu workera i kwalifikacji solvera.
Testy integracyjne wymagają managed build runnera. Pełne lokalne process E2E
sukcesu, anulowania żywego procesu i anulowania przed spawnem ograniczonego FDM
CPU przechodzą. P5-B pozostaje otwarte do automatycznego schedulera, orphan
reconciliation sprzed journalu decyzji, zdalnego ACK oraz dowodu braku równoległego starego workera dla
pozostałych lane'ów.
