# ADR 0065 — zachowanie nieznanej próby Docker i osobny namespace nowego startu

Data: 20.10.2026. Status: zaimplementowane w źródłach; kwarantanna zastosowana
20.10.2026 (`b4780ecd49134b88af963f773fe90f12`); runtime aplikacji nadal
NOT VERIFIED. Zakres: prywatny launcher DEV, bez zmiany fizyki,
ProblemIR, API ani solverów FDM/FEM CPU/GPU.

## Kontekst

Usunięcie kontenerów pozostawiło `active` dla nieznanej aktywacji i manualny
run czekający na preparation. V1 odzyskiwania pustego store nie obsługuje
tego przypadku. Usunięcie markera/ownera lub ponowienie starego requestu
nie jest poprawnym recovery. Operator jawnie zlecił nowy start przy zachowaniu danych.

## Decyzja

Jednorazowy protokół `docker_control_namespace` może odizolować bazowy namespace,
gdy istnieje dokładnie jeden manualny, niewykonany run z trwałą intencją anulowania,
terminalny failed owner, brak kontenerów grupy i żywych obcych konsumentów
oraz wyłącznie zwolnione rezerwacje hosta.

Helper ponawia kontrolę hashów pod globalnym operation lockiem, lockami
startup/launch/owner, store writer i ledger writer/inventory. Nie ma sieci,
socketa Docker ani writable bindów hosta. Host ponawia inwentarz i engine ID
przed COMMIT. Dowód obejmuje współpracujących klientów; nie zastępuje kontroli
dowolnych ręcznych poleceń administratora Docker.

Oryginalny `active`, receipt, owner, CAS i store pozostają na miejscu. Immutable
receipt zapisuje `quarantined-not-replayed` i `unknown-retained`, nigdy fikcyjne
`failed`, `succeeded`, `drained` lub `FinishedAt`. Rejestr autoryzuje wyłącznie
nową intencję i zakazuje replay starego request ID. Resolver i bramka aktywacji
weryfikują ten receipt; brak unresolved.json w nowym namespace nie stanowi zgody.

Nowe metadane używają `namespaces/<uuid>` w tym samym control volume i tej samej
grupie Compose. Nazwy, tożsamości i dane cache build/package pozostają zachowane.
Helpery i mounty control/runtime/frontend używają przypiętego subpath. Każda
operacja nadal trzyma bazowy operation.lock; alias locka w namespace jest
hardlinkiem tego samego inode dla istniejących reconcilerów. Rejestr SHA jest
sprawdzany przed operacją i pod blokadą. Stare klienty zatrzymuje zachowany active.

## Konsekwencje i rollback

Nowy start dostaje świeży owner i state root. Starego projektu/runu nie odtwarza
automatycznie; pozostaje zachowany do osobnego odzyskania. Ledger nie jest
resetowany. Nie rozszerzać tej ścieżki na aktywne lease/rezerwacje ani kolejne
generacje bez osobnej decyzji.

Nie cofać wskaźnika podczas aktywnego nowego runtime. Utrata obserwacji wymaga
odczytu receipt i rejestru bez zgadywania wyniku lub usuwania danych. Częściowa
publikacja przed rejestrem pozostawia stary fence. Walidacja cache markerów
i namespace mountów pozostaje obowiązkowa.

## Implementacja i dowody

Źródła: `docker_control_namespace.py`, `docker_build_control.py`,
`docker_volume_activation_reconcile.py`, `docker_volume_activate.py`,
`docker_backend_volume_cache.py`, `docker_volume_dev.py`, `docker_dev_codegen.py`.
Składnia i review nie zastępują wykonania operacji, buildu ani startu.
Na zlecenie operatora nie uruchamiać testów. Zachować oddzielnie dowody
quarantine, cache-hit, kompilacji, startu API, Solve i browser/WebGL.
