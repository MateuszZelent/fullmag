# Frozen Spins — audyt postępu wdrożenia

**Data:** 2026-08-31  
**Repozytorium:** `C:\git\fullmag\fullmag`  
**Baza audytu:** `ab3c8802a691a535063102c12f9a79bb0043b367`  
**Bieżący HEAD checkoutu:** `532e99c042049140e7ed1eec1a407f3c2672deed`  
**Plan normatywny P0–P16:** [`2026-08-29-frozen-spins-production-completion-plan.md`](../superpowers/plans/2026-08-29-frozen-spins-production-completion-plan.md)

## Werdykt

Implementacja funkcjonalna Frozen Spins jest wykonana, a brakujący dowód
cross-discretization/refinement został uruchomiony i niezależnie zwalidowany.
Release nie jest jeszcze kwalifikowany: bieżący checkout jest brudny, więc nie
można wystawić wspólnej tożsamości źródła ani ważnego zestawu receiptów P16.
Ostatni capture `artifacts/qualification/frozen-spins/source-baseline.json`
ma `git_dirty=true` oraz `git_sha=532e99c042049140e7ed1eec1a407f3c2672deed`;
jest dowodem blokady, nie zatwierdzonym baseline'em release. Snapshot ID i
hashe artefaktu pozostają w pliku JSON, ponieważ zmieniają się przy każdej
zmianie checkoutu.

Nie ma jednej uczciwej średniej procentowej. Procenty poniżej są rozdzielone na
osie implementacji, dowodu runtime i formalnej kwalifikacji.

## Status osi i procenty

| Oś | Wynik | Procent | Znaczenie |
|---|---:|---:|---|
| Implementacja kontraktu Frozen Spins | wdrożona | **100%** | IR/Python, planner, FDM CPU/CUDA, FEM CPU/GPU, checkpoint/resume, API, quantity i Control Room są w kodzie i mają testy/receipty runtime |
| Zakres V1 | 28 `REQUIRED` + 1 `OUT_OF_SCOPE` | **100%** | scope revision 2 przechodzi walidator i 5 testów |
| Naukowe case ID P15 wykonane | 13/13 | **100% wykonania** | dowody runtime/materialization istnieją; performance pozostaje osobną bramką |
| Cross-discretization reference runtime | 6/6: FDM/FEM × coarse/medium/fine | **100%** | produkcyjne compilery plannerów, rzeczywisty krok Heun, zero-ULP restore, free mobility, finite energy, parity i brak fallbacku |
| Browser/WebGL | 2/2: FDM CPU + FEM serial P1 | **100%** | pełny `create → Preview → Commit → solve → quantity 3D → rendered ACK` |
| Managed FDM CUDA | PASS | **100% dla wykonanego runu** | RTX 4080 SUPER, FP64/FP32, 5 integratorów, checkpoint i hot-rebuild; snapshot jest izolowany |
| Formalne receipt'y P16 | 0/60 ważnych w bieżącym checkoutcie | **0% kwalifikacji release** | brak zatwierdzonego clean source identity i wspólnego immutable receipt setu |

`100%` na osi implementacji/runtime nie oznacza `QUALIFIED`. Status globalny
pozostaje `RUNTIME_CONFIRMED / RELEASE QUALIFICATION INCOMPLETE` oraz
`qualification_status=UNQUALIFIED`.

## Zamknięte etapy

- **P0:** scope revision 2, jawne polityki i przypadek out-of-scope.
- **P1–P2:** generator source identity, fail-closed evidence ledger i agregator.
- **P3–P6:** capability/fail-closed routing, aktywacja i re-aktywacja, snapshot
  referencji, ExactResume oraz proweniencja.
- **P7:** FDM CPU single-grid oraz multilayer; CPU multilayer ma teraz stanową
  historię ABM3 i walidowany checkpoint/resume.
- **P8–P12:** FDM CUDA i FEM CPU/GPU; w FEM referencyjnym zamrożenie jest
  aktywowane przed krokiem, maskuje cały złożony RHS i przywraca referencję po
  każdym podkroku dla Heun/RK4/RK23/RK45/ABM3.
- **P13–P14:** API v2, solver-owned certificate, `frozen_spins` jako
  standardowe `spatial_scalar`, Preview→Commit, Inspector i carrier FEM.
- **P15:** browser/WebGL, Preview↔Solver parity, CPU↔CUDA parity oraz
  cross-discretization/refinement reference runtime.

## Dowody wykonane w ostatnim przebiegu

Recepta:

```text
just verify-frozen-spins-cross-discretization-runtime
```

Wynik: `PASS`, 11 testów Python, 6 wierszy runtime.

