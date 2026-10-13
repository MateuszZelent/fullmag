# BORIS — szczegółowy audyt transportu, elektrod, pola Oersteda i zastosowania do anten Fullmaga

Data: 2026-10-11. Status: **wewnętrzny audyt źródłowy**, nie kwalifikacja solvera ani nowy kontrakt fizyczny Fullmaga. Dokument zapisano w wersjonowalnym katalogu, nie w ignorowanym `docs/raports/`.

## 1. Werdykt i granice dowodów

BORIS rzeczywiście ma sprzężony transport ładunku i spinu, elektrody, pole Oersteda, momenty spinowe oraz modelowanie grzania Joule'a. To wartościowy punkt odniesienia dla anteny wzbudzającej fale spinowe. Nie należy jednak utożsamiać tego zakresu z pełnym solverem elektromagnetycznym anten mikrofalowych: badana ścieżka transportu i Oersteda nie wyznacza propagacji RF, impedancji falowej, skin/proximity effect ani parametrów rozpraszania portów.

Najważniejsze praktyczne wnioski:

1. Zachować nasz rozdział: geometria przewodnika → terminale i zasilanie → zaakceptowane V/J → pole Oersteda → baza na amper → waveform → LLG → analiza odpowiedzi.
2. Dla niezmiennego liniowego przewodnika obliczać bazę raz. Sinus prądu wymaga skalowania pola w czasie, a nie ponownego rozwiązania transportu czy FFT w każdym kroku.
3. Terminal elektryczny nie jest geometrią doprowadzenia ani dowodem zamknięcia źródła magnetycznego. BORIS nie usuwa naszej otwartej bramki obwodu.
4. Ten sam zaakceptowany prąd musi zasilać bilanse, wizualizację J i Oersteda. W ogólnym spinowym modelu BORIS te ścieżki nie używają identycznego wyrażenia konstytutywnego.
5. Znaleziono źródłową transpozycję w porównywarce Fullmag–BORIS i podejrzane fragmenty BORIS. Nie wolno użyć BORIS jako bezwarunkowego oracle fizyki.

**Czego nie wykonano:** kompilacji BORIS, uruchomienia jego CPU/CUDA, benchmarku anteny, porównania pól numerycznych ani kwalifikacji czterech backendów Fullmaga. Opisy `VERIFIED` wewnątrz kodu nie są dowodami takiej kwalifikacji.

## 2. Tożsamość źródeł i metoda audytu

W `external_solvers` zarówno obecnego worktree, jak i głównego checkoutu na tym komputerze nie znaleziono BORIS. Nie zainicjalizowano pozostałych submodułów i nie zmieniono tego katalogu.

Odczytano osobną, płytką kopię oficjalnego repozytorium:

- upstream: <https://github.com/SerbanL/BORIS>;
- pełny commit: `048503d2ca6475e91b073eb1762ecf9d3634c3e1`;
- data commita: `2023-11-02T10:23:43Z`, komunikat `master update 02/11/23`;
- lokalnie: `D:/git/fullmag/storage/tmp/boris-audit-20261011`;
- README: linia multi-GPU obejmująca funkcjonalność Boris 3.8, opisana jako prerelease wymagający dalszych testów;
- `LICENSE`: tekst GNU GPL v3; audyt nie kopiuje implementacji do Fullmaga;
- tożsamość odczytanych plików: [manifest dowodów](2026-10-11-boris-transport-oersted-antenna-audit.evidence.json).

Wszystkie ścieżki `Boris/...`, `BorisLib/...` i `BorisCUDALib/...` poniżej odnoszą się do tego commita, **nie do historycznego ignorowanego snapshotu Fullmaga**. Manifest `docs/physics/multilayer_convolution/boris-reference-manifest.v1.json` z sierpnia nie zawiera upstream SHA; jego tożsamość i niniejsza tożsamość nie są zamienne.

Zastosowano `scientific-documentation-contract`: oddzielono równania, jednostki, mapowanie źródeł, realizacje i poziomy dowodów. Ten raport pozostaje audytem wewnętrznym; nie jest terminalną publikacją naukową, nie ustanawia nowych parametrów Python/IR i nie zastępuje pełnej noty 0950 lub 0970. Publikacja nowej fizyki wymaga osobnej kompletnej noty, source map i jej bramek walidacji. Nie wymyślono wykonywalnego przykładu API dla niezakwalifikowanych funkcji.

## 3. Mapa właścicieli w BORIS

| Obszar | Ścieżka i symbol | Rzeczywista odpowiedzialność |
|---|---|---|
| Transport lokalny | `Boris/Transport.cpp::Transport`, `Boris/TransportBase.h::TransportBase` | Stan V/E/S, współczynniki materiałowe, lokalne operatory i obserwable |
| Transport wielomateriałowy | `Boris/STransport.cpp::STransport`, `STransport::UpdateField` | Elektrody, sterowanie, kontakty między siatkami, kolejność iteracji |
| Przewodnictwo | `Boris/Transport_Charge.cpp::Evaluate_ChargeSolver_delsqV_RHS` | Równanie potencjału charge-only |
| Iteracje charge | `Boris/STransport_Charge.cpp::solve_charge_transport_sor` | Red-black SOR na siatkach i aktualizacje kontaktów |
| Transport spinu | `Boris/Transport_Spin.cpp::Evaluate_SpinSolver_delsqS_RHS` | Akumulacja spinowa, relaksacja, dephasing i źródła |
| Interfejs spinowy | `Boris/STransport_Spin_GInterf.cpp::Afunc_N_S` | Warunki circuit theory, przewodności kontaktowe, pumping |
| Pole Oersteda | `Boris/Oersted.cpp::Oersted::UpdateField` | Transfer źródła na supermesh, konwolucja, dodanie H do siatek magnetycznych |
| Jądro pola | `Boris/OerstedTFunc.cpp::OeFunc::CalcOerstedTensors` | Analityczne współczynniki dla prostokątnych komórek |
| FFT | `Boris/OerstedKernel.cpp::OerstedKernel::Calculate_Oersted_Kernels_3D` | Jednorazowy kernel w przestrzeni Fourierowskiej i mnożenie widm |
| GPU | `Boris/OerstedCUDA.cpp::OerstedCUDA::UpdateField` | Konwolucja CUDA, rozkład x między urządzeniami, transfery |
| Dynamika i field-only | `Boris/SuperMeshSimulation.cpp::SuperMesh::AdvanceTime`, `SuperMesh::ComputeFields` | Wywołania modułów przed integracją lub bez przesuwania czasu |
| Ciepło | `Boris/Heat_Solve.cpp::Heat::IterateHeatEquation_1TM` | FTCS i źródło Joule'a na oddzielnej siatce termicznej |

