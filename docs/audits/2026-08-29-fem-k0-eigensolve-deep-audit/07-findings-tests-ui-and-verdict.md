# Audyt: testy, UI, werdykt i referencje

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 949–1121.

### TEST-01 — P0 — Contour i część SLEPc są kwalifikowane głównie na 2×2 makrospinie

**Klasyfikacja:** niewystarczające testy; **pewność:** potwierdzony.

**Dowód w implementacji.** Testy używają tiny algebraic fixtures; Poisson-airbox ma m.in. `q_dof_count=2`, `phi_dof_count=2` i macierze tworzone z dense.

**Dlaczego jest to błąd lub ograniczenie.** Toy problem nie ujawnia klastrów, PBC, conditioning, niejednorodnej masy, airbox coupling ani asymptotyki.

**Skutek.** D1/D2 bywa mylone z Q1.

**Naprawa.** Piramida testów: algebraic oracle → realny pojedynczy element → mały realny mesh → kanoniczny antydot → convergence mesh/airbox.

**Test akceptacyjny.** Każdy poziom ma osobny engine ID i nie zastępuje wyższego.


### TEST-02 — P0 — Brak świeżego kompletnego CPU window na obecnym source identity

**Klasyfikacja:** brak Q1; **pewność:** potwierdzony jako brak aktualnego dowodu.

**Dowód w implementacji.** Historyczny nearest/Kittel jest wartościowy, ale nie jest związany z bieżącym `master`; obecny CI nie dochodzi do testów.

**Dlaczego jest to błąd lub ograniczenie.** Nearest nie dowodzi kompletności, a stary receipt nie kwalifikuje nowego drzewa.

**Skutek.** Q1 pozostaje otwarte.

**Naprawa.** Po naprawie kodu uruchomić Kittel, full-window antydot, pełne residuale i convergence na jednym immutable candidate.

**Test akceptacyjny.** Receipt zawiera commit/tree/runtime/input i `window_complete=true` wyłącznie z niezależnym certyfikatem.


### TEST-03 — P0 — Brak profiler-backed GPU qualification

**Klasyfikacja:** brak Q2; **pewność:** potwierdzony jako brak aktualnego dowodu.

**Dowód w implementacji.** Obecny modalny CUDA kod jest bounded oracle; brak Nsight/PETSc trace pełnego eigensolve na realnym operatorze.

**Dlaczego jest to błąd lub ograniczenie.** Self-report nie dowodzi residency ani braku fallbacku.

**Skutek.** Q2 otwarte.

**Naprawa.** Dopiero po implementacji produkcyjnego adaptera: trzy rozmiary, parity CPU/GPU, peak memory, transfers, cancellation i sanitizery.

**Test akceptacyjny.** Niezależny profiler artifact związany z tym samym candidate.


### UI-01 — P0 — Control Room na `master` nie zawiera odnajdywalnego widma/eigenmode control opisanego historycznie

**Klasyfikacja:** brak konsolidacji funkcji; **pewność:** potwierdzony dla wyszukania na bieżącym `master`.

**Dowód w implementacji.** W `apps/control-room` wyszukiwanie `spectrum` i `eigenmode` zwraca 0 wyników; `ModeCompositionController` nie jest odnajdywany. Ogólne `modal` trafia w niezwiązane testy layout/footer.

**Dlaczego jest to błąd lub ograniczenie.** Historyczna obecność kodu na rescue/worktree nie jest obecnością w produkcie.

**Skutek.** U0–U2 nie mogą być uznane za zintegrowane na bieżącym `master`.

**Naprawa.** Odzyskać lub odtworzyć UI dopiero po zamrożeniu typed artifact API; wnieść jako osobny batch z generated client.

**Test akceptacyjny.** Unit model, API contract, browser E2E na rzeczywistych artefaktach.


### UI-02 — P0 — Brak świeżego live WebGL proof na tym samym candidate

**Klasyfikacja:** brak Q3; **pewność:** potwierdzony jako brak dowodu.

**Dowód w implementacji.** Nie istnieje aktualny browser receipt powiązany z `master`, CPU/GPU artifact identity i 60-sekundowym smoke.

**Dlaczego jest to błąd lub ograniczenie.** Testy modeli nie dowodzą poprawnego dekodowania pól zespolonych, cache invalidation ani stabilności kontekstu GPU.

**Skutek.** Q3 otwarte.

**Naprawa.** Live backend + API + browser: wybór moda, faza, komponenty, per-object ownership, restart FMS, context-loss monitor i memory/cache counters.

**Test akceptacyjny.** 60 s animacji, brak WebGL errors/context loss, niezerowy drawing buffer, stale revision odrzucona.

## 7. Ocena testów i twierdzeń produkcyjnych

### 7.1. Co można uczciwie twierdzić dziś

- Istnieje bounded algebraic proof dla części descriptoru i residuali.
- Istnieje CPU SLEPc adapter, który może znaleźć mody na małych problemach.
- Istnieją CUDA kernels potwierdzające wybrane działania operatora.
- Istnieją wartościowe historyczne wyniki Kittela i nearest antidot, lecz nie kwalifikują
  bieżącego `master`.
