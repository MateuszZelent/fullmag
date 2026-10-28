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
| I1: mapa selektywnej integracji | W toku; review trzech krytycznych WIP rekonstrukcji potwierdza identyczne obecne odpowiedniki (28.10); pozostałe historyczne fragmenty otwarte | Każdy istotny fix ma decyzję: przenieść / obecny odpowiednik / zastąpiony / otwarty; klasyfikacja po ścieżce nie wystarcza |
| I2: podpisane osie i tożsamość punktu | Kod wypchnięty; CI UI i browser fixture PASS | Wybór osi kx/ky/kz/path, SI, brak wymyślania znaku, stabilna próbka/mod po zmianie osi; aktualne typecheck/lint/CI |
| I3: właściciel pola i akcja punkt → mod | Owner-bound JSON/meta/binary i pięć rzeczywistych przejść punkt → mod (próbki 0/3/7/11/14) PASS; import FMS cold oraz visualization_only PASS, końcowy strict i bieżący runtime otwarte | Run/stage/sample/mode/equilibrium oraz generacja artefaktu spójne; odrzucenie brakujących/sprzecznych powiązań |
| I4: rzeczywisty mod w UI | Gamma nearest i ±10: rzeczywiste pola, Real/Imag/Abs/Phase, WebGL2, animacja i zrzut samego magnetyka PASS; pełny sweep pozostaje w I7 | Import wyniku/FMS lub przypięta mała symulacja; widoczny mod, real/imag/abs/phase, faza i animacja; WebGL bez utraty kontekstu i niezerowy buffer |
| I5: review, PR, master i cleanup | Otwarte | Wymagane CI/review, merge PR, lokalny fast-forward bez naruszania WIP; cleanup tylko potwierdzonego, czystego i nieużywanego worktree |
| I6: pozostała integracja solvera | Otwarte | Projekcja zespolona/transport bazy/periodyczne węzły, guards, artefakty, worker identity/journals, tracking; każda zmiana osobno zweryfikowana |
| I7: kwalifikacja naukowa | 15/15 z Gamma window zachowane w FMS i potwierdzone po imporcie; kompletność, zbieżność, serial/adaptive i COMSOL nadal NOT VERIFIED | Gamma + signed sweep, residuale, kompletność okna, serial/adaptive, zbieżność i COMSOL A1 ≤0,5% |

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

Kod M1–M4 został następnie wdrożony i wypchnięty; odbiór runtime pozostaje otwarty (szczegóły w najnowszym checkpointcie poniżej). Zmiany preparera i szybkiego błędu same zamykały jedynie wcześniejsze blokady. Samo podniesienie tolerancji, wyłączenie demag lub obejście accepted-run nie jest rozwiązaniem.

### Checkpoint źródeł po ponowieniu

Na remote `codex/eigensolve-integration-ui-20261026` wypchnięto: `6ba5c2321` (nietknięte multi-task recovery, 12 Python PASS), `1a7f1eeca` (native preparation planów częstotliwościowych i regresje), `c0da4b0a6` (dokładny terminalny błąd preparera, retry pozostaje pending), `6c036512c` (kanoniczny modeIntent fixture UI). Nowe testy Rust/frontend wymagają nowego wyniku GitHub Actions; nie były lokalnie kompilowane. Runtime nadal używa snapshotu `a8e7c518...` i zachowanej zatrzymanej próby, więc nowe poprawki nie mają jeszcze dowodu wykonania.


## Checkpoint wznowienia pilota — 26.10.2026, accepted modal worker

### Źródła i weryfikacja

