# Naprawa ładowania modelu DE w UI

<!-- canonical-mu0-source-checkpoint -->
## Aktualny checkpoint — poprawka μ₀ na remote; nowy build w kolejce

Odczyt 2026-10-04T04:01:49.824275+00:00. S00–S12 pozostają OPEN; brak nowych zaakceptowanych punktów.

- Docker po restarcie: health OK, worker_alive=true, worker_error=null, przyjmowanie zadań włączone. Ostatni pomiar przed zgłoszeniem: 3 385 720 832 B (~3,15 GiB), poniżej progu admission 8 GiB. Nie usuwano cache, wyników ani kontenerów i nie uruchomiono ciężkiego buildu poza kolejką.
- Γ #226: frequency_window zakończone błędem, 43/50 podokien OK; kompletność niezatwierdzona. Osobny selected-only nearest zakończył solver kodem 0 w 40,75 s: 9,299249697068216 GHz, full relative residual 6,396428791585744e-11. Driver prawidłowo odrzucił niespójną μ₀. Stary punkt pozostaje niezatwierdzony; nie poprawiano jego artefaktów.
- Przyczyna potwierdzona: dwie własne stałe μ₀ w shared-domain C++ składały rzeczywisty operator i probe. Commit `a8d67ac92002b884799119578a054b518cf40cbf` zastępuje oba przypisania istniejącym `fullmag::fem::kMu0`. Model, metadata oraz próg spójności 1e-12 i residualu 1e-8 pozostają bez zmian. Source review bez nowych P1/P2, kontrola dokładnie staged dokumentacji naukowej PASS. Regresja importera/Floqueta przygotowana, testy C++ niekompilowane zgodnie z zakazem. Poprawiony runtime NOT VERIFIED.
- Jeden managed build: job `d2a6c2dd0c3c4a66a1e05fce10bb32c7` (sekwencja 227), profil `fem-cpu-slepc-runtime-v2`, źródło commit `a8d67ac92002b884799119578a054b518cf40cbf`. Profil nie kompiluje unit tests ani frontendu. Zgłoszenie do kolejki nie dowodzi startu ani sukcesu. Admission jest blokowane dostępnym storage; po uzyskaniu terminalnego sukcesu i receipt należy wykonać nowy nearest Γ na niezmienionym modelu oraz zweryfikować stałą, residual, demag i binding siatki/równowagi. Nie używać pakietu #226 do kwalifikacji poprawki.
- PreviewState strict raw JSON jest na remote w `17d614412672cf22e6dbb6c01a7375bdcaae5076`. Ochrona centralnego postępu etapów przed obcymi session_id/epoch/run_id jest na remote w `c9f8e78b098545f59603e73c329d855f895902c1`; produkcyjne TypeScript (896 wejść, 0 testów) i lint (7 plików, 0 błędów/ostrzeżeń) PASS. Nowy import FMS, lifecycle/session-switch i browser/WebGL pozostają NOT VERIFIED. Potrzebny osobny zgodny build API+UI po bramce runtime.
- Nadal otwarte: 15 zaakceptowanych punktów signed DE, pełne okno Γ, serial/adaptive parity i pomiary CPU/RAM, API/GUI/FMS/Inspector, DE/BV/COMSOL A1 i zbieżność, S09/S10/GPU, PR #97 i integracja. Cztery wcześniejsze zaakceptowane punkty ±10/±25 nie kwalifikują nowego kodu.

Dowody: `preview-state-checkpoint/mu0-fix-review.md`, `mu0-staged-scientific-validation.json`, `mu0-runtime-build-submit.json`, `gamma226-selected-result-inspection.json`; `adaptive-ui-checkpoint/stage-identity-production-types.json` i `stage-identity-production-eslint-evidence.json` w katalogu evidence tego wątku.

<!-- gamma226-window-terminal-selected-mode -->
## Aktualny checkpoint — stan po restarcie Dockera

