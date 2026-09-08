# Sekcja audytu: dynamika, relaksacja i transport

Data audytu: **2026-09-08**. Checkout i fingerprint źródeł są opisane w raporcie nadrzędnym
`docs/audits/2026-09-08-fdm-fem-physics-audit.md`, dla którego punktem odniesienia jest
`6cc5e5e0396050f5f859a0e2b28dd3f963d3f7bb`. Ta sekcja porządkuje wykonawczą stronę
LLG, relaksacji, termiki, STT/SOT, transportu ładunku i spinu, pola Oersteda oraz
problemów modalnych. Równania bazowe są w raporcie głównym; tutaj najważniejsze są
ścieżki kodu, odmowy plannera, granice realizacji i status dowodów.

## Jak czytać wynik

`POTWIERDZONE — źródła` oznacza, że bieżący kod i wywołania opisują daną ścieżkę.
`TEST PASS` dotyczy wyłącznie testu kontraktowego wskazanego w raporcie. `UNSUPPORTED`
oznacza jawne odrzucenie kombinacji. `NOT VERIFIED` oznacza brak świeżego, przypiętego
receiptu wykonania, zbieżności lub parytetu dla konkretnej realizacji. Żaden wpis
`implemented` ani `semantic_only` nie jest przez to kwalifikacją produkcyjną.

| Zakres | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Deterministyczny LLG | `POTWIERDZONE — źródła`; runtime/parytet `NOT VERIFIED` | `POTWIERDZONE — źródła`; CUDA, urządzenie i parytet `NOT VERIFIED` | `POTWIERDZONE — źródła`; managed MFEM runtime `NOT VERIFIED` | `POTWIERDZONE — źródła`; CUDA runtime/parytet `NOT VERIFIED` |
| Relaksacja | LLG overdamped oraz BB/NCG; kwalifikacja `NOT VERIFIED` | ścieżki RK/relax obecne; kwalifikacja `NOT VERIFIED` | PGBB/NCG i relaxation step obecne; runtime `NOT VERIFIED` | PGBB/NCG/preconditioner obecne; runtime `NOT VERIFIED` |
| Termika | counter RNG i transakcyjny krok w źródłach; statystyka fizyczna `NOT VERIFIED` | kernel/ABI i testy kontraktowe obecne; runtime CUDA `NOT VERIFIED` | Brown sigma/field i test kontraktowy; runtime `NOT VERIFIED` | kernel źródłowy obecny, ale publiczny strict planner **UNSUPPORTED** (`CAP-THERM-GPU-001`) |
| STT/SOT | plan → `EffectiveFieldTerms`; brak czterotorowego parytetu | kernel FP64 z maskami i wersjami formuł; runtime `NOT VERIFIED` | część przez transport stage; pełne mapowanie `NOT VERIFIED` | RK torque kernels obecne; runtime/parytet `NOT VERIFIED` |
| Charge/spin transport | Rust FV/reference oraz natywne ABI opt-in; kwalifikacja `NOT VERIFIED` | transport ABI i hostowe odświeżanie; adaptacyjny device loop jawnie odrzucony | steady transport MFEM; brak dowodu sprzężenia dynamicznego | brak potwierdzonej produkcyjnej dynamicznej ścieżki charge/spin |
| Oersted | FFT/direct source i dynamiczne odświeżanie; runtime `NOT VERIFIED` | source hooks istnieją; runtime/closure `NOT VERIFIED` | vector potential/direct tetra; runtime `NOT VERIFIED` | CUDA kernel istnieje; runtime/closure `NOT VERIFIED` |
| Mody własne | brak dowodu kwalifikowanego eigenmodes | brak dowodu kwalifikowanego eigenmodes | linearized dynamic pencil; wykonanie `NOT VERIFIED` | brak dowodu kwalifikowanego eigenmodes |

## Wyprowadzenia kontrolne dla dynamiki i sprzężeń

### Torque Gilberta a jawny RHS