- `90a45aaba`: publiczne native static-PBC attestation i współdzielona walidacja domknięcia artefaktów.
- `10ea1042b`: oddzielny adapter accepted FEM Eigen, typowany pakiet `fullmag.study.modal_eigen_bundle.v1`, trwałe CAS i odtworzenie zakończonego attemptu bez ponowienia solvera.
- `3ecd9501f` / `d804b12f8`: kompilowany wspólny właściciel polityki PBC oraz zgodny typ `FemEngine` w preview.
- `af6383263`: publikacja zweryfikowanej modalnej generacji CAS do katalogu aktywnego UI, z blokadą konfliktów właściciela i odświeżeniem rewizji artefaktów.
- `4342fcf94` / `4f542bfa7`: Results Explorer i akcje gałęzi używają równowagi wybranej próbki, również bez wspólnego equilibrium.
- `e13f99ba2`: recovery anulowanej aktywacji bazowego development z wieloma zadaniami; 71 testów Python PASS.
- `efad81f00`: poprawione typy map fixture Rust, pełne provenance próbek w fixture UI i prawdziwy nagłówek generacji fixture pola. To nie zmienia tolerancji, fizyki ani guardów produkcyjnych. Nowe CI: https://github.com/MateuszZelent/fullmag/actions/runs/40331494879 — wynik do odczytu.

| Krok | Aktualny stan | Pozostały odbiór |
|---|---|---|
| M1 | Rzeczywista natywna relaksacja CPU: completed/converged, exact producer owner | Odbiór wyjścia do eigensolve i spójnej projekcji UI |
| M2 | DAG, typed CAS handoff, ścisły replay i dispatch skompilowane; CI PASS na 2f99894c54bc6745bc9353634dd06487a106cc51 | Runtime eigensolve po rozwiązaniu historycznego quarantined lease; NOT VERIFIED |
| M3 | Codec/CAS/publikacja do UI skompilowane | Prawdziwy kompletny pakiet i odczyt API |
| M4 | Walidacja zakończonego attemptu wdrożona | Dowód odtworzenia realnej publikacji bez solve |
| M5 | Piloty ponowione; native Relax działa, brak nowej częstotliwości FEM. Signed15 zapisany na remote | Decyzja o izolowanym worktree albo właściwe uzgodnienie historycznej lease; potem +10, -10 i signed sweep |
| M6 | Harness binarnego pola i decode-ready przygotowany, jeszcze bez realnego moda | Pole, selekcja, składniki/faza/animacja, WebGL i wykres z rzeczywistych punktów |

### Recovery i zarządzany build

- Anulowana aktywacja `3e79d6b7e6344f54a262268813a9d49d` została zachowująco zamknięta przez managed recovery: `stopped-awaiting-fresh-archive`, `execution_state=not-started`, lease zwolniony, oryginalne rekordy zachowane. Recovery SHA `1d5338aee65d40c5d6cc9ca431958f0dbcd0e339c129270563c645afba425c1a`.
- Development `6f678bf0e1d145d8be4d6f6914530ae7` zatrzymał się na E0308 preview przed startem API/solvera; poprawka `d804b12f8`.
- Development **`9ff104c274b74fcba650a384339fdfd8` PASS**, config **`869a5b9724b3c68de1ef1957e2fb04b1289d18b66f4315337994ef5bb27b1db1`**. Build aplikacji 339133 ms, exit 0, walidacja pakietu i gate runtime PASS. UI/API na `http://127.0.0.1:3217`, runtime bundle `0.1.0-dev.20261026.gd804b12f8f7b+9795`. Obrazy i cache użyte ponownie; niczego nie usunięto.

### Faktyczny wynik próby

