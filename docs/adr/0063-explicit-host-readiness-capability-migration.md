# ADR 0063: Jawna migracja możliwości współdzielonego hosta

Data: 2026-10-18. Decyzja: zaakceptowana przez operatora. Implementacja i weryfikacja runtime są osobnymi bramkami.

## Kontekst

Po migracji developmentu do Docker Compose kompilacja działa, lecz start odrzuca zmianę digestu możliwości hosta. Stary zapis raportował egzekwowanie CPU quota jako `Advisory`; bieżący probe bez delegacji cgroup raportuje `Unavailable`. Inwentaryzacja sprzętu pozostaje taka sama. Limit całego kontenera Docker nadal obowiązuje. Nie ma dowodu twardego limitowania każdego zadania przez delegowane cgroup.

Host ledger jest współdzielony przez worktree tego projektu. Jego reset, podział na oddzielne allocatory lub pozorne przywrócenie starego raportu naruszyłyby kontrakt planowania i bezpieczeństwo przydziałów.

## Decyzja

Raport zachowuje obserwowane `Unavailable`. Zwykła automatyczna rotacja readiness nadal odrzuca każdą niezgodność ABI. Operator może odrębnie zażądać migracji digestu możliwości przy niezmienionej tożsamości hosta, policy i inwentaryzacji.

Żądanie `host_runtime_readiness_migration_request.v1` zawiera dokładnie:

- `expected_host_id`;
- `expected_inventory_sha256`;
- `expected_ledger_sha256` — hash dokładnych bajtów bieżącego dokumentu;
- `expected_readiness_sha256` — bieżący pointer CAS;
- `expected_previous_capabilities_sha256`;
- `expected_next_capabilities_sha256`.

Nieznane pola, błędne hashe i zmiana bez zmiany digestu są odrzucane. Nowy readiness pochodzi z rzeczywistego probe native. Zgoda operatora dotyczy wskazanej pary digestów; nie upoważnia do zmiany pozostałych faktów ABI.

## Wymagania implementacji

Transakcja Rust wymaga istniejącego v4 ledgera i przypiętego rejestru aplikacji. Pod globalną blokadą writera ponownie sprawdza surowy hash dokumentu, pointer, host, inwentaryzację i oba digesty. Wszystkie rezerwacje muszą być zwolnione, a aktywny inventory owner nieobecny. Sam zapis ownera i epoch pozostają zachowane; plik lock nie zastępuje próby uzyskania blokady.

Nowy readiness, dokładna kopia starego dokumentu i dowód migracji są publikowane jako niezmienne dane przed atomową aktualizacją pointera. Awaria przed pointerem może pozostawić nieosiągalne immutable obiekty, lecz nie częściowo zaktualizowany ledger. Zachowane pozostają policy, node policy, historia rezerwacji, stare readiness, rekordy ownera i dane użytkownika.

Ścieżka jest jawna: `docker_dev.py up --host-readiness-migration-request <absolutny-plik-operatora>`. Launcher sprawdza i kopiuje dokładne bajty do control volume wybranej grupy. Stały backend otrzymuje wyłącznie kanoniczną readonly ścieżkę i jej hash; Python weryfikuje pin przed przekazaniem `--host-readiness-migration` do native inicjalizatora. Brak flagi nie wykonuje migracji. Nie ma hostowego kompilatora, osobnego kontenera budującego ani alternatywnego ledgera.

Ponowienie po nieznanym wyniku wymaga rozstrzygnięcia request/receipt/pointer. Istnienie samego receipt opublikowanego przed pointerem nie dowodzi commita. Zwykły restart po wykonanej migracji ma zachować standardowe kontrole ABI; retained opt-in nie może wymuszać ponownej migracji ani blokować poprawnych późniejszych snapshotów i rezerwacji.

## Zakres i konsekwencje

Publiczny Python DSL, ProblemIR, fizyka i ścieżki FDM/FEM nie zmieniają semantyki. Możliwości wykonania nadal wynikają z probe; UI nie otrzymuje obietnicy twardego limitu per zadanie. Nie zmienia się OpenAPI ani architektura workspace. CLI i audytowa historia native otrzymują odrębną operację operatorową.

Zmiany obejmują `host_resource_ledger.rs`, native inicjalizator `runtime_service_main.rs`, launchery Docker, transport żądania i kontrolę CI. Operacja pozostaje dostępna wyłącznie jawnie także po tej jednorazowej migracji; zwykły start nie uzyskuje automatycznej zgody na przyszłe zmiany możliwości.

Rollback nie polega na podmianie starego pliku: wymaga ponownej, jawnej i fenced migracji do zgodnego z rzeczywistym probe stanu. Zachowane kopie służą audytowi i rozstrzyganiu nieznanych wyników. Nie wolno przywrócić nieprawdziwego `Advisory`.

## Weryfikacja

GitHub Actions sprawdza odrzucenie złego hosta, digestu, pozostałych zmian ABI, aktywnej rezerwacji/ownera, zachowanie danych, awarie publikacji i kontrolowane ponowienie. Python sprawdza exact-byte staging, scope control volume, pin i brak niejawnej migracji. Lokalnie nie kompilujemy testów jednostkowych.

Wykonanie wymaga bieżącej obserwacji procesów i mountów, wykonania transakcji w zarządzanej grupie, odczytu receipt oraz porównania zachowanych danych. Osobno sprawdzamy API, przeglądarkę, HMR i restart. Zielone CI ani ten ADR nie dowodzą zakończenia migracji lub kwalifikacji naukowej.
