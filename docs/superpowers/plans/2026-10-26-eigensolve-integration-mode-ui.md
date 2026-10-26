# Integracja eigensolve i wizualizacja modów — plan wykonania

Data: 26.10.2026.
Cel: zachować niezintegrowaną pracę, przenieść poprawne fragmenty na aktualny master i odebrać rzeczywistą wizualizację modów w jednym workspace.
Architektura: selektywna integracja na bazie mastera, istniejący Python/IR i API v2, resource hooks, kernel commands oraz wspólny viewport. Nie przywracamy dawnych launcherów ani starej wersji całych plików.
Stos: Rust/native FEM, Python, React/TypeScript i obecna grupa Docker Compose.
Specyfikacja wejściowa: [audyt](../../audits/2026-10-26-eigensolve-worktrees-master-audit.md), jego JSON oraz istniejące kontrakty API/viewportu. Historyczny plan UI z brancha `f0ad762b599bef2d48e41dbd9bb64c8e38aabf6a` jest źródłem implementacji, nie aktualnym dowodem odbioru.

## Baza i ochrona pracy

- Master lokalny i remote sprawdzony: `1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7`.
- Worktree integracji: `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026`.
- Branch: `codex/eigensolve-integration-ui-20261026`.
- Owner: `codex:01a1770e-c06b-7282-9514-c818c5e8dfc1`.
- Oddzielna izolacja jest konieczna: główne checkouty są współdzielone, stare branche zawierają niezależny WIP i setki rozbieżnych commitów. Stare worktree są źródłami, nie miejscem masowego merge.
- Nowy worktree utworzono narzędziem aplikacji, następnie przeniesiono przez `git worktree move` do katalogu wymaganego przez AGENTS.md. Git i rejestr Fullmaga są poprawne; aplikacja odmówiła ponownego przypięcia przeniesionego katalogu jako managed worktree. Wszystkie polecenia używają jawnej ścieżki.
- 40 plików WIP głównej dyspersji skopiowano bez modyfikacji do `/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/eigensolve-integration-preservation/files`; `manifest.json` zawiera SHA-256, a blob każdego pliku zgadza się z audytem (uwzględnienie CRLF). To kopia bezpieczeństwa, nie review ani commit WIP.

## Ograniczenia

Nie usuwamy niezintegrowanych worktree, wyników, cache ani aktywnych zasobów. Nie resetujemy/stashujemy obcej pracy. Testy kompilowane wyłącznie w GitHub Actions zgodnie z wcześniejszą zgodą; lokalny development przez przypisaną grupę Compose. FDM CPU/GPU i FEM CPU/GPU pozostają odrębnymi realizacjami. Poprawny wykres nie dowodzi poprawności solvera ani kompletności widma.

## Etapy i stan

| Etap | Stan | Kryterium odbioru |
|---|---|---|
| I0: audyt, tożsamość i kopia WIP | Częściowo wykonany | Audyt przeczytany, baza sprawdzona, 40 plików zabezpieczone; pozostałe stare linie zachowane, ich semantyczne review nadal otwarte |
| I1: mapa selektywnej integracji | W toku | Każdy istotny fix ma decyzję: przenieść / obecny odpowiednik / zastąpiony / otwarty; klasyfikacja po ścieżce nie wystarcza |
| I2: podpisane osie i tożsamość punktu | W implementacji | Wybór osi kx/ky/kz/path, SI, brak wymyślania znaku, stabilna próbka/mod po zmianie osi; aktualne typecheck/lint/CI |
| I3: właściciel pola i akcja punkt → mod | Otwarte | Run/stage/sample/mode/equilibrium oraz generacja artefaktu spójne; odrzucenie brakujących/sprzecznych powiązań |
| I4: rzeczywisty mod w UI | Otwarte | Import wyniku/FMS lub przypięta mała symulacja; widoczny mod, real/imag/abs/phase, faza i animacja; WebGL bez utraty kontekstu i niezerowy buffer |
| I5: review, PR, master i cleanup | Otwarte | Wymagane CI/review, merge PR, lokalny fast-forward bez naruszania WIP; cleanup tylko potwierdzonego, czystego i nieużywanego worktree |
| I6: pozostała integracja solvera | Otwarte | Projekcja zespolona/transport bazy/periodyczne węzły, guards, artefakty, worker identity/journals, tracking; każda zmiana osobno zweryfikowana |
| I7: kwalifikacja naukowa | NOT VERIFIED dla nowej bazy | Gamma + signed sweep, residuale, kompletność okna, serial/adaptive, zbieżność i COMSOL A1 ≤0,5% |

