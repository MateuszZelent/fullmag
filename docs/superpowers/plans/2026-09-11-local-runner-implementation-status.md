# Lokalny runner — stan wdrożenia

## Poprawki przed integracją PR #87 — 2026-09-11

- `7f09af06316de5c8f2402f0dafebcf9648197c2f`: własność pustych prywatnych
  katalogów workera oraz poprawny wynik zatrzymania koordynatora.
- `0f2bb72523641f0320a3f896f8f5921926eedfcd`: mirrory skilli wymagane przez CI;
  `python-contracts` po tej poprawce przeszedł.
- `4e81346490d0c3a04b654f2a980bcc7310ba9452`: jawna lista zmiennych środowiska,
  zgodność identyfikatorów Git SHA-256 oraz własność nowo tworzonych cache
  (bez zmiany istniejących cache).
- `5b2b95c1e3b958b15f51a33a1ef4685541d7bc97`: odrzucanie dowiązań w rodzicach
  ścieżek źródeł i rozpoznawanych katalogów/sufiksów poświadczeń.
- `addf837f0c04626538ef68c6fd1c8aafa0711586`: odmowa wznowienia podczas drain,
  powiązanie idempotencji z native identity i jawne ograniczenie planu retencji.
- Testy po poprawkach: `just runner-test` — 138 runner, 25 API/usługi, 16 storage
  (5 skipped Windows), bez porażek; regresje odtworzono przed poprawkami.
- Wymieniono wyłącznie zweryfikowany bezczynny kontener koordynatora, zachowując
  dane i obrazy. Nowy kontener `c276a50f668d6724d2514e15ab341d9cf7bb93fe9edc03adabd19fea65da3360`
  używa obrazu `sha256:780c8283fc8a446f4686917dc5c932b5f75c6f42194cfa11ee0af3be74329044`.
  Późniejsze poprawki review wymagają aktualizacji tego obrazu po terminalnym jobie.
- Poprzedni job `5e5502807a9c4209aa38dad9fa0e83d0` zakończył się `failed`, exit 2.
  Potwierdzona przyczyna: katalogi execution/artifacts miały root:root 0755,
  a worker UID 65532 nie mógł pisać. Nie usuwano jego danych.
- Ponowny job `037a6d013cba4c8aa7696e118f11329b` ma digest
  `b163298430b9fa113cd3648c2691a3f3c87392429812249d32133dc066755966`,
  capture `4322768108ff441b877130e691157e9c`, źródła `0f2bb72523641f0320a3f896f8f5921926eedfcd`
  plus jawne dwie poprawki C++ guardu CPU. W kontroli runtime potwierdzono UID 65532
  i zapis do prywatnych katalogów, poprawną materializację oraz start native-build.
  Job zakończył się `failed`, exit 2: kompilacja release backendu i CLI przeszła
  (`Finished release`, 13m35s), ale następne pobranie crate `arrayref` nie mogło
  zapisać do podkatalogu legacy Cargo cache (root:root 0755).
- `bebbdea930db5a10719c0c0c265b6caa42d0a1c1`: guard CUDA helperów FEM/BEM
  i test kontraktu źródłowego; dowód kompilacji CPU pochodzi z powyższego joba,
  nie jest dowodem uruchomienia testu C++ ani kwalifikacji fizyki.
- `bdbf1da752d0c37ed882bc7d748cb440fb355820`: własna przestrzeń zapisywalnych
  cache Cargo/pnpm dla UID workera, bez zmiany legacy cache. Regresja red→green,
  runner 139, API/usługa 25, storage 16 (5 skipped), review bez blokera.
- Aktualny koordynator `2437cb493bd8eda388d352eeaaf5015e73cc66c0610e4e8f1b05647f837ba65f`
  używa `sha256:65cadd2fb22b5eb32c326b2755b5d238f8d7f974dc1d4aea6a2af0a9432b5325`.
  Wymiana po pauzie i pustym slocie, następnie jawne resume: `accepting_jobs=true`,
  `worker_alive=true`, `worker_error=null`. Dane i obrazy zachowane.