To multi-mesh FDM. Podział modułów jest użyteczny; nie jest instrukcją przeniesienia jego siatek, klas ani SOR do naszego MFEM.

## 4. Transport charge-only i elektrody

### 4.1. Wyprowadzenie i warunki brzegowe

Prawo Ohma i stacjonarne zachowanie ładunku dają:

```{math}
:label: boris-audit-ohmic
\mathbf E=-\nabla V,\qquad
\mathbf J_c=\sigma\mathbf E,\qquad
\nabla\cdot\mathbf J_c=0
\quad\Longrightarrow\quad
\nabla\cdot(\sigma\nabla V)=0.
```

Kod `Transport::Evaluate_ChargeSolver_delsqV_RHS` rozwija to dla dodatniej, lokalnie gładkiej przewodności do równania Laplace'a z prawą stroną $-(\nabla\sigma\cdot\nabla V)/\sigma$. Przy skokach materiałowych konieczny jest osobny warunek kontaktu; nie wolno stosować tego rozwinięcia jako klasycznej pochodnej przez nieciągłość.

`STransport::electrode_rects` i `TransportBase::SetFixedPotentialCells` realizują patche Dirichleta na powierzchniach. Na pozostałych izolowanych granicach obowiązuje zerowy normalny prąd. `set_cmbnd_charge_transport` i `VEC_VC::set_cmbnd_continuous` obsługują idealny kontakt: ciągłość V i normalnego strumienia, z rekonstrukcją z sąsiednich komórek. Wymagane są co najmniej dwie niepuste komórki normalnie do kontaktu.

**Elektroda nie modeluje przewodu zasilającego.** Rozwiązanie V/J w wyciętej domenie z otwartymi terminalami nie określa automatycznie pola brakujących kabli, źródła i powrotu prądu. Dla microstrip trzeba jawnie uwzględnić pasek sygnałowy, powrót oraz zakres modelowanych doprowadzeń. Szeroka płaszczyzna powrotna sama w sobie jest fizycznie dopuszczalna; nie należy zamieniać jej na CPW tylko dla wyglądu.

### 4.2. Sterowanie i diagnostyki

`STransport::adjust_potential` ustawia ground na $-\Delta V/2$, wszystkie pozostałe elektrody na $+\Delta V/2$. Ground jest tu etykietą polaryzacji/odniesienia, nie zawsze wartością zero. To nie jest ogólny niezależny wieloport.

`STransport::GetCurrent` mierzy prądy elektrodowe, sumuje `net_current`, po czym koryguje prąd ground przez odjęcie defektu podzielonego przez liczbę elektrod. W trybie constant-I także zmienia napięcie i następnie wpisuje prąd żądany do `current`. `GetResistance` wywołuje ten mutujący getter.

Wniosek Fullmag: osobne wartości **żądane**, **surowo zmierzone**, **defekt Kirchhoffa** i **napięcia rozwiązania**. Nie wolno skorygować pomiarów tak, żeby bilans wyglądał na poprawny, ani zastąpić pomiaru wartością requested.

`STransport::UpdateField` wykonuje jeszcze solve po korekcie constant-I. Nie jest to jednak pełna pętla akceptacji wszystkich prądów terminalowych; komentarz w kodzie sam wskazuje potrzebę dodatkowego kryterium.

### 4.3. SOR, tolerancje i ograniczenia

Wskaźnik SOR jest ilorazem maksymalnej zmiany iteracyjnej i maksymalnej wartości V; przy zerowym mianowniku używana jest zmiana absolutna. To nie residual PDE, nie lokalny bilans ani certyfikat prądu. Zależy od gauge. Komórki kontaktów są aktualizowane po redukcji i nie są objęte tym samym maksimum.

| Parametr kodu `STransport.h` | Typ / wartość początkowa | Jednostka i znaczenie | Granica interpretacji |
|---|---|---|---|
| `errorMaxLaplace` | `double`, `1e-6` | $1$, względny wskaźnik iteracyjny V | Przy zerowym maksimum używa zmiany bez normalizacji |
| `maxLaplaceIterations` | `int`, `500` | $1$, limit iteracji | Osiągnięcie limitu nie dowodzi zbieżności |
| `s_errorMax` | `double`, `1e-5` | $1$, względny wskaźnik S | Nie jest bilansem spinu |
| `s_maxIterations` | `int`, `200` | $1$, limit iteracji S | Osobny od charge |
| `SOR_damping` | `DBL2`, `(1.4,0.5)` | $1$, tłumienie V/S | Nie przyjmować jako polityki solvera Fullmaga |
| `ground_electrode_index` | `int`, `-1` | $1$, brak ground | Nie jest geometrycznym zamknięciem |
| `constant_current_source` | `bool`, `false` | $1$, korekta napięć | Raportowana wartość nie jest certyfikatem pomiaru |
| `open_potential_resistance` | `double`, `0.0` | $\Omega$, specjalny model termoelektryczny | Nie jest impedancją mikrofalowego portu |

To tabela obserwowanych defaults, nie pełna zwalidowana dokumentacja publicznych komend BORIS. Ich domeny walidacji nie zostały zakwalifikowane w runtime.

## 5. Pole Oersteda — co BORIS liczy i jak

### 5.1. Równanie ciągłe i dyskretyzacja

W modelu magnetostatycznym z zadanym konwencjonalnym prądem:

```{math}
:label: boris-audit-biot-savart
\mathbf H_{\mathrm{ant}}(\mathbf r)
=\frac{1}{4\pi}\int_{\Omega_c}
\frac{\mathbf J_c(\mathbf r')\times(\mathbf r-\mathbf r')}
{\lvert\mathbf r-\mathbf r'\rvert^3}\,\mathrm d^3r',
\qquad \mathbf B_{\mathrm{ant}}=\mu_0\mathbf H_{\mathrm{ant}}.
```

Ostatnia relacja oznacza wkład pola swobodnego prądu w przyjętym niemagnetycznym środowisku, nie całkowite B zawierające magnetyzację obiektu. Normalizacja H nie zawiera dodatkowego $\mu_0$.

Dla komórek prostokątnych i stałego J w każdej komórce pole jest liniowym splotem. Jądro ma zero na przekątnej i trzy niezależne elementy antysymetryczne. Jego parzystości względem osi pozwalają przechowywać mniej współczynników.