Odczyt 2026-10-04T03:28:58.637030+00:00. Źródła, runtime, GUI i kwalifikacja naukowa pozostają oddzielnymi bramkami.

- Docker i koordynator działają. Pilot Γ #226 zakończył się błędem (exit 1) o 2026-10-04T03:21:39 UTC; kontroler 75208 zakończył pracę. Zachowano receipt i dane. Poprawnie zakończyły się 43 z 50 podokien. Siedem ma `stop_reason=slepc_diverged`: base 1, 2 oraz refinement 12, 13, 14, 15, 24. Certyfikat ma stan `failed/pass_incomplete`. Kandydat 9,299249697096525 GHz wymaga nadal zatwierdzenia; nowych zaakceptowanych punktów jest zero. Nie wykazano niezerowego PetscErrorCode ani związku awarii z Dockerem.
- Odczyt ustawień po EPS potwierdza tolerancje EPS/KSP 1e-9/1e-9 i FGMRES z restartem 8. Dokładny preconditioner okna był wyłączony (`disabled_dimension_cap`): układ ma 656 stopni swobody, a limit wynosi 512. Wpływ tego ograniczenia na zbieżność jest hipotezą do sprawdzenia. Limit i próg fizycznego residualu 1e-8 pozostają bez zmian.
- Próba pojedynczego modu Γ `gamma-nearest-current-job226-v1` zakończyła solver kodem 0 w około 40,75 s. CSV i spectrum.v3 zawierają częstotliwość 9,299249697068216 GHz, a względny pełny residual wynosi 6,3964287916e-11 przy progu 1e-8. Natywny residual ma certyfikację, lecz driver odrzucił wynik z powodu niespójnej stałej μ₀: diagnostyka podaje 1,25663706212e-6, model deklaruje 4πe-7. Różnica względna wynosi około 5,44e-10. Wynik pozostaje niezatwierdzony do czasu sprawdzenia źródła rozbieżności; nie osłabiono gate. Jest to jawna próba `selected_only`, z `window_complete=false`. Zachowano ten sam model, L2, trzy warstwy i zweryfikowany runtime #226. Kompletność widma 8,5–16 GHz nadal jest otwarta. Dowód: `gamma226-selected-result-inspection.json` w katalogu checkpointu.
- Poprawka importu PreviewState jest na remote w commicie `17d614412672cf22e6dbb6c01a7375bdcaae5076`. RawValue zachowuje odrzucanie powtórzonych znanych pól oraz numeryczne klucze domen. Review źródeł, parser/format i kontrola whitespace przeszły. Regresje są przygotowane i nie były kompilowane. Kompilacja nowego readera, import oryginalnego FMS i weryfikacja w przeglądarce mają stan NOT VERIFIED. Pakiet #226 zawiera poprzedni reader Value.
- Trwa poprawka centralnego zasobu postępu etapów: UI ma porównywać session_id, epoch i run_id przed pokazaniem danych. Nowy build zgodnego API i UI wymaga wolnego storage; ostatni pomiar około 4,2 GiB był poniżej progu 8 GiB. Zachowano aktywne cache i mounty.
- S00–S12 pozostają OPEN. Do wykonania: zaakceptowany sweep 15 punktów, kompletność okna Γ, zgodność serial/adaptive i pomiar CPU/RAM, API/GUI/FMS/WebGL/Inspector, DE/BV/COMSOL A1 i zbieżność, S09/S10/GPU oraz integracja PR #97. Dotychczasowe cztery punkty ±10/±25 są wcześniejszymi wynikami. Zachowano pozostały WIP.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\preview-state-checkpoint\gamma226-terminal-inspection.json`, `gamma226-diagnostics.json`, `gamma226-nearest-launch-plan.json`; [naprawa importu FMS](2026-10-04-preview-state-json-repair.md).

## Potwierdzona przyczyna i korekta

