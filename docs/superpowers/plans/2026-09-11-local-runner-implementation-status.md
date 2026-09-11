# Lokalny runner — stan wdrożenia

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
