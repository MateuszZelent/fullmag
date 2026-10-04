# P8-53N — inventory globalnej bramki bezczynności

Stan: SOURCE AUDIT, implementacja pending. Ten dokument nie jest dowodem
bezpiecznego restartu. Zakres obejmuje accepted compute/preparation, nie wszystkie
historyczne/live-session ścieżki wykonania.

Aktualizacja: poniżej zachowano inventory sprzed implementacji. Trwały fence
i częściowe dowody procesu opisuje [P8-53O](53o-durable-admission-fence.md);
pełne bramki restartu i wyścigów pozostają otwarte.

## Wspólna granica

`SessionStore::write_transaction` (`crates/fullmag-session/src/store.rs`) używa
natywnego `WRITER.lock` przez `File::try_lock` w `writer.rs`. Reentrancy dotyczy
tylko owning thread. Nie znaleziono wspólnego durable admission/maintenance fence.

`active_run_intent_count_unlocked` konserwatywnie uznaje brak/pusty catalog i
wszystkie stany poza Succeeded/Failed/Cancelled/Interrupted za aktywną pracę.
Potrzebne jest również sprawdzenie aktywnych leases niezależnie od terminalnej
projekcji katalogu. Preparation ma globalny scan; compute ma scan tylko dla
konkretnego resource ID, więc wymaga enumeracji całego zbioru leases.

## Producenci wymagający kontroli pod writer transaction

| Granica w `SessionStore` | Wymagana ochrona |
|---|---|
| `commit_run_intent_with_optional_backlog_limit` | Nowy accepted intent; istniejący identyczny replay nie tworzy pracy |
| `commit_task_admission`, `reconcile_task_admissions` | Nowy compute dispatch i crash replay |
| `commit_resource_lease` | Bezpośrednie przyjęcie compute lease |
| Trzy warianty `commit_preparation_resource_lease` | Admission preparation, również niezależny resident scheduler |
| `commit_retry_decision`, `apply_retry_decision` | Retry przywracający Failed/Interrupted do Queued; terminalne stop/cancel muszą pozostać możliwe |
| `commit_preparation_retry_decision` | Uprawnienie do nowej próby preparation |
| `commit_run_catalog` | Genesis/requeue odróżnione od terminalnej projekcji |
| `commit_preparation_process_launch` | Dodatkowa granica przed spawn, oprócz active preparation lease |

Compute claim prowadzi przez `runtime-control/claim.rs` i scheduler. Preparation
przyjmuje lease w `accepted_fem_preparation_scheduler_main.rs`; supervisor zapisuje
process launch przed spawn. Trwałe admission/leases pozwalają wykryć dispatch,
który jeszcze nie uruchomił procesu. Same shutdown flags/pipes nie zamykają wyścigu.

## Kolejność następnej implementacji

1. Pod writer sprawdzić cały accepted catalog i wszystkie aktywne leases.
   Busy lub unknown odrzuca restart bez uruchomienia drain.
2. W tej samej transakcji opublikować trwały, owner-bound admission fence.
   Wszystkie powyższe entrypoints muszą go sprawdzać przed tworzeniem pracy.
3. Zwolnić writer, zachowując fence, i użyć owner-authenticated drain obu schedulerów.
4. Wymagać terminalnych receipts, potwierdzonego ownera i zwolnienia jego zasobów
   przed przejęciem przez replacement. Usunięcie fence musi również sprawdzać ownera.

Nie trzymać `WRITER.lock` podczas oczekiwania na exit: schedulery zapisują pod
tą samą blokadą checkpointy, release oraz końcowe receipts. Fence ma blokować
tworzenie pracy, pozwalając zakończyć już obserwowany lifecycle. Crash/nieznany
wynik pozostawia stan fail-closed; wiek pliku ani PID nie dowodzi prawa takeover.

Obecny `drain_confirmed` w `runtime_service_main.rs` nie wykonuje idle check.
Potwierdza drain wskazanego ownera, ale nie zastępuje tej bramki. Lokalny
`DevelopmentFreeze` zamyka mutacje danego API; nie chroni przed zewnętrznym
producentem accepted work. Implementacja i runtime race/fault gates pozostają
NOT VERIFIED.
