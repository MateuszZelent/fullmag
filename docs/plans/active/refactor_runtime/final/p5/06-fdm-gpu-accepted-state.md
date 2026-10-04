# P5-C — accepted state prostego FDM GPU

Data: 29.09.2026

Status: **SOURCE/UNIT PASS / MANAGED CUDA REQUALIFICATION NOT VERIFIED**.

## Wynik

Prosty lane FDM GPU emituje terminalny
`fullmag.fdm.gpu.accepted-state-snapshot.v1`. Snapshot powstaje po końcowym
odczycie magnetyzacji z urządzenia i wiąże:

- zaakceptowany krok, czas fizyczny i dodatni krok czasowy;
- kanoniczny digest kompletnej końcowej magnetyzacji `f64`;
- wspólne `clock_digest` i `state_digest` z `fullmag-quantities`.

Pusty lub niefinitywny nośnik jest odrzucany. Lane z M1/spin transport,
charge transport, Frozen Spins albo termicznym RNG nie publikuje częściowego
refa, ponieważ wymaga dodatkowych primary carriers.

Accepted worker wybiera snapshot według immutable requested device. Dla GPU
buduje ten sam `AcceptedStateRef`, zapisuje go w completed receipt i manifeście
outputów v2, wymaga exact match podczas recovery i udostępnia przez istniejący
GET run. Nie ma ścieżki CPU fallback.

## Weryfikacja

- TDD buildera i walidatora snapshotu GPU: **2/2 PASS**;
- pełny zestaw regresji accepted state runnera: **12/12 PASS**;
- produkcyjny `cargo check` runnera i API: **PASS**;
- regresja publicznego Submit/replay/readback API: **1/1 PASS**;
- składnia rozszerzonej bramki
  `verify_accepted_fdm_gpu_runtime.py`: **PASS**;
- spójność diffu: **PASS**.

Zarządzana bramka została rozszerzona o wymaganie publicznego refa z dokładnym
RunId, stage i ownership epoch. Nie została wykonana, ponieważ
`just runner-container-status` kończy się błędem
`Docker Desktop coordinator request failed`. Dlatego rzeczywiste wykonanie
nowego snapshotu CUDA, receipt, manifest i publiczny readback pozostają
**NOT VERIFIED** dla tego przyrostu.

## Granica dowodu

Zmiana obejmuje wyłącznie prosty, nietermiczny FDM GPU. Coupled/M1, charge
transport, Frozen Spins, termiczne RNG, multilayer, FEM CPU/GPU,
`ObservationRuntime`, checkpoint compatibility i kwalifikacja wydania
pozostają otwarte.

P5 rośnie do **95%**. Cały plan pozostaje około **49%**.