Niech $\mathsf C\mathbf x=\mathbf m\times\mathbf x$ oraz $\mathbf W=-\gamma_H\mathbf m\times\mathbf H+\mathbf T_G$. Na płaszczyźnie stycznej do jednostkowej $\mathbf m$ zachodzi $\mathsf C^2=-\mathsf I$. Odwrócenie operatora Gilberta daje więc

```{math}
:label: dyn-audit-gilbert-inverse
(\mathsf I-\alpha\mathsf C)\dot{\mathbf m}=\mathbf W,
\qquad
\dot{\mathbf m}=\frac{\mathbf W+\alpha\mathbf m\times\mathbf W}{1+\alpha^2}.
```

$\mathbf T_G$ i $\mathbf W$ mają jednostkę $\mathrm{s^{-1}}$. Torque zdefiniowanego przed odwróceniem Gilberta nie wolno bez konwersji dodać do już jawnego RHS. Dla bezwymiarowej polaryzacji $\mathbf p$ oraz współczynników $a,b$ w $\mathrm{s^{-1}}$:

```{math}
:label: dyn-audit-torque-components
\mathbf T_G=a\mathbf m\times\mathbf p+b\mathbf m\times(\mathbf m\times\mathbf p)
\quad\Longrightarrow\quad
\mathbf T_{\rm explicit}=
\frac{a-\alpha b}{1+\alpha^2}\mathbf m\times\mathbf p
+\frac{b+\alpha a}{1+\alpha^2}\mathbf m\times(\mathbf m\times\mathbf p).
```

To wyjaśnia mieszanie składników field-like i damping-like. Podstawa kontraktu: `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`, sekcje konwencji i torque. Źródło rzeczywistych wersji formuł FDM GPU: `backends/fdm/gpu/cuda/integrators/llg_fp64.cu::llg_rhs_fp64_kernel`, oddzielne gałęzie Zhang–Li, Slonczewski i wywołanie `prescribed_sot_explicit_rhs`. Porównując je z wzorem, trzeba najpierw ustalić kierunek prądu, polaryzację i wersję formuły. Stara i nowa gałąź nie są automatycznie tym samym modelem.

Dla kanonicznego Zhang–Li z $\mathbf v=(\mathbf u\cdot\nabla)\mathbf m$, $\mathbf u$ w $\mathrm{m/s}$, oraz nieadiabatycznością $\beta$:

```{math}
:label: dyn-audit-zhang-li
\mathbf T_{G,ZL}=-\mathbf v_\perp+\beta\mathbf m\times\mathbf v_\perp,
\qquad
\mathbf T_{{\rm explicit},ZL}
=\frac{-(1+\alpha\beta)\mathbf v_\perp+(\beta-\alpha)\mathbf m\times\mathbf v_\perp}{1+\alpha^2}.
```

$\mathbf v_\perp=\mathbf v-(\mathbf m\cdot\mathbf v)\mathbf m$ ma jednostkę $\mathrm{s^{-1}}$. Wyraz $1/(1+\beta^2)$ w historycznej parametryzacji prędkości nie może być dodany do innej konwencji bez przeliczenia. Test samego odwrócenia prądu nie wykryje błędnego wspólnego prefaktora; potrzebna jest niezależna amplituda oraz profil o znanym gradiencie.

### Brownowski szum termiczny

Dla niezależnych standardowych zmiennych normalnych $\xi_i^a$ i pola stałego w próbkowanym interwale $\Delta t$:

```{math}
:label: dyn-audit-brown-sigma
H_{{\rm th},i}^{a}=\sigma_i\xi_i^a,
\qquad
\sigma_i^2=\frac{2\alpha k_BT}{\mu_0\gamma_HM_{s,i}V_i\Delta t}.
```

$k_B$ ma jednostkę $\mathrm{J/K}$, $T$ — $\mathrm K$, $V_i$ — $\mathrm{m^3}$, a $\sigma_i$ — $\mathrm{A/m}$. Średnia pola to zero, wariancja skaluje się jak $T/(V_i\Delta t)$. `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp::thermal_brown_sigma` implementuje dokładnie ten prefaktor z nieprzeskalowanym przez Gilberta `gyromagnetic_ratio`. Dla niepoprawnych lub niedodatnich argumentów helper zwraca zero; nie zastępuje to walidacji publicznego wejścia.

