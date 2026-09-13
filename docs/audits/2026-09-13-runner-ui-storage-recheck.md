# Ponowne review runnera po poprawkach

Data: 2026-09-13. Sprawdzony HEAD: `303c2b0ea27afd7f28aca518d104ca61cb71444b`. Zakres: ponowna kontrola R1–R12 z poprzedniego review oraz integracji nowych pomiarów. Zastane zmiany ograniczone do submodułów; nie modyfikowano implementacji, konfiguracji ani danych runnera.

## Wynik

**Jest poprawa, ale pozostają istotne błędy.** Nie można jeszcze uznać automatycznej retencji i panelu telemetrycznego za gotowe. Poniżej rozdzielono poprawione elementy od pozostałych problemów; poprzedni raport jest historycznym snapshotem, nie listą w całości nadal aktualnych uwag.

## Najważniejsze pozostałe problemy

1. **P1 — retencja nadal zgłasza fikcyjny sukces.** `scripts/local_runner/observability.py:875` zmienia status na applied i zwraca estymację jako odzyskane bajty, bez usunięcia plików. Ponowna próba na izolowanym pliku 4096 B: `applied=true`, `reclaimed_bytes=4096`, plik nadal istnieje. `container_main.py:425` nadal używa estymacji jako reclaimed. Do czasu wdrożenia wykonawcy należy zwracać preview/unavailable, nie sukces.

2. **P1 — kandydaci retencji nadal omijają autorytatywny plan.** Dodane sprawdzenie stanu i TTL chroni aktywne joby, lecz `observability.py:596` dopuszcza wygasły terminalny execution bez journalu/tożsamości, a `:602` uznaje brak rekordu joba za zgodę na sprzątanie. `generate_retention_plan` nadal tworzy kandydatów z inwentaryzacji, zamiast z `raw_plan`. Reprodukcja: terminalny job bez journalu został zachowany przez silnik jako `missing_run_path`, ale UI dostało jednego kandydata. Należy używać jednej decyzji silnika, z domyślną ochroną nieznanych zasobów.

3. **P1 — metryki workera używają nieobsługiwanej operacji.** `container_main.py:347` wywołuje `docker(['stats', ...])`, lecz importowany `local_runner.unix_docker.docker` nie implementuje stats. Bez połączenia z daemonem odtworzono `ValueError: Docker operation not supported by container coordinator`. Szeroki catch ukrywa błąd i zwraca None. Wymagane rozszerzenie adaptera o rzeczywisty pomiar i test z właściwym adapterem, a nie wyłącznie mock CLI.

4. **P2 — historia pomiarów nie jest cykliczna i ma niewłaściwy zakres.** `sample_metrics()` jest wywoływane tylko przy inicjalizacji pustej historii (`observability.py:297`). Przy istniejącym pliku historia może pozostać całkowicie stara. `container_main.py:583` zwraca wszystkim jobom tę samą historię procesu koordynatora. Usunięto sinusoidy, ale brak okresowego kolektora oraz próbek związanych z jobem. Wymagane timestamp/stale/scope i dane konkretnego workera; pomiar procesu koordynatora nie jest pomiarem kompilacji.

5. **P2 — wynik etapów i receipt nadal nieprawidłowe.** `observability.py:952` nadal traktuje istnienie stdout jako succeeded. Pusty log aktywnego joba ponownie wystarczył do sukcesu. `container_main.py:495` nadal czyta `artifacts/receipt.json` zamiast `artifacts/build-receipt.json`. Podstawą statusu i czasu powinny być journal i wynik etapu, nie obecność pliku.

6. **P1 — automatic nadal nie wykonuje automatycznej ochrony.** UI w `PoliciesView.js:55` nadal udostępnia automatic. Polityka wpływa już na progi prezentowanych wolumenów i część TTL inwentaryzacji, lecz nie ma schedulera cleanupu ani ciągłej ochrony dysku w wykonawcy. Zapisu konfiguracji nie wolno opisywać jako aktywnej ochrony hosta.

