# Naprawa zbieżności w API i testu wizualizacji bimeronu

Cel użytkownika: naprawić `converged=false`, dopuścić prawidłowy nowy układ wolumenów do testu UI i sprawdzić rzeczywisty obraz bimeronu.

## Zakres i niezmienniki

Źródła: istniejący worktree `frontend-refresh-reconcile-20261030/fullmag`, branch `codex/frontend-refresh-reconcile-20261030`, właściciel `/root`, baza `533d7758cdb04fd86b5b140211e0e834d1d01bbc`. Grupa `fullmag-worktree-fullmag-cfc887ff26db7673`, port 3342. Aktywny przebieg `run-live-e608c269fdf3a6b67aa2dd89cc79a27845cbda0bfb7adfde8b469bfaf2aa2ad0` pozostaje zachowany podczas implementacji.

- Nie zmieniamy kryterium zbieżności ani równań solvera. Autorytetem jest istniejący typowany `RunResult.completion`.
- `Succeeded`, ostatni torque i domyślne liczniki StepStats nie zastępują dowodu completion.
- Dowód terminalny musi wiązać run, task, step, attempt, epoch, wejście oraz dokładny accepted state. Zachować odczyt starszych receiptów; brak dowodu nie promuje zbieżności.
- Publiczny kształt API pozostaje bez zmian; uzupełniamy istniejące pola etapu. Nie dodajemy ciężkich payloadów do statusu ani obliczeń do handlerów.
- Walidator UI obsługuje legacy i `group-volume-v1`, zachowując kontrolę subpathów, własności, readonly oraz zakaz dostępu frontendu/przeglądarki do rootu control, backendu i ledgeru.
- Tymczasowy zakaz kompilacji unitów pozostaje aktywny. Testy interpretowane są dozwolone. Aplikacja buduje się wyłącznie w swoim stałym backendzie Compose.

## 1. Dowód zakończenia — Sol medium

Właściciel: worker `completion_evidence_fix`. Pliki API: accepted_study_worker, accepted_fem_study_worker, accepted_field_materialization_worker, live_accepted_projection oraz mały nowy moduł i rejestracja, jeśli potrzebne.

Przenieść completion z FDM/FEM przez wynik workera i nową wersję receiptu, zachować je przy recovery, opublikować osobny wersjonowany i ograniczony artefakt CAS. Projekcja weryfikuje tożsamość i kopiuje reason/converged/metric/name/value/threshold do właściwego etapu. Bez zmiany scalar schema v1 i bez syntezy dowodu dla historycznych runów.

Weryfikacja: źródłowe regresje torque/energy/max_steps, round-trip recovery, niezgodny attempt/state/epoch, niejednoznaczny artefakt i brak legacy evidence; parser Rust oraz review. Unitów nie kompilować. Managed build potwierdza kompilację aplikacji; nowy mały przebieg testuje prawdziwe zakończenie oraz odczyt po ponownym uruchomieniu API.

## 2. Walidator i mounty QA — Luna max

Właściciel: worker `ui_group_volume_validator`. Wyłącznie `scripts/docker_dev_browser_qa.py` i `scripts/test_docker_dev_browser_qa.py`.

Najpierw reprodukcja obecnego odrzucenia nowego volume. Następnie walidacja poprawnego layoutu na podstawie przypiętego receiptu i Compose, inspekcji HostConfig i actual Mounts. Browser service otrzymuje wyłącznie wymagane subpathy frontendu. Legacy pozostaje walidowane dotychczasową ścieżką. Testować złą własność, marker profilu, volume, subpath, readonly, brak deklaracji i ujawnienie rootu/backendu/ledgeru.

Weryfikacja: interpretowany moduł unittest, parser/diff oraz review; rzeczywisty managed browser QA wykonuje root po odbiorze.

## 3. Integracja i runtime — root

Sprawdzić diff i dowody obu części; osobne spójne commity. Przed restartem potwierdzić stan runu, zapisać projekt i rozstrzygnąć zachowanie bieżącego stanu poprzez istniejącą zarządzaną ścieżkę. Nie kasować ownera/lease, nie ponawiać nieznanej mutacji ani historycznego Solve. Jeśli brak bezpiecznego wznowienia aktywnego runu, przed wdrożeniem uzgodnić z użytkownikiem istotną zmianę przebiegu.

Po zarządzanym rebuildzie zweryfikować dokładny pakiet, zdrowe API/native runtime oraz prawdziwe completion z nowego terminalnego wykonania i po odczycie recovery. Potem sprawdzić bimeron przez managed QA `--canvas-only --expect-live-field m`, bez tworzenia zastępczego modelu. Wymagane: widoczny canvas, niezerowy drawing buffer i niezagubiony WebGL. Obraz i stan obu magnetyków ocenić z dowodów; nie deklarować konwergencji fizycznej na podstawie canvasu.

Zachować raport, konkretne receipty, aktualne piny i wyniki. Kwalifikowaną retencję oraz integrację brancha wykonać w zakresie dopuszczanym przez aktywny runtime i obowiązkowe bramki; blokady odnotować jawnie.