Lumping masy FEM przypisuje tu węzłową objętość $V_i$; nie jest automatycznie pełną kowariancją szumu dla consistent mass. Ta wymaga osobnego wyprowadzenia względem macierzy masy. Wspólne losowanie Heuna, interpretacja Stratonovicha i równowagowy rozkład muszą być sprawdzone razem. Sama prawidłowa sigma nie dowodzi poprawnego stochastycznego integratora. Wymaganie identycznych trajektorii różnych generatorów CPU/GPU nie zastępuje kwalifikacji statystycznej.

### Zachowanie ładunku i pole Oersteda

Dla skalarnej przewodności $\sigma_c$ w $\mathrm{S/m}$, potencjału $\phi$ w $\mathrm V$ i ustalonego transportu:

```{math}
:label: dyn-audit-charge
\mathbf J_c=-\sigma_c\nabla\phi,
\qquad
\nabla\cdot\mathbf J_c=0,
\qquad
\int_{\partial\Omega_c}\mathbf J_c\cdot\mathbf n\,dS=0.
```

$\mathbf J_c$ ma jednostkę $\mathrm{A/m^2}$. Ostatnia tożsamość wynika z twierdzenia Gaussa i jest niezależnym kryterium bilansu, również dla dyskretnych strumieni FV. Czysty Neumann wymaga kompatybilnego strumienia i usunięcia stałej z przestrzeni potencjału. Właścicielem tych operacji FDM CPU jest `crates/fullmag-engine/src/fdm/cpu/transport/charge.rs::StructuredChargeProblem`.

Dla prądu objętościowego w otwartej przestrzeni, w przybliżeniu magnetostatycznym:

```{math}
:label: dyn-audit-oersted
\mathbf H_{\rm Oe}(\mathbf r)=\frac1{4\pi}
\int_{\Omega_c}\frac{\mathbf J_c(\mathbf r')\times(\mathbf r-\mathbf r')}{|\mathbf r-\mathbf r'|^3}\,dV',
\qquad
H_\varphi(r)=
\begin{cases}Ir/(2\pi R^2),&r\leq R,\\I/(2\pi r),&r>R.\end{cases}
```

Drugi wzór jest oraklem nieskończonego cylindra o promieniu $R$, z jednorodnym prądem $I$ w amperach; nie jest rozwiązaniem każdego skończonego obwodu. Dla pola $\mathbf H$ prefaktor Biota–Savarta nie zawiera $\mu_0$; dopiero $\mathbf B=\mu_0\mathbf H$. Parametry cylindra i jego osi są reprezentowane w `crates/fullmag-ir/src/study.rs::EnergyTermIR::OerstedCylinder`. Wariant z rozwiązania prądu musi używać tego samego źródła, zamknięcia obwodu i czasu etapu co torque.

Transport spinowy wymaga dodatkowego bilansu pojemności, dyfuzji oraz reakcji exchange/dephasing/spin-flip. Torque magnetyczny musi odpowiadać wybranym kanałom przekazu momentu pędu do magnesu. Cała dywergencja prądu spinu nie jest uniwersalnie tym samym torque w problemie przejściowym, ponieważ część bilansu magazynuje spin albo oddaje moment innym rezerwuarom. Warunki izolujące, interfejsy i parametry relaksacji są częścią modelu; ich pełna numeryczna weryfikacja pozostaje NOT VERIFIED.

### Linearizacja modalna

Dla stanu bazowego $\mathbf m_0$ i stycznej perturbacji $\boldsymbol\eta$:

```{math}
:label: dyn-audit-modal
\mathbf m=\mathbf m_0+\epsilon\boldsymbol\eta+O(\epsilon^2),
\quad \mathbf m_0\cdot\boldsymbol\eta=0,
\quad \mathsf B\dot{\boldsymbol\eta}=\mathsf A\boldsymbol\eta,
\quad \mathsf A\mathbf x=\lambda\mathsf B\mathbf x.
```