`OeFunc::G1` i `OeFunc::I2` wyznaczają współczynniki przez analityczne prymitywy i 27-punktową kombinację różnicową; `sum_KahanNeumaier` ogranicza utratę cyfr przy sumowaniu. Z analizy wymiarów G1 ma wymiar długości do czwartej potęgi, I2 i kernel — długości. Kernel pomnożony przez J w $\mathrm{A\,m^{-2}}$ daje H w $\mathrm{A\,m^{-1}}$.

Nie odtworzono niezależnie całego prymitywu G1 i nie sprawdzono jego błędu dalekiego pola. Analityczna postać i sumowanie kompensowane nie dowodzą poprawności w wszystkich reżimach. Do kwalifikacji potrzeba niezależnej całki i testów symetrii/znaków.

### 5.2. FFT i cache

`OerstedKernel::Calculate_Oersted_Kernels_3D` oblicza tensor i transformuje go FFTW. `ConvolutionData::SetConvolutionDimensions` podwaja nieperiodyczne rozmiary i stosuje zero-padding; to splot liniowy, nie fizyczna periodyczność. Oersted wymusza co najmniej dwie komórki w każdej osi; jego ścieżka 2D nie jest używana.

W `Oersted::Initialize`:

1. wybierane są wszystkie siatki z obliczeniami elektrycznymi;
2. jako źródło bierze się mnożone wartości E i `elC`;
3. są przenoszone na wspólną regularną siatkę;
4. pole transferowane jest do siatek z obliczeniami magnetycznymi, także obu podkrat AFM;
5. kernel jest przeliczany po zmianie jego wymiarów, nie przy każdym wywołaniu.

`Oersted::UpdateField` wykonuje konwolucję, gdy `STransport::Transport_Recalculated()` jest prawdziwe lub brak pierwszego pola; inaczej wykorzystuje już policzone H. To invalidacja zależna od aktualizacji transportu, **nie zamrożona baza per-A z dowolnym szybkim waveformem**.

Transfer na wspólną siatkę jest dodatkowym operatorem i źródłem błędu. W Fullmagu nie należy interpolować FEM RT0 na przypadkową siatkę i nazywać otrzymanego J konserwatywnym. Przyspieszenie FFT wymaga jawnego, zakwalifikowanego operatora źródło→scratch→target oraz testu bilansów i pola.

### 5.3. Kluczowe ograniczenie: który J zasila Oersteda?

W BORIS źródłem Oersteda i miernika prądów elektrodowych jest $\sigma\mathbf E$. Natomiast `Transport::GetChargeCurrent` dla transportu spinowego dodaje m.in. iSHE, spinowo-polaryzowaną dyfuzję, THE i charge pumping. `CalculateElectricField` uwzględnia iSHE w warunkach brzegowych gradientu V, ale nie dodaje do E całego jawnego członu curl S używanego przez `GetChargeCurrent`.

Dlatego **porównanie Oersteda ze spinowym J wyświetlanym przez BORIS nie jest automatycznie porównaniem tego samego źródła**. Dla czysto omowej niemagnetycznej anteny oba wyrażenia się redukują do tego samego J. Dla pełnego sprzężenia trzeba tę różnicę jawnie zbadać; nie stwierdzono runtime błędu wszystkich przypadków.

Fullmag: wizualizacja J musi pokazywać dokładnie prąd użyty przez operator pola, z tym samym mesh, materiałem, terminalami i provenance. To uzasadnia obecny owned snapshot RT0, zamiast odtwarzania J w frontendzie.

### 5.4. CUDA i energia

`OerstedCUDA::Initialize` wymaga partycjonowania x dla wielu GPU i wystarczającej liczby komórek. `OerstedKernelCUDA::Calculate_Oersted_Kernels_3D` przygotowuje kernel z użyciem CPU/FFTW i kopiuje go na GPU. Multi-GPU `UpdateField` zawiera jawne transfery/transpozycje FFT i synchronizacje; jest też opcjonalny tryb transferów o obniżonej precyzji. Obecność kernelu nie dowodzi pełnej device residency inicjalizacji ani parytetu FP64.

`Oersted::UpdateField` zwraca zero i komentarz wyłącza wkład pola z całkowitej energii. Nie kopiować tej semantyki do Fullmaga: zewnętrzne zadane pole ma energię Zeemana $-\mu_0\int\mathbf M\cdot\mathbf H_{\mathrm{ant}}\,\mathrm d^3r$. Bilans mocy wymuszania zależnego od czasu jest osobnym zagadnieniem.

## 6. Jednorazowy solve i sygnał sinusoidalny

### 6.1. Dlaczego baza wystarcza

Przy niezmiennych geometrii, przewodności, kontaktach i liniowych warunkach źródłowych operator przewodnictwa jest liniowy. Rozwiązanie dla prądu odniesienia wyznacza odpowiedź na jednostkę prądu; liniowy operator Biota–Savarta zachowuje tę liniowość:

```{math}
:label: boris-audit-separable-basis
\mathbf J_c(\mathbf r,t)=\sum_p I_p(t)\mathbf j_p(\mathbf r),\qquad
\mathbf H_{\mathrm{ant}}(\mathbf r,t)=\sum_p I_p(t)\mathbf h_p(\mathbf r),
\qquad I_p(t)=I_{0,p}\sin(2\pi f_pt+\phi_p).
```

$\mathbf j_p$ i $\mathbf h_p$ są odpowiedziami **na amper**, a nie polami, które można ponownie pomnożyć przez prąd już zastosowany w solve. Dla dodatnich/ujemnych prądów używać podpisanej normalizacji. Dla kilku portów zamrozić także rozdział prądów powrotnych.

W takim modelu LLG płaci za skalowanie/wektorowe sumowanie pól na targetach, nie za solve V/J ani całkę/FFT. Waveform musi być obliczany w czasie każdego rzeczywistego podkroku RK. Stan badanej ścieżki BORIS: V/I equation jest oceniane z czasem etapu po całym kroku; nie dowodzi tej dokładności podkrokowej.

`SuperMesh::ComputeFields` nie wywołuje integratora ODE, a `UpdateTransportSolver` pozwala wywołać sam transport. Wspiera to rozdział field-only od LLG na poziomie źródłowej architektury. Nie wykonano jednak poleceń NetSocks ani kompletnej sceny bez magnetycznego targetu; `Oersted::Initialize` wymaga niepustych domen elektrycznej i ferromagnetycznej.

### 6.2. Kiedy separacja przestaje być poprawna