- Aktywacja `d7aa3a225ee243cbaf791b42a8de4622`, request `eigensolve-ui-de-k10-modal-worker-20261026`, run **`run-live-9ddf7a6d56121142facf17c6a7645effcfd242df5a13ffc88012c3bb83d0cc8e`**. Model załadowany; domena FEM ma 2530 komórek.
- Oba taski są terminalne `failed`: `project storage preparation failed; no solver was launched: Permission denied (os error 13)`. Zachowane receipty `worker_prelaunch_failed.v1.json` oraz `worker_process_exit_receipt.v1` potwierdzają brak solvera. Sukces aktywacji nie oznacza sukcesu solve.
- Przyczyna: jawnie skonfigurowany alias outputów wskazuje `examples`, UID/GID 1000:1000 i tryb 0755; proces runtime ma UID 65532 i dodatkową grupę 1000. Utworzono wyłącznie dwa nowe katalogi `examples/fem_eigen_mode_ui_de_k10.zarr` i `examples/.fullmag-tmp` z trybem 0770; nie zmieniono uprawnień istniejących danych/źródeł. Odczyt z kontenera potwierdził zapis do nowego outputu.
- Nowe żądanie `eigensolve-ui-de-k10-storage-ready-20261026`, aktywacja **`cc5f5118a0c145978af065b8ae7fd5e8`**, zatrzymane na `workspace retirement returned HTTP 409`, stan `outcome-unknown-resources-retained`. Poprzedni run nadal widoczny jako failed; bez ślepego replay. Trwa ustalanie dokładnego powodu oraz istniejącej drogi reconcile/retry.
- Referencję policzono istniejącymi oracle: przy k=±10 rad/µm otwarty film z profilem grubości (8 funkcji bazy) daje ok. 11.228266 GHz, a jednorodny n=0 11.235414 GHz. **To nie są wyniki Fullmag FEM** i nie stanowią kwalifikacji ani punktów numerycznego wykresu.

**Stan naukowy i UI modów: NOT VERIFIED.** Nie ma jeszcze nowej częstotliwości FEM, zespolonego pola ani nowego wykresu dyspersji na tej bazie.


### Kolejny checkpoint: rzeczywista relaksacja i brakujący handoff

- `d804b12f8`: poprawka błędu importu typu preview; managed build `9ff104c274b74fcba650a384339fdfd8` pozostał uruchomiony. Biblioteka FEM jest powiązana z `libslepc.so.3.24` i `libpetsc.so.3.24`; to dowód zależności, nie wykonania EPS.
- `bac9c350f`: finalizacja odtwarzania przyjmuje wyłącznie token 32-hex albo token z jednym LF (rzeczywisty format writera). Raw bytes pozostają preimage CAS. 105 testów Python PASS.
- `5e50eeada`: mutable wskaźnik `activation/current.json` można zmienić tylko po zgodności z dokładnym immutable terminalem poprzedniej próby i jej pinami; live/logger-absence CAS, testy driftu i symlinków. 115 testów bounded suite oraz 8 testów refusal PASS.
- Operacja `cc5f5118a0c145978af065b8ae7fd5e8` zamknięta `failed-confirmed / retirement-replayed / retirement_resume_state=succeeded`. Archiwum starego failed runu: SHA `b9199dd6d00c847aaa6a196abd78e62dce3fe2e773bf1b77667718c6e844d8d5`; oryginalne dane zachowane.
- Aktywacja **`69626eb846e7483790a57efcca9133dd` PASS**, nowy run **`run-live-ed0a5b070419c663fa5f10431232e5dc3739ec07065d02ce1e02696c5b818944`**. To nowe wykonanie po naprawie dostępu do outputów, bez przebudowy solvera.
- **Relax: native CPU completed, converged=true, 3 kroki.** Kryterium `max_torque_apm`: `2.6466332450953524e-11 A/m <= 1 A/m`. Poisson CG/AMG: 142 iteracje, końcowy residual `1.6180945995077723e-12`. Dokładne dane są w metadata/qualification i certyfikatach tego worker attemptu. Samo UI pokazało `converged=false`; to osobna luka projekcji, nie podstawa zmiany certyfikatu.
- **Eigen: failed przed właściwym solve** — `accepted relaxation handoff is required before FEM eigensolve`. Zaakceptowany graf miał dwa niezależne kroki z pustymi inputs; samo `equilibrium_source=relax` nie tworzyło zależności CAS. Nie ma jeszcze częstotliwości ani pola modu.
- `63234a1ab`: nowo wykonywana accepted relaksacja wiąże certyfikat z dokładnym run/stage/kind przed dispatch; nie zmienia starych sidecarów. Dotychczas native entry point nadawał osobną standalone tożsamość i `stage-001`. CI https://github.com/MateuszZelent/fullmag/actions/runs/40338518632 PASS; zmiana nie jest jeszcze wdrożona w aktywnym pakiecie d804.
- `2998ccf4d`: gotowy jawny skrypt `examples/fem_eigen_mode_ui_de_signed15.py`; lista `K_RAD_PER_UM` steruje 15 próbkami i zapisem każdego pola. Fizykę/mesh/solver porównano przez AST z pilotem; sweep pozostaje NIEURUCHOMIONY.