## Uzgodnione wdrożenie i stopka — kontynuacja 2 listopada

Użytkownik wybrał zatrzymanie, zachowanie wyników i start od początku po wdrożeniu. Root zapisał archiwum .fms; canonical Stop tego samego runu został przyjęty po uzgodnieniu dwóch konfliktów StoreWriterBusy z dziennikiem. Worker zakończony exit0/stop_requested, run cancelled i lease released. Bez resetów ownera ani zabijania procesów.

Dodatkowy zakres użytkownika: dlaczego dt=0 oraz wskaźnik aktywnego solvera przy dt. Luna posiada FooterTelemetry.tsx i model tests. Pokazywać BB/NCG/TPI albo jawny integrator runtime; direct minimizer bez opublikowanego pseudoczasu ma nieadekwatne fizyczne time/dt (—, bez jednostki). Rzeczywisty LLG zachowuje fizyczne zero. Stage method ma pierwszeństwo nad global metadata, w tym heun_dynamics_settle i ochrona przed pseudoczasem poprzedniego etapu. Źródłem jest wyłącznie runtime o zgodnym run/session scope, nie projekt autora.

Root dodał zamknięty frontend-telemetry-source scope do istniejącej zarządzanej recepty (typecheck, ESLint, architecture/API). 31 interpretowanych testów potwierdza ścieżkę i ochronę wejść; źródłowy footer check przed korektami review przeszedł. Zakaz budowania unitów nadal obowiązuje. Po końcowym freeze/review powtórzyć ten check, commit spójnej stopki, przypięty restart-idle/rebuild bez Solve replay, GPU probes true/false/recovery, potem jeden nowy bimeron.

## Zarejestrowane wyniki wykonania

- Kod stopki po korektach review: commit `84a804317d0e7fdd027627d931a285a184b65bf2`; końcowe zarządzane typecheck/ESLint/architecture/API PASS. Brak uruchomienia Vitest i unit buildów zgodnie z zakazem.
- Build/iteration `70699bd342214ddb95acd6414d427499`: succeeded, cache miss, źródła 84a804317, snapshot `d4e7ebef2e3348e86b458f1241274a89a4bfc7cbb9263e443d6df3ff808e004c`. Zachowany backend container ID. Automatyczna retencja `8a7ab7fe2dac48b29328f3296bc21e71`: succeeded.
- Torque transport probe `run-live-530caf818b08851d65bd9274e9ac0a298031d96c25b673efee4caee5326b7e34`: krok 2, reason=torque, converged=true; metryka 881403.3703549876 A/m poniżej 795774715.459 A/m. Tolerancja 1000 T jest celowo luźną bramką transportu, NIE naukową kwalifikacją bimeronu.
- Budget transport probe `run-live-0b1967b47fe6c5930c178b522950eec30256f07aa9dcc8503c657f80190e558b`: krok 2, reason=max_steps, converged=false; metryka=próg=2. Oba wymuszają native FDM GPU/double/strict/cuFFT, bez CPU fallback.
- V4 receipt, pojedynczy przypięty artefakt completion, study output manifest oraz final state mają zgodne run/task/step/attempt/epoch/input/source/clock; SHA-256 CAS zweryfikowany. API odzwierciedla obie wartości.
- Mały model: managed browser QA `c4a94661069a42d5bb2f1c22bd06adbd` PASS, WebGL2/context_lost=false/buffer 617×527, m data-ready przed/po Home; terminalny Step i energia zgodne z API, brak błędów JS/HTTP. To NIE dowód obrazu dużego układu.
- Cached restart `bc2c7fd4a0e74523b1d4134274876fce` succeeded/cache hit: V4/CAS obu prób niezmienione, bez automatycznego Solve. Publiczne stage execution jest current-only, a restart archiwizuje current workspace: recovery projekcji historycznego completion w API pozostaje NOT VERIFIED. Osobny potwierdzony gap: prywatny `build_terminal_observation_stage_execution` dostaje pustą listę verified_outputs, więc terminal reattach nie adoptuje completion CAS. Nie rozbudowywano tej ścieżki w tym wdrożeniu.
- Ponowne uruchomienie właściwego bimeronu: activation `3f6ffc8e71ae404baa319fba7e3b9656`, run `run-live-32ddb220596ef44e24e2229f62b2679c8996dc2fe82746b1be7bc5fed42f216e`, GPU/BB/rDMI; pierwsza obserwacja native fdm_gpu krok 100. Duży browser smoke `122ac026bea5461987f0b1d4ae3af639` zakończył się failed-confirmed: poprawny WebGL2/buffer 617×527 i odebrane oba scoped m, następnie timeout DOM/screenshot. Brak błędów JS/HTTP; pełny obraz dużego bimeronu pozostaje NOT VERIFIED.

Próby są kontraktem transportu, nie implementują nowej fizyki ani numerics. FDM GPU: wykonanie powyżej; FDM CPU, FEM CPU, FEM GPU: te skrypty nie kwalifikują tych realizacji. Skrypty po wykonaniu dostały wyłącznie komentarz komórki #%%; AST przed/po identyczne.
