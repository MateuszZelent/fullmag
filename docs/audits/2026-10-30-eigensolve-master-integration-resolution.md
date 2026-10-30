# Integracja mastera — rozstrzygnięcie konfliktów 30.10.2026

Baza zadania: `676f6fc1bf391c0a0e383595eae13b0556c8dba7`; pobrany master: `57395376d43c85851ae2e7d5f81f5da2eae5138b`. Merge wykonano bez automatycznego commitu; nie używano reset, stash ani blanket ours/theirs.

| Konflikt | Zachowany kontrakt |
|---|---|
| live_accepted_projection.rs | Zachowano obie niezależne funkcje: dokładną linię publikacji modów z brancha oraz masterowy odczyt terminalnych skalarów z przypiętego artefaktu. Defer w Completing i wszystkie run/task/attempt/epoch/hash guards pozostają. |
| FooterTelemetry.test.ts | Pełny typed HTTP ScalarWindowResource z current_observation, rows i e_total; zachowano asercje Accepted scalar observation oraz nowsze testy mastera. |
| test_docker_build_control_cache_admission.py | Autospec BuildControl; zdarzenie pre-pull rejestrowane bez nieistniejącej metody fixture; fizyczny próg32GiB bez zmiany. |
| test_docker_dev_browser_qa.py | Rzeczywisty Compose command i Config.Cmd, odrębny helper i kontener browserQA, dokładne asercje cleanupu. |
| test_docker_volume_abrupt_stop_recovery.py | Cztery aliasy Windows i host-root wymagają fizycznych proofów; unsafeUNC odmawia przed próbą obserwacji. |
| test_docker_windows_bind_isolation.py | Provider Get-Item tylko dla linków; ordinarywalk .NET; ograniczenia czasu, wpisów,256linków i głębokości128 zachowane. |

Usunięto jedynie nadmiarowy końcowy pusty wiersz z masterowego live-quantity-refresh-audit.md, wskazany przez git diff --check. Po scaleniu AST6plików Python, parserYAML i parser4plików Rust przeszły; testów ani kompilacji lokalnie nie wykonywano. Hosted CI, runtime i nauka nadal są osobnymi bramkami.

Wszystkie14wcześniejszychWIP zachowało dokładneSHA z manifestu29.10. Dodatkowo zachowano ZIP141851B, CRC PASS, SHA256 `55a542e7ce0d7d34ab59fc20bbeb203b069f0aece4f19153824885d7936632d3`, w final-integration-20261030/pre-master-protected-wip. Oryginały pozostały na miejscu; nie dołączono ich do tego merge.

Native GHA41093866398 na475147b09 zatrzymało się przy kompilacji nowego fixture C++: brak namespace dla SLEPcTinyGyrotropicModalEigenResult. CTest nie został uruchomiony; C04 raportuje brak pomiarów. Artefakt12995884907/sha256 `1db7eb14df0e9b9e07ac2bd307fccf60b18efe767f9ac1d8a8f1bc8436356751` zachowano. Poprawka fixture i ponowna pełna bramka są konieczne, bez zmiany residuali ani fizyki.

Przed kolejną przebudową grupa3217 używała compiled5c8 i opublikowanych wyników15punktów. Wyniki zachowano także w sprawdzonym archiwum `.fms`. Merge źródeł nie jest dowodem przebudowy ani działania z nowego commitu.


## Checkpoint po bramce natywnej i próbie aplikacji

- Native GHA [41102742706](https://github.com/MateuszZelent/fullmag/actions/runs/41102742706), source `3967f03ba78323827712df99f7de020a2a16ff5b`: **21/21 CTest PASS**, 7,22 s. Artefakt13001715440, 429606 B, SHA256 `ee2f06fddeee59460f577b2f623199e93eb814e95ccd7d304c8043dae5f56975`; ZIP oraz log sprawdzono. To bramka natywnego kontraktu CPU/SLEPc, obejmująca nowy wybór FGMRES; nie jest ponowną kwalifikacją pełnego runtime ani nauki.
- Managed development `4c5c18af5b564ba1866cf20f11e49203` zakończył się **failed-confirmed** przy kompilacji aplikacji. Kontener backendu `a63f97a62eb9` zakończył się kodem2. Potwierdzono E0063/E0061 w modalnym workerze: brak dwóch pól `terminal_stats` i dziesiątego argumentu persystencji. Ten sam błąd zgłosiły GHA generated-api-determinism i checkpoint-windows-contracts. Nie uruchomiono nowego Solve.
- Poprawka `e17b78ae0e841344a160a02ec7517b0d3b4d4515` przekazuje jawne `None` w tych trzech miejscach. Modalny bundle nie posiada accepted time-domain state ani przypisanych StepStats. Nie kopiuje się skalarów z innego etapu. Parser Rust i YAML PASS; ponowna kompilacja aplikacji oraz hosted CI są nadal wymagane.
- Workflow dodatkowo uruchamia dwa istniejące pure source tests: MaxSteps nie oznacza convergence oraz odrzucenie niespójnego/nieskonwergowanego M0. Liczniki 2+1+1+1 są sprawdzane na pełnym wierszu wyniku; lokalnych unit testów ani ich kompilacji nie uruchamiano.
- Compose nieudanej próby ma SHA256 `609903dbcf38e00b5c51eab90f3e03d2ceacd103a396ffb17f6acf6587d3300a`. Nie zawiera override `FULLMAG_MODAL_SHIFTED_KSP_TYPE`; Schur-action pozostaje1. Prawidłowa próba z natywnym defaultem jest nadal **NOT VERIFIED**.

## Rozdzielenie dysków

Preflight kompilacji4c5 mierzył `/build` wewnątrz Dockera: 179862945792 B wolnego przy estymacie2963687540 B. Próg32GiB dotyczy tego filesystemu. Hostowy pomiar Ubuntu `/dev/sdd` wykazał jedynie734158848 B wolnego. `/state` jest bind-mountem z Ubuntu, a nie wolumenem builda; wymaga miejsca na sesje i wyniki. Żądanie dodatkowych30GiB w WSL jako warunku tego builda było nieprecyzyjne. Hostowy mount jest `rw`; widok `ro` pochodził z sandboxa.

Nie usunięto danych ani cache. Katalogi `runtimes` zawierają również wyniki i sesje; ich nazwa nie jest podstawą retencji. Inwentarz kandydatów i hostowy follow-up zachowano w `final-integration-20261030/wsl-cleanup-candidates` poza repo. Kolejny krok to spójna dokumentacja, ponowny managed build aplikacji, fresh signed15/R6 i analityka w rzeczywistym UI.
