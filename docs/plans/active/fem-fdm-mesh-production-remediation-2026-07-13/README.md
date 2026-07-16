# FEM/FDM mesh production remediation — indeks planów

**Data:** 2026-07-13
**Status:** Draft / active
**Źródło:** [audyt produkcyjny](../../../reports/2026-07-13/fem-fdm-mesh-production-audit/README.md)
**Liczba planów:** 60, po jednym dla każdego stabilnego findingu

Ten katalog nie ustanawia nowej fizyki ani drugiej architektury. Plany są
podporządkowane `docs/physics/0100`, `0105`, `0600`, `0800`, ProblemIR,
capability matrix i resource-first API v2. Implementacja problemu zmieniającego
fizykę lub numerykę zaczyna się od aktualizacji właściwej noty w `docs/physics/`.

## Porządek wykonania

| Fala | Cel | Plany |
|---|---|---|
| 0 | zamrozić kontrakt i fail-closed legality | MESH-FDM-001..007; MESH-FEM-001..002; MESH-PBC-FEM-002; MESH-PBC-FDM-001; MESH-REGION-001,004,008..011 |
| 1 | poprawić generatory i backend parity | pozostałe MESH-FEM i MESH-PBC-FDM; MESH-PBC-FEM-003..006; MESH-REGION-002,003,005,007 |
| 2 | zachować raporty, artefakty i API identity | MESH-FEM-003; MESH-PBC-FDM-006; MESH-API-001..004; MESH-REGION-006,012,015,016 |
| 3 | zamknąć authoring, Inspectory i viewport | MESH-UI-001..008; MESH-REGION-013,014,017 |
| 4 | zamknąć dowód fizyczny i promocyjny | MESH-PBC-FEM-001; MESH-GATE-001..004 |

Plany w jednej fali można wykonywać równolegle tylko wtedy, gdy nie dotykają tych
samych plików. Zmiany w `ProblemIR`, capability matrix, `artifacts.rs`, OpenAPI i
`justfile` wymagają sekwencyjnego review.

## Zasady wspólne dla wszystkich planów

- TDD: najpierw test, który odtwarza konkretny finding, potem minimalna naprawa.
- Brak cichych fallbacków; unsupported lub niecertyfikowane konfiguracje kończą
  się stabilnym kodem błędu i actionable reason.
- Requested intent oraz resolved runtime są przechowywane oddzielnie.
- FEM/MFEM/CUDA/hypre/libCEED jest budowane i weryfikowane przez repozytoryjne,
  container-backed recipe `just`; host build jest tylko diagnostyczny.
- Zmiana API przechodzi: schema/OpenAPI -> wygenerowany transport -> facade ->
  resource hook -> UI consumer -> HTTP snapshot/WS invalidation test.
- Każda zmiana `apps/control-room` przechodzi typecheck, lint z zerem ostrzeżeń,
  testy; viewport dodatkowo realny browser/WebGL smoke.
- Nie wolno uznać planu za zakończony na podstawie samego source inspection lub
  rozpoczętego kontenera. Sekcja evidence w planie musi zawierać komendę, wynik i
  ścieżkę do artefaktu.
- Przed każdym wdrożeniem należy ponownie sprawdzić `git status --short`; bieżący
  audyt był wykonywany na współdzielonym brudnym worktree.

## Powiązane istniejące plany

- [FEM meshing production readiness](../fem-meshing-production-readiness-plan-2026-05-30.md)
- [Mesh system holistic audit and repair](../mesh-system-holistic-audit-and-repair-plan-2026-05-30.md)
- [FEM adaptive mesh refinement](../fem-adaptive-mesh-refinement-plan.md)
- [Canonical mesh management UI](../mesh-management-ui-production-masterplan-2026-06-06-pl.md)
- [Model builder round-trip](../model-builder-roundtrip-study-universe-plan-2026-03-31.md)
- [FDM multilayer convolution rollout](../fdm-multilayer-convolution-rollout.md)
- [FEM PBC/Bloch/airbox](../fullmag_pbc_fem_bloch_airbox_plan.md)
- [FMR k=0 PBC/GPU readiness](../fmr-k0-pbc-gpu-readiness-plan-2026-06-28-pl.md)
- [Target certificate v6](../fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md)

## Indeks

Pliki są nazywane `<finding-id>-<slug>-implementation-plan.md`. Kompletną macierz
z priorytetem, opisem i linkiem do każdego pliku zawiera
[raport audytu](../../../reports/2026-07-13/fem-fdm-mesh-production-audit/README.md#macierz-problemów-i-planów-naprawczych).