#### Domknięcie M2: uzgodniony kontrakt implementacji

1. W authoring, dla jawnego FEM Eigen z `equilibrium_source=relax`, dokładnie jeden enabled Relax dostaje dodatkowy port `equilibrium_handoff: Artifact`; Eigen dostaje required `StepOutput` do tego konkretnego kroku i case `default`. Brak/niejednoznaczność jest błędem przed RunIntent. Poprawne jawne powiązania i inne rodziny obliczeń pozostają zachowane.
2. Neutralny addytywny codec `fullmag.study.fem_equilibrium_handoff@v1` zachowuje preparation binding, exact owner, fingerprint planu i siedem zahashowanych memberów. Budżet 64 MiB, dokładnie jedna kompletna rodzina certyfikatów v1 albo v2. Istniejące codec State i schema certyfikatów naukowych nie zmieniają semantyki.
3. Producer pakuje dokładny plan źródłowy, completion i m0 oraz oryginalne bytes accepted/certified fields, recomputed certificate i producer provenance. Używa ścisłego `from_completed_relax_verified_with_exact_artifacts_and_provenance`, nie samego `m_final` ani luźnego konstruktora.
4. Publication/completion/recovery oraz consumer wiążą dane z exact run/task/attempt/epoch/preparation. Consumer przyjmuje tylko zadeklarowany StepOutput zakończonego Relax; żadnego latest, skanowania katalogu lub przemianowywania certyfikatu.
5. Runner sprawdza istniejący certyfikat i target plan, wiąże dokładne m0 oraz przyjmuje handoff przez ścieżkę live-preview z zachowaniem obsługi przerwania i autosave. Zmiana `RelaxedInitialState -> Provided` należy do istniejącego natywnego kontraktu.
6. Następnie wymagane są CI, nowy managed build, ponowienie pilota +10, kontrola artefaktów/moda w UI, -10 oraz signed sweep i wykres. Kod M2 przeszedł przegląd połączeń i kontrole składni; kompilacja i CI tego połączenia przeszły na 2f99894c54bc6745bc9353634dd06487a106cc51. Runtime eigensolve pozostaje NOT VERIFIED z powodu opisanej niżej blokady zasobów.

Dodatkowa korekta wykryta podczas integracji: registry `ResolvedStudyArtifact` nie dopuszczał modal bundle mimo istniejącego dispatch decode. Dodano exact codec tuple i negatywną regresję wersji/kind; bez wildcard fallback.


Źródłowe kotwice kontraktu M2 (stan kodu, nie dowód wykonania):

- `crates/fullmag-authoring/src/scene_study_plan.rs::normalize_fem_eigen_relax_dependencies` — krawędź DAG i jednoznaczność producenta.
- `crates/fullmag-application/src/fem_equilibrium_handoff.rs::FemEquilibriumHandoff` / `decode_fem_equilibrium_handoff` — typowany, ograniczony transport exact bytes.
- `crates/fullmag-api/src/accepted_relax_equilibrium.rs::collect_handoff` / `prepare_modal_handoff` — producer, exact catalog lineage i consumer.
- `crates/fullmag-runner/src/accepted_relax_replay.rs::replay_accepted_fem_relaxation` — ścisły naukowy konstruktor v3; `materialize_accepted_fem_relaxation_target` — exact m0 i preflight targetu.
- `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs::AcceptedFemRelaxStageHandoff::validate_target_plan` i `validate_provided_continuation_plan` — osobne kontrole single-k i continuation; globalne guardy nie zostały rozluźnione.
- `crates/fullmag-runner/src/lib.rs::run_planned_problem_with_live_preview_and_relax_handoff` — przekazanie certyfikatu istniejącej ścieżce native z interrupt/autosave.
- `crates/fullmag-runtime-control/src/study_equilibrium.rs::validate_handoff_publication` — niezależna walidacja przed publication i completion.