W konwencji $\boldsymbol\eta(t)=e^{\lambda t}\mathbf x$ częstotliwość to $|\operatorname{Im}\lambda|/(2\pi)$ w hercach, a $\operatorname{Re}\lambda$ określa wzrost lub tłumienie w $\mathrm{s^{-1}}$. Residual eigensolve nie potwierdza równowagi $\mathbf m_0$ ani zgodności z funkcjonałem energii. Operator musi uwzględniać tę samą masę, demag, aktywne oddziaływania i warunki brzegowe co dynamika. Właściciel: `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`. Normalność operatora ani ortogonalność modów w zwykłym iloczynie euklidesowym nie są ogólną własnością tłumionego LLG.

## Integracja LLG i transakcja kroku

W FDM CPU właścicielem integratorów jest `crates/fullmag-engine/src/fdm/cpu/integrators.rs`.
Kod zawiera Heun, RK4, Bogacki–Shampine RK23, Dormand–Prince RK45 i ABM3, zarówno dla
układu AoS, jak i ścieżki SoA. Każdy kandydat jest rzutowany polityką jednostkowej sfery,
a zamrożone spiny są odtwarzane po każdym etapie. Dla RK23/RK45 kontroler rozróżnia
akceptację, retry, `dt_min`, błąd niefinitywny i wyczerpanie limitu retry; odrzucona próba
nie może zmienić stanu magnetyzacji ani czasu.

`ExchangeLlgProblem::heun_trial_with_external_stage_terms_and_lte` utrzymuje kandydat
magnetyzacji do chwili, w której zakończą się obserwacja i callback sprzężonego transportu.
`commit_heun_trial` przesuwa czas i licznik termiki dopiero po akceptacji. Dla transportu
przejściowego `coupled_imex_ark2_fixed_step_with_external_stage_terms` realizuje jawny
podział ARS(2,3,2), a runner w `crates/fullmag-runner/src/fdm/cpu/reference.rs`
porównuje jeden krok z dwoma połówkami i wycofuje oba stany przy odrzuceniu.

RK45 przechowuje FSAL, ale `dynamic_oersted` wyłącza ponowne użycie poprzedniego RHS,
ponieważ pole zależy od czasu. ABM3 ma historię RHS i restart przy zmianie kroku;
checkpoint zawiera historię, czas, poprzedni krok, seed oraz licznik termiki. To są
spójne zabezpieczenia transakcji, lecz nie dowodzą błędu globalnego ani parytetu CPU/GPU.

W FDM GPU `backends/fdm/gpu/cuda/integrators/llg_fp64.cu::llg_rhs_fp64_kernel` używa
konwencji Gilbert z `gamma/(1+alpha^2)`, normalizuje predyktor i korektor Heuna oraz
zeruje RHS zamrożonych komórek. `backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu` i odpowiadające pliki RK45 używają
embedded error, mask aktywnych/zamrożonych komórek i FSAL. Graph adaptive może wykonywać
retry na urządzeniu, ale nie z aktywnym GPU spin transportem: `compute_rhs_into` zwraca
`adaptive_device_loop_gpu_transport_unsupported`. Jest to jawna granica implementacji,
a nie dowód, że ten wariant można bezpiecznie zastąpić Heunem.

FEM CPU ma osobne implementacje w `backends/fem/cpu/mfem/integrators/`: `backends/fem/cpu/mfem/integrators/llg_rhs.cpp`,
`backends/fem/cpu/mfem/integrators/heun.cpp`, `backends/fem/cpu/mfem/integrators/rk4.cpp`, `backends/fem/cpu/mfem/integrators/rk23.cpp`, `backends/fem/cpu/mfem/integrators/rk45.cpp`, `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` i
`backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp`. `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp` ma wspólną politykę decyzji, a
`backends/fem/cpu/mfem/interactions/transport_stage.cpp` dostarcza etapowe źródła. FEM GPU rozdziela etap RHS, predykcję,
error kernels i transakcję w `backends/fem/gpu/cuda/integrators/rk/`; obecność tych
modułów nie jest dowodem uruchomienia na urządzeniu ani zgodności z MFEM CPU.

