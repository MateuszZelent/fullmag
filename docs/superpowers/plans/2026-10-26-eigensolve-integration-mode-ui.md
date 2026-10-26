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
| I2: podpisane osie i tożsamość punktu | Kod wypchnięty; CI UI i browser fixture PASS | Wybór osi kx/ky/kz/path, SI, brak wymyślania znaku, stabilna próbka/mod po zmianie osi; aktualne typecheck/lint/CI |
| I3: właściciel pola i akcja punkt → mod | Backend wypchnięty, UI w implementacji | Run/stage/sample/mode/equilibrium oraz generacja artefaktu spójne; odrzucenie brakujących/sprzecznych powiązań |
| I4: rzeczywisty mod w UI | Otwarte | Import wyniku/FMS lub przypięta mała symulacja; widoczny mod, real/imag/abs/phase, faza i animacja; WebGL bez utraty kontekstu i niezerowy buffer |
| I5: review, PR, master i cleanup | Otwarte | Wymagane CI/review, merge PR, lokalny fast-forward bez naruszania WIP; cleanup tylko potwierdzonego, czystego i nieużywanego worktree |
| I6: pozostała integracja solvera | Otwarte | Projekcja zespolona/transport bazy/periodyczne węzły, guards, artefakty, worker identity/journals, tracking; każda zmiana osobno zweryfikowana |
| I7: kwalifikacja naukowa | NOT VERIFIED dla nowej bazy | Gamma + signed sweep, residuale, kompletność okna, serial/adaptive, zbieżność i COMSOL A1 ≤0,5% |

Nie podajemy zbiorczego procentu: liczba commitów poza masterem nie mierzy ukończenia funkcji. S00–S12 oraz U1–U7 nie są zamknięte przez ten checkpoint.

## I2 — pierwszy spójny fragment

- [x] Rozszerzyć metadane `chartSeries.ts`/`chartCursorPoint.ts` i adapter w `frequencyDomainChartModels.ts` bez zmiany transportu API.
- [x] Przenieść czystą projekcję `dispersionChartAxes.ts`, kontrolkę osi i podłączenie w `AnalysisFrequencySurface.tsx` z zachowaniem nowszej infrastruktury jednostek i ograniczeń liczby punktów.
- [x] Zachować dokładne indeksy, identyfikatory i przerwy gałęzi; powtarzane k/crossing nie są tożsamością modu.
- [x] Dodać regresje dla ujemnego/zerowego/dodatniego k, brakujących składowych, zmiany osi i selekcji.
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

## Checkpoint źródeł — 26.10.2026

- Dokumentacja bazowa zapisana i wypchnięta jako `8ec44e900dee5e78be83ee947944dbe60f9b93ac`.
- Inwentarz obejmuje 388 odrębnych commitów w sześciu liniach audytu. Większość pozostaje `pending-semantic-review`; pierwsze adaptacje mają osobny disposition i wskazany pozostały zakres. Nie utożsamiamy spisu ścieżek z review.
- Review rekonstrukcji potwierdza trzy powiązane poprawki reference publication: zespolono-liniowa projekcja skalarna, ekspansja węzłów periodycznych i guard po materializacji równowagi. Native Full2x2 ma własną ekspansję i nie może być rozwijany drugi raz. Kołowa skalarna rekonstrukcja nie dowodzi eliptyczności fizycznego modu.
- Commit UI `6b500194cf598d5f6271eaf8c5e6c7b3c9f20bb9` nie nadaje się do bezpośredniego cherry-picku: master po `68fb29494e9e81fe6d01b36b1561cd07b276a4e3` ma immutable artifact generations i `validate_generation_producer`. Stary reader manifest/metadata trzeba uzgodnić z tą autorytatywną generacją, również w readerze binarnym, bez omijania mismatch guard. Wstępna decyzja: adaptować semantycznie, zachować nowy kontrakt mastera.
- Toolchain PASS: attempt `670d0e09f2814b0cb889de210057389b`, image `sha256:72430ffceef912ad51ab375bad1ba2ab813f4a2b8b614f017af5af483a4d8e73`.
- Grupa `fullmag-worktree-eigensolve-integration-ui-202610-78b341212cbdaa7d`, planowany port UI 3217. DEV/backend obrazy przygotowane; backend rozpoczął capture i kompilację. Nie jest to jeszcze dowód startu API ani modów.

## Checkpoint CI i runtime — 26.10.2026, po pierwszej integracji

