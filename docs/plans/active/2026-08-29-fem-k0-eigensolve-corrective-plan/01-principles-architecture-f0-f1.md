# Plan: zasady, architektura, F0–F1

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md` z 2026-08-29. Zakres oryginalnych linii: 1–201.

# Plan naprawczy i domknięcia FEM K0 eigensolve CPU/GPU

**Data:** 2026-08-29  
**Punkt bazowy audytu:** `master` `9d7bd3191959513ad31879a9c5ccecaa48e28558`  
**Dokument powiązany:** `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md`  
**Cel:** dostarczyć jeden odtwarzalny produkt: poprawny fizycznie FEM K0 eigensolve CPU,
następnie produkcyjny GPU, artefakty/API/FMS i Control Room, związane jednym immutable candidate.

## 1. Zasady realizacji

1. **CPU Q1 jest pierwszym produktem.** GPU nie może definiować fizyki ani być oracle'em dla CPU.
2. **Oracle i produkcja mają osobne engine ID, pliki, targety i statusy.**
3. **Nearest i complete window są osobnymi produktami.**
4. **Nie ma cichego fallbacku, renormalizacji, luzowania tolerancji ani zmiany konwencji.**
5. **Każdy claim wynika z typowanego certyfikatu backendu, nie z UI ani diagnostycznego JSON.**
6. **Production lane nie może alokować `O(N²)` pamięci dla sparse FEM.**
7. **Każdy dowód jest ważny tylko dla jednego `commit_sha + tree_sha + runtime + input`.**
8. **Zmiana źródła, generatora, ABI, recipe lub parametrów kwalifikacji unieważnia późniejsze receipt'y.**
9. **Brak dowodu oznacza `NOT_VERIFIED`, nie „prawdopodobnie działa”.**
10. **Do `master` trafia dokładnie zweryfikowany candidate, bez ręcznych poprawek po kwalifikacji.**

## 2. Docelowy, ograniczony scope pierwszego wydania

### 2.1. W zakresie CPU K0 MVP

- FEM, `k=0`, `alpha=0`;
- `m0` z kwalifikowanego stanu równowagi;
- wymiana jednorodna i regionowa, Zeeman, wspierane anizotropie;
- dynamiczny demag przez certyfikowany wspólny magnetyk–airbox;
- P1 Tet4 i Prism6 tylko tam, gdzie assembly jest zweryfikowane;
- pure Neumann + mean-zero gauge jako pierwszy, jawny wariant Poissona;
- selected nearest-frequency;
- complete frequency window jako osobny engine/mode;
- pełne zespolone pola modów i full descriptor residual;
- CPU SLEPc jako oracle dla przyszłego GPU.

### 2.2. Poza pierwszym wydaniem, dopóki nie mają własnego DoD

- `alpha != 0`, damped non-Hermitian spectra;
- dowolne Robin/Dirichlet airbox BC;
- generic MFEM physics route bez pełnego Hessianu;
- PBC bez topologicznego certyfikatu;
- DMI/magnetoelastic/spin torque, jeśli nie mają jawnej pochodnej w operatorze;
- native CUDA dense oracle jako produkcyjny engine;
- UI opisujące pierwszy mod jako resonance;
- complete-window przez sekwencję nearest shifts bez count certificate.

## 3. Docelowa architektura

```text
ProblemIR / planner
        |
        v
LinearizationCertificate
(m0, H0, mesh, airbox, mass, physics, BC, frame, digests)
        |
        v
FEM K0 OperatorFactory
  |-- bounded_dense_oracle
  |-- production_cpu_sparse / MatShell
  `-- production_gpu_petsc_slepc   [po Q1]
        |
        v
Modal engines
  |-- nearest_selected
  `-- complete_region/window
        |
        v
Full descriptor verifier
        |
        v
Atomic scientific artifacts + manifest
        |
        v
