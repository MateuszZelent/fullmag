# Propozycja: obserwacja zatrzymanej przestrzeni po zewnętrznym stopie Docker

**Status:** propozycja kontraktu; niezaimplementowane i nieweryfikowane w
runtime. **Zakres:** odzyskanie tej samej grupy po zatrzymaniu przez Docker
Desktop/daemon, gdy nie powstał wcześniejszy zarządzany `stop-journal`.

## Problem i granica

Istniejące `recreate-volume --recovery-authorization` wymaga niezmiennego
managed stop-journalu, a `recover_docker_orphan` odmawia rekonstrukcji już
zatrzymanego kontenera bez requestu opublikowanego przed stopem. Te bramki
pozostają bez zmian: nie wolno udawać journalu, przepisywać `OWNER.json` ani
receiptu, ponawiać `RunIntent`/Solve ani zakładać, że brak procesu oznacza
zwolnienie zasobów.

`runtime_service_main` nie ma Docker socketu. To hostowy observer musi wykonać
autorytatywny `inspect`; native runtime otrzymuje wyłącznie zweryfikowany,
przypięty rekord z control volume. `failed_outcome_retained` pozostaje
historycznym nieznanym wynikiem, nigdy zwykłym `shutdown_unknown`, `succeeded`,
`drained` ani `ready`.

## Decyzja proponowana

Dodać append-only rekord
`fullmag.docker-stopped-namespace-observation.v1`. Jest osobnym dowodem
zewnętrznego stopu, a nie retroaktywnym managed stop-journalem ani zamiennikiem
`fullmag.docker-stopped-namespace-attestation.v1` używanego przez istniejące
stop-failed reconciliation. Host observer publikuje go dopiero po dokładnym
odczycie Docker Engine i niezmiennych danych control volume, pod blokadą grupy;
nie mutuje store, ledgeru, starego receiptu ani `OWNER`.

Rekord wiąże:

- `observation_id`, engine ID, `compose_project`, source root/SHA,
  `development_attempt`, config/request/session/run/task identity oraz exact
  control volume;
- backend/frontend: pełne container ID i image ID, source/group labels,
  mount/network/device fingerprint, `StartedAt`, `FinishedAt`, exit code,
  `Running=false`, `Pid=0`, private PID namespace, `host_pid=false` oraz
  bounded wynik procesu potomnego;
- SHA i względne ścieżki do failed process receipt, failed `OWNER`, failure
  probe, runtime config/launch, accepted RunIntent/catalog/preparation,
  request/provenance, ledger snapshot i ewentualnego unknown activation;
- exact old-owner/run/reservation identity oraz potwierdzenie, że między
  inspectem i publikacją nie nastąpił restart/usunięcie kontenera (ponowny
  inspect i stabilne odczyty CAS są obowiązkowe);
- `outcome=unknown` lub `quarantined`, bez zmiany historii symulacji.

### Dwa rozłączne wyniki zasobów

1. **Owner handoff:** wszystkie lease/reservation tej konkretnej grupy są już
   jawnie `released`, a store ma tylko zachowane sesje, wyniki, catalogi i
   receipty, bez aktywnego queue/writera. „Pusty” nie oznacza usunięcia sesji
   ani wyników. Wtedy można odtworzyć accepted workspace bez zwalniania
   czegokolwiek.
2. **Exact reservation reconciliation:** konkretna aktywna lease i hostowa
   reservation są przypięte przez `(store_id, run_id, task_id, attempt_id,
   ownership_epoch, resource_id, lease_token, request_sha256, runtime
   generation)`, a observer dowodzi zatrzymania wyłącznie jej prywatnej,
   nieuprzywilejowanej przestrzeni. Native reconciler może wtedy zmienić
   tylko tę reservation/lease na stan odzyskany i zapisać
   `FmsRetryAction::AwaitReconciliation`; zachowuje unknown outcome, historię
   i inne worktree. Nie czeka na globalnie wolne GPU ani nie dotyka obcych
   reservation.