Zmienne $\sigma(T,\mathbf m)$, nieliniowe kontakty, spin/charge pumping albo zmiana profilu prądu przez indukcję wymagają osobnej polityki sprzężenia i invalidacji. Stałe źródło addytywne wymaga odpowiedzi affine: baza plus człon niezależny, nie samego mnożenia przez I.

Przy mikrofalach należy ocenić skin depth i opóźnienie elektromagnetyczne:

```{math}
:label: boris-audit-mqs-validity
\delta=\sqrt{\frac{2}{\omega\mu\sigma}},\qquad
\omega=2\pi f,\qquad k_{\mathrm{EM}}L\ll1.
```

Formuła skin depth dotyczy jednorodnego dobrego przewodnika w harmonicznym reżimie; nie jest modelem szczelin ani pełnej anteny. Mały rozmiar względem długości fali nie gwarantuje jednorodnego prądu przez grubość. Powyższe kryteria nie są nową implementacją w BORIS. Właścicielem trzech poziomów Fullmaga — separowalny quasistatic, harmonic MQS, full-wave — pozostaje nota 0950. Harmoniczna baza zespolona jest liczona osobno dla częstotliwości; nie oznacza konieczności ponownego solve przy każdym kroku sinusoidalnego LLG.

## 7. Transport spinu — przydatna fizyka, nie warunek omowej anteny

### 7.1. Zmienna spinowa i kolejność

`STransport::solve_spin_transport_sor` rozwiązuje najpierw V, potem aktualizuje E, następnie rozwiązuje S. Człony źródłowe są przygotowywane przez `PrimeSpinSolver_Charge/Spin`. To sekwencyjny quasistatyczny algorytm; nie transient transport spinu i nie dowód rozwiązania pełnego sprzężonego bloku z kontrolowanym residualem.

BORIS przechowuje akumulację magnetycznego momentu spinu $\mathbf S$ w jednostkach $\mathrm{A\,m^{-1}}$ i tensor strumienia momentu $J^s_{ia}$ w $\mathrm{A\,s^{-1}}$. Te jednostki są także jawnie zadane w `Boris/Simulation.cpp` przy konstrukcji `dataDescriptor`. Nie jest to Fullmagowe pełne rozszczepienie spinowe w woltach. W `Transport::cfunc_sec` i `cfunc_pri` współczynnik $D_e/(\sigma c)$ przelicza S na potencjał $V_s$, gdzie $c=\mu_B/e$. To ustalenie wymiarowe i źródłowe, nie samodzielny dowód identyczności kanałowego rozszczepienia.

### 7.2. Obserwowany tensor i relaksacja

Dla ferromagnetyka bez dodatkowego pumping/THE oraz niemagnetyka z SHE, `Transport::GetSpinCurrent` daje odpowiednio:

```{math}
:label: boris-audit-spin-constitutive
J^s_{ia,\mathrm F}=-cP\sigma E_i m_a-D_e\partial_i S_a,\qquad
J^s_{ia,\mathrm N}=c\theta\sigma\epsilon_{iak}E_k-D_e\partial_i S_a.
```

Pierwszy indeks to **kierunek przepływu**, drugi — polaryzacja. Ta identyfikacja wynika z `Types_VAL.h::operator|` i `VEC_VC_Grad.h::grad_neu`, nie z samej nazwy `Jsx`. $\epsilon_{xyz}=+1$. Dla dodatniego Ex i theta: $J^s_{zy}<0$, $J^s_{yz}>0$ w źródłowej konwencji BORIS.

`Evaluate_SpinSolver_delsqS_RHS` zawiera:

```{math}
:label: boris-audit-spin-relaxation
\nabla^2\mathbf S=
\frac{\mathbf S}{\lambda_{\mathrm{sf}}^2}
+\frac{\mathbf S\times\mathbf m}{\lambda_{\mathrm{ex}}^2}
+\frac{\mathbf m\times(\mathbf S\times\mathbf m)}{\lambda_{\mathrm{ph}}^2}
+\mathbf F_{\mathrm{src}}.
```

Źródło obejmuje konfigurację dryfu/pumping/THE/SHE; nie zastąpiono jego wszystkich gałęzi jednym ręcznie uproszczonym wzorem. W niemagnetyku człony exchange/dephasing z m są pominięte. Na izolowanym brzegu z SHE zerowy flux wymaga niejednorodnego warunku dla gradientu S, a nie automatycznie $\partial_n S=0$.

`NHNeumann_Vdiff` ma osobny parametr `iSHA`; `NHNeumann_Sdiff` używa `SHA`. Te parametry nie są w kodzie publicznym zawsze wymuszone jako równe. Wzajemność Onsagera wymaga jawnych konwencji i testu, nie podobnych nazw.

W N, przy odpowiedniej rekonstrukcji brzegowej, `GetChargeCurrent` dodaje:

```{math}
:label: boris-audit-ishe
\mathbf J_{c,\mathrm N}=\sigma\mathbf E+
\frac{\theta_{\mathrm{inv}}D_e}{c}\nabla\times\mathbf S.
```

$\theta_{\mathrm{inv}}$ oznacza `iSHA`. W `PrimeSpinSolver_Spin` źródło SHE zawiera dywergencję tensora `epsilon3(E)`, nie zwykłą skalarną dywergencję E. To doprecyzowanie skrótu w starszym audycie. Nazwa `l_ex` oznacza tutaj długość rotacji spinu, nie micromagnetyczną długość wymiany.

### 7.3. Bulk torque i kontakty

`GetSpinTorque` oblicza objętościowy transfer momentu:

```{math}
:label: boris-audit-bulk-torque
\mathbf T_{\mathrm{bulk}}=\eta_s D_e
\left[\frac{\mathbf S\times\mathbf m}{\lambda_{\mathrm{ex}}^2}
+\frac{\mathbf m\times(\mathbf S\times\mathbf m)}{\lambda_{\mathrm{ph}}^2}\right].
```

To tempo momentu magnetycznego w $\mathrm{A\,m^{-1}\,s^{-1}}$, nie bezpośrednio bezwymiarowe RHS dm/dt ani tesle. `CalculateSAField` buduje pole zastępcze z dodatkowymi prefaktorami; trzeba sprawdzić gamma, M i damping przed porównaniem LLG.

Interfejsy N/F/T mogą używać ciągłego kontaktu albo `Gi` i zespolonego `Gmix`; `CalculateDisplaySAInterfaceTorque` oblicza osobno interfacial torque z potencjałów spinowych ekstrapolowanych do interfejsu. Właściciel parametrów jest wybierany według strony/top-contact. To użyteczny przykład rozdziału fluxu i torque, lecz w Fullmagu właściciel interfejsu powinien być jawny, a nie wywnioskowany z ułożenia obiektów.

