# Aneks audytowy FEM — operatory, strategie demagnetyzacji i topologia

Data: 2026-09-08. Aneks odnosi się do raportu nadrzędnego
`docs/audits/2026-09-08-fdm-fem-physics-audit.md`. Nie powtarza jego ustaleń
OBS-01–OBS-05; wskazuje ich zakres tam, gdzie dotyczy on FEM.

## Zakres i poziomy dowodów

Przejrzano ścieżki natywnego MFEM CPU, CUDA FEM, planner FEM, kontrakty C++
oraz noty rodziny `fem_*` w `docs/physics/` i `docs/physics/0900-native-fem-operator-contracts-and-validation.md`.
`POTWIERDZONE — źródła` oznacza obecność i połączenie operatora w bieżącym
checkoutcie. `NOT VERIFIED` oznacza brak świeżego, przypiętego receiptu
managed runtime, zbieżności lub porównania CPU/GPU. Kontrakt źródłowy i test
strukturalny nie są dowodem poprawności fizycznej dla każdej siatki.

W tym audycie nie uruchamiano nowego FEM CPU/GPU, nie budowano MFEM/CUDA i nie
zmieniano solvera. Nie należy promować poniższych statusów `implemented` do
`qualified`. W szczególności rejestr LLG oraz ograniczenia kwalifikacji są już
opisane jako VAL-01 w raporcie nadrzędnym.

## Wspólna postać wariacyjna

Dla magnetyzacji zredukowanej `m=M/Ms` oraz pola w amperach na metr obowiązuje
kontrakt

```{math}
:label: fem-audit-variation
\delta E[\mathbf m;\mathbf v]
=-\mu_0\int_{\Omega_m}M_s\mathbf H_{\rm term}\cdot\mathbf v\,dV.
```

$\mathbf m$ i $\mathbf v$ są bezwymiarowe, $M_s$ i $\mathbf H$ mają jednostkę $\mathrm{A/m}$, a energia ma jednostkę $\mathrm J$. Każdy test pola musi używać tej samej kwadratury, maski domeny,
wartości `Ms` i warunku brzegowego co obliczenie energii. Część równoległa do $\mathbf m$ nie zmienia momentu LLG ani pracy stycznej wariacji; może jednak zmienić niepoprawną rekonstrukcję energii z iloczynu $\mathbf m\cdot\mathbf H$.

## Wymiana

Model noty `docs/physics/fem_exchange.md` to

```{math}
:label: fem-audit-exchange-energy
E_{\rm ex}=\int_{\Omega_m}A_{\rm ex}|\nabla\mathbf m|^2dV,
\qquad
\delta E_{\rm ex}=2\int_{\Omega_m}A_{\rm ex}
\nabla\mathbf m:\nabla\mathbf v\,dV.
```

W dyskretyzacji P1 operator sztywności i masa magnetyczna powinny spełniać

```{math}
:label: fem-audit-exchange-matrices
K_{ij}=\int A_{\rm ex}\nabla N_i\cdot\nabla N_jdV,
\qquad W_{ij}=\int M_sN_iN_jdV,
\qquad \mu_0W\mathbf h_{\rm ex}=-2K\mathbf m.
```

`backends/fem/cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem`
składa `DiffusionIntegrator(a_coeff)` na oznaczonych magnetycznych
atrybutach, osobną `MassIntegrator(ms_coeff)` oraz masę objętościową do
lumpingu. Sprawdza nieujemne sumy wierszy i odrzuca pustą domenę magnetyczną.
`backends/fem/cpu/mfem/interactions/exchange_field.cpp::compute_exchange_for_magnetization` aplikuje operator
dla trzech składowych, wykonuje wybraną projekcję masy, skaluje przez `Ms` i
akumuluje energię jako iloczyn magnetyzacji z residualem.