## Relaksacja i znaczenie czasu

`crates/fullmag-runner/src/fdm/cpu/reference.rs::build_reference_problem` ustawia
relaksację LLG overdamped przez wyłączenie precesji. Dla `ProjectedGradientBb` i
`NonlinearCg` runner omija całkowanie czasu i wywołuje bezpośredni minimizer. Wynik
publikuje liczbę kroków, line-search backtracks, ewaluacji energii/pola oraz plateau,
ale pseudo-czas nie jest czasem fizycznym. `crates/fullmag-runner/src/time_events.rs::build_native_fem_stage_event_schedule`
celowo nie materializuje okresowych zdarzeń dla direct minimization.

FDM CPU zachowuje oddzielnie warunek momentu/gradientu, plateau energii, liczbę kroków
i jawny powód zakończenia. FEM CPU ma `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`, `nonlinear_cg.cpp`,
`direct_energy_increment.cpp` oraz `backends/fem/cpu/mfem/relaxation/relaxation_step.cpp`; FEM GPU ma ich odpowiedniki
PGBB/NCG i preconditioner. Brakuje jednak świeżego testu, który na tej samej geometrii
wykaże zbieżność, niezależność od skali i zgodność wyniku między czterema torami.

## STT, SOT i torques z transportu

W FP64 CUDA kernel `llg_rhs_fp64_kernel` zawiera trzy rozdzielone źródła: Zhang–Li
z wersją centralną albo historycznym upwind, Slonczewski z funkcją polaryzacji i
`epsilon_prime`, oraz prescribed SOT z wersją formuły i maską celu. Torques są dodawane
do RHS po konwersji Gilbert; `project_frozen` zeruje końcowy RHS zamrożonych komórek.
Parametry są materializowane w `crates/fullmag-runner/src/fdm/cpu/reference.rs::build_zl_stt`, `build_slon_stt` i
`build_sot`, więc plan zachowuje wersję formuły oraz maskę, ale nie ustanawia parytetu.

FEM GPU ma `backends/fem/gpu/cuda/integrators/rk/rk_zhang_li_torque.cu` i `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu`, a FEM CPU etapowe źródło
`backends/fem/cpu/mfem/interactions/transport_stage.cpp`. Wymaga to osobnych testów znaku, jednostek, maski targetu i zgodności w czasie; test konfiguracji nie
potwierdza torque na rozwiązanej trajektorii. Stan wszystkich czterech realizacji dla
dynamicznego STT/SOT pozostaje `NOT VERIFIED`.

## Termika i retry

FDM CPU przechowuje temperaturę, seed i `thermal_step`; `crates/fullmag-engine/src/fdm/cpu/integrators.rs::set_thermal_dt_for_attempt`
ustawia rozmiar interwału próby, a akceptacja wywołuje `advance_thermal_step`. Mechanizm próby ponownie używa tego samego losowania interwału i skaluje je do nowego `dt`, nie zwiększając licznika przy odrzuceniu. Publiczny planner `crates/fullmag-plan/src/fdm.rs` odrzuca jednak połączenie Brown thermal z adaptive timestep oraz ABM3; obecność tego mechanizmu nie kwalifikuje adaptacyjnego SDE. To chroni od przedwczesnego przesunięcia procesu
losowego, lecz wymaga niezależnej walidacji rozkładu i korelacji czasowej.

