# Review runner-console i zmian runnera

Data: 2026-09-13. Baza: `17127ba764dd50ae3f7f4b8c463221dd68ab82da`, niezacommitowane zmiany w głównym checkoutcie. Zakres: nowy panel, API, observability, integracja kontenera, testy i ADR względem planu `2026-09-13-runner-observability-storage-ui-plan.md`. Nie oceniano cudzych zmian submodułów ani pozostałych audytów. Review bez poprawek implementacji, wdrażania i cleanupu danych użytkownika.

## Werdykt

**Wymagane poprawki przed uznaniem panelu za narzędzie operatorskie.** Powstała struktura UI/API, ale dane demonstracyjne są prezentowane jako rzeczywiste, a część akcji zgłasza sukces bez wykonania działania. Automatyczna retencja i ochrona hosta przed zapełnieniem nie zostały zaimplementowane. Nie należy utożsamiać zielonych testów z realizacją planu.

## Potwierdzone problemy

### R1 — P1: metryki i stan dysku zawierają wymyślone dane

`scripts/local_runner/observability.py:67` generuje historyczne próbki przez sin/cos. `sample_metrics` podaje stałe RAM/CPU/I/O i sztuczny przyrost danych; nie jest wywoływany przez cykl życia aplikacji. `get_storage_volumes` dokłada fikcyjny VHDX 64 GiB, a błąd rzeczywistego pomiaru zastępuje 45 GiB wolnego miejsca ze statusem healthy. `container_main.py:329` i `processes()` również zwracają stałe zużycie oraz limit workera.

Skutek: operator nie może ocenić obciążenia i bezpieczeństwa dysku, mimo że panel sugeruje świeże pomiary. Reprodukcja z `disk_usage` zgłaszającym OSError zwróciła healthy i 48318382080 wolnych bajtów. Wymagane: rzeczywiste kolektory z timestamp/scope/validity; brak pomiaru jako unavailable, bez historycznych danych syntetycznych w trybie produkcyjnym.

### R2 — P1: apply zgłasza odzysk miejsca bez usunięcia czegokolwiek

`scripts/local_runner/observability.py:524` zmienia status planu na applied i zwraca `reclaimed_bytes` równe estymacji. Nie usuwa danych, nie mierzy odzysku ani nie sprawdza ponownie stanu. `container_main.py:336` nazywa estymację reclaimed także dla samego preview.

Reprodukcja na pliku testowym 4096 B: API huba zwróciło `applied: true`, `reclaimed_bytes: 4096`, a plik nadal istniał. Wymagane: do czasu rzeczywistego wykonawcy akcja niedostępna/wyraźnie preview, bez udawanego sukcesu. Wykonawca docelowy musi spełnić walidację, leases, idempotencję i pomiar rezultatu z planu.

### R3 — P1: preview ignoruje decyzje bezpiecznego silnika retencji

`scripts/local_runner/observability.py:337` uznaje każde nieprzypięte execution za kwalifikujące się do retencji. `generate_retention_plan` wylicza `raw_plan`, lecz tworzy kandydatów z własnej inwentaryzacji, a wynik bezpiecznego planisty jedynie dołącza do odpowiedzi.

Reprodukcja: job `running` został zachowany przez raw engine z powodem `active`, ale trafił do listy kandydatów UI z komunikatem o upływie retencji. Brak sprawdzenia TTL, journalu i tożsamości nie może być zastąpiony flagą pin. Wymagane: jedna autorytatywna decyzja retencji; nie dublować reguł w warstwie prezentacji. Obecnie apply nie usuwa danych, więc nie stwierdzono faktycznej utraty aktywnych plików.

### R4 — P1: tryb automatic i progi są zapisywane, lecz nie sterują runnerem

`scripts/local_runner/observability.py:164` zapisuje politykę, ale odczyt parametrów nie jest włączony w scheduler, kontrolę miejsca ani TTL przekazywane do planisty. Progi wolumenów są stałe. Brak okresowego cleanupu i reakcji na presję podczas buildu. UI oferuje automatic jako cykliczne czyszczenie.