- Nowy job `73758d24d6f94d659971bb48784d7fde` buduje czysty commit
  `bdbf1da752d0c37ed882bc7d748cb440fb355820`, digest kapsuły
  `4bee7e06ea3a89b45e7f98a1faece8632136a974ba0fd8746f9310fb1c361caf`.
  Koordynator potwierdził terminalne `succeeded`, exit 0. Etapy: native-build
  1847671.840 ms, frontend-dependencies 1298081.361 ms, frontend-build 404077.274 ms,
  każdy exit 0. Niezależna kontrola rozmiarów i SHA-256 wszystkich 109 artefaktów
  nie wykazała rozbieżności. Receipt wiąże czysty commit `bdbf1da75...` z obrazem
  workera `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.
  Pełny build **FEM CPU release jest potwierdzony**; nie jest to kwalifikacja
  fizyki, GPU, browser/WebGL ani wydania. Katalog buildu został ponownie użyty;
  nie usuwano danych wcześniejszych prób. Pierwsze zapełnienie cache i operacje
  na plikach Windows były kosztowne; nie obiecujemy czasu następnego buildu.
- Checkpoint dokumentacyjny po tym buildzie nie zmienia jego źródeł wykonawczych.
  Wszystkie zakończone kontrole CI dla `bdbf1da75...` przeszły. Ostateczny wynik
  integracji i zachowane zasoby zapisuje rejestr worktree. Główny checkout ma
  niezwiązane dirty zmiany na `fix/viewport-3d-audit-s18-s19-upload-20260910`;
  nie wolno ich przełączać, resetować ani dołączać do tego PR.
- PR: https://github.com/MateuszZelent/fullmag/pull/87. GitHub nie ma required checks,
  ochrony brancha ani rulesetów; osobny workflow `managed-fem-qualification`
  oczekuje na niezarejestrowany self-hosted runner (`total_count=0`). Nie jest to
  dowód braku lokalnego kontenera. Nie nadano mu niezweryfikowanej etykiety FEM
  i nie pominięto kontroli naukowej. Integracja kodu i kwalifikacja są oddzielne.

Poniżej zachowano starszy checkpoint wdrożenia; identyfikatory kontenerów i stan
jobów w nim są historyczne.

## Aktualizacja: koordynator w Dockerze, 2026-09-11

Commit etapu: `a5486faec0319f1440b93e489fea9ae48297587a` — kolejka w Dockerze,
uwierzytelniony klient, wykonawca buildów, testy i instrukcje. Dowody: `just
runner-test` (130 + 20 PASS, capability 16 OK/5 skipped), resolver 26 OK/2 skipped.
To commit komponentów, nie zakończona kwalifikacja pełnego builda.

Poniższe wcześniejsze etapy zachowano jako historię, nie instrukcję nowego wdrożenia.
Użytkownik zatwierdził socket Docker wyłącznie dla `Fullmag_build_runner` i bearer
API publikowane wyłącznie na `127.0.0.1:8765`. Stała usługa Windows została zastąpiona.

- Działa kontener `9fc8d4d9bbc5a8b71a2f94cd5b2f8a37e6a4e96971981a7395bd60b8cba6d293`,
  obraz `sha256:f41edac5d4d079e97d0f078d051b960e9a8762e3f8502bc1e24eed6325e250b7`.
- Sprawdzono exact image/name/labels/mounty/port, uwierzytelnione health,
  pauzę, kontrolowaną wymianę pustego koordynatora i wznowienie.
  Worker health: running/alive/accepting_jobs; nie jest to dowód buildu.
- Skonfigurowany obraz FEM CPU:
  `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.
- Implementacja: stała kolejka, Unix Docker API, katalog profili, prywatny
  execution, wymagane artefakty/receipt, heartbeat podczas builda, pauza/resume,
  ochrona klienta przed redirect/proxy, read-only plan retencji.
- Testy aktualnego etapu: 130 runner + 20 service/API PASS; capability 16 OK
  (5 skipped Windows). Testy nie zastępują uruchomienia solvera.
- Snapshot `b1fdb5b6d1138772d84246343e0c7aba38f7c9492d91c539fc878470620ab986`,
  capture `b8b254d42d254c599ee8cfbd11f84212`, HEAD
  `5e53b8590b34067a8da8b608e4f3d2c20386986a` plus jawne dirty/untracked wejścia.
  Job `5e5502807a9c4209aa38dad9fa0e83d0` został przyjęty mimo timeoutu klienta,
  ma aktywny lease i wykonuje preflight. Nie zgłoszono duplikatu.
  Pełny build nową trasą **NOT VERIFIED**.
