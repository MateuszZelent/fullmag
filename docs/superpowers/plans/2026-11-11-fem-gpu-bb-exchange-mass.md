# Plan: FEM GPU BB exchange-mass preconditioner

**Cel:** dodać do FEM GPU `projected_gradient_bb` preconditioner wymieniający
kierunek wyszukiwania na rozwiązanie spójnego układu mass–exchange, a następnie
zmierzyć parytet SP4 i koszt do tego samego wyniku. To plan implementacji i
kwalifikacji; nie zakłada przyspieszenia ani promocji do produkcji.

**Właściciel:** główny agent zadania. Zmiany kodu, testy i pomiary wykonuje w
przypiętym worktree `codex/sp4-fem-gpu-bb-preconditioner-20261111`.

**Zakres źródeł:** host setup `backends/fem/gpu/cuda/relaxation/bb_exchange_mass.{cpp,hpp}`;
CUDA PCG `bb_exchange_mass_kernels.{cu,hpp}`; integracja `pgbb.cpp`,
`pgbb_kernels.{cu,hpp}`, stan/pamięć relaksacji i `backends/fem/CMakeLists.txt`;
typed Study API w `packages/fullmag-py/src/fullmag/world.py`,
`FemHintsIR`/`FemPlanIR`, native setter w `backends/fem/src/api.cpp`, niezależne
testy operatora i kwalifikatory SP4. Nota i mapa są w `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`
i sąsiednim `.source-map.json`.

## Ograniczenia

- Operator GPU ma używać tych samych CPU-oracle form:
  `M_Ms = ∫ Ms φ_i φ_j dV`, `K_A = ∫ A ∇φ_i·∇φ_j dV`,
  `[M_Ms + (2 λ_BB / μ0) K_A] z = M_Ms g`, po czym projekcja styczna.
- `λ_BB` ma używać istniejącego clampu CPU: `1e-12..1e-6 m/A`.
- Użyć persistent cooperative CUDA PCG na immutable device CSR `M_Ms` i `K_A`,
  device Jacobi oraz redukcji/alpha/beta/warunku stopu wewnątrz kernela.
  Wewnętrzne `rtol=1e-10`, limit `512`; dla niezerowego RHS niezależny
  residual spełnia `||r||≤1e-8||rhs||`; zerowy RHS daje dokładne zero.
  Osiągnięcie limitu fail-closed; to nie jest twierdzenie o naprawie CUDA
  error 719. Poissonowy limit/rtol pozostają bez zmian.
- Jedyny transfer z PCG do hosta to końcowy certyfikat residualu. Bez scalar
  readbacków na iterację i bez wektorowego D2H/CPU solve. Nieudostępniony
  cooperative launch kończy się jawnie błędem, bez CPU fallbacku.
- Nie używać bezwzględnego progu `1e-24` w nowym GPU certyfikacie: małe
  niezerowe RHS nadal wymaga względnej dokładności. Underflow/overflow normy
  oraz niefinity muszą fail-closed. Historyczny próg CPU i Poisson cert pozostają.
- Zachować surowy gradient fizyczny dla torque, stop i BB curvature. Sprawdzać
  fizyczny `g·z > 0`; przy braku descent restartować z surowego gradientu GPU.
- Bez CPU fallbacku. Zachować Armijo na reprezentowalnej cięciwie, świeży
  zerowy solve Poissona i niezależną certyfikację Poissona. NCG poza zakresem.
- Nie zmieniać istniejących bramek PBC; zachować projekcje okresową,
  free-mask i styczną. Dodać `StudyBuilder.fem_bb_preconditioner(policy=...)`,
  `FemHintsIR.gpu_bb_preconditioner`, `FemPlanIR` forwarding i native setter.
  Dozwolone tryby: `auto`, `none`, `exchange_mass`; brak globalnego env switcha.
- Pozostawić outer BB/Armijo scalar control i HYPRE Poisson host control
  jawnie host-controlled. Nie twierdzić, że cały krok jest w 100% GPU.
- Kandydat gałęzi może resolve'ować do `cooperative_device_pcg`, lecz to nie jest
  kwalifikowana promocja ani wynik performance.
