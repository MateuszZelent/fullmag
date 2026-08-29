# Plan: DoD, ownership, test matrix i reguły

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md` z 2026-08-29. Zakres oryginalnych linii: 735–860.

## 5. Definicja ukończenia (DoD)

| ID | Kryterium |
|---|---|
| DOD-01 | fresh checkout na Linux i Windows |
| DOD-02 | clean build CPU z pinned toolchain |
| DOD-03 | size-safe ABI vNext i generated bindings |
| DOD-04 | recomputed LinearizationCertificate |
| DOD-05 | rzeczywista tangent mass i domain identity |
| DOD-06 | brak dense-first na production CPU |
| DOD-07 | poprawny target/reformulacja wartości własnej |
| DOD-08 | full descriptor residual każdego moda |
| DOD-09 | selected-only i complete-window rozdzielone |
| DOD-10 | niezależny WindowCertificate |
| DOD-11 | realny MFEM Poisson-airbox E2E |
| DOD-12 | Kittel + antidot + mesh/airbox convergence |
| DOD-13 | atomic scientific artifacts i FMS restart |
| DOD-14 | Control Room na typed resources |
| DOD-15 | 60 s live WebGL proof |
| DOD-16 | production PETSc/SLEPc CUDA lane |
| DOD-17 | profiler-backed residency/no fallback |
| DOD-18 | CPU/GPU frequency/residual/subspace parity |
| DOD-19 | immutable release manifest |
| DOD-20 | zielone CI przed i po merge |

## 6. Dozwolona równoległość i ownership

| Lane | Może pracować nad | Nie może zmieniać |
|---|---|---|
| L0 integrator | branch, shared schema, candidate | fizyka bez review właściciela |
| L1 physics | certificate, terms, mass, PBC | ABI/UI/GPU lifecycle |
| L2 CPU numerics | SLEPc, KSP, window | GPU implementation, UI |
| L3 Poisson | airbox assembly, gauge, Schur | API status semantics |
| L4 artifacts/API | schemas, FMS, resources | solver decisions |
| L5 UI | Results/viewport/browser | qualification computation |
| L6 GPU | PETSc CUDA, residency, profiler | model fizyczny zatwierdzony w Q1 |

Zasady:

- wspólne nagłówki i schema mają jednego ownera;
- native build/GPU device są serializowane;
- agent nie może sam zatwierdzić własnego P0;
- generated files powstają tylko kanonicznym generatorem;
- każdy lane dostarcza source-map i negative tests.

## 7. Zalecane batch'e commitów

1. `repo: repair invalid symlinks and clean checkout`
2. `docs: freeze FEM K0 physical and engine contracts`
3. `abi: add size-safe modal eigensolve vNext`
4. `physics: add recomputed linearization certificate`
5. `fem: assemble real tangent mass and domain identity`
6. `fem: separate bounded dense oracle from sparse production`
7. `cpu: correct SLEPc spectral formulation and full residual`
8. `cpu: implement certified complete-window engine`
9. `fem: add real Poisson-airbox shared-domain assembly`
10. `artifacts: publish atomic modal scientific resources`
11. `fms: qualify restart round-trip`
12. `ui: restore typed spectrum and complex mode viewport`
13. `gpu: add persistent PETSc/SLEPc CUDA modal engine`
14. `qualification: add Q1/Q2/Q3 immutable receipts`
15. `release: promote verified candidate`

Każdy commit ma być bisectable i nie może łączyć refaktoru z nowym scientific claimem.

## 8. Test matrix

| Poziom | Przykład | Cel |
|---|---|---|
| Unit | enum, ABI prefix, frame, mass | lokalna poprawność |
| Algebraic oracle | 2×2/małe dense | znak, residual, descriptor |
| Element | Tet4/Prism6 | assembly |
| Real small mesh | film + airbox | integration |
| Scientific | Kittel | fizyka |
| Canonical | antidot window | produkt |
| Convergence | mesh/airbox | niezależność dyskretyzacji |
| Robustness | stale/cancel/corrupt | fail-closed |
| Performance | 3 rozmiary | asymptotyka |
| GPU | profiler + parity | Q2 |
| FMS/API | restart + revisions | transport |
| Browser | live WebGL | Q3 |

## 9. Stop-the-line rules

Natychmiast zatrzymać promocję, gdy:

- clean checkout lub CI baseline jest czerwone;
- dowolny production route wchodzi w dense oracle;
- `m0` jest modyfikowane bez nowego certyfikatu;
- request tolerance jest luzowana;
- `complete=true` nie ma certificate ID;
- engine/lane nie jest jednoznaczny;
- profiler wykrywa host fallback lub transfery per matvec;
- UI wyprowadza qualification lokalnie;
- artifact identity nie zgadza się między spectrum i mode field;
- po zamrożeniu candidate zmienił się kod, generator lub recipe.

## 10. Najkrótsza realistyczna ścieżka dostarczenia

```text
F0 checkout
→ F1 konsolidacja
→ F2 ABI/status
→ F3 równowaga
→ F4 sparse operator
→ F5 CPU nearest
→ F6 complete window
→ F7 real airbox + Q1
→ F8 artifacts/FMS
→ F9 UI + Q3
→ F10 GPU + Q2
→ F11/G2
```

Nie należy równolegle „dokańczać UI” i „dostrajać GPU”, dopóki F2–F7 nie zamrożą
znaczenia wyniku. W przeciwnym razie powstanie kolejna fala kodu poprawnie renderującego
lub przyspieszającego niekwalifikowane dane.

## 11. Decyzja implementacyjna

Najważniejszym produktem kolejnej iteracji nie powinien być „więcej funkcji”, lecz:

> **jeden mały, jawnie ograniczony, sparse CPU K0 solver z pełnym residualem i prawdziwym
> complete-window certificate na realnym mesh+airbox.**

Dopiero ten produkt jest stabilnym oracle'em dla GPU, artefaktów i Control Room.