Obsługiwane w źródle są masa lumpowana, masa spójna oraz redukcja klas węzłów
periodycznych (`backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp`). Wymaga to jednak testu
heterogenicznego `A/Ms`, testu interfejsu i ciągłości PBC; sama obecność
`CGSolver` ani dodatnia masa nie dowodzi zbieżności fizycznej. Operator jest
obecnie składany jako MFEM `LEGACY`, ponieważ wskazany problem z pełną
konwersją tetraedrycznego H1 do partial assembly może zatrzymać start.
To decyzja wykonawcza, nie dowód równoważności z partial assembly.

**Stan:** FEM CPU — `implemented` w źródle, runtime i test wariacyjny
`NOT VERIFIED`; FEM GPU — ścieżka operatora i kontrakt są opisane, lecz
identyczny fingerprint, urządzenie, pola i energia `NOT VERIFIED`.

## Demagnetyzacja Poisson–Robin/Dirichlet

Dla `H_d=-\nabla u` równania magnetostatyczne są

```{math}
:label: fem-audit-demag-equations
\nabla\cdot(\mathbf H_d+\mathbf M)=0,
\qquad
E_d=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_d\,dV.
```

W skończonej domenie airboxa wariant Robin ma słabą postać

```{math}
:label: fem-audit-poisson-robin
\int_\Omega\nabla u\cdot\nabla v\,dV
+\int_{\partial\Omega}\beta uv\,dS
=\int_{\Omega_m}M_s\mathbf m\cdot\nabla v\,dV.
```

`backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp::assemble_demag_poisson_rhs` tworzy prawą stronę,
`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp::initialize_demag_poisson_boundary_operator`
nakłada politykę brzegu, a `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp::context_compute_demag_poisson`
wykonuje assemble → solve → recovery. CPU Hypre jest konfigurowany i
sprawdzany przez `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp::solve_demag_poisson_hypre`, w tym
status zbieżności, residual, tolerancję, limit iteracji i warm start.
`backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp::recover_demag_poisson_field` odzyskuje pole, a
`backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp` ma osobne ścieżki energii z pola oraz z RHS/potencjału.

Residual potwierdza rozwiązanie określonego airboxa, nie rozwiązanie domeny
otwartej. Dla fizycznego wniosku wymagane są rozmiar airboxa, h-refinement,
znak energii i niezależny oracle analityczny. Redukcja periodyczna w
`backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` jest osobną realizacją; nie wolno mieszać jej z
otwartym airboxem ani przypisywać jej statusu zwykłego Poisson–Robin.

**Stan:** Poisson CPU — natywna ścieżka assemble/solve/recovery w źródłach,
`NOT VERIFIED` fizycznie; Poisson CUDA/Hypre — źródła i plan device-resident
istnieją, ale wykonanie, brak transferu i parity `NOT VERIFIED`. Dokument
`fem_demag_poisson.md` wprost nie rości sobie parytetu GPU.

## Fredkin–Koehler FEM/BEM

FEM/BEM jest odrębną strategią otwartej granicy, a nie inną nazwą airboxa.
Mapa w `docs/physics/fem_demag_fem_bem.md` wskazuje:

| Warstwa | Źródło i odpowiedzialność | Stan dowodu |
|---|---|---|
| powierzchnia | `backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp::build_demag_boundary_surface` — typed tet4 i watertight boundary | źródło |
| operator | `DenseDemagBemOperator::build`, `HierarchicalDemagBemOperator::build` — oracle dense i hierarchia H2 | źródło |
| RHS/gauge | `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp`, `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp` | źródło |
| solve/potencjał | `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`, `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | źródło |
| pole/energia | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`, `backends/fem/cpu/mfem/interactions/demag_fem_bem_energy.cpp::demag_fem_bem_energy_from_field` | źródło |
| GPU | `backends/fem/gpu/cuda/demag_fem_bem/` | źródła/kontrakt, runtime `NOT VERIFIED` |

