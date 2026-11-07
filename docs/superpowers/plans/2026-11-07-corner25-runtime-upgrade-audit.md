# Corner25: odbiór siatki i audyt gotowości aktualizacji runtime

Status: wykonany audyt odczytowy; bez buildu, zatrzymania usług, zwalniania
rezerwacji lub nowego Solve. Dokument nie jest zatwierdzonym planem operacji.

## Odbiór zatwierdzonej próby

Jedna zatwierdzona kontynuacja prepare-only 8b99f132491b4c0f9e6305186a252b87
wygenerowała rzeczywistą siatkę 40 783 Tet4. Publiczny CLI ze starszego pakietu
odrzucił interactive_session_requested i wait_for_solve. Cała próba ma stan
failed-confirmed; gotowy request nie powstał. Nie ponowiono przygotowania.

[Rzeczywiste liczności, metryki naroży, piny i kopia WSL](2026-11-07-gsg-corner25-prepare-proposal.md#odbiór-jednej-zatwierdzonej-kontynuacji--07112026)
opisują zakończone wykonanie. Nowa siatka nie oznacza nowej wartości błędu
prądu ani potwierdzenia zgodności z publikacją.

## Aktualna grupa i dane zachowane

- Worktree: /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011.
- HEAD audytu: cecd1ae8293af4e63a0f8952206ff5a1180392ff.
- Compose: fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
- Development attempt: 894d4efb43eb483eb6179d8d49fd449e.
- Config SHA256: 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4.
- Backend: 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
- Frontend: 271d8c4d455871a1b7b4b2fc34c55b9a122a3df305e0cd0c3382f072ac6779c4.
- Obraz: sha256:098568de0076be53ea36a7b99c02e8b8e263f3311aec36ba0b8de07451fea682.
- Pakiet: 0.1.0-dev.20261105.g006e8f024f89.dirty.s42d570eca01a+9805.

Odczyt HTTP potwierdził health=ok i active_session=true. Właściciel i process
receipt mają stan ready; API PID 19646, runtime PID 19654, schedulery 19657
i 19658. Nie wysyłano sygnałów i nie zmieniano tej inkarnacji.

Nie należy wnioskować o braku izolacji wolumenu z Mounts.Source.
HostConfig.Mounts[].VolumeOptions.Subpath potwierdza private/backend,
private/frontend i private/ledger w jednym prywatnym wolumenie grupy.
Sam ten odczyt nie kwalifikuje całej retencji ADR 0076.

## Zweryfikowana historia poprzedniego V/J/H

Run: run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e.
Task: task-902544fbad21c9da53757ca22786517f6866733c15a4e24dd380524b0c4cd859.
Attempt: attempt-b7eaad04933643379cd377462f2899b6, ownership_epoch=1.
Lease: lease-59f9d3a7b6384d23887e3ed3eec88664, heartbeat=222.

Task pozostaje Succeeded/reconciling. Istnieje autentyczny
worker-process-exit-2ab423eb3ff9757eaaf8c70fb7e00f1abcf442cb597062954ae56be4da314bd5:
exit_code=0, status_success=true, timed_out=false, stop_requested=false.
Lokalna rezerwacja pozostaje Active; jedyna niezwrócona rezerwacja hosta
jest Quarantined. Stan nie oznacza trwającej pracy solvera.

Uruchomiono wyłącznie istniejącą, odczytową funkcję
scripts/docker_dev_recovery_build.py::succeeded_worker_build_evidence,
wyodrębnioną bez zmiany jej treści. Przeszło 457 dokumentów: pełne ciągłe
dzienniki, zastosowany Start i heartbeats, osiadły inbox, udany exit receipt,
brak PID workera, zgodność rezerwacji oraz komplet opublikowanych artefaktów
i manifestu. Piny rezerwacji ponownie porównano po kontroli.

To kontrola historii, nie pełny preview buildu. Parametr diagnostic_api_only
należy do interfejsu tej funkcji; nie jest dowodem, że obecne API działa
diagnostycznie. Nie wywołano diagnostic_api_evidence, runtime_locks,
BuildControl ani wejścia budującego pakiet.

Dowody w prywatnym control volume:
verification/gsg-corner-refinement-20261107/runtime-upgrade-audit-v1/.

| Dowód | SHA256 |
|---|---|
| canonical-succeeded-history-build-proof.json | 7d6332f7881b0889d287874f099c197a070ff320397e1f487ec4c34326568aaa |
| history-audit-result.json | e25f47adb81b33e413ecf724f518c3cd3fd77ee7316438d606cc52f4763a320c |
| Źródło kontrolera recovery build | ec827f43a1b64794d40d02c0b41b5b58a49eb124729044db80dd1ec10acb5fb8 |
| Dokładna funkcja walidatora historii | b8305f3ef484df4e95b2ab99e1a53275ff7d8173c7b9e62c1b9aff2dbabb9e78 |

Historia i dane naukowe są zachowane na ext4 WSL; uprzedni pełny odczyt
1 958 obiektów CAS i kopii siatki opisuje podlinkowany raport. Nie powtarzano
go jako pozornego nowego cold-load. Obecna kontrola semantyczna jest odrębnym
dowodem, nadal bez nowego uruchomienia fizyki.

## Potwierdzona luka między zwykłym drain i recovery

1. docker/all-in-one/runtime_service.py::stop wywołuje
   service-drain-confirmed po zamknięciu API.
2. crates/fullmag-runtime-control/src/runtime_service_client.rs::request_pinned_drain
   i crates/fullmag-api/src/runtime_service_main.rs::drain_requested
   nie utożsamiają ConfirmedDrain z IdleConfirmedDrain.
3. crates/fullmag-api/src/accepted_scheduler_main.rs kończy drain po opróżnieniu
   pamięciowych active_workers/pending_task_outcomes; nie dowodzi to zwolnienia
   trwałej rezerwacji. Końcowy właściciel Drained nie jest dowodem Released.
4. crates/fullmag-api/src/succeeded_worker_recovery.rs::Request::validate
   dopuszcza Unknown/Failed, a validate_process_receipt wymaga konkretnego
   diagnostic-only receipt i nieobecności oryginalnych usług.
5. scripts/docker_dev_recovery_build.py::validate_diagnostic_build oraz
   diagnostic_api_evidence wymagają właściwego Unknown/fenced diagnostic API.
6. scripts/docker_volume_succeeded_namespace_recovery.py::validate_worker_evidence
   odrzuca istniejący exit receipt. Ta ścieżka naprawy brakującego receipt nie
   pasuje do bieżącego przypadku.
7. Bezpośredni SIGTERM właściciela nie gwarantuje publikacji Unknown; zapis Ready
   może pozostać. Nie wolno ręcznie podmienić ownera/process receipt w celu
   spełnienia warunków recovery.

Wniosek potwierdzony również niezależnym audytem źródeł: nie znaleziono kompletnej
istniejącej ścieżki aktualizacji dla obecnego Ready + Succeeded + rzeczywisty
exit receipt + Active/Quarantined. Nie uruchomiono zwykłego stop jako próby,
która mogłaby pozostawić działające obecnie UI bez API.

## Następna bramka i ograniczenia zakresu

Potrzebny jest konkretny projekt brakującego przejścia do istniejącego native
recovery albo poprawnej aktualizacji przy zachowaniu tych samych dowodów.
Projekt musi zamknąć cały cykl: dopuszczenie spójnego kandydata API/CLI,
verify-only, zwolnienie tylko tej rezerwacji, kontrolowany start i odczyt
zachowanego wyniku. Nie wystarczy umożliwić samo zatrzymanie kontenera.

Nie zatwierdzono tutaj nowego kontraktu, nie osłabiono starych odmów i nie
obiecujemy, że zwykły restart usunie tę blokadę. Poprzednia zgoda jawnie
wykluczała build i restart. Nowa decyzja może dotyczyć dopiero przejrzanego,
konkretnego zakresu; ten audyt nie rozszerza jej automatycznie.

Cleanup etapu: zachować siatkę, jej wejścia, dowody oraz pakiety current/rollback.
Nie potwierdzono zbędności żadnych zasobów; aktywne usługi i lease blokują
kwalifikowane sprzątanie. Nie wykonano prune, kasowania cache ani wolumenów.

Obliczenie J/H na corner25, nowa eta, zbieżność względem publikacji oraz LLG
pozostają niewykonane. Nie należy oznaczać E0–E12 jako ukończonego.
