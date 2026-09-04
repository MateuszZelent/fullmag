# Task 2: remediacja receipt FEM GPU

## VERIFIED

- `fullmag_fem_gpu_performance_snapshot_v2` oraz symbol ABI są już obecne w C headerze i `fullmag-fem-sys`; ABI v1 pozostało niezmienione.
- Runner odpytywał dotąd wyłącznie snapshot v1. Zmieniono go na symbol v2 i bezpośrednie odwzorowanie wszystkich 12 pól publicznego `FemGpuPerformanceSnapshotV2` (dwa pola nagłówka i dziesięć liczników/metadanych).
- Terminalna finalizacja dołącza `performance/fem_gpu_performance_snapshot.v2.json` tylko po poprawnym strict receipt i tylko dla `RunStatus::Completed`. Anulowanie i pauza nie odczytują ani nie publikują snapshotu.
- Produkcyjny attempt liczy setup, apply oraz accepted finalization wewnątrz aktywnego receipt attempt. Nie dodano synthetic fence: `compute_fence_count`, `snapshot_fence_count` i `export_fence_count` pozostają zerowe, jeśli nie wystąpił faktyczny fence.
- `apply_wall_time_ns` pozostaje czasem ściennym po stronie hosta dla rzeczywistego apply/enqueue asynchronicznych kerneli; nie jest deklarowany jako elapsed time GPU.
- Kontenerowy kontrakt `gpu-execution-receipt` przeszedł po `BuildMode=false`: CTest `fem_gpu_execution_receipt_contract` 1/1, ABI v2 `fullmag-fem-sys`, serializacja typu i artefaktu oraz trzy testy runnera z `--features fem-gpu` (mapowanie v2, strict Completed artifact, brak artifactu dla paused/cancelled/failed/non-strict).

## NOT VERIFIED

- Nie wykonano pełnej kwalifikacji runtime GPU ani benchmarku.

## Uruchomione polecenia

- `just verify-fem-gpu-execution-receipt-contract` — pierwsza próba wymagała dostępu do Docker Desktop; druga ujawniła niepełny cache Rustup, naprawiony przez retry.
- `scripts/windows/run_fullmag_fem.ps1 -BuildMode false -BuildOnly -Backend fem -Device gpu -Contract gpu-execution-receipt` — PASS. Zastosowano persistent `.fullmag-build/contracts/fem-gpu-execution-receipt` oraz `.fullmag-build/cargo-targets/fem-gpu-execution-receipt`.
