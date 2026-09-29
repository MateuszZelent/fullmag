# P5-C — fail-closed checkpoint compatibility

Data: 29.09.2026

Status: **SOURCE/HTTP PASS / GENERAL EXACT RESUME NOT QUALIFIED**.

## Wynik

Klasyfikacja checkpointu nie uznaje już brakujących pól po obu stronach za
zgodność. `ExactResume` wymaga niepustych i identycznych:

- identyfikatorów problemu, planu, schematu stanu, study, dyskretyzacji i
  layoutu pola;
- ABI restartu, engine, runtime family oraz precyzji;
- materialnego `backend_state_ref` w publicznej ścieżce restore.

Różna realizacja runtime przy zgodnym problemie, planie i stanie daje co
najwyżej `LogicalResume`. Sama dyskretyzacja i layout pola dają wyłącznie
`InitialConditionImport`. Puste metadane dają `ConfigOnly`.

Publiczny restore bieżącego live runtime'u przyjmuje tylko `ExactResume`.
Checkpoint magnetyzacji bez kompletnego stanu algorytmicznego jest widoczny
jako import initial condition, ale próba restore kończy się konfliktem przed
zmianą kroku, czasu, magnetyzacji lub wersji live state.

Obecny wąski producent `ExactResume` pozostaje ograniczony do kompletnego
`fullmag.fdm.coupled_m3_checkpoint.v1`. Jego kompatybilność wiąże także
kanoniczny digest tożsamości coupled, gdy aktywna sesja nie ma jeszcze
materialnego `SceneDocument`.

## Weryfikacja

- TDD klasyfikatora session: początkowo **3/3 FAIL**, po zmianie **3/3 PASS**;
- pełny checkpoint coupled M3 capture/restore: **1/1 PASS**;
- magnetization-only downgrade i odmowa restore bez mutacji: **1/1 PASS**;
- produkcyjny check `fullmag-session` i `fullmag-api`: **PASS**.

## Granica dowodu

Zmiana nie implementuje nowego `LogicalResume`, ogólnego `ExactResume`,
checkpointów FDM GPU/FEM ani `ObservationRuntime`. Frozen Spins, zwykły FDM,
autosave frames i nieznane payloady nie są promowane do exact resume.

P5 rośnie do **96%**. Cały plan pozostaje około **49%**.