Display interfacial torque jest rozsmarowany na komórkę magnetyczną o grubości normalnej $d_h$, z prefaktorem $2c_g/d_h$, gdzie $c_g=g\mu_B/(2e)$. W kodzie `GMUB_2E` nie jest numerycznie identyczny z `MUB_E`; nie redukować wszystkich prefaktorów do jednego bez sprawdzenia g.

Przy stałym module magnetyzacji $M_s$, bare normalized source $\mathbf t_s=\mathbf T_{\mathrm{bulk}}/M_s$ nie jest tym samym co solved Gilbert source. `DifferentialEquationFM::LLG` po dodaniu pola spinowego daje jego wkład w postaci:

```{math}
:label: boris-audit-gilbert-torque
\left.\frac{\mathrm d\mathbf m}{\mathrm dt}\right|_s
=\frac{\mathbf t_s+\alpha\mathbf m\times\mathbf t_s}{1+\alpha^2}.
```

To algebraiczny wniosek z reprezentacji torque jako Heff i rozwiązania równania Gilberta, dla stałego Ms; nie obejmuje longitudinal LLB. Porównanie surowego `Ts`/`Tsi` z RHS w $\mathrm{s^{-1}}$ bez normalizacji i tej definicji jest niepoprawne.

`Boris/SOTField.cpp::SOTField::UpdateField` jest odrębnym prescribed SOT. Używa wektora z `STp × (sigma E)` i grubości całego mesh-u w osi z. Nie rozwiązuje sam ciężkiego metalu, dyfuzji ani backflow. Zmiana STp nie zmienia automatycznie definicji grubości. Prescribed SOT, solved spin transport i Oersted muszą mieć osobne capabilities.

Omowa antena nad odizolowanym magnetykiem wymaga przede wszystkim pola Oersteda. SHE/STT/SOT nie należy aktywować tylko dlatego, że obiekt nazywa się anteną. Spin transport jest potrzebny dopiero dla jawnie zadanego przewodzącego kontaktu i właściwego modelu materiału.

## 8. Wykryte ryzyka i podejrzane fragmenty

| ID | Ustalenie źródłowe | Dowód | Status / następny test |
|---|---|---|---|
| B01 | Wskaźnik SOR nie jest residualem ani bilansem | `STransport_Charge.cpp::solve_charge_transport_sor`; `VEC_VC_Solve.h::IteratePoisson_SOR` | Udowodniona semantyka; mierzyć residual oraz raw currents |
| B02 | Getter prądu koryguje bilans i mutuje zasilanie | `STransport.cpp::GetCurrent`, około 296–331 | Udowodniona semantyka, nie certyfikat accepted source |
| B03 | Nietrafiający patch może zwrócić sukces | `VEC_VC_flags.h::set_dirichlet_conditions`, około 479–637 | Statyczne ustalenie; test nonempty resolved terminal |
| B04 | Oersted i meter używają sigmaE, display J może zawierać więcej | `Oersted.cpp::Initialize`; `TransportBase.cpp::CalculateElectrodeCurrent`; `Transport_Charge_Display.cpp::GetChargeCurrent` | Ograniczenie ogólnego spinowego porównania; dla charge-only brak tej różnicy |
| B05 | Powtórzony blok termoelektryczny CPU akumuluje tę samą zmienną dwukrotnie | `Transport.cpp::CalculateElectricField`, 283–337 i 339–393; CUDA `TransportCUDA.cu::CalculateElectricField` ma jedną ścieżkę | Podejrzana wada źródłowa; brak runtime reprodukcji |
| B06 | Pumping zawiera składnik `Gmix.j * m`, nie pochodną czasu | `STransport_Spin_GInterf.cpp::Afunc_N_S`, 289/307/329/348; `STransportCUDA_GInterf_S.h`, 109/417 | Podejrzana wada wymiarowa obecna także CUDA; test statycznego m z Im(Gmix)≠0 |
| B07 | Field i display interfacial torque wyznaczają różny koniec zakresu komórek | `Transport_Spin.cpp::CalculateSAInterfaceField`, około 1106; `Transport_Spin_Display.cpp::CalculateDisplaySAInterfaceTorque`, około 180 | Field nie dodaje `INT3(1)` tam, gdzie robi to display; podobna różnica CUDA. Test ostatnich rzędów/kolumn kontaktu, brak runtime reprodukcji |
| B08 | Ekstrapolacja drugiej komórki THE używa E1 i Bz1 mimo obliczenia E2 i Bz2 | `Transport_Spin.cpp::afunc_st_V_sec`, około 417, i `afunc_st_V_pri`, około 549 | Podejrzana wada źródłowa dla niejednorodnego THE; domyślnie wyłączona gałąź nie kwalifikuje włączonej |
| F01 | Porównywarka Fullmaga transponuje tensor przy składaniu | `scripts/compare_boris_fullmag_she_nf.py::_concat_qia`, 343–356 | Uruchomiony lekki test funkcji: transpozycja potwierdzona; brak kwalifikacji historycznego benchmarku |
| F02 | Samo podzielenie Js przez c nie ustanawia parytetu znaków | `GetSpinCurrent`; `Funcs_Math.h::epsilon3`; Fullmag nota 0970 | Wymagany jawny adapter i test wszystkich indeksów, nie dopasowanie wykresu |

F01: dla wierszy wejściowych `(1,2,3)`, `(4,5,6)`, `(7,8,9)` rzeczywista funkcja zwróciła `(1,4,7,2,5,8,3,6,9)` zamiast flow-major `(1,2,3,4,5,6,7,8,9)`. Wykonano definicję funkcji wyciągniętą z AST, z `_tensor` zastąpionym wyłącznie opakowaniem tuple; nie uruchamiano solverów. Wynik potwierdza permutację indeksów, nie cały pipeline OVF ani fizyczne znaki.

B06: przy statycznym m pierwszy składnik pumping znika, drugi nie; ma też inną jednostkę niż składnik z dm/dt. Nie podano tu „poprawionego” znaku Im(Gmix): zależy on od konwencji momentu, kierunku fluxu i interfejsu. Należy wyprowadzić go z circuit theory i testu wzajemności, a nie poprawić przez zgadywanie.