- Przygotowano poprawkę: API sprawdza bounded manifest i rejestruje job,
  a pełne hashowanie plików należy do preflight wykonawcy przed Docker create.
  Przygotowany obraz `sha256:115a9c236a5291b5cc36bc38f250fc89112e7a9f29f373574bf376529a40928c`
  nie jest wdrożony; po jego zbudowaniu dodatkowo poprawiono writable katalogi
  prywatnej kopii. Wymagana kolejna budowa obrazu i wymiana po terminalnym jobie.
- Pierwsze capture odrzucono po zmianie pliku w trakcie kopiowania; drugie
  odrzucono z powodu niejawnych untracked wejść. Nie uznano ich za buildy.
- Destrukcyjne apply retencji zostało odrzucone przez kontrolę uprawnień.
  Brak wdrożonego automatycznego usuwania execution/kontenerów buildów.
  Nie usunięto cache, logów ani wyników. Wymiana dotyczyła tylko własnego
  zatrzymanego kontenera koordynatora, przy zachowaniu storage i obrazu.
- Skorygowano AGENTS.md, dodano skill `local-build-runner` i aktualną instrukcję.
  Walidator skilla nie wystartował bez PyYAML; frontmatter i referencję
  sprawdzono osobnym, ograniczonym testem strukturalnym.

Pozostaje: rzeczywisty build/worker recovery, decyzja o wąskim cleanup apply,
końcowe review oraz integracja brancha. GPU, fizyka, publikacja runtime `current`,
GitHub ingress i kwalifikacja wydania **NOT VERIFIED**. Nie wykonano merge.

Zakres zatwierdzony: koordynator na tym komputerze, kapsuły commit/dirty snapshot,
kolejka współdzielona przez agentów i GitHub, izolowany worker Docker, zgodność
storage/receipt i managed FEM. Nie zastępujemy pełnego celu samym demonstratorem.

## Stan

- Worktree: local-container-runner-20260911, branch codex/local-container-runner-20260911.
- Baza: fe10f8be750474025fb3c677aa6134c505a9d45d.
- Kolejka SQLite: zaimplementowana jako wewnętrzny komponent koordynatora.
  Jeden aktywny heavy job, idempotencja owner/request_key, atomowe claim,
  anulowanie running nie zwalnia slotu do potwierdzenia zakończenia.
  Restart nie przejmuje lease na podstawie wieku.
- Kapsuły commit/snapshot, odrębne source/worktree/job identity, jawne wyjątki
  polityki źródeł, manifest i weryfikacja po stronie hosta oraz kontenera.
- Lokalny klient submit/status/logs/wait/cancel, operatorowe configure-image,
  run-once, reconcile i jawne recovery komendy odrzuconej przed create.
- Worker bez sieci/GPU, UID 65532, readonly source/build/root, 2 CPU/1 GiB.
  Zaufana konfiguracja przypina image ID i lokalny endpoint Docker Desktop.
- `just runner-test`: 68 PASS w jednym przebiegu, w tym dwa worktree,
  recovery bez journala i ponowienie po błędzie zapisu stanu/logów.
  Istniejący test_fullmag_storage.py: 26 testów, OK, 2 skipped.
  To testy komponentów runnera; nie jest to kwalifikacja solvera.
- Commity etapów:
  - 2ff0e60e032ccffde334fae976c899f6a926e354 — kolejka i jej początkowe testy;
  - a9a830a7a646488da7795c2076bccbfef6d563bf — działający Python oraz przypięty
    natywny Git Bash, bez niejawnego wyboru WSL przez resolver;
  - 1282361fe8af1ee4a5ae39800dc7779f54852b97 — kapsuły źródeł z testami.
  - 688b383cf36d6dd602993e65c5d9244a83862fa3 — izolowany worker diagnostyczny,
    koordynator, klient, recovery, testy i instrukcja użycia.

## Dowód rzeczywistego joba CPU

- Job: e820fdad7ddf4d2dbc3f5ecd8833d39e, state=succeeded, exit_code=0.
- Źródła: commit 2ff0e60e032ccffde334fae976c899f6a926e354, 7043 pliki,
  287418715 bajtów. To jawnie wskazany commit testowy, nie późniejszy HEAD.