7. **P2 — logi Dockera nadal nie otrzymują zdarzeń.** Dodano zdarzenia submit/cancel/claim/terminal, ale `observability.py:299` nadal zapisuje je tylko w pamięci. Brakuje emitowania na stdout. Ten fragment pierwotnej prośby pozostaje otwarty.

8. **P2 — pełna historia i kompletność storage nadal niezamknięte.** `container_main.py:449` nadal ogranicza zbiór do 1000 przed paginacją. `observability.py:793` nadal deklaruje completeness=complete, mimo pomijania błędów przez `_fast_dir_size`. Frontend może już pokazać partial, ale backend musi go rzeczywiście zwrócić. Skan pozostaje synchroniczny i bez budżetu I/O.

## Co poprawiono względem poprzedniego review

| Poprzednia uwaga | Aktualny stan źródeł |
|---|---|
| R1 — fikcyjne pomiary | Częściowo: usunięto sztuczną historię i healthy po błędzie pomiaru. Są odczyty OS. Integracja stats, cykliczność i zakres joba nadal wadliwe. |
| R2 — fałszywy apply | Otwarta; odtworzona ponownie. |
| R3 — aktywne execution jako kandydat | Częściowo: stan running/cancel_requested chroniony, ale brak journalu/rekordu nadal nie chroni jak istniejący silnik. |
| R4 — polityka automatic | Częściowo: progi/TTL używane w prezentacji; nie ma automatycznego wykonania i ochrony podczas buildu. |
| R5 — timeline/receipt | Otwarta; pusta zawartość logu nadal oznacza sukces. |
| R6 — lifecycle/logi | Częściowo: zdarzenia lifecycle dodane, stdout nadal niepodłączony. |
| R7 — limit 1000 | Otwarta. |
| R8 — pełny skan | Częściowo: poszerzono klasyfikację, ale completeness i obsługa błędów nadal błędne. |
| R9 — fałszywe dane i wynik apply w UI | Widoczne poprawki: handler sprawdza applied, usuwane wartości demonstracyjne; backend nadal może zwrócić fałszywy sukces. |
| R10 — odświeżanie | Dodano timer modala i update/dispose widoków; wymagane zachowanie live w przeglądarce pozostaje bez dowodu. |
| R11 — kompletność/błędy w UI | UI odczytuje completeness i używa Promise.allSettled do rozdzielenia błędów. Problem po stronie backendu pozostaje. |
| R12 — port | W kodzie poprawiono mapowanie na public port po obu stronach, zachowanie istniejącego portu configure i akceptację poprzedniego bindingu. Brak dowodu wdrożenia end-to-end. |

## Dowody bieżącej weryfikacji

- `python -m pytest -q scripts/tests/local_runner scripts/test_local_runner_container_client.py scripts/test_local_runner_retention.py scripts/test_local_runner_build_executor.py`: **93 passed, 4 subtests passed**, exit 0.
- `node apps/runner-console/test.mjs`: wszystkie testy unit/smoke przeszły, w tym brak sztucznych fallbacków, kompletność/error states i lifecycle widoków. Nie jest to test na rzeczywistej przeglądarce i działającym koordynatorze.
- Ponowne izolowane próby: pozorny odzysk 4096 B, terminalny kandydat bez journalu mimo odmowy silnika, pusty log jako succeeded, stats odrzucone przez adapter. Nie dotykano rzeczywistych katalogów buildów.
- `git diff --check`: exit 0 dla zastanego stanu.
- `just runner-container-status`: błąd **Docker Desktop coordinator request failed**, exit 2 klienta / exit 1 recepty. To inny wynik niż poprzednie allow-list mismatch; nie dowodzi poprawnego działania wdrożenia ani konkretnej przyczyny awarii Dockera.
- Managed build obrazu, live browser i ochrona hosta: **NOT VERIFIED**. Review nie uruchamiało dodatkowego koordynatora ani nie zmieniało konfiguracji w celu obejścia błędu statusu.

Zielone testy nie zamykają problemów potwierdzonych powyższymi reprodukcjami. Najpierw naprawić semantykę retencji i integrację pomiarów; potem kwalifikować panel na działającym runnerze.