- Część API i provenance jest zaprojektowana w dobrym kierunku.

### 7.2. Czego nie wolno twierdzić

- „pełne spektrum w oknie” bez niezależnego window certificate;
- „produkcyjny sparse CPU” przy dense-first payload;
- „device-resident GPU eigensolve” przy ≤64 DOF oracle i transferach per apply;
- „scientifically qualified” na podstawie dostępności pola lub samego EPS residual;
- „zintegrowany Control Room” na obecnym `master`;
- „zielony runtime” przy checkout failure;
- „ten sam kandydat CPU/GPU/UI” bez wspólnego immutable manifestu.

### 7.3. Macierz brakujących dowodów

| Gate | Wymagany dowód | Stan |
|---|---|---|
| Repository baseline | fresh checkout + pełny CI start | FAIL |
| Linearization | recomputed, mass-weighted certificate | FAIL |
| CPU nearest | poprawny target i full descriptor residual | FAIL/PARTIAL |
| CPU full window | niezależny count/completeness | FAIL |
| Real Poisson airbox | real MFEM mesh assembly | FAIL |
| CPU convergence | mesh + airbox + cluster tracking | NOT VERIFIED |
| GPU residency | persistent object graph + profiler | FAIL |
| CPU/GPU parity | frequency + residual + subspace | NOT VERIFIED |
| FMS/API | atomic restart round-trip na tym samym candidate | NOT VERIFIED |
| Browser | 60 s live WebGL proof | FAIL/NOT PRESENT ON MASTER |

## 8. Zaktualizowany werdykt względem etapów planu

| Obszar | Ocena źródłowa | Ocena produkcyjna |
|---|---:|---:|
| Model i kontrakty | średnio zaawansowane | NO-GO |
| Algebraic oracle | dobre dla bounded cases | PASS tylko jako oracle |
| CPU nearest | prototyp realnego solvera | NO-GO do korekt P0 |
| CPU full window | infrastruktura istnieje | NO-GO, brak completeness |
| Poisson-airbox | bounded synthetic descriptor | NO-GO dla real mesh |
| GPU modal | bounded validation | NO-GO dla Q2 |
| ABI | rozbudowane, lecz nie size-safe | NO-GO |
| Artefakty/provenance | częściowe | NO-GO |
| Control Room | nieskonsolidowane na master | NO-GO |
| CI/release | checkout broken | NO-GO |

## 9. Kolejność napraw o najwyższej wartości

1. Naprawić drzewo Git i odzyskać zielony checkout.
2. Zamrozić jeden kanoniczny branch oraz scope CPU K0.
3. Wprowadzić ABI vNext i typed statusy bez dalszego rozszerzania starej struktury.
4. Naprawić certyfikat równowagi, masę FE, tożsamość domeny i phase convention.
5. Usunąć dense-first z production lane.
6. Naprawić target SLEPc i pełny residual.
7. Oddzielić nearest od full-window; wdrożyć realną kompletność.
8. Zbudować realny MFEM Poisson-airbox E2E.
9. Dopiero wtedy odzyskać artefakty/API/FMS/UI.
10. Na końcu zbudować produkcyjny GPU adapter i wykonać Q2/Q3.

Szczegółowy, bramkowany plan wykonania znajduje się w osobnym dokumencie:
`2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md`.

## 10. Referencje techniczne

### Dokumentacja solverów

- SLEPc Users Manual, **EPS: Eigenvalue Problem Solver** — generalized eigenproblems,
  complex spectra, target selection, shift-and-invert, interval/region methods.
- SLEPc manual page **EPSSetTarget** — target jest `PetscScalar`; target zespolony wymaga
  complex-scalar build.
- PETSc manual pages **MATSEQAIJCUSPARSE/MATAIJCUSPARSE** — sparse CUDA matrix types.
- MFEM **BilinearForm** i assembly levels — bezpośrednie sparse assembly oraz matrix-free/partial assembly.

### Fizyka i FEM micromagnetics

- D'Aquino, Hertel i współautorzy, prace dotyczące obliczania modów rezonansowych przez
  liniaryzację LLG i metody elementów skończonych.
- Fredkin–Koehler, hybrid FEM/BEM demagnetizing field formulation.
- Współczesne prace o periodycznych diagramach fazowych i eigensolverach liniaryzowanej LLG.

## 11. Decyzja

**Nie mergować historycznego rescue w całości i nie promować obecnej implementacji jako
produkcyjnego CPU/GPU eigensolvera.**

Najpierw należy odtworzyć clean baseline i rozdzielić:

- `bounded_dense_oracle`,
- `synthetic_descriptor_oracle`,
- `production_cpu_sparse`,
- przyszły `production_gpu_petsc_slepc`.

Dopiero po tej separacji wyniki testów przestaną mieszać dowód algebry z dowodem
skalowalnej implementacji i z walidacją naukową.