- Draft PR: https://github.com/MateuszZelent/fullmag/pull/262 — nie scalony.
- `b152b0e63359c4f9664ff352a4556a68bca811ec`: referencyjna projekcja/ekspansja i guard równowagi; CI 40290633337 potwierdziło 5 testów projekcji, 2 guardu i 1 pozytywnej publikacji. Negatywna publikacja wykryła, że `FemLlgProblem::new_state` nakłada statyczne więzy przed sprawdzeniem materializacji.
- `100340ea2a29aea9e3e72e5ea9acab3521b61c5b`: walidacja również przed konstrukcją stanu; ponowione CI Rust 40292988623 zakończone PASS (rust-contracts). Nie zmieniono tolerancji ani kryterium przyjęcia.
- `e3cbbf8f7ded74d665139aacbe03e67d76789d45`: podpisane osie i tożsamość punktu. CI 40291646451: typecheck/lint PASS, 854 pliki testowe PASS, jeden nowy test ma błędne oczekiwanie `modeFieldAvailable` przy `field=true`. Browser fixture wykrył nieaktualne oczekiwanie etykiety `path_s` wobec nowej `k-path distance s [rad/m]`. Obie asercje są naprawiane.
- Doradczy lokalny hook React Doctor uruchomił hostowe npx i zwrócił niepełny wynik (oxlint `Unexpected discriminant 7 for TSTypeName`). Nie jest to PASS. Kolejny commit nie uruchamiał tego hooka; wymagane kontrole wykonuje CI, bez instalowania/budowania zależności na hoście.
- Docker DEV bazowych źródeł: attempt `8a3df04185104af481a76b9bc7dcad3a`, config SHA `94e06fec34cdae533ff041eb4bdfaa98799f579c76fdd17823bb6d0edefe6766`, kompilacja ok. 13 min 23 s, exit 0. Backend i frontend healthy; `http://127.0.0.1:3217/v2/platform/health` zwrócił `status=ok`, `active_session=false`. Ten build poprzedza nowe poprawki Rust — wymaga przyrostowego restartu po integracji.
- I3: trwa jeden resolver właściciela dla JSON/meta/binary/Results, exact member + immutable producer; bez fallbacku kind/active stage. Import FMS zachowuje run i nadal musi przejść mismatch guard. Manifest nowych publikacji będzie normalizowany z istniejącego PublicationOwner przed hash/write.
- I4: rzeczywiste pole, selekcja i animacja w przeglądarce nadal NOT VERIFIED. Zdrowe API i fixture wykresu nie zastępują tego dowodu.
- Nie usunięto żadnego starego worktree ani danych.

- `44ab221dfc80166bcf3548a7aee236e6df2695a9`: UI odrzuca konflikty dokładnego właściciela i rozpoznaje tylko historyczną parę placeholderów; poprawione dwie asercje. Browser CI 40294018307 w toku.

## Checkpoint właściciela i próby rzeczywistego pola

- `44ab221dfc80166bcf3548a7aee236e6df2695a9`: CI 40294013352 zakończone sukcesem, w tym frontend i browser fixture. Nie kwalifikuje rzeczywistego pola FEM.
- `3f8377e1998a682ef9e7c14aa913c0bc39390560`: wspólny exact-owner reader i binding publikacji. CI wykryło sześć regresji: historyczny response writer używa pary `current` / `frequency-response`, a jeden test opierał właściciela wyłącznie na rodzaju etapu.
- `df866b9988fcce30979d2040f0fe07e111c818d9`: rozpoznanie tej konkretnej pary placeholderów oraz jawne artifact_refs fixture'u, bez wnioskowania właściciela z rodzaju. CI 40297531266: frontend/browser oraz Rust (job 121487123536) PASS.
- Przyrostowy build i start API dla `3f8377e1998a682ef9e7c14aa913c0bc39390560` zakończone: attempt `aaa53dedc95e4ba885ebe830822f7fb5`, snapshot `e4beb2c88284fad8187f952789fcb98413990cdf8c7138cbad45770b28c1b75c`. Kompilacja backendu około 228 s. API healthy, brak aktywnej sesji.
- Próba źródła spod tests/fixtures została odrzucona przed Solve przez kontrakt mapowania outputów. Nowy przykład jest pod `examples/fem_eigen_mode_ui_de_k10.py`.
- Próba przykładu `eef547e38f114d6daf975ec20aa6c2dd`, request `eigensolve-ui-de-k10-examples-20261026`, source SHA `c9b001912673ac257ddcdc396da17e618d57eb952924d1d38be64eca1bd6ec41`: HTTP 422 `accepted_execution_plan_invalid`. Nie powstał wynik solvera. Receipty zachowane w wolumenie kontrolnym grupy.
- Diagnoza źródłowa: `materialize_pipeline_eigenmodes` ignoruje payload `eigen_magnetostatic_bc` i hardcoduje `LinearizedLlg`, mimo `full_2x2` w payloadzie. Naprawa musi zachować oba pola przed ponowną próbą. Nie zmieniamy bramki planera ani dynamicznego demag.
- Na prośbę użytkownika trwa wyszukiwanie archiwów FMS w storage E:, storage WSL, głównych checkoutach i starych worktree. Dotąd brak trafień; część technicznych katalogów probe odmawia odczytu. Nie zmieniono uprawnień ani nie usunięto danych. Brak trafienia nie jest dowodem nieistnienia archiwum poza przeszukanym zakresem.

