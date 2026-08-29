# Audyt: wydajność i Poisson-airbox

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 664–798.

### PERF-01 — P0 — „Sparse payload” powstaje przez pełne zmaterializowanie `N×N`

**Klasyfikacja:** błąd architektury sparse; **pewność:** potwierdzony.

**Dowód w implementacji.** Builder sparse wywołuje dense builder, aplikuje operator do każdej kolumny bazowej, a dopiero potem kompresuje wynik do CSR.

**Dlaczego jest to błąd lub ograniczenie.** To zaprzecza celowi sparse FE. Koszt pamięci to `O(N²)` zanim jakakolwiek oszczędność CSR zadziała.

**Skutek.** OOM i bardzo długi startup już dla średnich siatek.

**Naprawa.** Montować bloki bezpośrednio do MFEM/PETSc sparse z poprawną prealokacją albo użyć `MatShell`/partial assembly. Dense builder zachować wyłącznie jako bounded oracle z twardym limitem.

**Test akceptacyjny.** Guard zabraniający alokacji `N²` na production lane; memory scaling dla 3 rozmiarów.


### PERF-02 — P0 — Materializacja dynamicznego demagu może mieć koszt około `O(N³)`

**Klasyfikacja:** złożoność demagu; **pewność:** potwierdzony.

**Dowód w implementacji.** Każda kolumna pełnej macierzy jest uzyskiwana przez zastosowanie operatora; ścieżka demag wykonuje przy tym pełne mnożenie/solve nad reprezentacją gęstą.

**Dlaczego jest to błąd lub ograniczenie.** Demag jest globalny; próbkowanie wszystkich bazowych wektorów mnoży koszt jednego zastosowania przez `N`.

**Skutek.** Ścieżka nie skaluje się do realnych airboxów.

**Naprawa.** Operator Schura jako action: sparse coupling + persistent Poisson KSP. Nigdy nie materializować globalnego demagu kolumna po kolumnie w produkcji.

**Test akceptacyjny.** Profiler potwierdza stały setup i wiele matvec bez ponownego assembly/factorization.


### PERF-03 — P1 — Sparse mass jest densyfikowana do overlap/dedup

**Klasyfikacja:** ukryta densyfikacja; **pewność:** potwierdzony.

**Dowód w implementacji.** Ścieżka full-window konwertuje macierz masy do dense, aby liczyć podobieństwo modów.

**Dlaczego jest to błąd lub ograniczenie.** Overlap `xᴴMy` można policzyć sparse matvec bez `N²` pamięci.

**Skutek.** OOM w postprocessingu mimo sparse eigensolve.

**Naprawa.** Pozostawić `M` jako PETSc/MFEM operator; wykonać `y=Mx`, potem dot product. Dla klastrów użyć małych macierzy Gram.

**Test akceptacyjny.** Memory guard oraz parity sparse-versus-dense na małym fixture.


### PERF-04 — P0 — Poisson Schur MatShell odtwarza gęsty solve w każdym `MatMult`

**Klasyfikacja:** brak persistent Schur; **pewność:** potwierdzony.

**Dowód w implementacji.** CSR jest przekształcane do dense, a augmentowany układ Poissona jest ponownie faktoryzowany przez eliminację Gaussa dla każdego zastosowania.

**Dlaczego jest to błąd lub ograniczenie.** Shift-invert wykonuje setki/tysiące matvec/solve. Setup Poissona powinien być trwały; inaczej dominujący koszt jest sztucznie powielany.

**Skutek.** Katastrofalna wydajność i brak możliwości GPU residency.

**Naprawa.** Utworzyć persistent KSP/PC/HYPRE dla `Aφφ` i reuse preconditionera/factorization zgodnie z polityką. `MatMult` ma wykonywać tylko coupling, solve i back-coupling.

**Test akceptacyjny.** Licznik setup Poisson równy 1 na kontekst; test 100 matvec bez dodatkowych alokacji.


### PERF-05 — P1 — Explicit Schur jest budowany przez probing każdej kolumny

**Klasyfikacja:** błędna kwalifikacja wydajności; **pewność:** potwierdzony.

**Dowód w implementacji.** Ścieżka certyfikacyjna aplikuje shell do wektorów bazowych, aby stworzyć pełny operator.

