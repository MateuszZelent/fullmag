# P5-C — trwały `AcceptedStateRef` prostego FDM CPU

Data: 28.09.2026

Status: **SOURCE/IN-PROCESS PASS / PUBLIC API I MANAGED RUNTIME NOT VERIFIED**.

## Wynik

`fullmag-api-accepted-worker` odczytuje terminalny snapshot
`fullmag.fdm.cpu.accepted-state-snapshot.v1` z prywatnego katalogu attemptu i
wiąże go z immutable accepted inputem. Powstający `AcceptedStateRef` zawiera:

- `run_id` oraz `stage_id` dokładnego claimu i kroku study;
- accepted step, `clock_digest` i `state_digest` ze snapshotu runnera;
- `domain_digest` równy zweryfikowanemu fingerprintowi accepted preparation;
- `plan_digest` kanonicznego zestawu `ProblemIR`, resolved `ExecutionPlanIR` i
  requested execution, zapisany jako `sha256:<64 lowercase hex>`;
- generację runtime'u z ownership epoch oraz accepted revision równą
  terminalnemu accepted step.

Referencja jest częścią immutable
`worker_execution_completed.v1.json`. Recovery najpierw odczytuje i waliduje
snapshot, następnie wymaga dokładnej zgodności refa z receiptem. Publikacja po
zakończeniu workera ponownie odtwarza completed receipt i porównuje zarówno
typed outputs, jak i `AcceptedStateRef`; rozbieżność blokuje efekt. Historyczny
receipt bez refa pozostaje czytelny i może zostać odtworzony tylko wtedy, gdy
nie ma odpowiadającego mu snapshotu.

Odczyt zagnieżdżonego artefaktu pozostaje ograniczony do skanonizowanego rootu
prywatnego attemptu. Symlink lub ścieżka wychodząca poza root jest odrzucana.

## Weryfikacja

- `cargo check -p fullmag-api --bin fullmag-api-accepted-worker`: **PASS**;
- filtrowane regresje snapshotu runnera: **2/2 PASS**;
- procesowy scenariusz accepted submit → worker → completed receipt → recovery
  bez live session: **1/1 PASS**;
- scenariusz potwierdza `run_id`, `stage_id`, ownership epoch, accepted
  revision oraz prefiksowane digesty planu i domeny;
- `git diff --check` i kontrola spójności repozytorium są wymagane przed
  commitem tego przyrostu.

## Granica dowodu

Materializacja dotyczy wyłącznie prostego FDM CPU bez coupled spin transportu
i Frozen Spins. Te konfiguracje pozostają fail-closed, ponieważ wymagają
dodatkowych primary carriers. FDM GPU, FEM CPU/GPU, publiczny zasób API,
`ObservationRuntime`, checkpoint compatibility, restart całego procesu solvera
oraz managed qualification pozostają **NOT VERIFIED**.

P5 rośnie konserwatywnie do **93%**. Cały plan pozostaje około **49%**.