Przegląd wykrył i poprawił preflight zewnętrznego KPath: używa istniejącego walidatora continuation na walidacyjnym klonie Provided, zachowując RelaxedInitialState w zwracanym planie. Native path nadal materializuje i waliduje każdy single-k punkt przed solve. Dodano regresje Path/Single, m0, mesh/material drift oraz zakazu reuse przy bias-field sweep.


### Checkpoint po ponowieniach i odmowie recovery

Pełny bootstrap źródeł `40352367030` zakończył się **success** dla `2f99894c54bc6745bc9353634dd06487a106cc51`; obejmuje nową regresję stabilności bajtów `ExecutionPlanIR`, źródłowe kontrakty Relax→Eigen, API i UI. Runner: 1817 passed, 0 failed, 1 ignored. Zarządzany build `a88722cf8121416b91c0666c119f68c2` PASS. To odrębne dowody od native eigensolve, który nie wystartował w ostatnim pilocie.

Dokładne próby, tożsamości, historyczna aktywna lease w kwarantannie, odmowa `stop-diagnostic-volume` i konkretne warianty dalszego działania: [decyzja odzyskania runtime](2026-10-26-eigensolve-runtime-recovery-decision.md). Nie nadpisano kwarantanny, nie sfabrykowano release proof i nie powtórzono niejednoznacznej aktywacji.

Harness UI wymaga pobrania binarnego pola zespolonego o dokładnej generacji oraz markeru gotowości po dekodowaniu; zdrowy canvas i metadata-only `3D field ready` nie są takim dowodem. Wykres odniesienia 101 punktów jest tylko analityczny. Nie ma nowych punktów FEM do dodania do wykresu.

Harness zapisano w osobnym checkpointcie `6a913922ada2c5325acdbf430a16f9fc0fd026f7` po `node --check` i `--help`; czyta wyłącznie API, blokuje mutacje i wymaga dokładnej generacji binarnego pola oraz gotowości kontrolera. Nie ma jeszcze pozytywnego uruchomienia na rzeczywistym modzie.

## Aktualizacja odbioru — 27.10.2026, Gamma i pełny nonzero sweep

- I3/I4: rzeczywisty Gamma odebrany: run `bd97005a…`, 9,299249697 GHz, residual 2,7356e-13; pole zespolone, Real/Imag/Abs/Phase, WebGL i animacja PASS. Dowody: `docs/audits/2026-10-27-eigensolve-gamma-after-docker.evidence.json` i `2026-10-27-eigensolve-gamma-ui.evidence.json`. Wcześniejsze stwierdzenia braku jakiegokolwiek wyniku/UI są historyczne.
- I7: Gamma nearest zgadza się z continuum n=0 finite-airbox do błędu numerycznego. Nie kwalifikuje to kompletności frequency-window ani COMSOL.
- Signed14: native tasks succeeded, 14 rzeczywistych modów; finalne odwzorowanie do sesji UI zablokował literalny session_id=current. Diagnoza i dowody: `docs/audits/2026-10-27-eigensolve-path-session-mismatch.md`. Poprawka producenta i regresja przygotowane; wymagane CI, managed build, nowe wykonanie i UI.
- Następnie: wykres 15 opublikowanych próbek, rzeczywisty wybór modów ±k w UI; zbieżność/kompletność oraz COMSOL A1 nadal NOT VERIFIED.
- I5: PR262 draft/open, mergeStateStatus DIRTY — konflikty z nowszym masterem wymagają rozwiązania po zachowaniu bieżących danych.
- Korekty infrastruktury: ograniczone oczekiwanie na przejściowy ledger writer busy podczas retirement; jawne raportowanie odrzuconej publikacji zamiast bezterminowego running.


## Odbiór modów ±10 i kolejny krok — 27.10.2026

