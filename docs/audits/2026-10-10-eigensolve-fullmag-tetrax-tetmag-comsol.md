# Porównanie eigensolve: dedykowany worktree Fullmaga, TetraX, tetmag, mumax+ i COMSOL

Data: 10.10.2026. Rewizja R2.

**Przedmiot audytu:** `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`, branch `codex/eigensolve-dispersion-plan-20260912`, odczytany HEAD `1827c3436f80ff17396c285d13c0e269eecf4b25`. Oceniamy rzeczywiste pliki tego worktree, a nie mastera. Trwa tam równoległa praca; dokładne fragmenty i SHA-256 plików podano w [zrewidowanym planie](../plans/active/2026-10-10-eigensolve-reference-adaptation-and-physics.md#10-dokładne-odnośniki-i-fragmenty-źródłowe-snapshot-r2).

Status Git worktree: próby `git status --short --ignore-submodules=all` zwróciły `fatal: this operation must be run in a work tree`; nie potwierdzam clean ani zgodności wszystkich plików z HEAD. Odczyt źródeł i ich hashing działał. Nie zmieniono konfiguracji Git, uprawnień, kodu, indexu ani procesów worktree. Dokumenty zapisywane są w bieżącym workspace, co nie zmienia ich bazy porównawczej.

## 1. Korekta poprzedniego raportu

Poprzednia wersja odnosiła implementację do mastera. **Wycofuję ogólne stwierdzenie, że Fullmag nie ma numerycznego dynamicznego demag przy k≠0.** Dedykowany worktree ma rzeczywiste production CPU routing, sparse magnetic/potential payload i osobnego Floquet modal ownera. Brak świeżej kwalifikacji nie oznacza braku źródeł ani routingu.

Wycofuję również sugestię, że obecna produkcyjna trasa nie rozróżnia envelope/phase constraints, oraz że występowanie lumped weights w artefakcie równowagi dowodzi lumped modal mass. W tym worktree representation jest jawna, a sparse Floquet mass jest consistent P1.

Aktualny problem to domknięcie ograniczeń geometrii, exterior, memory/preconditioner, kompletności widma i kwalifikacji, a następnie rozszerzenie na exact damping/GPU. Kod źródłowy, algebraiczny certyfikat, runtime receipt i naukowa walidacja są osobnymi poziomami dowodu.

## 2. Aktualna ścieżka Fullmaga

### CPU nonzero-k dynamic demag jest podłączony

[`eigen_capability.rs:92`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/crates/fullmag-runner/src/fem/eigen_capability.rs:92), `native_cpu_modal_window_has_floquet_dynamic_demag_path`, wybiera bounded CPU route dla Full2x2, `Ignore`, wspieranego nearest/window target, Floquet, `SharedDomainMeshWithAir`, airbox+Poisson, zgodnych metadanych i identycznych pair sets oraz finite single/path k z nonzero sample.

[`eigen_execution.rs:2026`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/crates/fullmag-runner/src/fem/eigen_execution.rs:2026) kieruje ten przypadek do `execute_native_modal_window(...ProductionCpu...)` przed runner dense K/M. Nie wolno wyciągać wniosku „operator missing” z rejection reason w innej gałęzi bez prześledzenia tego predicate.

[`modal_eigen_solver.cpp:2229`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/src/frequency_domain/modal_eigen_solver.cpp:2229) przekazuje Aqq, Bqq, P, Aqφ, Aφq, positive tangent mass, `full_descriptor_assembly` i `floquet_shared_domain_operator`. Native CPU owner to [`modal/floquet_modal_solver.cpp`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp:737), nie tylko scalar helper. Dosłowne fragmenty: plan W01–W03.

### Reprezentacja Blocha i masa

[`floquet_airbox_operator.cpp:757`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp:757), `assemble_floquet_airbox_shared_domain_blocks`, wybiera `full_field_phase_constrained` dla scalar operatora i source. Gradient pełnego pola nie jest dodatkowo przesuwany o k. [`floquet_bloch_scalar.cpp:48`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp:48) ma oddzielny wariant `shifted_envelope`.

[`poisson_airbox_shared_domain.cpp:2852`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp:2852) składa consistent positive tangent mass. Trial field jest nodal FE: suma N_a T_a q_a. Nodal tangency nie oznacza exact pointwise tangency w textured P1. To ograniczenie dyskretyzacji wymagające osobnego leakage/refinement, nie automatyczna awaria operatora.

### Co certyfikat rzeczywiście sprawdza

[`certify_floquet_full_descriptor:737`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp:737) odtwarza pełne pola i oryginalne actions, następnie projektuje residual przez C^H (864–890) oraz sprawdza scalar/tangent/Cartesian/equilibrium seams (984–1007). Native solve odrzuca unavailable lub nieprzechodzący certificate (8204–8237).

Zakres dowodu: **full_projected_weak_form_and_periodic_seams**. Nie jest to pointwise strong-form flux ani pełna geometric/exterior qualification. Raw row residual na eliminated periodic DOF może zawierać constraint reaction; nie wolno wymagać jego zerowania poza dopuszczalną test space. Plan W04–W06 podaje fragmenty.

### Nadal niekwalifikowane albo poza dopuszczonym tuple

| Obszar | Aktualny wniosek |
|---|---|
| Exact damping `Include` | Nie jest dopuszczone przez nonzero-k production CPU predicate; reference linewidth correction nie zastępuje pełnego B_alpha solve |
| GPU nonzero-k modal | Osobny gated zakres; istniejącego GPU K0 nie awansujemy automatycznie |
| `Lowest` | Nie jest targetem tej bounded nonzero-k trasy |
| Nearest | Selected modes, bez obietnicy kompletnego okna |
| Geometry/exterior/mesh convergence | Wymagają odrębnych dowodów, których ten audyt nie wykonał |
| Spectrum completeness | Contour owner/count certificate już istnieje; sparse Floquet shift-invert jawnie go nie produkuje. Residual i two-pass agreement nie zastępują count |
| Large-scale performance | Generic MFEM sparse payload producer najpierw alokuje trzy N² buffers i konwertuje dense→CSR; późniejszy SLEPc solver jest sparse. Odrębny direct shared-domain Floquet producer ma swój zakres/budget |
| DMI/STT/EASA | Support musi wynikać z całego modalnego lowering/JVP/BC; time-domain support nie jest tym dowodem |

## 3. Co naprawdę daje każda referencja

| Referencja | Potwierdzony mechanizm | Co adaptujemy / czego nie dowodzi |
|---|---|---|
| TetraX `DynamicMatrix` | Lokalna rotacja, materiałowe unitless gamma, full sparse+matrix-free action | Wzorzec modularnej liniaryzacji. Gamma_average jest skalą, nie dowodem utraty lokalnego gamma |
| TetraX ARPACK | `eigs`, sigma=0, OPinv, 2*num_modes; LGMRES + ILU sparse core | Wzorzec inverse action/preconditionera. Nadpróbkowanie nie certyfikuje pełnego widma |
| TetraX demag-k | +ik source/gradient, k² scalar operator i k-dependent dense BEM | Spójność wszystkich bloków. Propagacyjna cross-section nie jest gotowym periodic-film kernel |
| TetraX linewidth/absorption | Postprocessing Γ/(2π), eliptyczność i RF overlap | Perturbacyjny HWHM/prosty biegun. Nie exact damped eigenpairs ani generic left-mode response |
| tetmag | Time-domain CVODE oraz Poisson/BEM/Laplace z dense/H2 MVP | Open-boundary demag i niezależny ringdown; CVODE/AMGCL nie są eigensolverami |
| mumax+ lokalny FFT test | AFM `sub1`, `enable_demag=False`, transient→FFT→peak | Mechanizm kontroli widma; potrzebny nowy zgodny FM/demag fixture do DE/BV |
| COMSOL manual | Linearized Gilbert, complex eigenfrequencies, przestrzenny Floquet, dwa magnetostatic modules | Kontrakt fizyczny/workflow. Nie źródło algorytmu zamkniętego eigensolvera |

Dokładne linie, krótkie fragmenty i hashe: [plan, sekcja 10](../plans/active/2026-10-10-eigensolve-reference-adaptation-and-physics.md#10-dokładne-odnośniki-i-fragmenty-źródłowe-snapshot-r2), E01–E23 i W01–W06. E22 dokumentuje dense→CSR producer; E23 existing contour count i jego brak w sparse Floquet. TetraX jest lokalnym katalogiem v2.0.0 bez ustalonego upstream commita. tetmag gitlink: `ab7f266c0d78fff0ed425cc013382e7ab24fa39c`; mumax+ gitlink: `14fa37691b247ec4f7eb7f3a0a2fa87810a3b5ea`, local package v1.2.1. Local source hashes, a nie sam gitlink, wiążą cytowane fragmenty.

## 4. Fizyka i numeryka: poprawione rozróżnienia

- Dynamiczny demag to pochodna pola zastosowana do δM=Ms δm; statyczne Hdemag[m0] nie zastępuje operatora perturbacji. W quasi-static approximation nie oznacza retardacji Maxwellowskiej.
- Full-phasor+phase constraints i envelope+grad_k są równoważne w continuum. Standardowe P1 mają jednak różne approximation spaces; exact matrix equality jest błędnym ogólnym warunkiem odbioru.
- TetraX ma przestrzenny +ik, Fullmag −ik. Jego tensor N_dip daje +grad Φ, a field provider osobny minus. Nie importujemy znaku pola z komentarza bez sprawdzenia całego provider chain. Konwencji czasowej TetraX nie potwierdzono w lokalnym materiale.
- Constrained energy Hessian zawiera multiplier curvature; fixed Zeeman contribution nie znika z modalnego problemu tylko dlatego, że Euclidean E'' jest zerowe. Generator, gyrotropic pencil i energy Hessian nie są tą samą macierzą.
- Dla exp(+iΩt), Ω=ω_r+iΓ daje zanik przy Γ>0. FWHM mocy izolowanego bieguna to Γ/π; TetraX Γ/(2π) odpowiada HWHM. Overdamped finite modes mogą mieć ReΩ=0 i nie są nieistniejącymi modami.
- Real-split dopuszcza complex eigenpairs. Physical-sector reconstruction i original complex residual muszą poprzedzać mapowanie do stable/unstable; nie liczymy algebraicznych kopii podwojonej reprezentacji jako nowych modów.
- Residual oceniamy po fizycznych BC, przed Schurem i w dopuszczalnej test space; scalar-potential, gauge, frame/flux/exterior są oddzielnymi sprawdzeniami. Dwa zgodne listowania znalezionych modów nie wykrywają wspólnie pominiętego subspace.

Pełne równania, SI, skonkretyzowane progi i negative fixtures są w zrewidowanym planie, sekcje 4–7. Nie narzucamy wszystkim lanes identycznych symetrii ani stopnia kwalifikacji.

## 5. Manual COMSOL — dokładne odnośniki

Źródło: [`Manual_for_Micromagnetics_Module.pdf`](C:/git/fullmag/fullmag/docs/comsol/Manual_for_Micromagnetics_Module.pdf), V2.13, Weichao Yu, 29.09.2025, 74 strony PDF. Starsza kopia w `docs/plans/active/fd_sovler_masterplan` ma datę 27.12.2024 i 71 stron; nie mieszamy paginacji.

| Treść | Drukowana strona / PDF / równanie |
|---|---|
| Linearized Gilbert i faza exp(+iωt) | 16 / 21 / (11)–(13) |
| Poprzeczność perturbacji | 20 / 25 / (19) |
| Spatial Floquet exp(−ik·Δr) | 22–23 / 27–28 / (20) |
| Surface anisotropy BC | 23 / 28 / (21), znormalizowane współczynniki manualu |
| Complex eigenfrequency i resonance/linewidth | 25–26 / 30–31 |
| Texture handoff | 26–27 / 31–32 |
| Static i dynamic demag w oddzielnych modules | 35–36 / 40–41 |

Nie ma dostępnego kodu COMSOL w tym manualu; nie wymyślamy snippets ani nazwy preconditionera. Jego szerszy katalog DMI/STT/EASA wymaga własnej liniaryzacji i natural BC w Fullmagu, zwłaszcza że manual wskazuje nierozstrzygnięty frequency-domain DMI BC.

## 6. Dowody wykonania i granice

W dedykowanym worktree [`2026-10-04-dispersion-master-merge-checkpoint.md:270`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/docs/raports/2026-10-04-dispersion-master-merge-checkpoint.md:270) zapisano historyczny #231 FGMRES, k=+10 rad/µm, 11.205285324453773 GHz, residual 1.8215819390878056e−13 i `completed_unqualified`. Ten sam opis zachowuje `geometric_bc_certified=false`, `selected_only`, `window_complete=false`.

To odczyt raportu, **bez świeżej kontroli receipt/binary/source/input identity**. Nie przenosimy go automatycznie na HEAD ani aktualne dirty pliki. Nie dowodzi DE/BV n0 identification, mesh/airbox convergence, A1-COMSOL ani GPU parity. [`de-nonzero-discrepancy-source-scan:34`](C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/docs/raports/2026-10-04-de-nonzero-discrepancy-source-scan.md:34) pozostawia rozbieżność i jej przyczynę otwarte.

W tej rewizji wykonano tylko mały NumPy/SciPy check algebraiczny: circular/elliptic macrospin, overdamped case, complex matrix coefficients, physical-sector reconstruction i energy balance; exit 0, max residual 6.1015e−16. To dowód algebry opisanej w planie, nie wykonanie natywnego FEM/SLEPc ani fizycznego demag-k.

**NOT VERIFIED w tej rewizji:** current managed runtime, solver performance, geometry/exterior qualification, complete spectrum, COMSOL numerical parity i CPU/GPU parity. Nie uruchamiano buildów ani kompilacji unit tests. Zmieniono wyłącznie raport i plan oraz pomocnicze pliki ich tekstowej/algebraicznej kontroli w `tmp`.