- Zachować 62 zachowane wejścia/wyniki kampanii i inne grupy Compose. Drain/rebuild
  dotyczy wyłącznie wybranej, zakwalifikowanej grupy; integracja według cyklu
  worktree z AGENTS.md.

## Etapy i bramki

1. **Tożsamość wejść.** Zarejestrować pełny SHA źródeł, dokładny hash siatki
   SP4 R2, ProblemIR, materiały, stan początkowy, grupę Compose i GPU. Pomiary
   porównywać tylko przy zgodnej tożsamości.
2. **Operator.** Zachować `bb_exchange_mass.cpp` jako setup bridge, a wymienić
   roboczy host-CG na persistent cooperative device PCG kernel. Przygotować
   immutable CSR device danych form i cache po kluczu lifecycle operatora.
   Testować gęsty niezależny oracle, heterogeniczne `Ms/A`, maski i węzły air,
   zero RHS, clamp kroku, cache hit/miss, residual i fail-closed błędy.
3. **Publiczny wybór i integracja.** Zmapować `auto/none/exchange_mass` przez
   typed Study builder → `FemHintsIR` → `FemPlanIR` → setter kontekstu natywnego.
   `auto` zachowuje requested intent; provenance raportuje resolved solver.
   Odrzucić tryby poza explicit FEM GPU projected-gradient BB.
4. **Integracja BB.** Utrzymać oryginalny gradient fizyczny; po solve wykonać
   aktualną projekcję okresową, maskę wolnych węzłów i projekcję styczną.
   Udowodnić identyczne zachowanie raw-gradient restartu przy niedescent.
5. **Managed source gate.** Właściwa recepta naukowa; audyt potwierdza brak
   per-iter scalar-D2H PCG, jeden końcowy transfer certyfikatu, brak wektorowego
   D2H, CPU solve i fallbacku. Osobno pokaże outer BB/Armijo oraz HYPRE host
   control. Cooperative-launch rejection ma test fail-closed.
6. **SP4 parity.** Ten sam zamrożony R2 mesh, ProblemIR i stan początkowy dla
   baseline/candidate. Wymagać torque agreement `≤ 1e-6`, względnego parytetu
   `E_total` `≤ 1e-9`, niezerowych składników `≤ 2e-6` (zerowych do `1e-30 J`)
   oraz zachować CPU target
   `E_total = 6.23101634685e-19 J`. Zachować kompletne Zarr i provenance
   wszystkich przebiegów, również nieudanych. Progi składników ustalono przed
   pierwszym nowym biegiem: dotychczasowe przybliżone minima przy torque 1 µT
   różnią się w exchange o `8.8e-7`, mimo zgodności sumy do `7.86e-11`.
   Niezależny test operatora na tym samym wektorze pozostaje osobną bramką.
7. **Pomiar.** Recepta uruchamia izolowane baseline/candidate Studies z
   `policy="none"` i `policy="exchange_mass"`; `auto` kwalifikuje się osobno.
   Co najmniej pięć naprzemiennych powtórzeń po
   warmupie; CUPTI wyłączone, ten sam GPU, limity, binaria, siatka i stan.
   Dodać CPU jako odrębny lane. Raportować rozkłady, solve count, iteracje,
   koszt preconditionera, Armijo, torque, składowe energii i czas do tej samej
   tolerancji. Nie wyciągać wniosku o speedup z GPU utilization.
8. **Decyzja.** Oddzielić test operatora, wykonanie na GPU, parytet fizyczny i
   performance. Dopiero pełne gates mogą rozstrzygnąć kwalifikację i produkcyjne
   ustawienie; do tego czasu raportować `implemented, unqualified`.

**Zaliczenie:** niezależny oracle i bramki SP4 przechodzą, każda próbka ma
rzeczywiste GPU/source/mesh/state provenance i pełny Zarr, brak pogorszenia
fizyki, a raport osobno ujawnia wewnętrzną residency PCG i hostowe sterowanie
zewnętrzne. Przy braku speedup nie promować przyspieszenia; zachować wynik i
oddzielny status kwalifikacji.