I3/I4: oba rzeczywiste mody ±10 odebrane na runtime fde189663; pola zespolone, Real/Imag/Abs/Phase, WebGL2 i animacja z kontrolą pikseli PASS. Poprawiono brak pól manifestu multi-k i sprzeczny sample_id. [Dowody](../../audits/2026-10-27-eigensolve-multik-mode-ui-contract.md). Nie zamyka to całego I7 ani I5.

Następny krok I7: odtworzenie i diagnoza Gamma frequency_window na tej samej fizyce/siatce przez `examples/fem_eigen_mode_ui_de_gamma_window.py`, następnie pełny signed15 i wykres. Historyczny sukces nearest-Gamma nie zastępuje bramki frequency-window. Zakończoną sesję ±10 zachowujemy przez managed retirement, bez edycji wyników.


## Kontynuacja integracji przy blokadzie dysku — 27.10.2026

Nowe źródła, jeszcze nieobecne w uruchomionym runtime fde189663:

- 97c6c430d: ograniczone oczekiwanie na typed StoreWriterBusy przy otwieraniu store/host ledger dla retirement. CI bootstrap/rust 40481439173 w toku.
- 148075e43: częściowa adaptacja historycznego f0986ede: C ABI i exterior-facet proof akceptują sentinel zero pure Neumann. CI native-modal 40482575121 oraz positive-mass 40482578832 w toku. Nie zmienia to zadanych warunków finite Dirichlet ani nie dowodzi rozwiązania awarii Gamma window.
- [Review semantyczne](../../audits/2026-10-27-eigensolve-exact-gamma-selective-review.md) i inwentarz odróżniają fragmenty zaadaptowane, obecne odpowiedniki oraz pozostałe części starego commita.
- [Stan runtime i miejsca](../../audits/2026-10-27-eigensolve-runtime-continuation-blockers.md): po zachowującym kopię przeniesieniu własnych zależności odzyskano ok. 157 MiB; bieżący odczyt wolnego miejsca WSL ok. 147 MiB. Lokalny build i bezpieczny pełny sweep blokuje brak miejsca; użytkownik został poproszony o zwolnienie przestrzeni WSL. Nie ruszano cudzych danych.

Pełny cel i I5/I6/I7 pozostają otwarte. Po zwolnieniu miejsca: domknąć dokładną operację retirement bce31153098a456a8f7e67326e3760a4, dokończyć Gamma window na tym samym modelu, następnie signed15 i aktualny wykres/wybór modów w UI. Oczekujące kontrole nie są wynikiem PASS.


## Checkpoint po końcowych kontrolach źródeł — 27.10.2026

Wszystkie pięć uruchomionych bramek źródeł PASS: API/retirement 40481439173, C ABI 40482575121, MFEM 40482578832, runner/import certificate 40483507450, UI 40486139519 (testy, architektura, complete typecheck, React Doctor). Browser pozytywny/negatywny UI PASS. Te dowody nie zastępują nowego Gamma i pełnego sweepa. Backend nadal fde189663.

Powtarzająca się blokada wykonania: /dev/sdf WSL ~60 MiB wolnego. Własne bezpieczne sprzątanie zakończone, brak przestrzeni nadal wymaga działania operatora. [Pełny punkt wznowienia i macierz pozostałych wymagań](../../audits/2026-10-27-eigensolve-resume-after-wsl-space.md). Cel nie jest zakończony; I0/I1/I3/I5/I6/I7 mają otwarty zakres. Nie uruchomiono kolejnej symulacji przy pełnym dysku.

## Aktualizacja 27.10.2026 — Gamma window i UI po naprawie runtime

I7 Gamma frequency-window PASS dla wybranego modu: run afe29d88…,
9,299249697 GHz, pełny residual 1,65e-13, 50/50 podokien,
search_stability=stable, NCV=32. window_complete=false: brak niezależnego
count certificate pozostaje otwarty. Porównanie finite-Dirichlet 5,5e-11%.
I4 browser real/imag/abs/phase i animacja Gamma window PASS; bounds samego
filmu 40x40x10 nm. Dokładne dowody w audycie resume-after-wsl-space oraz
2026-10-27-eigensolve-gamma-floor32-{published,ui}.evidence.json.