Puste UI uruchamiało sesję bez modelu. Następnie próba połączenia API z buildu #195 i frontendu #197 ujawniła niezgodność identyfikatora `request_scope_epoch`: frontend pozostawał przy wykrywaniu sesji. Dodatkowo zapis checkpointów na Docker Desktop 9p był odrzucany przez kontrakt trwałości.

Działający podgląd korzysta z API i frontendu tej samej zweryfikowanej wersji #197, a workspace oraz stan sesji znajdują się w prywatnym tmpfs. Kapsuła źródeł i pakiet buildu pozostają tylko do odczytu. Jest to sesja tymczasowa; restart usuwa jej stan. Model wejściowy i dowody pozostają w kanonicznym storage.

## Model i dowody

- UI: http://localhost:3105/workspace/
- Model wejściowy: `71ec3f159b47ee7a56e471020923248c2cac283f`, `examples/fem_de_smoke_numeric.py`.
- FEM CPU, double; film 40×40×10 nm, pole 0.1 T w x, demag airbox Dirichlet.
- Trzy etapy: relaksacja, eigensolve `k_y=+10^7 rad/m`, eigensolve `k_y=-10^7 rad/m`; full_2x2, demag i Floquet.
- Prawdziwa przeglądarka: widoczny film i drzewo trzech etapów, canvas 617×556, contextLost=false, niezerowy drawing buffer.
- Eksport/import sceny po korekcie Python zachowuje także politykę solvera; GET sceny porównany z wejściem.
- Kontrole Python renderer/API: 38 passed. Kontrole launchera modelu: 7 passed.

## Naprawy źródeł i pozostałe bramki

Renderer SceneDocument poprzednio pomijał eigenmodes. Obecnie odtwarza etapy, tożsamości, k, Floquet, demag i politykę solvera. Błędne jawne count/k nie przechodzą po cichu do wartości domyślnych. Publiczny add_eigenmodes przyjmuje stage_id, zgodnie z istniejącą semantyką identyfikatorów etapów.

Hook preparation rozróżnia oczekiwany brak zasobu (404 przed Prepare) od błędu wykonania. Regresje React są zapisane, ale NIE wykonane: obowiązuje zakaz kompilacji testów jednostkowych. Ta poprawka frontendu oraz renderer Python nie są jeszcze wdrożone w immutable UI #197. W podglądzie pozostaje toast dotyczący nieistniejącego jeszcze preparation, mimo poprawnie załadowanego modelu.

Build #202 `0f941ef9a26840ab9ff190eb1c58e3f8` jest niezależnym ponowieniem #201 po korekcie guardu koordynatora. Obserwator uruchomi signed pilots po terminalnym sukcesie buildu. UI preview nie jest sesją wykonania tego obserwatora. Brak nowych częstotliwości, brak kwalifikacji fizyki; żadnego sukcesu solvera nie wnioskujemy z UI.

Status integracji: review i bramki runtime/frontendu pozostają otwarte; worktree zachowane. Pełne scalenie do master nie zostało wykonane.

## Kolejny checkpoint

Powtórny start poprawionym launcherem potwierdzony na porcie 3106: automatyczny import filmu i trzech etapów, scope sesji oraz WebGL PASS. #202 zablokowała kontrola źródeł po dwóch plikach bytecode utworzonych przez obserwator. #203 (`d30406a2ef6d42cb9120ce04d58d646a`) używa świeżej kapsuły commita `d89bc761f93a28e30ab55959bd818f99020453ab`; obserwatory mają `-B` i `sys.dont_write_bytecode=True` przed importem. Cache w nowej kapsule nie istnieje. Wynik solvera pozostaje NOT VERIFIED.

Push/merge jest wstrzymany: aktualizacja otwartych PR uruchomiłaby CI kompilujące testy jednostkowe, których obecnie zakazuje AGENTS.md. Frontendowy toast 404 ma lokalną poprawkę z regresją, bez wykonania tej bramki i bez wdrożenia.