### Wynik wyszukiwania archiwów

Pełny przebieg wyszukiwania nazw `*.fms`, `*de-smoke-k10*`, `*ui-seven*` zakończony w dostępnych katalogach `/mnt/e/git/storage`, `/home/kkingstoun/git/fullmag/storage`, obu głównych checkoutach, Windows `worktrees`/`fullmag-worktrees`, `recovery-backups`, `Claude outputs` i WSL `run_output`. Nie znaleziono oczekiwanego DE-SMOKE ani siedmiopunktowego archiwum. Niektóre katalogi techniczne zwróciły permission denied; nie zmieniono ich uprawnień.

Jedyny FMS: `/home/kkingstoun/git/fullmag/storage/user-data/viewport-r7-qa-archives/session-18e161c536100cdb00000be8-5ea6d68ed5766540.fms` (35289 B, 15 wpisów). Odczyt ZIP bez rozpakowywania: manifest backend `fdm`, status `running`, brak ścieżek eigen/dispersion/spectrum/mode. Ten plik nie jest dowodem modów FEM i nie został importowany ani zmieniony.

Poprawka materializatora zapisana jako `0b64bb67cc638a2da1a2a880b165ab8d3fdae0a3`; dodane trzy regresje. Testy tej poprawki i ponowiony runtime pozostają NOT VERIFIED do następnego CI/buildu. Nie obniżono kryteriów solvera.

### I3 i ponowiony runtime

- `855a8a105`: weryfikacja mode JSON → meta → binary z exact owner/sample/raw mode/field/equilibrium i jedną committed generation; cancellation i intent equality obejmują nową tożsamość. Nowe testy czekają na CI.
- `d72e1ac77`: akcja punkt → mod oraz rozwiązywanie równowagi per próbka w wykresie i obu Inspectorach. Brak tożsamości wyłącza dostęp do pola. Testy i real browser pozostają otwarte.
- Restart początkowo użył identyfikatora `iteration` zamiast bazowego `development` i zakończył się bez zmiany usług. Po odczycie obu receiptów użyto bazowego `8a3df04185104af481a76b9bc7dcad3a`.
- Przyrostowy restart `2cc0fb10362b4a458a51b4d11d6b38d8` zakończył się sukcesem. Backend: commit `0b64bb67cc638a2da1a2a880b165ab8d3fdae0a3`, dirty snapshot `9c71f2247d214f22e70a0738309f24e057d7766688d86c384ed9862caa25cbcb`. Jest to precyzyjny snapshot buildu, nie dowód wszystkich późniejszych zmian UI.
- Aktywacja `e1be187148524b89bc5a3d8e43f3b6c0`, request `eigensolve-ui-de-k10-lowering-fixed-20261026`, przeszła wcześniejszą bramkę planera i utworzyła run `run-live-a89cc2126d08df4ba04b68387007cd50e7e15b92c011a7355c3a9bf7ccc71e71`. Następnie HTTP 503 `accepted_preparation_runtime_failed`; launcher zachował wynik `outcome-unknown-resources-retained` i zabronił automatycznego replay.
- Supervisor: `runtime service owner observation failed during supervision: runtime service owner is not ready`; receipt `/opt/fullmag/runtime-control/runtime-service/process-tree.json`, stan `failed_outcome_retained`. API pozostaje diagnostyczne. Nie wykonano ponownego Solve ani restartu po tym błędzie; trwa diagnoza i odczyt dowodów.

### Checkpoint końcowy wyszukiwania i bieżąca blokada recovery