Naprawy źródłowe 7261e2b80 (minimalny NCV) i eb15c8520 (typed busy deferral
odczytu CPU przed spawn) są na origin. Runtime potwierdza eb15c8520.
CI MFEM 40495171889 PASS; Rust 40497276333 jeszcze nie odebrane.
Signed15 33b8b56d… rzeczywiście running; nie zamykamy pełnego sweepa,
wykresu ani pozostałych bramek I7 przed odbiorem wyników.


## Checkpoint pełnego signed15 — 27.10.2026

Bieżące obliczenia, wykres i dodatkowe poprawki UI/FMS opisuje [raport odbioru](../../../audits/2026-10-27-eigensolve-signed15-published-and-ui.md).

- [x] Ukończyć i opublikować w bieżącym API pełne 15 próbek z Gamma i dynamicznym demag.
- [x] Wygenerować aktualny wykres z analityką i zachować numeryczne CSV/provenance.
- [x] Pokazać rzeczywisty mod Gamma w 3D, cztery reprezentacje i zmieniającą się/zatrzymaną animację (oddzielny dowód wizualny).
- [x] Naprawić ETag dużego katalogu artefaktów i uzyskać strict browser PASS bez HTTP 500 (nowy backend ga63, nowy signed15, oba browserowe odbiory PASS).
- [x] Kliknięcie punktu Gamma → właściwe pole 3D po naprawie układu i readera KSamplingIR; tożsamość pola zachowana po ky → path.
- [x] Sprawdzić zakres i widoczność punktów wykresu po zmianie osi (15 punktów, końce i Gamma, oba warianty osi, trzy rozmiary okna).
- [x] Pełny strict browser bez błędów, w tym katalog artefaktów po aktualizacji backendu (Gamma oraz 15-punktowa przeglądarka).
- [ ] Naprawić pełny round trip accepted-v2 FMS z projekcjami modów i typed AcceptedStateRef; nie usuwać guardów kompletności.

Pozostałe bramki I0/I1/I5/I6/I7 zachowują oryginalny zakres. Cel pozostaje aktywny.

## Checkpoint przeglądarki i zapisu modów — 27.10.2026

Przebudowana główna przeglądarka Analysis pokazuje wszystkie 15 punktów signed15, widmo filtrowane według k, referencje importowane z tych samych CSV co Python oraz akcję punkt→3D. Odbiór rzeczywistego UI: `docs/audits/2026-10-27-eigensolve-modal-workbench-ui.md` i jego evidence JSON. Pięć wybranych próbek ma potwierdzone owner-bound kompleksowe bufory, widoczną powierzchnię magnetyka i zdrowy WebGL. CI frontendu na `d99aa5b2c` zakończone sukcesem.

Naprawy FMS są w źródłach i przeszły pełny workflow `40594365988` na `26408e119`: 437 testów sesji, niepusty Zarr bundle, negatywne przypadki catalog/owner/epoch/chunk i pełny cold import w nowym stanie API bez oryginalnego store. To dowód transportu; rzeczywisty archive round trip signed15 pozostaje otwarty w `2026-10-27-eigensolve-fms-roundtrip-repair.md`.

Przed przebudową własnej grupy zabezpieczono 304 pliki (132501653 bajty) generacji `sha256:94a4698432bb417fd3e0758c39300ef98661c84a7d3b7e6638e74b10b9ca7f4f`, z kontrolą każdego rozmiaru i SHA-256. Kopia danych użytkownika: `/state/runs/eigensolve-checkpoints/signed15-94a4698432bb-1793140585978662568`. Nie jest archiwum FMS ani uprawnieniem schedulera. Oryginalne wyniki i accepted CAS zachowano. Dowód i status aktualizacji: `docs/audits/2026-10-27-eigensolve-modal-runtime-update.evidence.json`.