Starszego raportu SHE z sierpnia nie można przeliczyć po fakcie bez źródeł/binary/artefaktów jego konkretnego wykonania. Błędy rzędu dwóch mogą wynikać z konwencji lub adaptera; nie są automatycznym dowodem błędu fizyki Fullmaga czy BORIS.

## 9. AMR, termoelektryka i ciepło — zakres drugoplanowy

`CalculateElectricalConductivity` dla AMR aktualizuje skalar przewodności według poprzedniego kierunku prądu; nie stosuje po prostu pełnego stałego tensora przewodności. Włączenie AMR/TAMR i parametrów temperatury invaliduje transport. Przypadek jednoczesnego AMR/TAMR dodaje w kodzie dwie rezystywności względne zawierające własne jedynki; nie należy opisać go innym, „ładniejszym” wzorem.

`Evaluate_ChargeSolver_delsqV_Thermoelectric_RHS` stosuje uproszczone równanie $\nabla^2V=-S_e\nabla^2T$ z jawnym pominięciem gradientów przewodności i współczynnika Seebecka. Ogólne prawo $\mathbf J=-\sigma(\nabla V+S_e\nabla T)$ daje dodatkowe człony po rozwinięciu dywergencji. W Fullmagu ewentualny model termiczny musi dokumentować to przybliżenie i zakres, nie odziedziczyć go przypadkowo.

`Heat::IterateHeatEquation_1TM` realizuje FTCS z przewodzeniem i źródłem $\sigma\lvert\mathbf E\rvert^2$, po uśrednieniu E i sigma na siatce temperatury. Uśredniona sigma razy kwadrat uśrednionego E nie jest ogólnie tym samym co uśrednienie lokalnej mocy. Dla ogólnego sprzężenia potrzebny jest bilans energii i kwalifikacja transferu między siatkami. Ciepło nie jest wymaganiem pierwszego poprawnego omowego field-only anteny.

## 10. FFT anteny a fale spinowe

FFT używane przez `OerstedKernel` to **narzędzie obliczania pola**, nie wykres fal spinowych wzbudzanych w falowodzie.

Dla anteny można policzyć widmo źródła na zdefiniowanym targetcie/płaszczyźnie. Sama duża amplituda H przy danym k nie gwarantuje wzbudzenia modu: liczy się także orientacja równowagowej magnetyzacji, polaryzacja, profil modu przez przekrój, dyspersja, częstotliwość, tłumienie i warunki brzegowe.

Praktycznie potrzebne są trzy odrębne wyniki:

- widmo źródła H: już bez LLG, jawny sampling i normalizacja;
- nakładanie pola na dostępne mody: tylko z wiarygodną bazą modową;
- odpowiedź magnetyzacji w przestrzeni i czasie: dopiero z LLG lub zakwalifikowanego solvera liniowej odpowiedzi.

Publikacja BORIS pokazuje dyspersję uzyskiwaną z przestrzenno-czasowej transformaty magnetyzacji po pobudzeniu sinc. To inny workflow niż source FFT. Dla niejednorodnej siatki FEM nie stosować zwykłego FFT po kolejności węzłów — potrzebna fizyczna siatka próbkowania/operator probe.

## 11. Wnioski dla implementacji i dokumentacji Fullmaga

### 11.1. Czy to już jest w naszym planie?

**Zasadnicza architektura tak, pełne wykonanie i kwalifikacja nie.** Nota 0950 i plan `2026-09-08-microwave-antenna-refactoring-plan.md` przewidują 3D przewodnik, zasilanie/powrót, bazę pola, reuse, waveform, field-only, targety, LLG i rozdzielenie source FFT od odpowiedzi. Zbieżność pomysłu z BORIS nie zamyka żadnej z tych bramek.

Aktualna praca nad owned V/RT0/H, snapshotem J oraz ograniczeniami accepted source jest zgodna z wnioskami audytu. Nadal trzeba wykonać i zakwalifikować publikację J, renderer/API, obwód i truncation, bazę per-A, rzeczywisty waveform RHS, cold-load/stale rejection i analizy. **Nie zmieniono capability matrix na podstawie tego audytu.** Nieaktualne/historiczne wiersze macierzy wymagają osobnego reconciliation z dowodami, nie automatycznej promocji.

### 11.2. Dokładne właściciele i brak zmiany API

| Kontrakt Fullmaga | Ścieżka + symbol / anchor | Wniosek |
|---|---|---|
| Wspólna fizyka anteny | `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md::antenna-separable-field-basis` | Baza per-A, granice separacji, trzy poziomy modelu |
| Terminale i accepted current | Ta sama nota, `antenna-terminal-current-certificate` | Requested i measured pozostają odrębne |
| Obiekt / port / stage | `packages/fullmag-py/src/fullmag/model/antenna.py::AntennaPortMode`, `AntennaFieldSolveStage`; `world.py::StudyBuilder.antenna_object` | Audyt nie wprowadza nowego publicznego API ani nowych defaults |
| Zasilanie | `packages/fullmag-py/src/fullmag/model/current_transport.py::CurrentSourceDrive`, `CurrentTransport` | Jawne źródło i terminale, nie typ prezentacyjny |
| Owned źródło CPU FEM | `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp::solve_accepted_external_lead_display_bundle` | WIP snapshot J pochodzi z tego samego zaakceptowanego RT0 co H |
| Materiał inspection-only | `crates/fullmag-runner/src/antenna_external_lead_solution.rs::reject_unqualified_external_lead_source` | Inspekcja V/J/H nie może stać się bazą LLG przez zmianę etykiety |
| Baza i consumption | `crates/fullmag-runner/src/antenna_field_solution.rs::load_solved_antenna_drive_basis_projected` | Wymagane tożsamość, zgodność targetu i kwalifikacja |
| Source spectrum | `crates/fullmag-runner/src/antenna_spectrum.rs::compute_antenna_source_spectrum_artifact` | Widmo pola źródłowego, nie odpowiedź m |
| Spin | `docs/physics/0970-spin-hall-drift-diffusion-transport.md::governing-equations` | Full splitting w V, jawny flow/spin tensor i reciprocal block |
| Adapter porównawczy | `scripts/compare_boris_fullmag_she_nf.py::_concat_qia` | Osobne zadanie naprawy mapowania i znaków przed parity |

Źródło→Python→ProblemIR nie ulega zmianie w tym audycie. Pełne tabele parametrów, serialized IR, walidacja i round-trip należą do kanonicznych not/implementacji; nie zastąpiono ich komendami NetSocks ani strukturami BORIS. Ten dokument nie jest podstawą do opublikowania nowego „działającego” przykładu.

