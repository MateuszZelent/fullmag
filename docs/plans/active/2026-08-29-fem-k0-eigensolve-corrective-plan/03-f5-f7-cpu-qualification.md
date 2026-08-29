# Plan: F5–F7 kwalifikacja CPU

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-corrective-completion-plan.md` z 2026-08-29. Zakres oryginalnych linii: 375–523.

## F5 — CPU nearest-frequency (`slepc_cpu_nearest_v1`)

**Priorytet:** P0  
**Zależności:** F4  
**Cel:** pierwszy kwalifikowalny produkt numeryczny.

### Decyzja architektoniczna

Przed implementacją wybrać i udokumentować jedną reprezentację:

**Wariant A — rzeczywista wartość własna `ω`:**
przekształcić pencil tak, aby SLEPc target realny był fizycznie poprawny.

**Wariant B — complex scalar `λ=iω`:**
budować PETSc/SLEPc complex i używać targetu `iω`.

Nie pozostawiać bieżącej hybrydy: `λ` urojone + target rzeczywisty.

### Zadania

1. Poprawić problem type i target.
2. Adaptacyjne `nev/ncv/mpd`, aż:
   - zwrócono wymaganą liczbę dodatnich modów;
   - albo jawny partial/limit.
3. Osobne liczniki accepted/rejected.
4. Full descriptor residual po rekonstrukcji `φ`.
5. Bez hardcoded residual floor.
6. Phase convention end-to-end.
7. KSP monitor sumujący wszystkie solve.
8. LU tylko jako bounded oracle; produkcyjny KSP/PC jako osobny profil.
9. `nearest` zawsze publikuje `selection_scope=selected_only`.
10. Artifact commit atomowy.

### Testy

- macrospin Kittel;
- kilka ciasnych modów;
- degeneracja;
- zero mode;
- target między modami;
- niedokładny Poisson;
- cancellation;
- requested modes > converged;
- obie phase conventions.

### Bramka F5

- poprawny target potwierdzony mutation testem;
- wszystkie zwrócone mody przechodzą pełny residual;
- request count jest spełniony albo status jawnie partial;
- brak pola `complete:true`.

---

## F6 — CPU complete window (`slepc_cpu_window_v1`)

**Priorytet:** P0  
**Zależności:** F5  
**Cel:** prawdziwe, certyfikowane spektrum w oknie.

### Zadania

1. Usunąć `solve_tiny_contour_interval` z auto-production selection.
2. Zachować go jako bounded validation oracle z limitem N i nazwą wskazującą ograniczenie.
3. Wybrać dojrzały mechanizm:
   - spectrum slicing dla odpowiednio przekształconego realnego problemu; albo
   - SLEPc CISS + region (`RG`) dla spektrum zespolonego.
4. Niezależny count convergence:
   - co najmniej dwa contour/refinement settings;
   - stabilna liczba modów;
   - pełne residuale;
   - boundary overlap.
5. Cluster-aware dedup przez mass Gram/subspace, bez dense mass.
6. Mod na granicy należy przypisać deterministycznie.
7. `window_complete=true` tylko po wystawieniu `WindowCertificateV1`.
8. Użytkownik otrzymuje reason, gdy kompletność nie jest osiągnięta.

### Testy

- znane diagonalne spektrum;
- mody na granicach;
- ciasne/degenerate clusters;
- probe rank deficiency;
- contour perturbation;
- insufficient budget;
- artificial missing subwindow negative control.

### Bramka F6

- count stabilny;
- wszystkie mody w oknie i żaden spoza tolerancji;
- brak cyrkularnego `rank=count`;
- niezależny certyfikat podpisuje pełny wynik.

---

## F7 — Realny MFEM Poisson-airbox i kwalifikacja CPU Q1

**Priorytet:** P0  
**Zależności:** F6  
**Cel:** przejść od syntetycznej algebry do fizycznego meshu.

### Zadania assembly

1. Realne bloki Tet4/Prism6 ze wspólnego mesh snapshot.
2. Certyfikowana mapa magnetyk → airbox.
3. Pierwszy wspierany BC: pure Neumann + mean-zero gauge.
4. Pozostałe BC fail-closed w plannerze.
5. Persistent sparse Poisson solve.
6. Pełny residual i gauge residual.
7. Dynamic demag action parity z niezależnym statycznym testem.

### Kanoniczne przypadki Q1

1. **Uniform/Kittel:** seria pól, bez przecieku wartości referencyjnej do solve.
2. **Prosty film/element:** analityczna lub wysokiej jakości referencja.
3. **Antydot:** nearest diagnostic, następnie complete window.
4. **Convergence:**
   - co najmniej 3 siatki;
   - co najmniej 3 airbox sizes albo uzasadniony model asymptotyczny;
   - cluster/subspace tracking.
5. **Reproducibility:** dwa świeże runy na tym samym candidate.

### Proponowane kryteria startowe Q1

- Kittel max relative frequency error ≤ 2% dla ustalonego przypadku;
- full descriptor residual ≤ requested tolerance bez hidden floor;
- top-two mesh frequency drift ≤ 1% dla modów izolowanych;
- dla klastrów: stabilny wymiar i małe principal angles;
- kompletność okna potwierdzona przez certyfikat;
- brak fallbacku i brak dense production allocation.

Progi muszą być zatwierdzone w naukowym ADR, nie zaszyte przypadkowo w kodzie.

### Bramka Q1

Jeden immutable CPU candidate ma:

- clean source/build identity;
- Kittel receipt;
- real mesh antidot complete-window receipt;
- mesh/airbox convergence;
- full mode fields;
- all residual certificates;
- bounded performance envelope;
- zero unresolved P0 CPU.

---