- Rust CI 40302491392 / job 121503715612 PASS, obejmuje poprawkę materializatora. Frontend przeszedł typecheck, lecz nowy negatywny test zaczynał od już zgodnej selekcji; scenariusz poprawiony w `113fb56ab`. Browser wykrył niepełny mock mode JSON Inspectora; korekta w `5cdf773f9`, bez usuwania asercji wyścigu run A/B. Ponowione CI dla nowych źródeł pozostaje w toku.
- `503e91b79`: eigen overlay bez typed intent jest unverified i nie trafia do generic viewport. To domyka obejście mode JSON gate; AnalysisResult i response zachowują osobne kontrakty.
- `7937688a2`: admission zachowuje dokładny powód odrzucenia próbki zasobów. Historycznego powodu awarii nie da się odtworzyć: ostatni sample miał właściwy boot/owner i około 4,6 s wieku, lecz po wyjściu procesu lock ownera jest już zwolniony. Nie uznajemy tego stanu po awarii za jej przyczynę.
- Próba preview `stop-held-retirement-volume` odmówiła: nasza aktywacja nie jest nierozstrzygniętym retirement przed publikacją. Następnie istniejąca ścieżka `stop-diagnostic-volume --pending-activation` odmówiła przed zmianami: wymaga dokładnie jednego zadania.
- Odczyt katalogu runu potwierdził dwa zadania (relax/eigenmodes), oba lifecycle `accepted`, readiness `blocked/accepted_task_awaiting_preparation`, bez artifact_ids; katalog ma tylko run_intent, run_catalog i preparation_resource_leases. Nie uruchomiono Solve, nie usunięto lease/ownerów ani archiwów.
- **Blokada I4:** brak zweryfikowanej zarządzanej drogi odzyskania tego dwustopniowego przyjętego przygotowania. Następny krok to plan i regresje dla dokładnego wieloetapowego archive-only recovery, z ponowną kontrolą wszystkich tasków, rezerwacji, ownera i braku wykonania. Samo rozluźnienie `len(tasks)==1` jest niedopuszczalne. Dopiero później nowy build z diagnostyką i jawna nowa próba, bez automatycznego replay starego runu.
- PR #262 pozostaje draft. Master, stare worktree i dane referencyjne pozostają zachowane. Wyszukiwanie archiwów zakończone; rzeczywiste pole i browser/WebGL nadal NOT VERIFIED.


## Ponowienie rzeczywistych obliczeń — 26.10.2026, recovery i nowy blocker

- Poprawka `6ba5c2321`: archive-only recovery sprawdza wszystkie nietknięte zadania i dopasowuje lease po task_id; 12 testów Python PASS, diff check PASS. Kontrolowane zatrzymanie starego nieuruchomionego runu zakończone `stopped-awaiting-fresh-archive`; stan i cache zachowane.
- Managed fresh-state recreation zakończone sukcesem. Development attempt `fdba82b7de6f4c8881357bd7840bdb8d`, config `c387b9ab8e83047ee7e6a92bb79a6ab18ef975147d5d4ffa7dba235f07da9af0`. Backend snapshot `a8e7c51827c84ce24c586e75acd8e74222d6879796654834d3c28fde9059ce6f` na bazie `c2871b1385039821ea62d5ea0b12f9ac8a6e2c9d`; build 115194 ms, package/gates/API ready. UI http://127.0.0.1:3217.
- Ponowiono `examples/fem_eigen_mode_ui_de_k10.py`, request `eigensolve-ui-de-k10-recovered-20261026`, activation `3e79d6b7e6344f54a262268813a9d49d`, run `run-live-7c501da955ebfad86f566b13adf4961e45bac0ef78296f736789c289e898c4bd`.
- Native preparation etapu `relax` PASS (758 true DOF w dowodzie przestrzeni). Nie jest to wynik relaksacji ani częstotliwości. Przygotowanie `eigenmodes` zakończone błędem: `accepted FEM preparer requires a time-domain FEM or antenna inspection plan` (`accepted_fem_preparer.rs`, selekcja siatki). Brakuje obsługi planu częstotliwościowego w ścieżce accepted preparation; kontrakt jest analizowany przed poprawką.
- API czekało na brakujący receipt mimo trwałego błędu preparera i zdrowego ownera. Osobna poprawka ma zgłaszać dokładny błąd, respektując autoryzowane retry, zamiast czekać do timeoutu.
- Stop przez API zakończony i potwierdzony w journalu: `fm-34feb8cf-244c-420d-8c21-0defd3700db5`. Wcześniejsze writer-busy nie zapisały polecenia. Aktywacja zakończyła się HTTP409 `accepted_preparation_run_stopped`, zachowując lease/dane; nie wolno jej ślepo ponawiać.
- Nowa częstotliwość, pole modu, wykres oraz kwalifikacja naukowa pozostają NOT VERIFIED. Następny krok: poprawić preparation i raportowanie błędu, zachować anulowaną próbę poprzez managed recovery, przebudować i ponowić pilot; dopiero po rzeczywistym wyniku signed sweep i wykresy.

