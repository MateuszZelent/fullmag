<!-- integration-current-evidence-20261004 -->
## Bieżący stan przed integracją — 2026-10-04

Ten checkpoint zastępuje niższe deklaracje bieżącej liczby punktów,
aktywnych jobów i lokalnych/niewypchniętych zmian. Zachowujemy je jako
datowaną historię, także tabelę statusu wykonania i końcowe wpisy #219.

Istnieje 15 rzeczywistych punktów DE (14 nonzero z managed#228 oraz
Gamma selected-only #227) i dwa osobne dodatnie refinements air1,15.
Raport: [baseline15](../../raports/2026-10-04-de-signed15-runtime.md),
[air refinement](../../raports/2026-10-04-de-air-grading-two-points.md).
Nie są to ukończony wspólny signed15 ani serial/adaptive parity; Gamma
full window, convergence, GUI i A1/COMSOL pozostają OPEN. Wyniki są
completed_unqualified, bez promocji GPU lub produkcyjnego waveguide.

Użytkownik zlecił commit/push całości worktree, synchronizację najnowszego
origin/master i integracjęPR97. Ten etap Git nie kończy naukowego S00–S12.
Runner jest idle/healthy, około1,80GiB wolnego; nie ma aktywnej symulacji
ani nowego buildu nearest. Kompilowane unit tests nadal NOT RUN.

# Naprawa ładowania modelu DE w UI

<!-- eps-dimensions-analytic-checkpoint-20261004 -->
## Aktualny checkpoint — wymiary EPS i analityka Γ

Odczyt 2026-10-04T05:29:59.287034+00:00. Całe S00–S12 pozostają OPEN; ten etap nie dodaje zaakceptowanych punktów ani nowego wykresu.

- Commit źródeł `d95053982f3b0447d81df240663d1c9bec721b79` zapisuje rzeczywisty EPSGetDimensions (NEV/NCV/MPD) w istniejących fazach diagnostyki. Signed zera i sentinele są zachowane, nieudany odczyt daje false/null. Odbiornik zachowuje opcjonalne dane osobno w raporcie globalnym, próbce i każdym podoknie; brak historycznego pola nie tworzy pomiaru. Wymiary mogą różnić się między oknami. Operator, konfiguracja EPS/KSP, residual i kryteria akceptacji nie zostały zmienione.
- Natywne oraz Python source review: brak nowych P1/P2. Dokładnie staged nota/mapa naukowa, Python AST i whitespace PASS. 19 interpretowanych testów Pythona PASS; nowe przypadki wykrywają brak zachowania danych w starym odbiorniku (oczekiwany RED). Test C++ actual formattera przygotowano bez kompilacji zgodnie z zakazem. Native getter, świeży pakiet i managed runtime tego przyrostu NOT VERIFIED.
- Niezależna kontrola wcześniejszego Γ #226: raw 9,299249697068216 GHz wobec analityki jednorodnej warstwy 9,299249697068401 GHz, różnica około −0,000185 Hz. Referencja używa tego samego t=10 nm, p=2 µm po każdej stronie, B=0,1 T, Ms=800 kA/m i demag Nz=2p/(2p+t). Model otwartej nieskończonej warstwy daje 9,309813711433354 GHz i nie jest tym samym warunkiem brzegowym. Zgodność częstotliwości nie dowodzi tożsamości modu, nonzero-k ani zbieżności. Kandydat pozostaje odrzucony przez pierwotną bramkę μ₀; artefaktów ani tolerancji nie zmieniono.
- Runner po zgłoszonym restarcie: running=True, worker_alive=True, accepting_jobs=True, worker_error=None. Wolne 2110935040 B (~1.97 GiB) wobec progu 8 GiB; aktywne joby [], ostatni stan koordynatora waiting_for_disk. Ten sam #227 ma stan obserwatora `queued` / `waiting_for_build`. Żywy uchwyt 81829/PID 243032 potwierdzono; nie zgłoszono duplikatu i nie usuwano danych.
- #227 pozostaje przypięty do a8d67ac92002b884799119578a054b518cf40cbf, digest e848950d7d555f4d70d27a71421803fd2566d7e2f57d7e05b22f05da8123e8e6: zawiera poprawkę μ₀, bez późniejszych EPS termination/dimensions ani S09. Po terminalnym sukcesie publiczny managed dry-run ma poprzedzić pojedynczy Γ nearest; przyjęcie wymaga rzeczywistych artefaktów. Pełne frequency_window wymaga później świeżego pakietu z diagnostyką i kontrolowanego strojenia.
- S09 pozostaje OPEN: atomiczny typed cutover musi objąć ProblemIRV04/Wire.study, StudyIR wraz z pozostałymi payloadami, migrację i round-trip, obecność BC, planner, geometryczne certyfikaty siatki/regionów/ramy oraz MFEM 2.5D. Dotychczasowe guardy i propozycje kontraktu nie są produkcyjnym providerem. API/UI/FMS/WebGL, serial/adaptive parity i pomiar puli, signed15, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR97/integracja nadal OPEN.

Dowody w katalogu preview-state-checkpoint wizualizacji wątku: eps-dimensions-final-staged-validation.json, eps-dimensions-native-review.md, eps-dimensions-consumer-review.md, eps-dimensions-consumer-source.md, eps-dimensions-regression-baseline.json, gamma226-finite-air-analytic-comparison.json i gamma226-finite-air-analytic-audit.md. To osobne dowody źródeł i kontroli wcześniejszego raw wyniku, bez nowej kwalifikacji solvera.


<!-- eps-termination-spatial-checkpoint-20261004 -->
## Aktualny checkpoint — diagnostyka podokien i S09 na remote

Odczyt 2026-10-04T04:47:21.413299+00:00. S00–S12 pozostają OPEN; nowych zaakceptowanych punktów jest zero.

- Poprawka EPS `091a046970b2256c85813c5ea4761377496c5e57` zachowuje rzeczywisty signed kod zakończenia i liczbę iteracji osobno dla każdego podokna; dostępny kod błędu 0 nie usuwa zmierzonych danych. Brak odczytu, hard error oraz nieważny kontekst pozostają false/null. Review: jeden P2 zamknięty źródłowo, bez nowych P1/P2; dokładnie staged dokumentacja naukowa i whitespace PASS. Regresja rzeczywistego formattera przygotowana, niekompilowana zgodnie z zakazem. Native/runtime NOT VERIFIED. Nie zmieniono operatora, tolerancji, budżetów ani kryteriów akceptacji.
- S09 `c667a41779a6cba20d917983b674563b1e3f929f`: historyczne readery/migratory odrzucają obecność spatial_representation, także null, zamiast tracić intent. Nowa nota 0833 i specyfikacja 2.5D są propozycją kontraktu; typed ProblemIRV04 i produkcyjny provider MFEM 2.5D nadal OPEN. Kontrole naukowe, parser Rust bez kompilacji i review źródeł PASS; siedem wcześniejszych niezmienionych kontroli algebraicznych pozostaje aktualne. Nie uznano tego za kwalifikację solvera 2.5D.
- Korekta diagnozy Γ #226: układ split ma 1312 stopni swobody, magnetyczne q ma 656; limit dokładnego preconditionera 512 sprawdza split_count. Nearest i frequency_window różniły się również KSP/preconditionerem oraz NEV/NCV, więc nie stanowią kontrolowanego A/B. Z brakujących kodów podokien nie można wywieść rzeczywistej przyczyny siedmiu slepc_diverged. Pełne okno nadal OPEN; kandydat nearest 9,299249697068216 GHz został odrzucony przez bramkę μ₀ i nie jest nowym zaakceptowanym punktem.
- Runner po restarcie: worker_alive=True, accepting_jobs=True, worker_error=None; wolne 2184069120 B (~2.03 GiB), próg admission 8 GiB. Job #227 `d2a6c2dd0c3c4a66a1e05fce10bb32c7` ma stan `queued`. Nie zgłoszono duplikatu, nie usuwano danych ani cache.
- Jeden żywy kontroler sesji 81829 (PID 243032) obserwuje job #227; faza `waiting_for_build`. Po succeeded/exit0 i publicznym managed dry-run uruchomi tylko nową próbę nearest Γ 9,3 GHz na modelu 71ba0d18225ffcc83f7f18e676de8dc051e87fd1, L2/t3. Wynik wymaga walidacji artefaktów, μ₀, demaga, residualu i binding. Kontroler nie kwalifikuje pełnego okna ani 15-punktowego sweepu.
- Ważna tożsamość źródeł: #227 kompiluje commit a8d67ac92002b884799119578a054b518cf40cbf z poprawką μ₀; nie zawiera S09 ani nowej diagnostyki EPS. Następny eksperyment całego okna wymaga świeżego pakietu tej diagnostyki po zakończeniu bieżącej bramki; queued nie oznacza wykonania. API+UI/FMS/WebGL, serial/adaptive parity i pomiary CPU/RAM, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR #97/integracja pozostają OPEN. Wykres nie otrzymał nowych punktów.

Dowody w katalogu evidence wątku: `preview-state-checkpoint/eps-termination-staged-validation.json`, `eps-subwindow-termination-review.md`, `spatial-contract-staged-validation.json`, `spatial-presence-guard-review.md`, `gamma226-window-convergence-audit.md`, `eps-plan-live-checkpoint.json`, `gamma227-nearest-controller-state.json`.

<!-- canonical-mu0-source-checkpoint -->
## Poprzedni checkpoint — poprawka μ₀ na remote; nowy build w kolejce

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
- Odczyt ustawień po EPS potwierdza tolerancje EPS/KSP 1e-9/1e-9 i FGMRES z restartem 8. Dokładny preconditioner okna był wyłączony (`disabled_dimension_cap`): układ split ma 1312 stopni swobody (magnetyczne q: 656), a limit wynosi 512. Wpływ tego ograniczenia na zbieżność jest hipotezą do sprawdzenia. Limit i próg fizycznego residualu 1e-8 pozostają bez zmian.
- Próba pojedynczego modu Γ `gamma-nearest-current-job226-v1` zakończyła solver kodem 0 w około 40,75 s. CSV i spectrum.v3 zawierają częstotliwość 9,299249697068216 GHz, a względny pełny residual wynosi 6,3964287916e-11 przy progu 1e-8. Natywny residual ma certyfikację, lecz driver odrzucił wynik z powodu niespójnej stałej μ₀: diagnostyka podaje 1,25663706212e-6, model deklaruje 4πe-7. Różnica względna wynosi około 5,44e-10. Wynik pozostaje niezatwierdzony do czasu sprawdzenia źródła rozbieżności; nie osłabiono gate. Jest to jawna próba `selected_only`, z `window_complete=false`. Zachowano ten sam model, L2, trzy warstwy i zweryfikowany runtime #226. Kompletność widma 8,5–16 GHz nadal jest otwarta. Dowód: `gamma226-selected-result-inspection.json` w katalogu checkpointu.
- Poprawka importu PreviewState jest na remote w commicie `17d614412672cf22e6dbb6c01a7375bdcaae5076`. RawValue zachowuje odrzucanie powtórzonych znanych pól oraz numeryczne klucze domen. Review źródeł, parser/format i kontrola whitespace przeszły. Regresje są przygotowane i nie były kompilowane. Kompilacja nowego readera, import oryginalnego FMS i weryfikacja w przeglądarce mają stan NOT VERIFIED. Pakiet #226 zawiera poprzedni reader Value.
- Trwa poprawka centralnego zasobu postępu etapów: UI ma porównywać session_id, epoch i run_id przed pokazaniem danych. Nowy build zgodnego API i UI wymaga wolnego storage; ostatni pomiar około 4,2 GiB był poniżej progu 8 GiB. Zachowano aktywne cache i mounty.
- S00–S12 pozostają OPEN. Do wykonania: zaakceptowany sweep 15 punktów, kompletność okna Γ, zgodność serial/adaptive i pomiar CPU/RAM, API/GUI/FMS/WebGL/Inspector, DE/BV/COMSOL A1 i zbieżność, S09/S10/GPU oraz integracja PR #97. Dotychczasowe cztery punkty ±10/±25 są wcześniejszymi wynikami. Zachowano pozostały WIP.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\preview-state-checkpoint\gamma226-terminal-inspection.json`, `gamma226-diagnostics.json`, `gamma226-nearest-launch-plan.json`; [naprawa importu FMS](2026-10-04-preview-state-json-repair.md).

## Historyczny checkpoint ładowania modelu (zastąpiony aktualnym checkpointem powyżej)

- Dwa zaakceptowane punkty FEM z demagiem: k_y=−10/+10 rad/µm, około 11.205285 GHz; pełny residual <2.5e-10. Wykres rzeczywistych dwóch punktów i referencji −25…25 istnieje.
- Cel rozszerzono do 15 punktów DE: −25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25. Brakuje 13 nowych punktów. Pierwsza równoległa para ±2 zakończyła się błędem shift-invert GMRES (subwindow_failed); journal signed15-v1 zachowano, kampania jest zatrzymana. Osobna Gamma jeszcze nie ruszyła.
- Capture v3 po prawdziwym Solve ACK oraz v4-auto bez ręcznego Compute zakończyły się kodem 0. Archiwa FMS zawierają snapshot rzeczywistej siatki/pól oraz kompletny zestaw artefaktów modów, zweryfikowany hashami. Aktualny automatyczny driver ma commit 70a9ad670; build runtime #203 pozostaje niezmieniony.
- GUI wyników nadal NOT VERIFIED: import do własnego podglądu 3106 nie zmienił sesji, ponieważ kontrola pojemności staging odrzuciła /tmp 256 MiB (wymagane około 343 MiB). Naprawa launchera zwiększa konfigurowalną pamięć sesji bez osłabienia tej kontroli. Paired reader build #207 zakończył się błędem TypeScript po poprawnym native-build i bundlowaniu frontendu: preparation resource dopuszcza null, a model overlay deklarował węższy typ. Commit `5fa251fb184f31ac39144afda082af5b0fddcbef` poprawia ten kontrakt; kontrola typów modułu produkcyjnego PASS, regresje zapisane bez kompilacji unit tests. Build #208 `e29bc7499aad4377ad0a9ff58975edff` (fem-cpu-release, dokładnie ten commit) trwa; pełny receipt i browser proof jeszcze otwarte. Poprawkę launchera zapisano w 125da8d44.
- Nowy zakres: adaptacyjna pula oddzielnych procesów k oraz ustawienia CPU/RAM w UI/Python/IR, plan 2026-10-02-adaptive-dispersion-execution.md i ADR0034. Stan: source implementation; świeżość i hierarchy cgroup/RSS poprawiane na podstawie niezależnego review, pełny managed runtime NOT VERIFIED.
- Pełna kwalifikacja naukowa, COMSOL A1 i integracja PR pozostają otwarte. Zakaz kompilacji unit tests nadal obowiązuje.


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


## Kontynuacja: solver i GUI wykonania

- Build #203 zakończył etap `native-build` z kodem 0. CLI, API i `_fullmag_core` zostały zbudowane; istnieją CMake, dependency i runtime attestation. Terminalna weryfikacja koordynatora nadal trwa — samo powodzenie kompilacji nie jest jeszcze zgodą na start pilota.
- Obserwator pozostaje jedynym kontrolerem obliczeń DE `k_y=+10^7` i `-10^7 rad/m`, L2, trzy warstwy, full_2x2, nearest 11 GHz. Na czas tego wpisu `results=[]`; nie ma nowych częstotliwości. Referencja repozytorium dla obu znaków wynosi 11.235414178890272 GHz; jest porównaniem po solverze, nie wynikiem FEM.
- Poprawka nieistniejącego preparation przed pierwszym Prepare jest w commicie `f72bc7f935918bbf7a01dcc3de2afa4f16ada1d3`. Review źródeł i `git diff --check` PASS; regresje React zapisano, lecz nie uruchamiano kompilacji testów. Build produkcyjny i browser gate pozostają otwarte.
- Oczekujący #205 anulowano bez usunięcia danych, ponieważ snapshot Windows różnił się od źródeł #203 zakończeniami linii i trybami executable. Zastępuje go #206 (`912bae7d4d934cdaafb6b4f5a6107128`), profil fem-cpu-release, źródła z kanonicznego commita Git. Nie osłabiono kontroli zgodności kapsuł ani nie przerwano obcego #204.
- Launcher otrzymuje opcjonalne połączenie API/runtime #203 i web #206. Wymaga ścisłego porównania plików poza docs/ i apps/control-room/ oraz dokładnej zgodności wygenerowanych kontraktów OpenAPI. Pełna walidacja SLEPc, ABI i availability jest wymagana niezależnie od hashy plików.
- Headless pilot z API_PORT=0 nie publikuje snapshotu i nie tworzy kompletnego archiwum FMS. Podgląd autorskiej sceny na 3106 nie dowodzi wykonania. Wariant live musi wystartować API przed solverem, publikować prawdziwy snapshot/mesh i wyeksportować archiwum przed zatrzymaniem API; nie wolno ręcznie konstruować snapshotu istniejącego przebiegu.
- `capabilities.eigen_modes=false` jest obecnie stałą w statusie. W Control Room blokuje edycję k-path; nie blokuje pobierania istniejących spectrum/branches/mode fields. Nie traktujemy tej flagi jako dowodu nieobecności wyników.

Cel pozostaje otwarty: potrzebne rzeczywiste zaakceptowane punkty ±10, wykres i browser proof GUI pokazującego stan wykonania/wyniki. Kwalifikacja naukowa oraz integracja PR są oddzielnymi bramkami.


### Wynik pierwszego uruchomienia #203

Koordynator potwierdzil terminalny sukces #203. Pilot nearest +10 zakonczyl sie po poprawnym meshowaniu (30012 tetraedrow, 6138 wezlow), przed eigensolve. Konkretna przyczyna: `floquet_airbox_dynamic_demag_cpu_plan_supported` dopuszcza tylko `EigenTargetIR::FrequencyWindow`; nearest nie jest dopuszczony pomimo dostepnego drivera. Zlecono retry +10 z oryginalnej kapsuly #203 przez frequency_window 8.5-12 GHz, ten sam model, L2/trzy warstwy i progi. Wyniki oraz zgodnosc analityczna nadal NOT VERIFIED. Pelna walidacja receipt #203 i strict source-compatibility #203/#206 przeszly.


### Diagnoza kolejnych prób i poprawki

- Build #203 ma terminalny sukces; pełny validator receipt (SLEPc, ABI, dependency availability, źródła i wszystkie artefakty) PASS.
- Próba frequency_window 8.5–12 GHz znalazła kandydata 11.2052853243801 GHz poza pierwszym podoknem. Nie oceniono jego oryginalnego residualu: nie jest zaakceptowanym wynikiem. Solver błędnie zatrzymywał agregację zamiast przejść do następnego podokna.
- Commit `3bef07162db960d2caa4ca649045cc60d9610cbe` poprawia routing Nearest oraz kontynuację wyłącznie po czystym pustym podoknie przy dodatnim EPS reason. Odrzucenie residualu, divergence i błędy rekonstrukcji nadal kończą obliczenia błędem. Dwie interpretowane regresje źródłowe i kontrola dokumentacji PASS; nowy managed runtime tej poprawki jeszcze NIE powstał.
- Model `6cf0b786dc688e6a6993f7273df96dcb50727b1b` dopuszcza jawne, wersjonowane override'y granic częstotliwości. 36 regresji Python PASS. Okno diagnostyczne 10.9–11.5 GHz jest zapisane w provenance i nie zastępuje pełnej kwalifikacji pasma.
- Pierwsza próba wąskiego okna zakończyła się breakdown GMRES restart=8: residual rekursji różnił się od obliczonego residualu przy restarcie. Nie osłabiono tej kontroli ani progu residualu fizycznego 1e-8. Trwa kolejne wykonanie z restart=30, najpierw +10, następnie −10 tylko po sukcesie +10.
- Obserwator wykresu przyjmie wyłącznie wykonania z sukcesem wrappera, kontrolą pełnego residualu i powiązanymi hashami siatki/modów. Nie tworzy symetrycznego punktu z samej analityki.
- Commit launchera `710b6782a2a2fce9d9df266e42094b835134874c` umożliwia rozdzielone attested runtime/web, zachowując strict capsule/OpenAPI compatibility. 30 interpretowanych regresji PASS; rzeczywista walidacja wszystkich 14 artefaktów #203 PASS. Usunięto też błąd literalnego zakończenia linii protokołu JSON.
- Driver live UI jest przygotowany: API przed CLI, prywatny workspace/state, realny publisher, eksport FMS ze scope i niepustą domeną. Runtime/browser gate jeszcze NIE został wykonany. Web #206 pozostaje w FIFO.

Nadal brak zaakceptowanej nowej częstotliwości ±10 i brak GUI z rzeczywistymi wynikami. Model-preview na 3106 pozostaje oddzielnym, częściowym dowodem.


### Pierwszy certyfikowany mod +10; bramka eksportu nadal otwarta

Próbę GMRES30 przy środku okna 11.2 GHz przerwano po ponad 15 minutach bez wyniku; zachowano osobny receipt anulowania i wszystkie artefakty. Środek następnego okna 10.5–11.5 GHz wynosi 11 GHz. Solver zakończył się kodem 0 i opublikował mod +10 rad/µm o częstotliwości **11.205285324380608 GHz**:

- eps_full = 2.196199052709384e-10 przy wymaganiu 1e-8;
- eps_phi = 3.882423991196778e-14;
- pełny descriptor i szwy Floqueta certified=true;
- analityka n=0 = 11.235414178890272 GHz, różnica −0.2681597%;
- półanalityka sprzężonych modów N=32 = 11.228265979485525 GHz, różnica −0.2046679%; N=16 różni się o mniej niż 1 Hz.

Wrapper pozostał failed: niezależna kontrola eksportu H_d = −grad(phi) znalazła 64 rozbieżne składowe na 30012 tetraedrach. Runtime-success i pełny residual nie zastępują tej bramki. Trwa diagnoza eksportu/walidatora i osobne rzeczywiste obliczenie −10 przy tym samym modelu, oknie, mesh L2/trzech warstwach i progach. Wykres certyfikowanych artefaktów oraz GUI wyników nadal NIE zostały zatwierdzone.

Driver live/FMS zapisano w `7a7b7c36871acdcb898a17c66b459a83293df211`: 26 interpretowanych regresji PASS. Próba zgłoszenia nowego runtime z tym commitem została odrzucona przez aktywny storage lock pilota; nie powstał dodatkowy job ani alternatywny target.


## Historyczny checkpoint #203: dwa zaakceptowane punkty i wykres

Oba świeże wykonania `priority-validated-de-kp10-t3` i `priority-validated-de-km10-t3` zakończyły się kodem wrappera 0 i stanem `completed_unqualified`. Używają runtime #203 (`d30406a2ef6d42cb9120ce04d58d646a`), wersjonowanego modelu `6cf0b786dc688e6a6993f7273df96dcb50727b1b` i kontrolera z commita `978c0d70c876bcfedf385071236d06466a8780af`.

| k_y [rad/µm] | f FEM [GHz] | pełny residual |
| --- | --- | --- |
| +10 | 11.205285324405772 | 2.277784989202247e-10 |
| −10 | 11.205285254344654 | 2.4809101991678807e-10 |

Film DE 40×40×10 nm, B_ext=0.1 T w x, Ms=800 kA/m, A=13 pJ/m; mesh L2, trzy warstwy, pełny demag Floqueta, padding airboxu 2 µm. Okno 10.5–11.5 GHz, GMRES restart=8, EPS/KSP=1e-9; próg pełnego residualu fizycznego pozostaje 1e-8. Kontrole niepustych modów, tożsamości modelu/siatki, faz Floqueta i eksportowanego potencjału PASS. Korekta kontrolera potencjału w commicie 978c0d7 uwzględnia lokalny błąd zaokrąglenia operacji float64 i odrzuca niezależną regresję uszkodzonego pola; nie obniża wymagań residualu solvera.

Wykres `de-priority-k10-validated-v2.png`/`.pdf` zawiera dokładnie dwa rzeczywiście obliczone punkty i krzywe referencyjne −25…25 rad/µm. Raport wiąże hashe danych i wykresu. Pliki są w kanonicznym `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/nonzero-k-validation/d30406a2ef6d42cb9120ce04d58d646a/`. Różnica do analityki n=0 wynosi −0.26816%, do sprzężonej referencji N=32 −0.20467%; różnica między znakami około 70 Hz. Nie jest to jeszcze dowód zbieżności siatki/airboxu ani odtworzenie modelu A1 COMSOL.

GUI wyników pozostaje otwartą bramką. Build web #206 działa. Przygotowano eksport rzeczywistej sesji przez API-only capture; nie konstruujemy syntetycznych snapshotów. Odczyt źródeł wykazał, że runtime/API #203 publikuje epoch-only scope, a nowy launcher oczekiwał także request_scope_epoch. Naprawa musi używać dokładnego kontraktu attested API i zachować rygorystyczną ochronę nowej wersji. Podgląd na 3106 nadal nie jest dowodem GUI wyników.


### Rozszerzenie zlecenia: 15 punktów DE i równoległość

Użytkownik zlecił dodatkowe punkty w −25…25 rad/µm oraz sprawdzenie równoległego wykonania różnych k. Docelowa próbka: −25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25. Zweryfikowane ±10 są ponownie użyte z zachowaniem ich receiptów i hashy; reszta wymaga rzeczywistych nowych obliczeń.

Pierwszy test równoległy obejmuje +2/−2. Nadrzędny kontroler utrzymuje jeden prawdziwy worktree build_lock i przekazuje jedynie jego legalny odziedziczony token dzieciom. Kapsuła i runtime pozostają ro; każdy przebieg ma prywatny output/state/cache i nazwę kontenera. Nie fabrykujemy tokenów ani nie uruchamiamy równoległych buildów poza FIFO. Pomiar czasu/CPU/pamięci dotyczy dokładnie kontenerów tej serii. Gamma ma oddzielną kontrolę periodic_airbox_k0/gauge; nonzero-k kontrolę Floqueta.

Build GUI #206 zakończył się błędem kompilacji wariantu bez SLEPc: stała diagnostyki znajdowała się wewnątrz warunku zależnego od PETSc. Commit `ad3a20584147f28c465c8b9bb6aaf79ba8a32da6` przenosi niezmienną wartość do zakresu dostępnego także bez SLEPc. Nowy paired API/web build #207 `1e1a9289180a428e9204dc952e3f3a81` jest w kolejce, profil fem-cpu-release, źródła ad3a2058. GUI ma działać jako czytnik prawdziwego FMS w visualization_only; wykonanie solvera nadal ma pochodzenie runtime #203. Nie nazywamy GUI bez SLEPc silnikiem nowych obliczeń.

Capture v1 zatrzymała nieobsługiwana flaga Compose --tmpfs; v2 stara trasa /v1/openapi.json. Obie próby zachowano. Poprawki używają tmpfs deklarowanego w YAML i kanonicznej /v2/platform/openapi.json, 31 interpretowanych regresji PASS. Capture v3 uruchomiła realne API i meshowanie; bramka eksportu i browser pozostaje otwarta.

### Aktualizacja readera #208 i adaptacyjnego runtime #209

#208 (`e29bc7499aad4377ad0a9ff58975edff`) zakończył się sukcesem exit 0:
produkcja backendu i Control Room przeszła. Na 3107 uruchomiono przypięty
czytnik rzeczywistego archiwum +10; spectrum.v2 zwraca
11.205285324405771 GHz, domena ma 30012 elementów FEM. To wciąż wynik
solvera #203, a nie nowe obliczenie readera bez SLEPc.

Oryginalne archiwum ujawniło błąd serde w PreviewState: wewnętrznie tagowany
enum gubi adaptację numerycznych kluczy per_domain_quality. Źródłowa
poprawka zachowuje JSON, osobno odczytuje discriminator i wariant. Wymaga
nowego produkcyjnego buildu oraz sprawdzenia importu oryginalnego FMS.
Obecny czytnik używa jawnie oznaczonej kopii z preview:null; pozostałe
47 wpisów ZIP oraz dane fizyczne są byte-identical. Oryginał zachowano.
Restore class jest config_only / visualization_only; nie kwalifikujemy go
jako checkpointu wznawialnego.

Ponowny odczyt model/scene i meshing/policies/universe: HTTP 200,
scene.v2 revision 1. Wcześniejsze 404 nie dowodzą trwałego braku sceny:
canonical main.py ładuje ją leniwie. Browser proof potwierdza canvas
617×556, WebGL contextLost=false i brak pageerror. Jednak po ponownym
odczycie viewport pokazuje Resource load deadline exceeded, brak carrier
pola i bardzo mały obiekt mimo Focus. Pełne GUI wyników pozostaje otwarte;
nie uznajemy samego canvas za poprawną wizualizację solvera.

#209 (`21f2ba8564ce47f4a1a167f374948113`) jest aktywnym buildem SLEPc
adaptacyjnej puli. Zmiany polityki UI/Python/IR i pomiarów CPU/RAM są w
zamrożonym snapshotcie, lecz nie są jeszcze wdrożone ani zakwalifikowane.
Naprawa PreviewState powstała po freeze #209 i wymaga kolejnego buildu.