Skutek: operator może włączyć ochronę, która nie działa. Wymagane: ukryć/oznaczyć niewdrożone możliwości albo podłączyć rzeczywisty wykonawca i monitor; walidować typy/zakresy, wersjonować zmiany. Aktualny próg startu 8 GiB pozostaje dotychczasowym ograniczeniem, nie ochroną całego hosta.

### R5 — P2: timeline uznaje utworzenie logu za sukces etapu

`scripts/local_runner/observability.py:601` oznacza etap succeeded, gdy plik stdout/stderr istnieje. Worker tworzy pliki przed uruchomieniem polecenia (`build_entrypoint.py`, `run_stage`). Pusty log aktywnej kompilacji wystarcza więc do pokazania sukcesu i przejścia do kolejnego etapu. Potwierdzono na pustym pliku testowym.

Dodatkowo `container_main.py:405` czyta `artifacts/receipt.json`, podczas gdy build zapisuje `artifacts/build-receipt.json`, a journal końcowy znajduje się w `run_root/receipt.json`. Dane queue nie zawierają `started_at`, z którego korzysta nowy widok. Wymagane: timeline z trwałych zdarzeń/receipt i journalu, prawdziwe czasy oraz jawny stan nieznany. Sam plik logu nie dowodzi wyniku.

### R6 — P2: zdarzenia nie są podłączone do buildów ani stdout Dockera

`ObservabilityHub.record_event` dodaje rekord wyłącznie do deque w pamięci. Wywołania dotyczą startu huba, pinów, polityki i planu; brak zdarzeń submit/claim/stage/terminal z wykonawcy. `job_events` filtruje po job ID, którego rzeczywisty build nie zapisuje w hubie.

Wymagane: wpięcie w rzeczywisty lifecycle i zredagowany logger stdout z ograniczeniami retencji. Obecna zmiana nie rozwiązuje zgłoszonej ciszy w konsoli Dockera.

### R7 — P2: paginacja ukrywa zadania poza pierwszym tysiącem

`scripts/local_runner/container_main.py:359` najpierw pobiera maksymalnie 1000 rekordów, a dopiero potem filtruje i stronicuje. `total` oraz lista worktree dotyczą obciętego zbioru. Starsze zadania są nieosiągalne i nie ma flagi truncation. Analogicznie ograniczone są obliczenia kolejki i nowy preview.

Wymagane: filtrowanie, liczenie i paginacja w SQLite lub kompletne iterowanie z jawnie raportowanym limitem. Operator musi widzieć, czy historia/inwentaryzacja jest pełna.

### R8 — P2: skan storage deklaruje kompletność mimo pominiętych danych i błędów

`scripts/local_runner/observability.py:442` zawsze zwraca completeness=complete. `_fast_dir_size` pomija błędy odczytu; skan nie klasyfikuje wszystkich plików, a kategorie logs/docker/unassigned pozostają puste bez pomiaru. Skan całych runs/builds/cache wykonywany jest synchronicznie z żądania HTTP i bez budżetu I/O.

Wymagane: kolektor z checkpointem, limitem czasu, raportem błędów i stanem partial/stale. Rozróżnić brak danych od zera; zachować ochronę granic symlink/mount/reparse. Duży storage nie powinien wymagać pełnego przejścia przy każdym wejściu w widok.

### R9 — P1: frontend również wymyśla dane i potrafi pokazać sukces odmowy apply

`apps/runner-console/src/components/BuildDetailsModal.js:176` zastępuje brak RAM przez 340 MiB, CPU przez 85.4%, a przyrost miejsca przez 485 MiB. Dalej tworzy przykładowe katalogi i rozmiary przy braku zasobów. Nawet naprawienie backendu nie usuwa tego problemu. Aktualna próbka jest też opisana jako peak RAM lub średni CPU, choć nie jest taką agregacją.

`apps/runner-console/src/views/StorageView.js:88` nie sprawdza `res.applied`: odpowiedź `applied:false` bez message prowadzi do alertu o pomyślnym wykonaniu. Wymagane: poprawne rozróżnienie wyniku operacji, żadnych danych demonstracyjnych poza jawnym trybem demo.

### R10 — P2: szczegóły i logi buildu nie są live