Typed API / FMS / Control Room
```

### 3.1. Kanoniczne engine ID

| ID | Rola | Status docelowy |
|---|---|---|
| `bounded_dense_cpu_oracle` | mała algebraiczna referencja | validation-only |
| `synthetic_poisson_descriptor_oracle` | test pełnego descriptoru | validation-only |
| `cuda_bounded_dense_validation_oracle` | parity wybranych CUDA actions | validation-only |
| `slepc_cpu_nearest_v1` | selected frequency | production po Q1-nearest |
| `slepc_cpu_window_v1` | kompletne okno/region | production po Q1-window |
| `slepc_cuda_nearest_v1` | GPU selected | production po Q2 |
| `slepc_cuda_window_v1` | GPU complete window | późniejszy etap |

Stary string `production_gpu`, `gpu_dense_eigensolver` lub ogólne `validation` nie może
zastępować tych identyfikatorów.

## 4. Zależności faz

```text
F0 clean repository
 -> F1 recovery and source consolidation
 -> F2 contract/ABI freeze
 -> F3 equilibrium and identity
 -> F4 production sparse operator
 -> F5 CPU nearest
 -> F6 CPU complete window
 -> F7 real Poisson-airbox + convergence
 -> Q1 CPU

Q1 CPU
 -> F8 artifacts/API/FMS
 -> F9 Control Room + browser
 -> Q3 browser

Q1 CPU
 -> F10 production GPU
 -> Q2 GPU

Q1 + Q2 + Q3
 -> F11 immutable release + G2 merge
```

F8 może rozpocząć typed schema wcześniej, ale nie może zamrozić naukowych statusów przed F6/F7.
F9 nie może implementować własnej semantyki qualification. F10 nie może zmieniać modelu fizycznego
zatwierdzonego przez Q1.

---

## F0 — Naprawa repozytorium i odtwarzalnego checkoutu

**Priorytet:** P0  
**Zależności:** brak  
**Cel:** umożliwić fresh checkout i uruchomienie testów.

### Zadania

1. Usunąć/zastąpić puste symlinki:
   - `.claude/skills/*`;
   - `.worktrees`.
2. Dodać guard skanujący wpisy `120000` i odrzucający pusty target.
3. Ustalić politykę:
   - pliki narzędzi agenta nie są częścią runtime produktu;
   - lokalne worktree nigdy nie są wersjonowane.
4. Ponownie uruchomić wszystkie workflow dla jednego commita.
5. Zapisać baseline status i listę testów, które rzeczywiście zostały wykonane.

### Testy

- fresh clone/checkout Linux;
- checkout Windows z poprawną polityką symlinków;
- `git archive` i rozpakowanie;
- test pustego symlinku jako negative control.

### Bramka F0

- wszystkie joby przechodzą checkout;
- co najmniej workflow contract/bootstrap rzeczywiście uruchamia kroki testowe;
- branch jest clean i nie zawiera lokalnych build artifacts.

### Stop condition

Nie rozpoczynać kwalifikacji solvera, jeśli jakikolwiek runner nie może zmaterializować drzewa.

---

## F1 — Odzyskanie i kontrolowana konsolidacja źródeł

**Priorytet:** P0  
**Zależności:** F0  
**Cel:** jeden branch z aktualnego `master`, bez utraty unikalnych zmian rescue.

### Zadania

1. Zrobić pełny manifest:
   - zdalny rescue;
   - zdalny eigensolve-k0-demag;
   - każdy dostępny lokalny worktree/patch opisany w audycie historycznym.
2. Dla każdego pliku oznaczyć `KEEP`, `REBUILD`, `DROP`, `DOC_ONLY`.
3. Utworzyć nowy branch finalizacyjny z aktualnego `origin/master`.
4. Przenosić tylko logiczne batch'e:
   1. dokumentacja/model;
   2. IR/planner;
   3. ABI/certificates;
   4. CPU operator;
   5. CPU engines;
   6. GPU validation;
   7. artifacts/API/FMS;
   8. UI.
5. Po każdym batchu wykonać focused tests i niezależny review.
6. Nie kopiować całego starego worktree ani 364 staged plików jako jednego commita.

### Artefakty

- `docs/audits/eigensolve-source-recovery-manifest.md`;
- `docs/audits/eigensolve-range-diff.md`;
- machine-readable JSON z commitami i ścieżkami.

### Bramka F1

- każdy unikalny commit/patch ma decyzję;
- finalizacyjny branch jest clean;
- nie istnieje nieprzeniesiona funkcja wymagana przez scope MVP.

---