Wybrano kontrolowaną aktualizację i ponowienie tego samego rzeczywistego benchmarku na nowej binarce. Istniejąca private reattach ścieżka jest odzyskiwaniem po awarii, a zwykły restart przenosi model, nie pełny wynik; nie poluzowano tych kontraktów ani nie wstrzyknięto starego snapshotu. Ponowienie ma nową tożsamość runu i nie zastępuje starego wyniku. Pozwala uzyskać rzeczywisty export/reopen na poprawionej binarce i ponownie odebrać cały wykres oraz pola.

Nie zamyka to I0/I1/I5/I6 ani naukowych bramek I7 (kompletność widma, zbieżność, serial/adaptive i COMSOL A1).

## Odbiór nowego runtime i signed15 — 28.10.2026

Pełne wyniki ponowiono w `run-live-93df870d6af7a8e9d70a3742a0de6e7860b5a072c98b7359c3463c18b49113de` na backendzie ga63; wszystkie 15 częstotliwości jest identycznych z poprzednim wykonaniem. Obie referencje są w nowym UI. Przeszły workbench (15 punktów, pięć pól, osie i okna) oraz strict Gamma z reprezentacjami i animacją. Zero błędów HTTP/JS w odbiorze; wdrożony ograniczony ETag zamyka poprzedni błąd katalogu. Zapisano rzeczywisty solved FMS z referencjami.

Dowód: `docs/audits/2026-10-28-eigensolve-modal-runtime-results.md` / `.evidence.json`. Wykres i mod są dostępne w aktualnym UI. FMS export nie oznacza round trip: rzeczywisty import ujawnił limity 10 MiB proxy oraz 128 MiB JSON, a archiwum referencji wymaga poprawnego rozdzielenia revision dokumentu i execution input. Naprawy L1–L4: `2026-10-28-eigensolve-large-fms-transport.md`. To otwarta część I3/I6; nie zamyka I0/I1/I5/I6/I7.

## I1 — review zachowanego WIP, 28.10.2026

[Decyzja integracyjna](../../audits/2026-10-28-eigensolve-reconstruction-integration-review.md) porównuje trzy funkcje rekonstrukcji, ekspansji węzłów i transportu baz z zahashowaną kopią WIP. Obecne ciała funkcji są identyczne z zachowanymi; konsumenci zachowują rozdzielenie scalar reference / Full2x2 reference / native. Nie skopiowano ponownie starych plików. Pełny runner CI 40611719529 dla e805d0774: SUCCESS, 1821 passed / 0 failed / 1 ignored. Sprawdzono log: wszystkie dziewięć nazwanych regresji rekonstrukcji, guardów i publikacji wykonane z wynikiem ok. Nie jest to odbiór natywnego runtime/GPU.

Aktualny runtime jest niedostępny po utracie demona Docker. Potwierdzone pozostają wcześniejsze cold import, visualization_only, identyczność 15 wartości z Pythonem i pięć modów w workbench; końcowy strict po naprawie compute_fields pozostaje otwarty. Nie utożsamiać wcześniejszego PASS I4 z bieżącą dostępnością UI ani z nowym strict po imporcie. Źródło szczegółów: audyt modal-ui-file-restore z 28.10.

### Dopięcie bramki zapisu i bieżący master

CI 40612294926 dla 0a02ca809: default-feature runner 1821 PASS oraz osobny, jawnie uruchomiony checkpoint-inspector Rust→Python 1 PASS. Zapis rzeczywistego manifestu i odczyt integralności potwierdzone; scientific_qualification pozostaje NOT VERIFIED.

[I5 preflight](../../audits/2026-10-28-eigensolve-master-integration-preflight.md): remote master 2c67d8f904b1dede9268bbbc8bf6257cbe33aa4f, 215 commitów incoming, 583 zmienione pliki, 12 tekstowych konfliktów w odczytowym preview. Nie przeprowadzono merge, status indeksu/WIP zachowany. Nowe CI nie zastępuje testów przyszłego zintegrowanego drzewa.