**Dlaczego jest to błąd lub ograniczenie.** To może być oracle dla małego N, ale nie kwalifikacja produkcyjnej ścieżki matrix-free.

**Skutek.** Test przechodzi na małym problemie, lecz nie mówi nic o skalowaniu.

**Naprawa.** Twardy limit i nazwa `bounded_explicit_oracle`; produkcyjna kwalifikacja przez action parity na losowych wektorach i pełne residuale modów.

**Test akceptacyjny.** Randomized operator action parity oraz brak explicit build powyżej limitu.


### PERF-06 — P1 — Domyślne `PCLU` jest sekwencyjne i nie stanowi ścieżki dużych problemów

**Klasyfikacja:** brak skalowalnego solve; **pewność:** potwierdzony.

**Dowód w implementacji.** SLEPc route konfiguruje LU dla shift-invert.

**Dlaczego jest to błąd lub ograniczenie.** LU jest wartościowym oracle i baseline'em, ale pamięć fill-in rośnie szybko; na GPU nie daje zamierzonego persistent sparse solve.

**Skutek.** Brak drogi do dużych meshy i mylące określenie production.

**Naprawa.** Zachować LU jako bounded CPU oracle; produkcyjnie iteracyjny KSP z field-split/Schur, AMG/HYPRE i kontrolą inexact shift-invert.

**Test akceptacyjny.** Trzy rozmiary, stabilność liczby iteracji i memory envelope.


### POI-01 — P0 — Poisson-airbox eigensolve jest ograniczony do syntetycznego algebraicznego oracle

**Klasyfikacja:** oracle przedstawiony zbyt szeroko; **pewność:** potwierdzony.

**Dowód w implementacji.** Kod wymaga `assembly_kind="synthetic_algebraic_oracle"`, limituje całkowite DOF (m.in. ścieżka do 128) i publikuje `production_implication:false`.

**Dlaczego jest to błąd lub ograniczenie.** To wartościowy test algebry descriptoru, lecz nie dowodzi poprawnego assembly z realnego Tet4/Prism6, mapy domen ani BC.

**Skutek.** Ryzyko uznania toy fixture za Q1.

**Naprawa.** Zachować oracle bez zmian semantycznych, ale oddzielić namespace/engine ID. Dodać realny MFEM assembly E2E z mesh snapshot i airbox certificate.

**Test akceptacyjny.** Co najmniej makrospin, realny prosty ferromagnetyk+airbox oraz antydot na rzeczywistym meshu.


### POI-02 — P0 — Periodic certificate sprawdza głównie schema i dodatnią liczbę par

**Klasyfikacja:** niewystarczający certyfikat PBC; **pewność:** potwierdzony.

**Dowód w implementacji.** Preflight nie dowodzi bijekcji, translacji, orientacji, regionów, zgodności DOF ani braku wielokrotnego sparowania.

**Dlaczego jest to błąd lub ograniczenie.** Błędny seam zmienia funkcjonalną przestrzeń rozwiązania i widmo; liczba par nie gwarantuje prawidłowej identyfikacji.

**Skutek.** Sztuczne mody brzegowe i błędny demag.

**Naprawa.** Certyfikat PBC generowany z topologii: bijekcja, odwrotność, wektor translacji, orientacja faces/edges, region/material parity, DOF permutation i tolerancja geometryczna.

**Test akceptacyjny.** Duplicate pair, missing pair, reversed orientation, wrong translation, mixed region.


### POI-03 — P1 — API akceptuje więcej typów BC, niż wspiera descriptor route

**Klasyfikacja:** rozjazd kontraktu BC; **pewność:** potwierdzony.

**Dowód w implementacji.** Początkowy preflight dopuszcza Robin/Dirichlet, ale później route odrzuca je z powodu braku wspieranego gauge/descriptoru; praktycznie działa tylko wąski pure-Neumann + mean-zero.

**Dlaczego jest to błąd lub ograniczenie.** Planner powinien odrzucić konfigurację przed kosztownym assembly, a nie po wejściu w solver.

**Skutek.** Niespójne błędy i trudny UX.

**Naprawa.** Jawna tabela capabilities per engine; planner fail-closed. Rozszerzać BC dopiero po implementacji właściwego operatora i residualu.

**Test akceptacyjny.** Każda kombinacja BC ma jednoznaczny planner result i reason code.