CPU H2 i device-resident FK mają implementację, lecz brak świeżego receiptu
z błędem względem dense oracle, zbieżnością siatki i identyfikacją urządzenia.
FMM pozostaje poza tym zakresem. P2/all-tet accuracy i mixed-domain parity są
`NOT VERIFIED`.

## DMI

Dla konwencji objętościowej i interfejsowej użytej w notach:

```{math}
:label: fem-audit-dmi
w_b=D_b\,\mathbf m\cdot(\nabla\times\mathbf m),
\qquad
\mathbf H_b=-\frac{2D_b}{\mu_0M_s}\nabla\times\mathbf m,
```

```{math}
:label: fem-audit-interfacial-dmi
w_i=D_i\left[m_n\nabla_\parallel\cdot\mathbf m_\parallel
-\mathbf m_\parallel\cdot\nabla_\parallel m_n\right].
```

`backends/fem/cpu/mfem/interactions/dmi_bulk.cpp::compute_bulk_dmi_field` i
`backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp::compute_interfacial_dmi_field` budują słaby residual,
obsługują projekcję wejścia przy PBC, używają lumped-mass projection i
akumulują energię. Znak `D`, normalna interfejsu oraz człon brzegowy muszą być
sprawdzane razem z wymianą; zwykły zerowy strumień po dodaniu DMI nie jest
automatycznie warunkiem Roharta–Thiaville.

CPU bulk/interfacial DMI jest `implemented` na poziomie źródeł, ale
derivative test, chiralność, pitch i brzeg `NOT VERIFIED`. CUDA DMI kernels
istnieją, lecz mieszany guard dopuszcza DMI tylko dla jawnego CPU; GPU mixed-P1
jest więc odrzucane bez fallbacku. Rotated-interfacial DMI ma zintegrowaną
ścieżkę źródłową Python → IR → planner → runner/ABI → CPU/GPU dla time-domain.
Focused testy `H_rotated_dmi`, pochodnej FEM i managed build nie są jednak
kwalifikacją scenariusza Göbel: brak pełnego managed receiptu bimeronu,
parytetu CPU/GPU i dowodu czterech lane'ów pozostawia wykonanie oraz
kwalifikację **NOT VERIFIED**.

## Anizotropia

Źródłowe pola lokalne obejmują `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp::compute_uniaxial_anisotropy_field`
i `backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp::compute_cubic_anisotropy_field`; CUDA odpowiedniki są
w `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`.
Przykładowo

```{math}
:label: fem-audit-uniaxial
w_u=-K_{u1}q^2-K_{u2}q^4,
\qquad
\mathbf H_u=\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\mathbf a,
\quad q=\mathbf m\cdot\mathbf a.
```

Obie realizacje mają źródłowy kontrakt osi i współczynników. Należy jednak
rozróżniać lokalny skalar native od materializacji mapy: OBS-01 wykazuje
błąd rekonstrukcji `Ku2` w `eden_ani`, nie dowodzi błędu pola używanego przez
LLG ani natywnej sumy skalarnej. Testy osi, minimów cubic i pochodnej
kierunkowej dla każdej potęgi pozostają `NOT VERIFIED`.

## Magnetoelastyka

`backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp::compute_magnetoelastic_field` realizuje
prescribed-strain, małe odkształcenia z parametrami `B1/B2`, zamienia shear
engineering na tensorowy i liczy energię z węzłową wartością `Ms` oraz
`ctx.integration_weights.mfem_lumped_mass`. Dla konwencji cubic odpowiada to
strukturze

```{math}
:label: fem-audit-magnetoelastic
w_{me}=B_1(\epsilon_{xx}m_x^2+\epsilon_{yy}m_y^2+\epsilon_{zz}m_z^2)
+2B_2(\epsilon_{xy}m_xm_y+\epsilon_{xz}m_xm_z+\epsilon_{yz}m_ym_z).
```