- wejście: [`frozen-spins-cross-discretization-runtime-v1.json`](../../artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-v1.json), SHA-256 `6AF022660566F0C9028B065BE6784F8DAE9158F2D8DC9316D2CFF2CA844CA5F6`;
- evidence: [`frozen-spins-cross-discretization-runtime-evidence-v1.json`](../../artifacts/qualification/frozen-spins/cross-discretization/frozen-spins-cross-discretization-runtime-evidence-v1.json), SHA-256 `38CD65E050E7D4D30143351FFE95B5B4FB70112BAAC18EC7D0023AABE48BA3BA`;
- walidator odrzuca niezerowy drift ULP, fallback, brak wiersza, niefinitywną
  energię, brak free mobility i niespójność parity;
- dodatkowa regresja all-frozen materializuje próbki `OutputIR` w `t=0`, czasach
  pośrednich i `t_end` bez wykonywania sztucznych kroków solvera.

Kontrole kodu:

- celowane testy runnera Frozen FEM: `PASS`;
- managed runner CPU multilayer: `29 passed / 0 failed` oraz planner ABM3
  `1 passed / 0 failed` (łącznie `30/30`), w tym pełny ABM3 Frozen Spins
  checkpoint/resume z bitową zgodnością biegu ciągłego;
- receipt managed: [`fdm-frozen-spins-multilayer-v1.json`](../../artifacts/qualification/frozen-spins/fdm-multilayer/fdm-frozen-spins-multilayer-v1.json), SHA-256
  `44D3C0834ECF2A93EE01CB990141E622E2E1B9A89F84B2CDBD62045EE3C25766`;
- `cargo test -p fullmag-engine fem`: `PASS`;
- `cargo test -p fullmag-ir`: `PASS`;
- izolowane testy Control Room quantity/overlay/carrier/Inspector: `6 files,
  275 tests PASS` (uruchomione lokalnym `vitest`, ponieważ wrapper `pnpm`
  odrzucił niezweryfikowany podpis registry);
- `git diff --check`, rustfmt i 16 testów walidatorów Python: `PASS`;
- `just verify-frozen-spins-authoring`: `PASS`;
- `just verify-frozen-spins-qualification`: `FAIL-CLOSED` na wymaganym clean
  source gate (`SOURCE_IDENTITY_ERROR`), przed uruchomieniem agregatora;
- pełny `cargo test -p fullmag-runner --lib`: `1016 passed / 22 failed / 0 ignored`;
  22 błędy pochodzą z innych zmian bieżącego dirty tree (w tym kaskady
  zatrutych mutexów) i nie są promowane jako dowód Frozen Spins.

## Co jeszcze trzeba wykonać

1. **P1/P16 — clean source tree:** uzgodnić zakres zmian, przygotować jeden
   zatwierdzony qualification tree i uruchomić
   `just verify-frozen-spins-clean-source`. Obecny wynik jest jawny:
   `SOURCE_IDENTITY_ERROR=qualification source tree is dirty`.
2. **P8/P15 — managed CPU multilayer receipt:** wykonane. Recepta
   `just verify-frozen-spins-fdm-multilayer` w obrazie `fem-cpu` przeszła
   `29 + 1 = 30/30` testów i zapisała trwały receipt z invariant, wpływem
   frozen→free, wszystkimi krokami Heun/RK4/RK23, ABM3 checkpoint/resume oraz
   fail-closed CUDA multilayer v2. Receipt jest potwierdzeniem runtime w tym
   checkoutcie, ale musi zostać powtórzony na tym samym zatwierdzonym clean
   source identity, aby wejść do P16.
3. **P15 — managed native cross-lane:** powtórzyć cross-discretization dla
   autorytatywnych managed FDM/FEM CPU/GPU, z device/precision/build manifestem,
   bez CPU fallbacku i bez transferów per-step.
4. **P15 — performance/transfer:** wykonać wymagane profile overheadu, pamięci,
   H2D/D2H i macierzy 4096/1M sites; nie używać supplemental CPU benchmarku jako
   zamiennika globalnej kwalifikacji.
5. **P16 — 60/60 receiptów:** każdy receipt musi wskazywać tę samą source
   identity, immutable evidence ID, recipe, runtime manifest, device/precision
   i wynik `PASS`; następnie uruchomić agregator
   `just verify-frozen-spins-qualification`.
6. **Release review:** dopiero po agregatorze `60/60` można podjąć decyzję
   `QUALIFIED`; commit/push/release pozostają osobną decyzją właściciela.

## Pliki wykonawcze

- [Plan P0–P16](../superpowers/plans/2026-08-29-frozen-spins-production-completion-plan.md)
- [Macierz kwalifikacyjna](../validation/frozen-spins-qualification-matrix.md)
- [Runtime probe FDM/FEM](../../crates/fullmag-runner/examples/frozen_spins_cross_discretization_runtime.rs)
- [Fail-closed validator runtime](../../scripts/build_frozen_spins_cross_discretization_runtime_evidence.py)
- [Testy validatora](../../scripts/test_build_frozen_spins_cross_discretization_runtime_evidence.py)