### 11.3. Realizacje i poziom dowodów

| Realizacja | BORIS w badanym zakresie | Fullmag — wpływ audytu |
|---|---|---|
| FDM CPU | Źródłowo widoczne charge/spin/Oersted FFT; tutaj nie uruchomiono | Nie promować transportu/LLG anteny bez dowodów jego własnej ścieżki |
| FDM GPU | Źródłowo widoczne CUDA i multi-GPU; brak tutaj device/parity proof | Oddzielna kwalifikacja double, brak cichego CPU fallbacku |
| FEM CPU | Nie jest realizacją badanego BORIS | Własny H1/RT0/MFEM i 3D operator pola, bez kopiowania FDM |
| FEM GPU | Nie jest realizacją badanego BORIS | Audyt nie wdraża GPU transportu ani nie kwalifikuje hybrydowej ścieżki |

## 12. Konkretne bramki do dalszej pracy

| Bramka | Wykonalny test | Warunek uznania |
|---|---|---|
| Przewodnictwo | Bar o zadanym L, przekroju A i sigma; dwa materiały w szeregu | Zbieżność do R=L/(sigma A), właściwe znaki i niekorygowany bilans |
| Terminale | Puste/nakładające się patche, brak gauge, rozłączony komponent | Jawne odrzucenie przed solve; resolved IDs i powierzchnie |
| Requested→measured | Każdy terminal, w tym reference i requested-zero | Niezależny H1 i RT0 pomiar w tolerancjach noty 0950 |
| Jedno źródło J | Display snapshot vs ewaluator pola, centrum/ślady lokalne elementów | Ta sama owned mesh/RT0/material/ledger, nie frontend reconstruction |
| Zamknięcie | Jawny source/return/feed, sweep odległości truncation | Bilanse per component i kontrolowany wpływ brakującego obwodu |
| Oersted | Długi prosty przewód, pętla, symetrie, odwrócenie prądu; niezależna całka | Poprawne SI/znaki i zbieżność pola poza i blisko przewodnika |
| Baza | I=0, dodatnie/ujemne I, suma dwóch portów | Liniowość i brak ponownego transport solve po zmianie samej amplitudy |
| Waveform | Sinus przy każdym podkroku każdego wspieranego RK | Kontrola fazy i zbieżności czasowej względem prescribed-field reference |
| Cache | Cold-load; edycja materiału/terminala/mesh/closure/target | Reuse wyłącznie zgodnego artefaktu, jawne stale rejection |
| Field-only | Obecny microstrip bez relax/run | V/J/H inspectable, brak wymogu magnetycznego m źródła |
| UI/API | Ten sam inspector template, antenowe quantities, target/generation | V na conductor, J na jego carrier, H na zgodnym sampling/target; brak m na antenie |
| Source FFT | Zdefiniowana płaszczyzna, regularny sampling, znany profil | Poprawne k, jednostki, okna, Nyquist; nie obiecywać response |
| Adapter spinowy | Dziewięć różnych składowych, sześć SHE orientacji, diffusion/P oddzielnie | Jawny flow/spin order i podpisana normalizacja przed solver parity |
| Pumping | Statyczne m i precesja z Re/Im Gmix | Zerowe pumping w statyce i jednostki/circuit-theory signs |
| CPU/GPU | Te same wejścia, residuale, raw fluxy, torque i H | Wykonany parytet na zidentyfikowanym urządzeniu; źródła to za mało |

Nie ustanawia się tutaj nowych progów liczbowych. Przed każdym benchmarkiem zamrozić progi błędu pola/prądu/fazy i metodę refinement z właściwej noty. Tolerancja SOR BORIS nie jest takim progiem.

## 13. Symbole i jednostki SI

| Dokładny token | Znaczenie w tym raporcie | Jednostka |
|---|---|---|
| $\mathbf r,\mathbf r'$ | Pozycja targetu i źródła | $\mathrm m$ |
| $\Omega_c,\mathrm d^3r'$ | Domena przewodnika i miara objętości | $\mathrm{m^3}$ dla miary |
| $V,\Delta V,V_s$ | Potencjał charge, różnica napięć, potencjał spinowy BORIS | $\mathrm V$ |
| $\sigma$ | Skalar przewodności | $\mathrm{S\,m^{-1}}$ |
| $\mathbf E,E_i$ | Pole elektryczne / składowa w charge-only | $\mathrm{V\,m^{-1}}$ |
| $\mathbf J_c$ | Konwencjonalny prąd objętościowy | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_{\mathrm{ant}},\mathbf M$ | Natężenie pola anteny i magnetyzacja | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{ant}}$ | Wkład indukcji od anteny | $\mathrm T$ |
| $\mu_0,\mu$ | Przenikalność próżni / materiałowa w kryterium skin depth | $\mathrm{H\,m^{-1}}$ |
| $p,i,a,k$ | Port, kierunek przepływu, polaryzacja, indeks sumowany | $1$ |
| $I_p,I_{0,p}$ | Prąd i jego amplituda | $\mathrm A$ |
| $\mathbf j_p$ | Rozkład J na jednostkę prądu | $\mathrm{m^{-2}}$ |
| $\mathbf h_p$ | Rozkład H na jednostkę prądu | $\mathrm{m^{-1}}$ |
| $t,f_p,f,\omega,\phi_p$ | Czas, częstotliwości, pulsacja, faza | $\mathrm s$, $\mathrm{Hz}$, $\mathrm{Hz}$, $\mathrm{rad\,s^{-1}}$, $\mathrm{rad}$ |
| $\delta,L,k_{\mathrm{EM}}$ | Skin depth, rozmiar struktury, liczba falowa EM | $\mathrm m$, $\mathrm m$, $\mathrm{m^{-1}}$ |
| $\mathbf m,m_a$ | Jednostkowy kierunek magnetyzacji | $1$ |
| $\mathbf S,S_a$ | Akumulacja magnetycznego momentu spinu BORIS | $\mathrm{A\,m^{-1}}$ |
| $J^s_{ia}$ | Strumień magnetycznego momentu spinu BORIS | $\mathrm{A\,s^{-1}}$ |
| $c,\mu_B,e$ | c=muB/e, magneton Bohra, dodatni ładunek elementarny | $\mathrm{m^2\,s^{-1}}$, $\mathrm{A\,m^2}$, $\mathrm C$ |
| $D_e$ | Współczynnik dyfuzji spinowej | $\mathrm{m^2\,s^{-1}}$ |
| $P,\theta,\theta_{\mathrm{inv}},\epsilon_{iak},\eta_s$ | Polaryzacja, SHA, iSHA, tensor Levi-Civity, efektywność torque | $1$ |
| $\lambda_{\mathrm{sf}},\lambda_{\mathrm{ex}},\lambda_{\mathrm{ph}}$ | Długości spin-flip, exchange rotation i dephasing | $\mathrm m$ |
| $\mathbf F_{\mathrm{src}}$ | Pozostałe źródło równania Laplace'a dla S | $\mathrm{A\,m^{-3}}$ |
| $\mathbf T_{\mathrm{bulk}}$ | Tempo transferu momentu magnetycznego | $\mathrm{A\,m^{-1}\,s^{-1}}$ |
| $G_i,G_{\mathrm{mix}}$ | Przewodności kontaktowe na powierzchnię | $\mathrm{S\,m^{-2}}$ |
| $M_s,\mathbf t_s,\alpha$ | Moduł magnetyzacji, znormalizowany bare torque, damping Gilberta | $\mathrm{A\,m^{-1}}$, $\mathrm{s^{-1}}$, $1$ |
| $d_h,c_g,g$ | Grubość komórki normalna do kontaktu, prefaktor g muB/(2e), czynnik g | $\mathrm m$, $\mathrm{m^2\,s^{-1}}$, $1$ |
| $T,S_e$ | Temperatura i współczynnik Seebecka | $\mathrm K$, $\mathrm{V\,K^{-1}}$ |
| $\nabla,\partial_i$ | Gradient i pochodna względem osi | $\mathrm{m^{-1}}$ |

