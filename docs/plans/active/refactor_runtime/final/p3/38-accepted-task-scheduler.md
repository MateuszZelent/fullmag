# P3-B/P5-B — ograniczony scheduler accepted task

Data checkpointu: 27.09.2026. Commit implementacji: `master@4c26e584f40dcb8afcf2f2a65881e532898ffbea`.

## Zrealizowany kontrakt

`fullmag-api-accepted-scheduler` wykonuje ograniczoną liczbę przebiegów dla jednego immutable `RunId` i jednej jawnie przekazanej oferty zasobu. W kolejności zaakceptowanego `StudyPlan` wybiera pierwszy enabled/planned task, który:

- pozostaje w scheduler-owned `Accepted/Blocked` albo w nieprzypisanym `Queued/Ready`;
- ma wszystkie wymagane wejścia `StepOutput` zakończone sukcesem i odtwarzalne z trwałego manifestu;
- pasuje do requested/resolved device lane;
- przechodzi durable admission bez cichego fallbacku urządzenia.

Scheduler publikuje kolejno trwałe `Prepare`, workerowe `Prepared` i `Start`. `Start` zostaje zapisany jako pending w `DurableWorkerInbox` przed uruchomieniem istniejącego supervisora. Awaria procesu po tej granicy trafia do dotychczasowej rekonsyliacji pending effect.

Retry zachowuje poprzedni `ownership_epoch` w kolejce. Ponowne queue/admission jest dopuszczone wyłącznie, gdy istnieje dokładnie jedna trwała decyzja `Retry` dla tego taska i epochu; następny claim zwiększa epoch o jeden. Brak decyzji, wiele decyzji albo pominięty epoch kończą się fail-closed.

## Weryfikacja

- `just verify-api-accepted-scheduler-e2e`: **1/1 PASS**, receipt `557b3400e25045e59652836afe4efd97`;
- `just verify-api-accepted-scheduler-retry-e2e`: **1/1 PASS**, receipt `c4ea19ef2b674713aa56be5ae8eb30a8`;
- `just check-api-source`: **PASS**, receipt `48ac1e104f0447ac89977899ae2e46a6`;
- regresja `just verify-api-accepted-supervisor-retry-recovery-e2e`: **1/1 PASS**, receipt `def707d1d0c841f2b95e56fb59edbd88`;
- routing i release-contract Python: **35/35 PASS**;
- scheduler jest wymagany przez portable bundle, jego validator i Windows MSI; parser PowerShell: **PASS**;
- `python -m py_compile`, `cargo metadata --locked --no-deps` i `git diff --check`: **PASS**.

Pierwszy E2E przechodzi od `Accepted/Blocked` przez queue, admission, worker, CAS/manifest i terminalny `Succeeded`, a następnie potwierdza brak aktywnego lease. Drugi wymusza awarię workera przed side effect, potwierdza durable `Retry`, wykonuje nową próbę z `ownership_epoch = 2` i kończy ją sukcesem z artefaktami.

## Granica dowodu

To jest bounded scheduler jednego runu i jednej oferty zasobu. Nie jest usługą rezydentną ani pulą: nie ma wielorunowej fairness, dynamicznego discovery zasobów, kolejek priorytetowych, backpressure między hostami ani zdalnych ACK heartbeat/Stop. Wymagane authored/pinned/continuation inputs pozostają zablokowane bez osobnego resolvera. Process E2E obejmuje nadal tylko FDM CPU/double/strict.

Otwarte pozostają orphan reconciliation sprzed trwałej decyzji retry, transport zdalny, pula zasobów, pozostałe lane'y i kwalifikacja release. Ten przyrost podnosi P3 do około **72%**, P5 do około **34%**, a cały plan do około **34%**.