Jest to model zadanego odkształcenia; nie jest dowodem sprzężonego solve'a
mechanicznego. Kernel CUDA istnieje, ale mixed-P1 guard wyłącza rozszerzoną
fizykę tego zakresu, a planner odrzuca isotropic magnetostriction bez
uzasadnionego mapowania na `B1/B2`. Zero strain, uniform strain, obrót osi i
pochodna energii są `NOT VERIFIED` dla CPU i GPU.

## Mixed-P1 i fail-closed topology

`backends/fem/core/fem_mesh.cpp::validate_supported_physics_topology` wymaga
w rozszerzonym mixed scope:

| Warunek | Znaczenie fizyczne/wykonawcze |
|---|---|
| `tet4 + prism6 + pyramid5` | pełna, jawnie typowana domena shared mesh |
| `tri3 + quad4` | zgodne fasety objętości i granic |
| `markers_match_scope` | prism6 są magnetyczne, tet4/pyramid5 są air zgodnie z receptą |
| `fe_order == 1`, double | P1 magnetyzacja i FP64; wyższy rząd jest odrzucany |
| exchange + Poisson Robin/Dirichlet | zawężony, sprawdzalny workload |
| brak dodatkowych pól i PBC w tej kwalifikacji | brak nieudokumentowanego rozszerzenia zakresu |
| DMI tylko `mfem_device == cpu` | GPU mixed-P1 kernel nie ma kwalifikacji |

Każde naruszenie zwraca błąd z `fallback=none`; nie ma cichego przejścia do
CPU ani do innej topologii. Czysty prism6 ma oddzielną, CPU-only zakres obsługi
z ograniczonym exchange+Poisson scope. Dokument `0431-fem-demag-mixed-order-potential.md`
opisuje P1 magnetyzację i P2 potencjał pomocniczy; jego prototypowe dowody
tet4 nie są produkcyjnym dowodem mixed prism/pyramid/tet.

Planner `crates/fullmag-plan/src/fem.rs` wymusza `fe_order=1` i odrzuca
wyższy rząd, jeśli nie ma odpowiedniej capability. To poprawna granica
kontraktu, ale nie kwalifikacja wykonania. Mixed-P1 CPU/GPU parity, puste
ścieżki fallbacku, residual, źródło i urządzenie są nadal `NOT VERIFIED`.

## Macierz statusu FEM

| Obszar | FEM CPU: źródło | FEM GPU: źródło | Runtime / physics qualification |
|---|---|---|---|
| exchange | `implemented` | operator/kontrakt obecny | `NOT VERIFIED` |
| Poisson airbox | assemble/solve/recovery present | CUDA/Hypre path present | `NOT VERIFIED` |
| FK FEM/BEM | CPU dense/H2 | device path present | `NOT VERIFIED` |
| bulk/interfacial DMI | `implemented` | kernel present, mixed guard | `NOT VERIFIED`; GPU mixed unsupported |
| rotated-interfacial DMI | source/weak residual present; focused field test | CUDA residual/kernel present; focused field test | source/runtime probes present; Göbel bimeron and CPU/GPU parity `NOT VERIFIED` |
| uniaxial/cubic | local fields present | kernels present | `NOT VERIFIED`; OBS-01 dotyczy mapy |
| prescribed magnetoelastic | field + energy present | kernel present | `NOT VERIFIED`; mixed scope excludes |
| mixed prism/pyramid/tet P1 | fail-closed guard | fail-closed guard | source only; `NOT VERIFIED` |

Minimalny następny pakiet dowodowy powinien mieć osobne receipt’y dla
Poisson i FK, exchange derivative/energy, DMI chirality i boundary tilt,
anizotropii `Ku2`, magnetoelastyki oraz mixed-P1 CPU/GPU. Każdy receipt musi
przypinać wejścia, siatkę, precision, requested/resolved device, operator IDs,
residual i brak fallbacku; sama kompilacja, znaleziony kernel lub recipe
`just` nie wystarczają.