Nie podajemy zbiorczego procentu: liczba commitów poza masterem nie mierzy ukończenia funkcji. S00–S12 oraz U1–U7 nie są zamknięte przez ten checkpoint.

## I2 — pierwszy spójny fragment

- [ ] Rozszerzyć metadane `chartSeries.ts`/`chartCursorPoint.ts` i adapter w `frequencyDomainChartModels.ts` bez zmiany transportu API.
- [ ] Przenieść czystą projekcję `dispersionChartAxes.ts`, kontrolkę osi i podłączenie w `AnalysisFrequencySurface.tsx` z zachowaniem nowszej infrastruktury jednostek i ograniczeń liczby punktów.
- [ ] Zachować dokładne indeksy, identyfikatory i przerwy gałęzi; powtarzane k/crossing nie są tożsamością modu.
- [ ] Dodać regresje dla ujemnego/zerowego/dodatniego k, brakujących składowych, zmiany osi i selekcji.
- [ ] Review diff, testy w CI, typecheck/lint oraz browser po uruchomieniu dedykowanej grupy.

W tym fragmencie nie wymieniamy Inspectora ani renderera: master ma nowsze damping observables, sterowanie i reguły cyklu życia. Akcja pola należy do I3, ponieważ stare UI korzysta z dodatkowego kontraktu właściciela i równowagi per próbka.

## I3–I4 — zależności, które trzeba zamknąć

Porównać `frequency_domain_owner.rs` starej gałęzi z bieżącym odczytem artefaktów; uzgodnić binding manifest/metadata, `native_provenance_by_sample` i walidację `equilibrium_artifact_sha256`. Nie kopiować fallbacku do bieżącej selekcji ani zgadywać wspólnej równowagi. Zachować generation gate w `modeFieldOverlayResources.ts`. Dopiero wtedy podłączyć `DispersionModeAction` do istniejącej komendy `analysis.eigen.plot-mode-3d`.

Przed oceną polaryzacji przenieść lub potwierdzić odpowiednik WIP `project_complex_mode_to_tangent_basis`, ekspansji periodycznych węzłów i kontroli transportu baz. Źródłowa poprawka bez wykonania nie dowodzi właściwego pola.

Browser: realny wynik z identyfikacją źródeł; widoczny punkt, kliknięcie i zgodny mod, metadane oraz binarne pole, zmiana fazy i komponentu, powrót bez starego pola. Osobno sprawdzić canvas, `gl.isContextLost() === false`, wymiary bufora i wizualną obecność pola. Fixture jest dodatkową regresją, nie dowodem solvera.

## Decyzje sprzątania

| Zasób | Decyzja | Warunek ponownej oceny |
|---|---|---|
| Główne Windows worktree dyspersji | Zachować: unikalna historia + 40 WIP | Semantyczne review/integracja wszystkich potrzebnych zmian, czystość, brak ownerów i mountów |
| Windows dispersion-mode-ui | Zachować: 96 unikalnych patchy, część backendowa | Integracja lub jawne zastąpienie każdego istotnego kontraktu |
| Starsze Windows K0/remediation/HPC/Sphinx | Zachować: niezintegrowane/WIP | Mapa odpowiedników i zatwierdzony zakres cleanupu |
| Dawne niedostępne WSL katalogi | Nie wykonywać prune | Potwierdzenie mountów i braku niezapisanych danych; ancestry nie dowodzi pustego katalogu |
| Wyniki i pakiety runtime | Zachować | Sprawdzenie odwołań i zatwierdzony planer retencji |

Do tej pory nie usunięto danych. Docker działa; konfiguracja WSL przechodzi `setup_docker.py --check`. Dostęp GPU hosta niewykazany; nie jest to dowód FEM GPU. Na filesystemie WSL jest około 23 GiB wolnego; przed ciężkim buildem ponownie ocenić miejsce i równoległe zapisy. Aktualna lista kontenerów obejmuje cudze grupy — nie przejmujemy ich.