## 14. Bibliografia i indeks źródeł

Podstawą obserwacji implementacji są konkretne funkcje powyżej. Literatura jest źródłem wyprowadzeń i niezależnych modeli, nie dowodem działania naszego kodu:

1. S. Lepadatu, *Boris computational spintronics—High performance multi-mesh magnetic and spin transport modeling software*, J. Appl. Phys. 128, 243902 (2020), [DOI](https://doi.org/10.1063/5.0024382), [manuskrypt autora](https://arxiv.org/abs/2008.02478).
2. S. Lepadatu, *Unified treatment of spin torques using a coupled magnetisation dynamics and three-dimensional spin current solver*, Scientific Reports 7, 12937 (2017), [manuskrypt autora](https://arxiv.org/abs/1704.07758).
3. S. Lepadatu, *Accelerating micromagnetic and atomistic simulations using multiple GPUs*, J. Appl. Phys. 134, 163903 (2023), [DOI](https://doi.org/10.1063/5.0172657). Dowód zastosowanej architektury w publikacji nie kwalifikuje każdej ścieżki bieżącego snapshotu.

| Twierdzenie | Źródło przypięte do SHA | Symbol / odpowiedzialność | Poziom dowodu |
|---|---|---|---|
| Charge PDE i thermo approximation | [Transport_Charge.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport_Charge.cpp) | `Evaluate_ChargeSolver_delsqV_RHS`, `Evaluate_ChargeSolver_delsqV_Thermoelectric_RHS` | Odczyt źródeł |
| Elektrody, current getter, waveform | [STransport.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/STransport.cpp) | `GetCurrent`, `adjust_potential`, `UpdateField` | Odczyt źródeł |
| Defaults i flags | [STransport.h](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/STransport.h) | `errorMaxLaplace`, `SOR_damping`, `Transport_Recalculated` | Odczyt źródeł |
| SOR i kontakty | [STransport_Charge.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/STransport_Charge.cpp) | `solve_charge_transport_sor`, `set_cmbnd_charge_transport` | Odczyt źródeł, brak residual qualification |
| Patch validity | [VEC_VC_flags.h](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/BorisLib/VEC_VC_flags.h) | `set_dirichlet_conditions` | Statyczne ustalenie |
| Źródło i cache H | [Oersted.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Oersted.cpp) | `Initialize`, `UpdateField` | Odczyt źródeł |
| Prymitywy i symetrie | [OerstedTFunc.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/OerstedTFunc.cpp) | `OeFunc::G1`, `I2`, `CalcOerstedTensors` | Analiza źródeł/wymiarów, bez oracle |
| Operator FFT | [OerstedKernel.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/OerstedKernel.cpp) | `Calculate_Oersted_Kernels_3D`, `KernelMultiplication_3D_line` | Odczyt źródeł |
| Multi-GPU H | [OerstedCUDA.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/OerstedCUDA.cpp) | `Initialize`, `UpdateField` | Brak device runtime proof |
| E i podejrzany thermo duplikat | [Transport.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport.cpp) | `CalculateElectricField` | Statyczny defekt podejrzany |
| Display J | [Transport_Charge_Display.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport_Charge_Display.cpp) | `GetChargeCurrent` | Odczyt wyrażenia konstytutywnego |
| Spin PDE i boundary | [Transport_Spin.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport_Spin.cpp) | `Evaluate_SpinSolver_delsqS_RHS`, `NHNeumann_Sdiff`, `CalculateSAField` | Odczyt źródeł |
| Js i torque | [Transport_Spin_Display.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport_Spin_Display.cpp) | `GetSpinCurrent`, `GetSpinTorque`, `CalculateDisplaySAInterfaceTorque` | Odczyt źródeł |
| Podejrzany pumping | [STransport_Spin_GInterf.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/STransport_Spin_GInterf.cpp) | `Afunc_N_S` | Analiza wymiarowa, brak runtime reprodukcji |
| Flow-major tensor | [Types_VAL.h](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/BorisLib/Types_VAL.h) | `VAL3::operator\|` | Odczyt jawnego outer product |
| Field-only vs ODE | [SuperMeshSimulation.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/SuperMeshSimulation.cpp) | `ComputeFields`, `AdvanceTime` | Źródłowo odrębne wywołania |
| Gilbert i normalizacja torque | [DiffEqFM_Equations.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/DiffEqFM_Equations.cpp) | `DifferentialEquationFM::LLG` | Analiza algebraiczna, bez parity runtime |
| Prescribed SOT | [SOTField.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/SOTField.cpp) | `SOTField::UpdateField` | Odrębna ścieżka źródłowa |
| Joule heating | [Heat_Solve.cpp](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Heat_Solve.cpp) | `IterateHeatEquation_1TM` | Odczyt źródeł |

Wynik zadania: audyt i zalecenia; **nie implementacja poprawek BORIS ani zamknięcie modułu anten Fullmaga**. Nie zmieniono sceny użytkownika, uruchomionego workspace, modelu microstrip ani publicznych kontraktów.