- source_digest: 0ddd86ec61083348a61ae82acf91f8ac624049303643d235e2819fb9afad9620.
- Image: sha256:109e9023aa594b0ff3ea59e7f9b24014d2351e4103ced1deece608cb45455092.
- Receipt pod `storage/runs/local-container-runner-20260911-8901f7ca0cf5cfd3/e820fdad7ddf4d2dbc3f5ecd8833d39e/artifacts/source-verification.json`.
- `runner-status` i `runner-logs` odczytane również w sandboxie tylko do odczytu;
  obserwator SQLite nie wykonuje już zapisu PRAGMA podczas odczytu.
- Pierwszy job 4f9ba1812c0e418198a3e1b98d643b53 był odrzucony przez parser
  `docker create` (nieprawidłowe `rw` w `--mount`). Po potwierdzeniu zakończenia
  procesu oraz braku kontenera został jawnie zamknięty jako blocked, z powodem
  w journalu. Nie zwolniono lease na podstawie wieku ani nie usunięto kontenera.

## Decyzja infrastrukturalna przed kolejnym etapem

Aktualizacja po zgodzie użytkownika: zamiast tworzenia nowego wolumenu
wdrożono [sondę/bramkę właściwości](../../guides/storage-capability-gate.md).
Testy: 75 runner PASS + 16 capability OK (5 pominiętych na Windows).
Żywe próby source/artifact przeszły, build odrzucony z powodu braku case
sensitivity. Próba włączenia flagi w nowym pustym katalogu NTFS otrzymała
Access denied; WinAPI potwierdziło brak flagi. Nie zmieniono ACL ani nie
utworzono wolumenu. Dalsza kwalifikacja build/FEM wymaga rozstrzygnięcia tej
konkretnej właściwości, nie samej nazwy ext4. Poniższy opis pytania o wolumen
jest historycznym checkpointem sprzed tej zgody.

Bezpośredni odczyt `stat -f -c %T /source /build /artifacts` w rzeczywistym
workerze zwrócił trzy razy **v9fs**. Obecny guard managed FEM wymaga loop-backed
ext4 oraz dowodu backing storage. Nie wolno przestawić etykiety lub ominąć guarda.

Operator otrzymał pytanie o zgodę na kontrolowany wolumen Docker Desktop dla
buildów Linux, z indeksem i eksportem do obecnego storage. Jest to rozszerzenie
obecnego kontraktu, który lokuje kontrolowane buildy pod storage projektu.
Nie utworzono takiego wolumenu, nie przeniesiono dysku Docker Desktop i nie
zmieniono ADR 0030 ani bramki kwalifikacji. Decyzja pozostaje do rozstrzygnięcia.

To checkpoint częściowej implementacji, nie zakończenie zatwierdzonego zakresu.
Nie wykonano push, PR, merge ani cleanup worktree tego zadania. Po decyzji
storage następnym krokiem jest adapter i jego kontrakt/attestation, następnie
execution context, managed worker stage oraz rzeczywiste bramki FEM/GitHub.

## Pozostaje

- Prywatny writable execution context bez fałszowania `.git`, build Fullmaga,
  zgodność capsule identity z runtime source-snapshot v2.
- Zaufany worker stage istniejącej recepty managed FEM, obraz z toolchainem
  i runtime bundle oraz semantyka kwalifikacji dirty snapshotów.
- Uwierzytelnienie/ACL i zaufany koordynator; sam owner w SQLite nie jest autoryzacją.
- Wspólne leases z istniejącymi launcherami i resolverem.
- Walidacja adaptera Windows Docker Desktop/ext4 i rzeczywista kwalifikacja FEM.
- Ephemeral GitHub runner, polityka zaufania PR, rejestracja i artefakty.
- Rzeczywiste crash/restart i GPU, końcowe review, PR/integracja/cleanup.

## Ograniczenia

Nie uruchomiono runnera GitHub ani nie nadano etykiety fem-managed.
Obecny komponent kolejki nie buduje jeszcze Fullmaga. Blokady SQLite nie
zastępują kontroli istniejących procesów, GPU i blokad storage.
W chwili inwentaryzacji działał kontener FEM zadania sp4-windows-launch-fix;
nie wolno go usuwać/przerywać w ramach tego wdrożenia. Ponowna kontrola jest
wymagana przed jakimkolwiek GPU run. Cudzy dirty checkout pozostaje zachowany.