`apps/runner-console/src/components/BuildDetailsModal.js:66` pobiera dane jednorazowo. Mechanizm `app.js:94` odświeża tylko widoki mające `update()`, którego nie zwracają m.in. Historia, Storage i Logi. Otwarty modal zatrzymuje się na dawnym etapie i fragmencie logów, mimo dalszej pracy buildu.

Wymagane: kontrolowane odświeżanie/subskrypcja z teardown, świeżością i zachowaniem scrolla, aktywnej zakładki i selekcji. Polityki mogą być odczytem na żądanie, ale ekran opisany jako live musi aktualizować dane.

### R11 — P2: UI ukrywa częściowy skan i błąd pobierania storage

`apps/runner-console/src/views/StorageView.js:203` bezwarunkowo pokazuje „Pełny (100%)”, niezależnie od pola completeness. Przy pobieraniu (`:101`) błędy zamienia w pusty wynik. Wymagane: renderować completeness i status błędu ze źródła, zachowywać ostatni dobry snapshot jako stale, nie utożsamiać niedostępnej inwentaryzacji z pustym storage.

### R12 — P1: port hosta i kontenera są pomieszane, a stary binding nie ma migracji

`scripts/local_runner/container_client.py:621` publikuje `public['port']:CONTAINER_PORT`, lecz `container_main.py:605` uruchamia serwer na `config['port']`. Dla jawnego portu 51234 i domyślnego wewnętrznego 48765 Docker kieruje do 48765, a aplikacja słucha na 51234. CLI i UI tracą dostęp. Wymagane: rozdzielić host_port od container_port i przetestować rzeczywistą zgodność listenera z mapowaniem.

Zmiana `CONTAINER_PORT` z 8765 na 48765 powoduje też, że atestacja istniejącego kontenera oczekuje innego bindingu (`container_client.py:494`). `replace` zachowuje wymaganie atestacji i zmienia obraz, bez migracji bindingu. Potrzebna jest jawna kompatybilność/migracja konfiguracji, zamiast wymagania nowego portu od już uruchomionego kontenera. Nie utożsamiać tego z osobno zaobserwowanym błędem allow-list.

## Weryfikacja

- `python -m pytest -q scripts/tests/local_runner scripts/test_local_runner_container_client.py scripts/test_local_runner_retention.py scripts/test_local_runner_build_executor.py`: **81 passed, 4 subtests passed**, exit 0.
- Izolowane próby na katalogu tymczasowym: aktywny job w kandydatach, fałszywy odzysk 4096 B, succeeded po pustym logu i healthy po błędzie pomiaru — wszystkie opisane nieprawidłowości odtworzone. Nie używano rzeczywistych danych buildów.
- `git diff --check`: exit 0.
- Niezależny przegląd UI: `node apps/runner-console/test.mjs` i `node apps/runner-console/build.mjs` przeszły; pakowany `scripts/local_runner/ui_dist` jest zgodny bajtowo ze źródłami panelu. Są to lekkie testy/pakowanie, bez dowodu zachowania w przeglądarce.
- `just runner-container-status`: **zablokowane**, `Container profile allow-list mismatch`, exit 1 recepty / exit 2 klienta. Nie przypisano tej rozbieżności nowym zmianom bez dowodu.
- Managed build nowego obrazu, live UI/browser oraz ochrona hosta: **NOT VERIFIED**. Nie wymieniano kontenera ani nie obchodzono blokady konfiguracji.

Istniejące nowe testy jawnie oczekują początkowej syntetycznej historii, sukcesu apply i kwalifikowania execution bez dowodów. Należy poprawić założenia testów, a nie tylko zwiększać liczbę przechodzących przypadków.

## Zalecana kolejność poprawek

1. Usunąć fałszywe dane i fałszywe sukcesy akcji; niewdrożone pola oznaczyć unavailable/preview.
2. Oprzeć preview na istniejącym bezpiecznym silniku i dodać regresje dla aktywnych jobów, pinów i błędów pomiaru.
3. Podłączyć lifecycle, rzeczywiste metryki, poprawne receipt i czasy; poprawić kompatybilność wdrożenia.
4. Zamknąć etap panelu read-only z dowodem browser i spójnym ADR opisującym faktyczny stan.
5. Dopiero potem wdrażać wykonawca cleanupu, politykę presji i pełne testy restartów/wyścigów zgodnie z planem.