CPU FEM ma `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp::thermal_brown_sigma`, `backends/fem/cpu/mfem/interactions/thermal_brown_field.cpp` i
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp`; test `backends/fem/tests/thermal_brown_contract.cpp` sprawdza
konwencję sigma i politykę nieprawidłowych danych. GPU FEM ma `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu` oraz `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu`, lecz `crates/fullmag-plan/src/fem.rs` jawnie odrzuca strict FEM GPU `ThermalNoise` przez `CAP-THERM-GPU-001`. Obecność tych plików nie oznacza publicznie dostępnej realizacji. CUDA FDM ma odpowiadający kontrakt i test FSAL/thermal, lecz żaden
z tych testów nie jest pełnym receiptem GPU z seedem, urządzeniem, trajektorią i statystyką.

## Charge, spin i sprzężenie czasowe

Rustowy charge transport jest właścicielem `StructuredChargeProblem::{face_fluxes,
conservative_divergence,solve,balance_diagnostics}`. Używa zorientowanych strumieni FV,
jawnego gauge dla czystego Neumanna, kontroli dodatniej przewodności i bilansu prądu.
`SpinDriftDiffusionProblem::{face_fluxes,steady_residual,reaction_channels,solve}` dodaje
dyfuzję, spin Hall, reakcje spin-flip/exchange/dephasing, interfejsy i absorpcję; torque
Gilberta jest tworzony dopiero po jawnych targetach `Ms` i `gamma_e`.

`TransientSpinIntegrator` ma wersję `transient_spin_balance.fullmag.v1` i ARS
`coupled_imex_ark2.v1`, z fizyczną pojemnością spinu, GMRES, step-doubling, checkpointem
oraz ochroną historii BDF2 przed nierównym krokiem. W runnerze nieprzejściowy transport
FDM CPU wymusza stały Heun i odrzuca adaptive timestep z komunikatem o braku obsługi
rejection. Transport przejściowy ma osobny workflow, kopiowane stany próbne i jawny
rollback. Są to poprawne granice fail-closed; nie należy przedstawiać ich jako pełnej
swobody integratora.

FDM GPU ma `context_evaluate_gpu_transport_rhs`, `launch_add_gpu_transport_torque_fp64`
oraz checkpoint/layout ABI. Ścieżka może odświeżać transport na etapach hostowych, ale
adaptive device graph odrzuca aktywny transport. W provenance rozróżnia się `fdm_cuda`
od Rust reference, jednak validation state pozostaje `unvalidated`. FEM CPU ma steady
transport w `backends/fem/cpu/mfem/transport/steady_transport.cpp` z testami ABI i
`backends/fem/cpu/mfem/transport/conservative_current_view.cpp`; nie znaleziono dowodu, że rozwiązanie charge/spin jest
włączone do dynamicznego LLG dla wszystkich materiałów i warunków brzegowych. FEM GPU
nie ma w tym audycie dowodu takiego sprzężenia.

## Oersted i pola zależne od czasu

FDM CPU buduje cylinder w `crates/fullmag-runner/src/fdm/cpu/reference.rs::build_oersted`, materializuje dynamiczne pole
przez `resolved_per_node_external_field_for_count` i oddziela je od anteny w
`resolved_oersted_visual_field_for_count`. Implementacja operatora korzysta z FFT/open
boundary oraz diagnostyki direct w `backends/fdm/cpu/interactions/oersted/`. Dynamiczny
Oersted wyłącza FSAL i jest oceniany w czasie etapu; testy sprawdzają punkt pola i maskę,
lecz nie dają świeżego zamknięcia fizycznego dla pełnej trajektorii.

FEM CPU rozdziela bezpośrednią całkę tetraedrów od vector potential w
`backends/fem/cpu/mfem/interactions/oersted/`; FEM GPU ma `backends/fem/gpu/cuda/interactions/oersted/oersted_kernels.cu`. Nie ma
aktualnego dowodu, że te dwa warianty dają zgodne pole i pracę dla tej samej siatki,
przewodnika, orientacji, obwiedni czasu i maski celu. Energia pola dynamicznego nie
powinna być utożsamiana z energią konserwatywną bez jawnej definicji pracy źródła.

## Próbkowanie oraz mody

`crates/fullmag-runner/src/time_events.rs::build_resolved_stage_event_schedule` scala
granice etapów, obwiednie i żądane czasy, zaś `schedules.rs::advance_due_schedules`
rejestruje dane po zaakceptowanych krokach. Przy adaptive `t_n` nie jest szeregiem
równomiernym; kod nie dowodzi dense output. Zatem bez kwalifikowanego resamplingu nie
wolno traktować bezpośredniej listy accepted samples jako certyfikowanego FFT.

Problem modalny ma osobną ścieżkę `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`
i nagłówek `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`. Jest to liniaryzacja wokół stanu, a nie dowód
stabilności nieliniowego LLG ani dowód, że FDM i FEM mają ten sam operator. Dla obecnego
checkoutu wykonanie eigensolve, normalizacja modów, ortogonalność, zbieżność siatki i
parytet z trajektorią czasową są `NOT VERIFIED`.

## Ustalenia i ryzyka

| ID | Priorytet | Ustalenie | Status |
|---|---:|---|---|
| DYN-01 | P1 | Źródła integratorów istnieją w czterech drzewach, lecz brak kompletu świeżych managed receipts obejmującego LLG, energię, normę i parytet CPU/GPU. | `NOT VERIFIED` |
| DYN-02 | P1 | FDM CPU odrzuca nie-Heunowy/adaptive wariant dla nieprzejściowego spin transportu; fallback jest zabroniony. | `POTWIERDZONE — fail-closed` |
| DYN-03 | P1 | FDM GPU odrzuca adaptive device graph z aktywnym GPU transportem (`adaptive_device_loop_gpu_transport_unsupported`). | `POTWIERDZONE — ograniczenie` |
| DYN-04 | P1 | Termika ma transakcyjny retry CPU, ale rozkład, seed parity, GPU execution i statystyka nie są kwalifikowane. | `NOT VERIFIED` |
| DYN-05 | P2 | Accepted-step scheduling nie dostarcza sam z siebie równomiernej serii do widma. | `POTWIERDZONE — ograniczenie` |
| DYN-06 | P1 | Mody są opisane przez FEM linearized pencil; brak dowodu wykonania i zgodności z nieliniowym LLG. | `NOT VERIFIED` |
| DYN-07 | P2 | Direct minimization publikuje synthetic step metrics, nie fizyczny czas i nie dynamiczne próbki. | `POTWIERDZONE — semantyka` |

## Warunki domknięcia

1. Dla każdego integratora wykonać test jednego spinu z rozwiązaniem analitycznym, test
   normy, test znaku precesji/tłumienia oraz test zbieżności kroku; osobno dla AoS/SoA.
2. Powtórzyć identyczny przypadek FDM CPU, FDM GPU, FEM CPU i FEM GPU z przypiętą
   geometrią, siatką, maską, parametrami, seedem, precision, urządzeniem i receipt.
3. Dla STT/SOT/Oersted porównać pole/torque na każdym etapie, a nie tylko końcową energię;
   sprawdzić maski, jednostki, znak, obwiednię czasu i aktywne komórki.
4. Dla termiki pokazać kontrolę rozkładu, niezależność od retry, zgodność seedów oraz
   statystyczny test CPU/GPU z określonymi tolerancjami.
5. Dla charge/spin wykazać niezależny residual, bilans strumienia, closure torque,
   zbieżność solvera i niezmienność checkpoint/rollback; dla adaptive transportu
   przypiąć akceptację lub jawny `UNSUPPORTED` dla każdej ścieżki.
6. Dla modów dołączyć stan bazowy, operator liniowy, normę, warunki brzegowe, zbieżność
   siatki i porównanie z mało-amplitudową trajektorią czasową.
7. Dla widm dodać gęsty output albo kwalifikowany resampling z zachowaniem exact physical
   time series, błędem interpolacji i provenance źródłowych accepted steps.

Do czasu spełnienia tych warunków nie ma podstaw do stwierdzenia, że dynamika,
transport i mody są poprawnie wdrożone oraz zwalidowane we wszystkich czterech
realizacjach. Obecne odmowy są jawne i bezpieczne, ale brak dowodu runtime pozostaje
`NOT VERIFIED`.