Brak pinów, active/unknown writer lub lease poza exact target, zmiana
container/image/source/group/engine/timestamp, niepełny process tree, zmiana
request/session/config, niespójna aktywacja albo brak stabilnego CAS kończy się
quarantine/stopped bez mutacji. Konieczny jest brak aktywnego inventory
publishera tylko w krytycznej transakcji ledgeru; nie jest to wymóg globalnej
bezczynności hosta.

## Najmniejszy reuse native

Nie rozszerzać semantyki `RuntimeServiceConfig::recover_container_empty` ani
`RuntimeServiceContainerRecoveryRequest` v1. Ten kod używa
`require_empty_runtime_store`, które celowo odrzuca retained runs; jest właściwy
wyłącznie dla całkowicie pustej przestrzeni bez accepted session.

Dla zachowanego accepted workspace użyć istniejącego prywatnego
`development_accepted_restore::restore_before_listen`,
`load_accepted_restore` i `validate_backing_records`: te funkcje odtwarzają
immutable Study/Scene, RunIntent, catalog/preparation anchor i scheduler-ready
projection bez nowego RunIntent oraz bez Solve. Ich backing-record validator
powinien przyjąć nowy external observation obok dotychczasowej ścieżki
stop-failed, nadal rozróżniając obie provenance.

Dla przypadku 2 wykorzystać typy i idempotentne granice z
`crates/fullmag-session/src/host_resource_ledger/worker_orphan_teardown.rs`:
`WorkerOrphanTeardownRequest`, `WorkerOrphanExactIdentity`,
`DockerNamespaceTeardownAttestation`, `WorkerOrphanTeardownReleaseProof` oraz
`FmsRetryAction::AwaitReconciliation`. Istniejące
`HostResourceLedger::begin_worker_orphan_teardown`/
`complete_worker_orphan_teardown` wymagają jednak pre-stop intentu i globalnego
quiescence; nie wolno wywoływać ich po daemon stopie jako fałszywego managed
intentu. Dodać wąski origin-specific sibling request/method dla external
observation, współdzielący walidację exact identity i proof release, ale
odrzucający obce reservation i nie wymagający globalnego GPU idle.

Typed observation oraz jego bounded reader należą do
`crates/fullmag-session/src/host_resource_ledger/worker_orphan_teardown.rs` /
`crates/fullmag-runtime-control/src/runtime_service_client.rs`; hostowy
producer/validator do `scripts/docker_volume_container_recovery.py` lub
`scripts/docker_volume_accepted_reattach.py`. Native consumer przyjmuje tylko
SHA/path zweryfikowanych recordów oraz bieżącą compiled source/config/group/
control-volume identity. Nie dodawać publicznego HTTP endpointu.

## Niezależne bramki

1. Po zwykłym daemon stopie: dokładny inspect, retained accepted session/results,
   brak active queue/writer, stabilna observation i reattach bez RunIntent/Solve.
2. Po external stopie z exact active reservation: inny worktree pozostaje
   aktywny; tylko przypięta lease/reservation przechodzi przez reconciliation,
   a catalog dostaje `AwaitReconciliation` i unknown outcome.
3. Negatywne przypadki zmieniają osobno ID/image/source/group/timestamp/engine,
   owner/process/probe/store/ledger/request SHA, reservation identity,
   activation i control volume; każda odmowa jest bez mutacji. Sprawdzić
   restart/delete między dwoma inspectami oraz symlink/niepełny process tree.
4. Replay tego samego observation/request zwraca istniejący receipt; zmienione
   bajty konfliktują. Existing managed v1 nadal wymaga stop-journal, orphan
   route zachowuje odmowę post-factum, a inne worktree/lease nie są kasowane.

Python interpreted tests można dodać obok
`scripts/test_docker_volume_container_recovery.py`; Rust unit tests do nowych
typed records i exact reservation path, uruchamiane w CI. Rollback wyłącza
wyłącznie nowy consumer i zostawia grupę w stopped/quarantined. Przed
implementacją potrzebne jest osobne ADR/rewizja kontraktu; ta propozycja nie
jest dowodem recovery mastera ani runtime.