### Potwierdzone dalsze zależności wykonania (nie tylko preparation)

1. `accepted_fem_study_worker.rs` wymaga planu time-domain oraz artefaktu `final_state`; nie posiada adaptera modalnego. `accepted_study_worker.rs::collect_runner_study_outputs` publikuje stan/energię, ale nie ma kontraktu pakietu widma i zespolonych modów. Przed realnym wynikiem UI trzeba wdrożyć dispatch modalny, typed output/recovery i publikację do właściwego run/stage/sample/equilibrium. Nie wolno przepuszczać eigen przez guard czasowego workera.
2. Preflight czasowego workera odrzuca wszystkie static PBC bez publicznego native-lane attestation. Runner ma `FemStaticPbcLane::NativeDemagPoisson`, ale sama obecność kodu nie jest dowodem dopuszczenia accepted worker. Pilot DE potrzebuje tego również dla relaksacji.
3. Istniejąca ścieżka `recover-cancelled-activation` obsługuje pojedynczy task po iteracji; obecny run ma dwa taski i bazowy development. Wymaga zachowującego pełne dowody rozszerzenia przed kolejnym restartem; żadnych fikcyjnych pinów iteracji ani kasowania stanu.
4. CI `40306170593`: Rust i inspector-actions PASS; frontend 8866 testów PASS / 1 FAIL (fixture overlay bez modeIntent), browser fixture FAIL (brak k-resolved w inspector-run). To nie jest zielona bramka integracji. Fixture testu overlay jest uzupełniany, asercje zmiany właściciela pozostają wymagane.

### Minimalna kolejność domknięcia accepted modal execution

| Krok | Zakres | Odbiór |
|---|---|---|
| M1 | Native static-PBC attestation eksportowane przez runner; accepted relax dopuszcza tylko potwierdzone natywne lane, w tym demag Poisson | Ten sam przypięty plan, CPU/double, brak ReferenceReduction/fallback; negatywne testy lane niedozwolonych |
| M2 | Oddzielny modal dispatch w accepted worker, istniejący runner `FemEigen`, wejściowa równowaga z dokładnego CAS/dependency | Brak kierowania eigen do time-domain adaptera; exact preparation, lease, mesh i input identity; brak ponownego solve po niejednoznacznym skutku |
| M3 | Jawny kontrakt typed output dla widma, dyspersji i zespolonych pól oraz ich immutable publication | Run/stage/sample/mode/equilibrium/generation i hashe; brak udawanego final_state jako dowodu modu; limity rozmiaru i kompletne referencje |
| M4 | Recovery modalnego zakończonego attemptu | Odtworzenie publikacji wyłącznie z istniejących zweryfikowanych wyników; bez powtórzenia native solvera |
| M5 | Pilot DE +10, następnie -10 i signed sweep -25..25 rad/um | Wiersze częstotliwości, residuale, PBC, dynamiczny demag, źródła i równowaga; bez lustrzanego dopisywania numeryki |
| M6 | Wykres i browser real-mode proof | Wykres z realnych artefaktów; kliknięcie sample/mode, real/imag/abs/phase i animacja; osobno WebGL i naukowa kwalifikacja |

M1–M4 pozostają otwarte. Zmiany preparera i szybkiego błędu zamykają jedynie wcześniejsze blokady, nie te cztery kroki. Samo podniesienie tolerancji, wyłączenie demag lub obejście accepted-run nie jest rozwiązaniem.

### Checkpoint źródeł po ponowieniu

Na remote `codex/eigensolve-integration-ui-20261026` wypchnięto: `6ba5c2321` (nietknięte multi-task recovery, 12 Python PASS), `1a7f1eeca` (native preparation planów częstotliwościowych i regresje), `c0da4b0a6` (dokładny terminalny błąd preparera, retry pozostaje pending), `6c036512c` (kanoniczny modeIntent fixture UI). Nowe testy Rust/frontend wymagają nowego wyniku GitHub Actions; nie były lokalnie kompilowane. Runtime nadal używa snapshotu `a8e7c518...` i zachowanej zatrzymanej próby, więc nowe poprawki nie mają jeszcze dowodu wykonania.
