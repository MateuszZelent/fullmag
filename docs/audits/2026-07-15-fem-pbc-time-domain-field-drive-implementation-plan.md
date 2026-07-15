# FEM PBC: czasowy napęd polem magnetycznym — specyfikacja fizyczna i plan wdrożenia

- Data: 2026-07-15
- Status: zatwierdzony kierunek projektowy; dokument implementacyjny, kod nie jest jeszcze kompletny
- Wariant: **C — wspólny kontrakt napędu oraz osobne ścieżki kwalifikacji Γ i finite-k**
- Dokument bazowy: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive.md`
- Przykład bazowy: `examples/fem_periodic_antidot_relax_exchange_coupled.py`
- Zakres: fizyka, Python DSL, SceneDocument, ProblemIR, planner, FDM, FEM CPU/GPU,
  natywne ABI, runner, artefakty, OpenAPI v2, Control Room i analiza widmowa

> **Instrukcja wykonawcza:** implementować zadania po kolei, test-first, bez promowania
> capability na podstawie samej obecności kodu. Dla zmian natywnego FEM jedynym
> autorytatywnym dowodem są zarządzane receptury `just` uruchamiające właściwy runtime.

## 1. Cel i definicja ukończenia

Celem jest umożliwienie fizycznie i numerycznie jednoznacznego przebiegu:

1. zdefiniowanie stałego pola polaryzującego;
2. relaksacja/minimalizacja do stanu równowagi `m0` przy wyłączonym napędzie czasowym;
3. jawne przeniesienie `m0` do etapu dynamicznego;
4. włączenie globalnego albo regionalnego pola magnetycznego o serializowalnej funkcji czasu,
   w szczególności impulsu `sinc`;
5. całkowanie precesyjnej LLG z ewaluacją pola w każdym podetapie Rungego–Kutty;
6. zapis pola rzeczywiście użytego przez solver i odpowiedzi `m(t)`;
7. analiza:
   - widma modów Γ dla pojedynczej komórki PBC,
   - widma `S(k,f)` dla superkomórki/falowodu z lokalnym źródłem;
8. równoważne authoring i round-trip w Pythonie oraz Control Room;
9. jawne odrzucenie niewspieranych backendów, bez semantycznego fallbacku.

Funkcja jest ukończona dopiero wtedy, gdy wszystkie poniższe własności są udowodnione:

- ten sam znormalizowany `RegionalFieldDriveIR` powstaje z Pythona i UI;
- plan zawiera niezmienną bazę przestrzenną i zamknięty opis waveformu;
- `H_drive(r,t)` użyte w RHS, energii i quantity readback pochodzi z tej samej realizacji i rewizji;
- wymuszenie jest liczone w czasach `t_n + c_i dt` wszystkich podetapów RK;
- zdarzenia nieciągłości nie są przekraczane jednym krokiem;
- PBC nie powoduje niejawnego uśredniania niespójnej maski;
- FEM CPU double stanowi oracle, FEM GPU double przechodzi parity i convergence;
- przykłady Γ i finite-k generują zwalidowane artefakty oraz działają z Pythona i UI;
- capability matrix rozróżnia `source_visible`, `executable` i `validated`;
- komplet testów Python/Rust/UI oraz zarządzane receptury FEM przechodzą.

## 2. Źródła i wynikające z nich wymagania

### 2.1 Literatura lokalna

1. `docs/papers/mic_intro.pdf`, s. 34–37:
   - LLG obejmuje precesję i tłumienie w polu efektywnym;
   - pole zewnętrzne może zależeć od czasu;
   - przykład dynamiczny najpierw wyznacza stan równowagi bez precesji/przy silnym tłumieniu,
     zapisuje go, a następnie uruchamia właściwą dynamikę z impulsem Gaussa.
2. `docs/comsol/Manual_for_Micromagnetics_Module.pdf`:
   - rozdz. PBC, s. 14 i 22–23: zwykłe PBC wymusza zgodność wartości na parach periodycznych,
     a Floquet PBC jest właściwym narzędziem do bezpośredniego zadawania fazy Blocha;
   - przykład fal stojących, s. 24–26 dokumentu (s. 29–31 PDF): impuls pola i transformata
     czasowo-przestrzenna służą do wyznaczania modów;
   - opis workflow, s. 45 PDF: stan końcowy relaksacji jest dziedziczony przez etap wzbudzenia,
     w którym włącza się pole dynamiczne i właściwe parametry czasowe.

Wniosek implementacyjny: relaksacja i wzbudzenie są osobnymi etapami z jawnym stanem
początkowym, osobnym zegarem etapu oraz osobną aktywacją napędu.

### 2.2 Kod solverów referencyjnych w `external_solvers`

- MuMax3, `external_solvers/3/engine/excitation.go`: excitation jest sumą wartości regionalnych
  i składników „maska przestrzenna × mnożnik czasowy”. Jest to wzorzec separacji kosztownej
  realizacji przestrzennej od taniej ewaluacji czasu.
- MuMaxPlus, `external_solvers/plus/src/core/dynamic_parameter.{hpp,cpp}`: parametr dynamiczny
  przechowuje wiele składników czasowych, opcjonalnie z maską, i superponuje je w chwili `t`.
- MuMaxPlus, `external_solvers/plus/src/cmd/spinwave_dispersion.cpp`: przykład używa szerokopasmowego
  `sin(x)/x` z `fmax = 20 GHz`. Kod tworzy też maskę centralnych komórek, lecz w obecnej wersji
  wywołuje overload bez maski; nie wolno kopiować tego przykładu jako dowodu lokalnego źródła.
- Tetmag, `external_solvers/tetmag/main/TheLLG.cpp`: solver przekazuje bieżący czas operatorowi RHS,
  a pole impulsu jest obliczane jako baza przestrzenna razy wartość pulse w tym czasie.
- OOMMF, `external_solvers/oommf/oommf/app/oxs/ext/scriptuzeeman.cc`: Zeeman rozróżnia `stage_time`
  i `total_time`; to uzasadnia jawny `time_origin`.
- BORIS, `external_solvers/BORIS/Boris/ZeemanBase.h`: pole użytkownika może zależeć od `(x,y,z,t)`;
  Fullmag nie przejmuje dowolnych callbacków, tylko bezpieczny, serializowalny podzbiór.

### 2.3 Publikacje pierwotne

- A. Vansteenkiste et al., “The design and verification of MuMax3”, *AIP Advances* 4,
  107133 (2014), [DOI 10.1063/1.4899186](https://doi.org/10.1063/1.4899186).
- O. Dmytriiev et al., “Role of boundaries in micromagnetic calculations of magnonic spectra of
  arrays of magnetic nanoelements”, *Phys. Rev. B* 87, 174422 (2013),
  [DOI 10.1103/PhysRevB.87.174422](https://doi.org/10.1103/PhysRevB.87.174422).
  Praca uzasadnia, że symetria i profil wymuszenia selekcjonują mody; jednorodne pobudzenie
  periodycznej komórki nie daje dowolnego skończonego `k`.
- Y. Au et al., “Direct Excitation of Propagating Spin Waves by Focused Ultrashort Optical Pulses”,
  *Phys. Rev. Lett.* 110, 097201 (2013),
  [DOI 10.1103/PhysRevLett.110.097201](https://doi.org/10.1103/PhysRevLett.110.097201).
  Zlokalizowane źródło ma skończone widmo wektorów falowych, które ogranicza wzbudzane `k`.
- F. Alouges, E. Kritsikis, J. Steiner, J.-C. Toussaint, “A convergent and precise finite element
  scheme for Landau–Lifschitz–Gilbert equation”, *Numer. Math.* 128, 407–430 (2014). Wymaganiem
  Fullmag pozostaje kontrola normy `|m|`, zbieżności czasowej i spójności dyskretnej energii, a nie
  samo podobieństwo trajektorii:
  [DOI 10.1007/s00211-014-0615-3](https://doi.org/10.1007/s00211-014-0615-3).

Źródła są inspiracją i zestawem oracle; publiczna semantyka Fullmag pozostaje zdefiniowana przez
noty `docs/physics`, ProblemIR i niniejszy kontrakt.

## 3. Decyzje architektoniczne

### 3.1 Osobny `RegionalFieldDrive`

Pole zadane analitycznie/maską nie jest anteną ani wynikiem rozwiązania przewodnika. Docelowe typy:

- `RegionalFieldDrive`: zadane pole globalne, obiektowe lub regionalne;
- `SolvedAntennaDrive`: pole z bazy obliczonej przez solver przewodnika;
- `AntennaFieldSource(model="prescribed_zeeman_mask")`: wyłącznie wejście kompatybilnościowe.

`RegionalFieldDrive` nie może być przechowywany w `current_modules`. Powstaje nowa typowana kolekcja
`field_drives` w Pythonie, SceneDocument i ProblemIR. Stara maska jest deterministycznie migrowana i
otrzymuje provenance `migrated_from="prescribed_zeeman_mask"`.

### 3.2 Rozdzielenie targetu i profilu

Target określa, na jakiej domenie magnetycznej wolno działać:

- `global`: wszystkie aktywne domeny magnetyczne;
- `object(object_id)`: jeden obiekt magnetyczny;
- `region(object_id, region_id)`: jeden region obiektu magnetycznego.

Profil określa zmianę amplitudy wewnątrz targetu:

- `uniform`;
- `sinc(axis, period_m, center_m, width_m, window)`: istniejący analityczny profil przestrzenny,
  nazwany niezależnie od czasowego `SincPulse`;
- `geometry_mask(object_id, envelope)`: przecięcie z obiektem-maską, który może być niemagnetyczny;
  `envelope` jest typowanym `uniform` albo `sinc`, dzięki czemu maska i obwiednia mogą działać
  jednocześnie.

Stary zapis `object="source_mask", spatial_profile={"kind":"uniform"}` jest migrowany jako
`target=global`, `spatial_profile=geometry_mask(source_mask, envelope=uniform)`. Stary zapis z
profilem sinc jest migrowany do `geometry_mask(source_mask, envelope=sinc(...))`, bez utraty
parametrów. Nie wolno interpretować obiektu niemagnetycznego jako targetu magnetycznego.

Analityczny sinc jest zdefiniowany w globalnym układzie współrzędnych. Dla
`u=axis/|axis|`, `xi=u·r-center_m`:

\[
S_\mathrm{sinc}(\mathbf r)=\operatorname{sinc}_\pi(\xi/\mathrm{period\_m})W(\xi).
\]

`period_m>0`; `axis` jest niezerowa. Jeśli `width_m` nie podano, `W=1`. Jeśli ją podano, profil
jest zerowy dla `|xi|>width_m/2`. `window="none"` daje `W=1` wewnątrz nośnika, natomiast

\[
W_\mathrm{Hann}(\xi)=\sin^2\!\left[\pi\left(\frac{\xi}{\mathrm{width\_m}}+\frac12\right)\right]
\]

dla `|xi|<=width_m/2`. Dla geometry mask całkowity profil to `chi_G(r) S_envelope(r)`.

### 3.3 Nazwy quantities

- `H_drive` `[A/m]`: suma wszystkich aktywnych `RegionalFieldDrive`;
- `B_drive` `[T]`: widok `mu0 H_drive`, nie drugi niezależny stan solvera;
- `E_drive` `[J]`: energia oddziaływania z `H_drive`;
- `eden_drive` `[J/m^3]`: gęstość tej energii;
- `H_ant` `[A/m]`: pozostaje polem `SolvedAntennaDrive` i aliasem kompatybilnościowym tylko dla
  zmigrowanych starych źródeł antenowych.

Ta decyzja koryguje regionalną część starszych planów z 2026-07-10, które używały `H_ant` również
dla prostego regionalnego napędu. Część dotycząca obliczanej bazy antenowej pozostaje bez zmian.

### 3.4 Jeden kontrakt, dwie kwalifikacje fizyczne

- **Γ:** jedna komórka elementarna, PBC x/y, pole globalne albo profil zgodny z komórką; wynik to
  rezonanse `k=0` i profile wewnątrz komórki.
- **finite-k:** wydłużona superkomórka/falowód, oś propagacji otwarta, lokalne źródło i strefy
  absorbujące; wynik to odpowiedź skończonej domeny `S(k,f)`.

Pełna dyspersja nieskończonego kryształu dla zadanego `k` pozostaje domeną solvera Blocha/Floqueta
lub eigensolvera częstotliwościowego. Czasowy finite-k jest walidacją propagacji w superkomórce,
nie zamiennikiem tego kontraktu.

## 4. Pełna definicja fizyki

### 4.1 Pole napędu

Dla aktywnych napędów `q = 1,…,N_d`:

\[
\mathbf B_\mathrm{drive}(\mathbf r,t)
=\sum_q B_q\,\hat{\mathbf e}_q\,S_q(\mathbf r)\,f_q(\tau_q),
\qquad
\mathbf H_\mathrm{drive}=\frac{\mathbf B_\mathrm{drive}}{\mu_0}.
\]

- `B_q` jest publiczną amplitudą w teslach;
- `e_q` jest znormalizowanym kierunkiem bez jednostki;
- `S_q(r)` jest bezwymiarowym profilem przestrzennym;
- `f_q` jest bezwymiarową funkcją czasu;
- `H_drive` jest przekazywane do LLG w A/m;
- napędy superponują się liniowo, również gdy ich targety zachodzą na siebie.

Kierunek zerowy, niefinitywne parametry, ujemna amplituda skalarna i nieistniejące referencje są
odrzucane. Znak pola koduje kierunek; `amplitude_B_T >= 0`.

### 4.2 Zegar

\[
\tau_q =
\begin{cases}
t_\mathrm{abs}-t_{\mathrm{stage,start}}, & \texttt{stage_local},\\
t_\mathrm{abs}, & \texttt{absolute}.
\end{cases}
\]

Domyślne jest `stage_local`. Stage ma stabilny `stage_id`; aktywacja może być:

- `all_time_evolution`: wszystkie etapy `run`, nigdy domyślnie `relax/minimize`;
- `stage_ids([...])`: tylko jawnie wskazane etapy.

Pole stałe może zostać jawnie dopuszczone w minimizerze. Pole niestałe w minimizerze jest błędem,
ponieważ minimizer nie ma fizycznego zegara. Domyślny statyczny `B_ext` pozostaje częścią energii
równowagi i nie jest automatycznie konwertowany na drive.

### 4.3 Zamknięty katalog funkcji czasu

Wszystkie backendy implementują identyczne funkcje:

| Rodzaj | Definicja |
|---|---|
| `constant` | `f(tau)=1` |
| `sinusoidal` | `sin(2 pi frequency_hz tau + phase_rad) + offset` |
| `pulse` | `1` dla `t_on <= tau < t_off`, w pozostałych chwilach `0` |
| `piecewise_linear` | interpolacja liniowa; poza zakresem utrzymanie wartości końcowej |
| `sinc_pulse` | `a sinc_pi(2 f_c (tau-t0))` |

Znormalizowana funkcja sinc:

\[
\operatorname{sinc}_\pi(x)=
\begin{cases}
1,&x=0,\\
\frac{\sin(\pi x)}{\pi x},&x\ne0,
\end{cases}
\]

zatem

\[
f_\mathrm{sinc}(\tau)=a\,
\frac{\sin(2\pi f_c(\tau-t_0))}{2\pi f_c(\tau-t_0)}.
\]

Dla nieskończonego przedziału czasu moduł ciągłej transformaty jest prostokątny i stały dla
`|f|<f_c` (z wartością proporcjonalną do `a/(2 f_c)`), a przesunięcie `t0` dodaje tylko fazę.
Skończony stage i zapis czasowy obcinają ogony, więc rzeczywiste widmo źródła jest splotem z oknem;
artefakt zapisuje oraz pokazuje faktycznie spróbkowane `H_drive(f)`, nie idealny prostokąt.

Wymagania: `f_c > 0`, `t0 >= 0`, wszystkie wartości skończone. Implementacja używa rozwinięcia
stabilnego numerycznie w otoczeniu zera. Sinc ma nieskończony ogon — solver go nie ucina. Validator
ostrzega, jeśli `|f(0)|` przekracza domyślnie `1e-4 |a|`, bo oznacza to niezerowy impuls w chwili
startu etapu. Próg ostrzeżenia jest częścią walidacji, nie semantyki pola.

Dowolny callback Python/JavaScript jest niedozwolony: nie da się go bezpiecznie serializować,
przenieść na GPU ani odtworzyć w provenance.

### 4.4 LLG i pole efektywne

W domenie magnetycznej `Omega_m`, dla `|m|=1`:

\[
\frac{\partial\mathbf m}{\partial t}
=-\frac{\gamma_0}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_\mathrm{eff}
+\alpha\,\mathbf m\times(\mathbf m\times\mathbf H_\mathrm{eff})\right],
\]

gdzie `gamma0 = |gamma| mu0` ma jednostkę m/(A s), `alpha` jest bezwymiarowe, a

\[
\mathbf H_\mathrm{eff}
=\mathbf H_\mathrm{existing}
+\mathbf H_\mathrm{drive}.
\]

`H_existing` obejmuje exchange, demag, anizotropię, statyczny Zeeman, Oersted i inne już aktywne
oddziaływania. Regionalny drive nie zastępuje statycznego pola polaryzującego.

Energia napędu:

\[
E_\mathrm{drive}(t)=-\mu_0\int_{\Omega_m}
M_s(\mathbf r)\,\mathbf m(\mathbf r,t)\cdot
\mathbf H_\mathrm{drive}(\mathbf r,t)\,dV.
\]

`E_drive` może rosnąć albo maleć, bo pole zależne od czasu wykonuje pracę; test monotonicznego
spadku całkowitej energii nie obowiązuje w etapie wzbudzenia. Wymagana jest natomiast spójność
energii z polem użytym w RHS.

### 4.5 Stan równowagi i odpowiedź dynamiczna

Etap przygotowania daje `m0(r)`. Etap dynamiczny startuje dokładnie z tego snapshotu i definiuje:

\[
\delta\mathbf m(\mathbf r,t)=\mathbf m(\mathbf r,t)-\mathbf m_0(\mathbf r).
\]

W etapie dynamicznym przywracane jest fizyczne `alpha`; wysokie tłumienie lub solver bezprecesyjny
służy wyłącznie przygotowaniu `m0`. Provenance zapisuje oba zestawy parametrów.

### 4.6 Warunki periodyczne

Dla zwykłego PBC `k=0`:

\[
\mathbf m(\mathbf r+\mathbf R,t)=\mathbf m(\mathbf r,t),\qquad
\mathbf H_\mathrm{drive}(\mathbf r+\mathbf R,t)=
\mathbf H_\mathrm{drive}(\mathbf r,t).
\]

Po projekcji każdy periodyczny odpowiednik węzła musi mieć zgodną wartość bazy pola w tolerancji
`atol + rtol max(|H_i|,|H_j|)`, z domyślnym `rtol=1e-12`, `atol=1e-9 A/m` dla double.
Niespójność jest błędem planowania; nie wolno jej naprawiać średnią. Globalne pole jednorodne jest
zgodne automatycznie. Lokalna maska w komórce PBC jest periodycznie powielana.

## 5. Dyskretyzacja FEM pola regionalnego

### 5.1 Projekcja P1 przez lumped L2

Surowy test „czy współrzędna węzła leży w masce” jest niewystarczający: zależy od położenia siatki,
źle traktuje elementy przecięte granicą i nie jest spójny z masą FEM. Dla funkcji bazowych P1
`phi_i`:

\[
M_i=\int_{\Omega_m}\phi_i\,dV,
\qquad
w_{qi}=M_i^{-1}\int_{\Omega_m}
\phi_i(\mathbf r)\,\chi_{T_q}(\mathbf r)S_q(\mathbf r)\,dV.
\]

Niezmienna baza węzłowa napędu:

\[
\mathbf H^0_{qi}=\frac{B_q}{\mu_0}\hat{\mathbf e}_q w_{qi},
\qquad
\mathbf H_{\mathrm{drive},i}(t)=\sum_q f_q(\tau_q)\mathbf H^0_{qi}.
\]

Ta sama lumped mass i ta sama material-weighted forma biliniowa są używane przez LLG, energię i
quantity readback. Dla globalnego profilu jednorodnego test algebraiczny wymaga `w_i=1` na wszystkich
aktywnych magnetycznych DOF z dokładnością solvera.

### 5.2 Realizacja targetu i profilu

- target `global`: wszystkie elementy z `Ms>0`;
- target `object/region`: marker elementów z canonical mesh ownership;
- profil `uniform`: `S=1`;
- profil `geometry_mask`: deterministyczna adaptacyjna kwadratura tetraedralna na przeciętych
  elementach;
- profil `sinc`: wartość analityczna próbkowana w tej samej kwadraturze.

Dla geometry mask nie wolno opierać produkcyjnej dokładności na środku ciężkości tetraedru.
Algorytm v1 jest następujący:

1. legalne geometrie maski to `Box`, `Cylinder`, `Translate`, `Difference`, `Union` i
   `Intersection` zbudowane rekurencyjnie z obsługiwanych prymitywów; `ImportedGeometry`, krzywe
   waveguide i inne kształty bez stabilnego predicate są odrzucane przed planowaniem;
2. AABB tetraedru poza AABB maski daje wkład zero; tetra całkowicie wewnątrz prymitywu z
   certyfikowalnym testem wypukłym używa dokładnego całkowania P1;
3. pozostałe tetra są całkowane parą reguł tetraedralnych rzędu 2 i 4 dla czterech
   całek `phi_i chi S`;
4. jeśli norma różnicy przekracza `1e-6` razy objętość bieżącego podtetra, tetra jest dzielone
   deterministycznie przez wszystkie środki krawędzi na osiem podtetra z ustaloną przekątną
   wewnętrznego ośmiościanu wybraną przez najmniejszą leksykograficznie parę współrzędnych jego
   przeciwnych wierzchołków; ta reguła działa identycznie na każdym poziomie rekursji;
5. maksymalna głębokość wynosi 10. Brak spełnienia tolerancji jest błędem materializacji z id
   elementu, oszacowanym błędem i głębokością, nie cichym przyjęciem wyniku;
6. po zsumowaniu stosowane jest dzielenie przez lumped mass `M_i`; węzeł z `M_i=0` nie należy do
   aktywnej domeny i otrzymuje zero.

Reguły kwadratury i kolejność redukcji są stałe oraz wersjonowane w basis signature. Dla bardzo
małych masek poniżej rozdzielczości siatki validator wymaga refinement zamiast zwiększania amplitudy
na pojedynczym węźle. Kwalifikacja obejmuje analityczne objętości Box/Cylinder, refinement study
objętości, normy L2 pola i Γ-resonance. Względny błąd objętości maski ma być `<0.5%` na siatce
kwalifikacyjnej i zbiegać co najmniej liniowo przy `h -> h/2` dla niezgodnej granicy.

Implementacja v1 obsługuje wyłącznie pole magnetyzacji P1 (`fe_order == 1`), zgodne z węzłowym
AOS-3 ABI. Planner odrzuca regional drive dla wyższego rzędu z komunikatem wymagającym osobnego
high-order DOF projection contract. Nie wolno broadcastować wartości węzłowych na dodatkowe DOF.

### 5.3 Cache i rewizje

`H0_q` jest budowane przez produkcyjny moduł projekcji w `backends/fem`, a nie przez planner lub
runner w Rust. Rust rozwiązuje i waliduje semantyczny target, profil, activation oraz wersjonowany
descriptor geometrii/markerów. Natywny backend wykonuje kwadraturę, dzielenie przez lumped mass,
certyfikat PBC i zapisuje diagnostykę materializacji. Referencyjny projektor poza
`backends/fem` może istnieć wyłącznie jako niezależny oracle testowy i nie może zasilać
produkcyjnego runtime.

`H0_q` jest przebudowywane wyłącznie po zmianie:

- topologii/koordynatów siatki;
- targetu, profilu lub amplitudy/kierunku;
- mapowania materiałów/regionów wpływającego na aktywną domenę;
- klasy periodycznych DOF.

Zmiana wyłącznie waveformu nie przebudowuje projekcji. Signature bazy zawiera wersję schematu,
mesh revision, target/profile, amplitudę, kierunek i algorytm projekcji. Runtime provenance zapisuje
signature oraz normy kontrolne bazy.

### 5.4 Dyskretyzacja FDM

W FDM profil nie jest wartością w środku komórki, tylko średnią objętościową zgodną z metodą
różnic/objętości skończonych:

\[
w_{qc}=V_c^{-1}\int_{V_c}\chi_{T_q}(\mathbf r)S_q(\mathbf r)dV,
\qquad
\mathbf H^0_{qc}=\frac{B_q}{\mu_0}\hat{\mathbf e}_q w_{qc}.
\]

Uniform/global daje dokładnie `w=1` w aktywnych komórkach. Region marker daje 0/1. Geometry mask i
analityczny sinc używają deterministycznej pary kwadratur tensorowych rzędu 2/4 z
rekurencyjnym podziałem komórki do tej samej względnej tolerancji `1e-6` i maksymalnej głębokości 10.
Brak zbieżności jest błędem. Dzięki temu różnica FDM/FEM wynika z dyskretyzacji rozwiązania, a nie z
innej semantyki maski. FDM CPU i GPU przechowują niezmienną bazę komórkową, a waveform ewaluują w
każdym podetapie RK.

## 6. Integracja czasowa

### 6.1 Ewaluacja w podetapach RK

Dla każdego podetapu `s` jawnego RK:

```text
t_eval = t_n + c[s] * dt
tau_q  = stage_local ? t_eval - stage_start : t_eval
lambda_q = waveform_q(tau_q)
H_drive = sum_q lambda_q * H0_q
H_eff   = existing_effective_field(m_stage, t_eval) + H_drive
k_s     = LLG(m_stage, H_eff)
```

Nie wolno obliczać `H_drive(t_n)` raz na zaakceptowany krok. Dotyczy to Heuna, RK4, RK23 i RK45
na CPU i GPU oraz FDM i FEM. Test rzędu używa problemu z analitycznym polem czasowym i wykazuje
oczekiwany slope błędu do momentu ograniczenia przez tolerancję/projekcję.

### 6.2 Zdarzenia i nieciągłości

Event scheduler zbiera w zegarze absolutnym:

- `Pulse.t_on`, `Pulse.t_off`;
- wszystkie węzły `PiecewiseLinear`;
- początek/koniec aktywacji drive przez zmianę stage;
- dokładne chwile output cadence.

Krok jest skracany tak, aby kończył się na najbliższym zdarzeniu. Dla prostokątnego pulse:

- krok kończący się na zdarzeniu używa wartości lewostronnej w etapach wewnętrznych;
- następny krok startuje z prawostronną semantyką `t_on <= t < t_off`;
- FSAL i cache RHS są unieważniane na zdarzeniu.

Adaptacyjny controller nie może odrzucić skróconego kroku i ponownie przekroczyć eventu. Zdarzenia
bliższe niż tolerancja czasu są deduplikowane deterministycznie.

### 6.3 Norma magnetyzacji i adaptacja

Istniejąca projekcja/renormalizacja `|m|=1` pozostaje niezmieniona. Nowe testy zapisują:

- `max_i ||m_i|-1|`;
- liczbę accepted/rejected steps;
- minimalne/maksymalne `dt`;
- liczbę skróceń do eventów i output times;
- rewizję pola na każdy zaakceptowany snapshot.

Próg kwalifikacyjny double: `max norm drift <= 1e-10` po mechanizmie normalizacji i brak NaN/Inf.
Single precision dostaje osobny, luźniejszy próg dopiero po kwalifikacji double.

### 6.4 Output cadence

FFT wymaga równomiernych czasów. Pierwsza implementacja wymusza dokładne snapshoty
`t_n = t_start + n delta_t_out` przez skracanie kroku. Nie wykonuje FFT na nieregularnych próbkach
i nie interpoluje ich po fakcie.

Warunki:

\[
\Delta t_\mathrm{out}\le\frac{1}{2f_\mathrm{max}},\qquad
\Delta f=\frac{1}{T_\mathrm{record}}.
\]

Validator ostrzega, jeśli `f_max` waveformu przekracza Nyquista. Dla sinc domyślne zalecenie
kwalifikacyjne to co najmniej 10 próbek na okres przy `f_c`, choć matematyczny Nyquist wymaga 2.

## 7. Analiza Γ

### 7.1 Domena i excitation

- bazowa komórka antidot 200 nm × 200 nm × 10 nm;
- PBC x/y, istniejący demag `periodic_airbox_k0`;
- statyczne `B_ext` polaryzuje w x;
- drive globalny, mały i poprzeczny, np. 1 mT w y;
- `SincPulse(cutoff_hz=20e9, t0=100e-12)`;
- napęd aktywny wyłącznie w stage `excite_gamma`;
- amplituda musi zostać sprawdzona w reżimie liniowym przez porównanie 0.5/1/2 mT.

### 7.2 Obserwable

Domyślna odpowiedź moment-weighted:

\[
\overline{\delta m}_a(t)=
\frac{\int_{\Omega_m}M_s(\mathbf r)\delta m_a(\mathbf r,t)dV}
{\int_{\Omega_m}M_s(\mathbf r)dV}.
\]

Całki są liczone tym samym `Ms`-weighted lumped mass co statystyki FEM, a nie średnią po węzłach.
Canonical config `detrend` ma `none | mean | linear`; domyślnie `none`, ponieważ `m0` jest już
odjęte. Każda dodatkowa operacja jest zapisana w artefakcie. Dla `N` równomiernych próbek:

\[
w_n=\frac12\left[1-\cos\left(\frac{2\pi n}{N-1}\right)\right],
\quad U_t=\sum_{n=0}^{N-1}w_n^2,
\]

\[
\widetilde m_a(f_p)=\sum_{n=0}^{N-1}w_n\delta m_a(t_n)
\exp(+i2\pi pn/N),
\quad f_p=\frac{p}{N\Delta t},
\]

\[
P_a(f_p)=c_p\frac{|\widetilde m_a(f_p)|^2}{N U_t},
\]

gdzie `c_p=1` dla DC i Nyquista (gdy istnieje), a `c_p=2` dla pozostałych dodatnich
częstotliwości. Znak `+i omega t` jest zgodny z finite-k convention poniżej. `P_a` ma jednostkę
kwadratu obserwable, a suma one-sided bins reprodukuje średni kwadrat sygnału okienkowanego w
przyjętej normalizacji. Surowe kompleksowe `m_tilde` i `U_t` są zachowane, aby analiza mogła zostać
odtworzona.

Dla składowych poprzecznych:

\[
S_\Gamma(f)=P_y(f)+P_z(f).
\]

Opcjonalna podatność `chi(f)=m_tilde(f)/H_tilde(f)` jest publikowana tylko tam, gdzie
`|H_tilde(f)| >= epsilon_source max|H_tilde|`, domyślnie `epsilon_source=1e-6`; w pozostałych
punktach wartość ma maskę invalid, nie zero.

Artefakt `spin_wave_response.v1` zawiera `m0`, czasy, surowe momenty, okna, kompleksowe widmo,
PSD, parametry źródła, jednostki, normalizację i częstotliwość Nyquista. Symmetry diagnostic ostrzega,
gdy wybrany kierunek pola ma zerowe sprzężenie z oczekiwanym modem.

### 7.3 Kryteria Γ

- po wyłączeniu drive trajektoria startująca z `m0` pozostaje w granicy błędu relaksacji;
- odpowiedź skaluje się liniowo z amplitudą: częstotliwości peaków zmieniają się `<0.5%`, a
  amplituda odpowiedzi po podwojeniu pola mieści się w `2.0 ± 5%` dla kwalifikacyjnego małego sygnału;
- po `dt -> dt/2` główne częstotliwości zmieniają się `<0.5%`;
- po refinement mesh główne częstotliwości zmieniają się `<2%`;
- FEM CPU/GPU double: peak frequencies `<0.5%`, znormalizowane PSD L2 `<5%`;
- globalny drive ma stałe węzłowe `H_drive=B/mu0` i przechodzi PBC certificate.

## 8. Analiza finite-k

### 8.1 Domena

Pierwsza kwalifikacja używa wydłużonej superkomórki/falowodu z antidotami:

- oś propagacji x: otwarta, długość wystarczająca na źródło, obszar obserwacji i absorbery;
- oś y: PBC poprzeczne, jeśli geometria jest translacyjnie periodyczna;
- oś z: fizycznie otwarta/demag zgodnie z istniejącym kontraktem;
- lokalna `geometry_mask` w pobliżu środka albo jednego końca obszaru roboczego;
- kierunek drive poprzeczny do `m0`;
- damping ramp przy końcach x.

Profil absorbera:

\[
\alpha(x)=\alpha_0+(\alpha_\mathrm{max}-\alpha_0)s(x)^p,
\quad s\in[0,1],
\]

z `p>=2`; absorber nie zachodzi na analizowany centralny obszar. Kwalifikacja porównuje co najmniej
dwie długości/rampy i wymaga spadku amplitudy odbitej o co najmniej 20 dB względem przypadku bez
absorbera w zdefiniowanym oknie czasowym.

### 8.2 Próbkowanie FEM

Nie wolno FFT-ować niejednorodnego zbioru węzłów FEM jak równomiernej siatki. Pole P1 jest
próbkowane na równomiernych pozycjach `x_j`, jako przekrojowa średnia moment-weighted:

\[
\delta m_a(x_j,t_n)=
\frac{\int_{A(x_j)}M_s\delta m_a\,dA}
{\int_{A(x_j)}M_s\,dA}.
\]

Operator próbkowania jest zbudowany raz jako rzadka macierz `P` z FE DOF do próbek i wersjonowany
mesh/probe signature. Dla każdej płaszczyzny `x=x_j`:

1. przeciąć każdy aktywny tetra z płaszczyzną z tolerancją geometryczną
   `epsilon_geom = 64 eps_machine max(L_domain, 1e-30 m)`;
2. wynikowy trójkąt albo czworokąt uporządkować wokół centroidu; czworokąt podzielić przekątną o
   mniejszej parze leksykograficznej współrzędnych;
3. ograniczenie funkcji P1 do przekroju jest liniowe, więc całki `Ms phi_i` policzyć dokładnie
   regułą trójkątną rzędu 2; `Ms` jest elementowe albo interpolowane zgodnie z canonical material
   realization;
4. płaszczyzna leżąca na wspólnej ścianie używa half-open ownership: element o mniejszym globalnym
   id jest właścicielem, co zapobiega podwójnemu zliczaniu;
5. znormalizować każdy wiersz przez `int_A Ms dA` i zapisać jego sumę kontrolną.

Punkt/przekrój bez dodatniej masy magnetycznej jest oznaczony invalid. Dla lokalnych modów można
zdefiniować kilka pasów y/z, ale każdy ma osobny id i normalizację.

Warunek przestrzennego Nyquista:

\[
\Delta x\le\frac{\pi}{k_\mathrm{max}},
\qquad k\;\text{raportowane w rad/m}.
\]

### 8.3 Dynamic structure factor

Po odjęciu `m0`, wybranym detrend i zastosowaniu okien `w_x`, `w_t`, przy
`U_x=sum_j w_x(j)^2`, `U_t=sum_n w_t(n)^2`:

\[
\widetilde m_a(k_l,f_p)=
\sum_{j,n}w_x(j)w_t(n)\delta m_a(x_j,t_n)
\exp[-i(k_lx_j-2\pi f_pt_n)],
\]

\[
S_m(k,f)=\sum_{a\in\mathcal C}|\widetilde m_a(k,f)|^2.
\]

Canonical znormalizowana mapa jest dokładnie:

\[
S_m(k_l,f_p)=c_p\frac{\sum_{a\in\mathcal C}|\widetilde m_a(k_l,f_p)|^2}
{N_xN_tU_xU_t},
\]

z one-sided temporal factor `c_p` jak w Γ. Osie mają
`k_l=2 pi l/(N_x delta_x)` po `fftshift` do zakresu ujemnego/dodatniego oraz
`f_p=p/(N_t delta_t)`. Konwencja `exp[-i(kx-2 pi f t)]` sprawia, że fala
`exp[i(k0 x-2 pi f0 t)]` ma peak przy `(k0,f0)`. Implementacja może użyć FFT i sprzężenia, ale
artefakt oraz test syntetycznej fali muszą potwierdzić tę konwencję.

Artefakt `dynamic_structure_factor.v1` zapisuje:

- `x_m`, `time_s`, `k_rad_per_m`, `frequency_hz`;
- komponenty, orientację osi i konwencję znaku fazy;
- complex spectrum albo jawnie rozdzielone real/imag;
- `S_m`, okna i ich normalizację;
- probe-domain id, mesh/probe signature;
- maskę invalid i odcięty obszar absorberów;
- źródło i jego osobne `H(k,f)`.

### 8.4 Kryteria finite-k

- zmiana `delta_x/2` nie przesuwa wybranych branch peaks o więcej niż 2%;
- zmiana `delta_t/2` nie przesuwa ich o więcej niż 1%;
- podwojenie długości centralnego obszaru nie zmienia gałęzi w zaakceptowanym oknie o więcej niż 2%;
- sygnał przy dodatnim/ujemnym `k` odpowiada lokalizacji źródła i konwencji fazy;
- wyłączenie lokalizacji źródła na rzecz globalnego drive redukuje finite-k weight zgodnie z
  oczekiwaniem symetrii;
- branch w granicy `k -> 0` zgadza się z wynikiem Γ w granicy tolerancji geometrii/superkomórki;
- FEM CPU/GPU double przechodzi porównanie peak-line oraz znormalizowanej mapy.

## 9. Kanoniczny kontrakt authoring i ProblemIR

### 9.1 Python DSL

Docelowe użycie:

```python
drive = fm.RegionalFieldDrive(
    id="drive-pulse",
    name="Gamma sinc pulse",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.SincPulse(cutoff_hz=20e9, t0=100e-12, amplitude=1.0),
    time_origin="stage_local",
    activation=fm.DriveActivation.stage_ids(["excite_gamma"]),
)

study.field_drives.add(drive)
study.stages.add_minimize(stage_id="equilibrate", method="bb", ...)
study.stages.add_run(stage_id="excite_gamma", until=4e-9, output_every=5e-12)
```

Publiczne klasy są niemutowalne, typowane i eksportowane z `fullmag`. `direction` jest normalizowany
przy konstrukcji, a oryginalny wektor nie jest tracony tylko wtedy, gdy provenance wymaga go jako
requested input. Metody stage wymagają albo generują stabilne id; eksport UI zawsze zapisuje id.

### 9.2 Wire representation

```json
{
  "id": "drive-pulse",
  "name": "Gamma sinc pulse",
  "kind": "regional",
  "enabled": true,
  "target": {"kind": "global"},
  "amplitude_B_T": 0.001,
  "direction": [0.0, 1.0, 0.0],
  "spatial_profile": {"kind": "uniform"},
  "waveform": {
    "kind": "sinc_pulse",
    "cutoff_hz": 20000000000.0,
    "t0": 1e-10,
    "amplitude": 1.0
  },
  "time_origin": "stage_local",
  "activation": {"kind": "stage_ids", "stage_ids": ["excite_gamma"]}
}
```

Alternatywne targety mają dokładnie postać:

```json
{"kind":"object","object_id":"film"}
{"kind":"region","object_id":"film","region_id":"source"}
```

Profil maski:

```json
{
  "kind":"geometry_mask",
  "object_id":"source-mask",
  "envelope":{"kind":"uniform"}
}
```

Profil maski ze starą obwiednią sinc:

```json
{
  "kind":"geometry_mask",
  "object_id":"source-mask",
  "envelope":{
    "kind":"sinc",
    "axis":[1.0,0.0,0.0],
    "period_m":2e-7,
    "center_m":0.0,
    "width_m":1e-6,
    "window":"hann"
  }
}
```

Serde stosuje `deny_unknown_fields` na nowych typach. Kolejność drives nie zmienia fizyki; planner
sortuje po `id` dla deterministycznego planu i sumy. Duplikat id/nazwy jest błędem.

### 9.3 Walidacja

Walidator rozróżnia błędy i ostrzeżenia:

**Błędy:** brak targetu, dangling id, zero direction, niepoprawny waveform, stage id nieistniejący,
niestały drive aktywny w minimizerze, profil maski bez realizowalnej geometrii, niespójność PBC,
backend bez executable capability, brak output cadence dla żądanej analizy FFT.

**Ostrzeżenia:** sinc aktywny przy `tau=0`, pole równoległe do `m0`, zbyt duża amplituda dla small
signal, naruszenie Nyquista, za krótki record, źródło globalne przy żądaniu finite-k, zbyt mały
odstęp source–absorber, potencjalna symetryczna ciemność modu.

## 10. Plan natywnego ABI i runtime FEM

### 10.1 ABI C i Rust FFI

Zmiana jest wersjonowana i fail-closed. W `native/include/fullmag_fem.h` oraz lustrzanym
`crates/fullmag-fem-sys/src/lib.rs` dodać:

```c
typedef enum fullmag_fem_time_dependence_kind {
  FULLMAG_FEM_TIME_CONSTANT = 0,
  FULLMAG_FEM_TIME_SINUSOIDAL = 1,
  FULLMAG_FEM_TIME_PULSE = 2,
  FULLMAG_FEM_TIME_PIECEWISE_LINEAR = 3,
  FULLMAG_FEM_TIME_SINC_PULSE = 4
} fullmag_fem_time_dependence_kind;

typedef enum fullmag_fem_time_origin {
  FULLMAG_FEM_TIME_STAGE_LOCAL = 0,
  FULLMAG_FEM_TIME_ABSOLUTE = 1
} fullmag_fem_time_origin;

typedef struct fullmag_fem_time_point {
  double time_s;
  double value;
} fullmag_fem_time_point;

typedef struct fullmag_fem_sinusoidal_time_desc {
  double frequency_hz;
  double phase_rad;
  double offset;
} fullmag_fem_sinusoidal_time_desc;

typedef struct fullmag_fem_pulse_time_desc {
  double t_on_s;
  double t_off_s;
} fullmag_fem_pulse_time_desc;

typedef struct fullmag_fem_sinc_pulse_time_desc {
  double cutoff_hz;
  double t0_s;
  double amplitude;
} fullmag_fem_sinc_pulse_time_desc;

typedef union fullmag_fem_time_dependence_parameters {
  fullmag_fem_sinusoidal_time_desc sinusoidal;
  fullmag_fem_pulse_time_desc pulse;
  fullmag_fem_sinc_pulse_time_desc sinc_pulse;
} fullmag_fem_time_dependence_parameters;

typedef struct fullmag_fem_time_dependence_desc {
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t kind;
  fullmag_fem_time_dependence_parameters parameters;
  const fullmag_fem_time_point* points;
  uint64_t point_count;
} fullmag_fem_time_dependence_desc;

typedef struct fullmag_fem_regional_field_drive_desc {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t stable_id_hash;
  fullmag_fem_field_target_desc target;
  fullmag_fem_spatial_profile_desc spatial_profile;
  double amplitude_b_t;
  double direction[3];
  fullmag_fem_time_dependence_desc waveform;
  uint32_t time_origin;
} fullmag_fem_regional_field_drive_desc;
```

`fullmag_fem_plan_desc` otrzymuje `regional_field_drives`, `regional_field_drive_count` i
`stage_start_time_s`. Wskaźniki żyją co najmniej do zakończenia wywołania create/configure; native
kopiuje descriptor i potrzebne tablice. `abi_version`, `struct_size`, null/count oraz value count są
walidowane przed alokacją.

Descriptor targetu zawiera rozwiązane markery elementów canonical mesh ownership. Descriptor
profilu jest zamkniętym, wersjonowanym drzewem obsługiwanych prymitywów i transformacji albo
analitycznym profilem sinc; nie przenosi callbacku ani gotowej bazy węzłowej. Native kopiuje
descriptor, buduje `H0_q` na pełnym zbiorze węzłów siatki wejściowej metodą z rozdz. 5, sprawdza
zgodność każdej klasy PBC, a dopiero potem mapuje pole na reprezentantów. Powstała baza ma layout
AOS-3 (`value[3*i+c]`, `c={x,y,z}`) na CPU; GPU wykonuje jednorazową konwersję do SoA przy uploadzie.
ABI eksportuje basis signature, normy i certyfikat PBC jako diagnostykę, ale nie przyjmuje
niezweryfikowanego `h_basis_xyz` z planera.

ABI dodaje `FULLMAG_FEM_OBSERVABLE_H_DRIVE` oraz osobne `drive_energy_joules` w step stats.
`external_energy_joules` nadal oznacza energię statycznego `H_ext`; suma całkowita zawiera oba
składniki dokładnie raz. Runtime bundle, C header i Rust FFI są wersjonowane i przebudowywane razem;
runner odrzuca mismatch wersji zamiast próbować użyć starszego plan layoutu.

Interaktywny context dostaje jawne `begin_stage`/`reconfigure_regional_field_drives`; zmiana rewizji
unieważnia FSAL, cached RHS, energy i quantity snapshots. Nie dodawać nowej fizyki do
`mfem_bridge.cpp` ani nowego przekrojowego pola w `Context`; rozszerzyć istniejący
`ZeemanRuntimeState` i dedykowane moduły interactions.

### 10.2 FEM CPU

Nowe moduły:

- `backends/fem/cpu/mfem/interactions/zeeman_time_dependence.{hpp,cpp}`;
- `backends/fem/cpu/mfem/interactions/zeeman_regional_field.{hpp,cpp}`.

`ZeemanRuntimeState` przechowuje:

- listę zamkniętych waveform descriptors;
- contiguously packed `H0_q`;
- roboczy `H_drive`;
- `last_evaluation_time_s`, `drive_revision` i materialization counters.

W `effective_field` dla każdego `evaluation_time_s`:

1. wyzeruj `H_drive`;
2. dla każdego aktywnego q oblicz `lambda_q`;
3. wykonaj `H_drive += lambda_q H0_q`;
4. dodaj dokładnie raz do `H_eff`;
5. oznacz ten sam bufor/time/revision jako źródło energii i readbacku.

Stałe drive mogą użyć fast path bez materializacji na każdym stage, ale wynik quantities musi być
identyczny. Sumowanie wielu drives używa deterministycznej kolejności id; test wielu niemal
kasujących się pól kontroluje stabilność.

### 10.3 FEM GPU

Nowe elementy pod `backends/fem/gpu/cuda/interactions/zeeman/`:

- `time_dependence_device.cuh` — bezalokacyjna ewaluacja closed descriptor;
- `regional_field_kernels.{cuh,cu}` — materializacja/sumowanie baz;
- rozszerzenie energy reductions dla `E_drive`.

GPU przechowuje resident:

- packed basis `H0[q][component][node]`;
- packed waveform descriptors i PWL points;
- wynikowy `h_drive` w field buffer state.

Każdy RK stage uruchamia kernel z `evaluation_time_s`; nie kopiuje pełnego pola z hosta. Dopuszczalny
jest upload małego descriptoru przy zmianie stage, nie przy każdym podetapie. `h_ext` i `h_drive`
pozostają osobnymi buforami dla provenance/quantities, a `rk_effective_field.cu` sumuje oba raz.

Pierwsza kwalifikacja: double. Single jest `source_visible`/`unsupported` do osobnego testu błędu
fazowego, energii i widma; nie dziedziczy statusu z double.

## 11. Runner, planner, provenance i artefakty

Planner:

1. normalizuje drive i stage activation;
2. rozwiązuje target/profile do wersjonowanego descriptoru markerów i geometrii;
3. sprawdza semantyczną legalność PBC i przekazuje klasy periodyczne;
4. zleca produkcyjną materializację lumped-L2 oraz certyfikat PBC natywnemu `backends/fem`;
5. tworzy event schedule;
6. sprawdza backend capability;
7. wpisuje plan signature i diagnostics.

Runner:

1. wybiera aktywne drive dla stage;
2. przekazuje tylko ich bazy i waveformy do native context;
3. ustawia `stage_start_time_s`;
4. przenosi snapshot `m0` bez ponownej inicjalizacji;
5. materializuje output cadence i quantities;
6. zapisuje requested execution i resolved execution;
7. przy braku capability kończy run przed startem solvera.

Zakazany jest fallback FEM GPU → FEM CPU, jeśli zmienia wykonanie żądanego drive bez jawnej zgody
trybu execution. Nawet dozwolony fallback musi ponownie przejść capability resolution i zachować
requested/resolved provenance.

Artefakt `regional_field_drive.v1` zawiera:

- normalized drive JSON;
- target/profile signature;
- waveform i time origin;
- basis norms/min/max/integral;
- PBC certificate;
- backend/precision/ABI;
- stage activation i event schedule;
- quantity revision map.

Ciężkie pola pozostają w binary data plane. JSON status zawiera tylko id, revision, availability,
units, shape i artifact refs.

## 12. OpenAPI v2 i Control Room

### 12.1 API

Implementować istniejącą specyfikowaną rodzinę:

```text
GET    /v2/sessions/current/model/field-drives
POST   /v2/sessions/current/model/field-drives
PATCH  /v2/sessions/current/model/field-drives/{drive_id}
DELETE /v2/sessions/current/model/field-drives/{drive_id}
```

Mutacje wymagają `base_revision`, modyfikują canonical SceneDocument transaction i zwracają nową
revision. Nie są oddzielnym store. OpenAPI ma discriminated unions dla target/profile/waveform/
activation; nie używa `BTreeMap<String, Value>` dla nowego kontraktu.

Data/analysis resources:

```text
GET /v2/sessions/current/data/fields/H_drive
GET /v2/sessions/current/data/scalars/E_drive
GET /v2/sessions/current/analysis/spin-wave-response/{run_id}/gamma-spectrum
GET /v2/sessions/current/analysis/spin-wave-response/{run_id}/dynamic-structure-factor
```

HTTP jest źródłem prawdy, websocket przekazuje tylko bounded invalidation/revision. Generated TS nie
jest edytowany ręcznie.

### 12.2 UI authoring

Explorer ma gałąź `Physics > Field drives`, osobny node dla każdego drive i własny Inspector.
Inspector zawiera:

- enabled, name, amplitude w mT/T z jednoznaczną konwersją;
- wektor kierunku i przycisk normalizacji;
- target global/object/region;
- profil uniform/geometry mask/spatial sinc;
- waveform kind oraz typowane pola z SI;
- time origin;
- multi-select aktywnych stage id;
- capability badge requested/resolved;
- diagnostics Nyquist, sinc tail, PBC i symmetry;
- read-only preview `B(t)` oraz preview przestrzenne na mesh.

Preview waveformu używa tej samej definicji co canonical model, ale nie jest oracle runtime. Po run
panel wyraźnie przełącza się na resource `H_drive` rzeczywiście zmaterializowany przez solver.

Dotychczasowy `AntennaObjectPanel` przestaje zapisywać luźny `current_modules` payload dla
`prescribed_zeeman_mask`. Adapter odczytu pokazuje stary wpis jako zmigrowany drive i przy następnym
zatwierdzeniu zapisuje canonical `field_drives`.

`RunStageInspector` pokazuje jawnie aktywne drive i origin czasu. Nie może twierdzić, że pole jest
ewaluowane per RK stage, dopóki resolved capability nie ma statusu validated.

### 12.3 UI analysis

- Γ: wykres `delta m(t)`, input `H_drive(t)`, PSD/susceptibility, peak table i profile modów;
- finite-k: heatmap `S(k,f)` z osiami rad/µm i GHz, wyborem komponentów, log/linear scale,
  crosshair, line cuts i eksportem danych;
- tooltipy zawsze pokazują jednostki, normalizację i maskę invalid;
- dane są bounded/decimated, ECharts ma jednoznaczny lifecycle i nie redrawuje się w idle;
- unsupported/degraded są jawne, nie jako pusta mapa.

## 13. Plan wdrożenia test-first

Każde zadanie kończy się zielonym focused testem. Commity w przykładach są sugestią granic review;
nie należy stage'ować cudzych zmian ze wspólnego worktree.

### Task 0 — Ustanowienie źródeł normatywnych

**Pliki:**

- Rename: `docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md` →
  `docs/physics/0920-regional-time-domain-field-drive.md`
- Add: `docs/adr/0019-regional-field-drive-and-stage-time-semantics.md`
- Modify: `docs/specs/problem-ir-v0.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/visualization-quantities-v1.md`
- Modify references: `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
- Modify references: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive.md`
- Modify references: `docs/validation/2026-07-09-backend-llg-audit-coverage.md`
- Modify: `docs/superpowers/plans/2026-07-10-microwave-antenna-contracts-api-implementation.md`
- Modify: `docs/superpowers/plans/2026-07-10-microwave-antenna-backend-implementation.md`
- Modify: `docs/superpowers/plans/2026-07-10-microwave-antenna-ui-analysis-implementation.md`

- [ ] Zmienić nazwę i przepisać notę 0920 z przeciążonego `AntennaFieldSource` na osobny
      `RegionalFieldDrive`; zaktualizować wszystkie wejściowe referencje, nie pozostawiać drugiej
      konkurencyjnej noty ani martwego linku.
- [ ] Dodać wszystkie równania, jednostki, stage clock, FEM projection, PBC, Γ i finite-k z rozdz. 4–8.
- [ ] W ADR 0019 zapisać rozdział `RegionalFieldDrive`/`SolvedAntennaDrive`, `H_drive`/`H_ant`,
      aktywację stage i migrację starej maski.
- [ ] Oznaczyć starsze punkty planów antenowych jako superseded wyłącznie dla regional drive.
- [ ] Zaktualizować capability matrix początkowo bez promocji: obecny stan ma pozostać jawny.
- [ ] Uruchomić `rg -n "RegionalFieldDrive|H_drive|stage_local|finite-k"` po dokumentach i usunąć
      sprzeczne nowe definicje; nie usuwać historycznych opisów bez adnotacji.

### Task 1 — Publiczne klasy Python i stabilne stage id

**Pliki:**

- Modify: `packages/fullmag-py/src/fullmag/model/antenna.py`
- Modify: `packages/fullmag-py/src/fullmag/model/energy.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Add: `packages/fullmag-py/tests/test_regional_field_drive.py`
- Add: `packages/fullmag-py/tests/test_study_stages.py`

- [ ] Najpierw testy konstrukcji, jednostek, normalizacji direction, wszystkich target/profile/
      waveform variants i invalid inputs.
- [ ] Testy wymagają `stage_id` w `add_run`, `add_relax`, `add_minimize` oraz wykrywają duplikaty.
- [ ] Zaimplementować niemutowalne `RegionalFieldDrive`, `FieldTarget`, profile i `DriveActivation`.
- [ ] Dodać `study.field_drives.add(...)` i top-level `Problem.field_drives`.
- [ ] Zachować dokładne obecne wzory `TimeDependence`; dodać stabilną ewaluację sinc przy zerze.
- [ ] Test: `python -m pytest packages/fullmag-py/tests/test_regional_field_drive.py packages/fullmag-py/tests/test_study_stages.py -q`.

### Task 2 — Canonical script export i migracja starego Pythona

**Pliki:**

- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Add: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`
- Modify: `packages/fullmag-py/tests/test_current_transport.py`

- [ ] Failing golden tests dla round-trip każdego waveformu, targetu, profilu, activation i stage id.
- [ ] Dodać deterministic exporter z argumentami nazwanymi i SI.
- [ ] Dodać one-way migration adapter `prescribed_zeeman_mask -> RegionalFieldDrive` z provenance.
- [ ] Nowy eksport nigdy nie emituje starego modelu; import pozostaje wspierany.
- [ ] Test idempotencji `script -> SceneDocument -> script -> SceneDocument` byte-equivalent po
      canonical JSON sort.
- [ ] Uruchomić oba wskazane pliki testowe.

### Task 3 — ProblemIR i walidacja

**Pliki:**

- Modify: `crates/fullmag-ir/src/model.rs`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-ir/src/quantities.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`

- [ ] Serde round-trip tests dokładnego wire JSON z rozdz. 9.
- [ ] Validation tests: dangling target/stage, duplicate id, zero direction, invalid sinc/PWL,
      dynamic drive w minimizerze i collision starego/nowego źródła.
- [ ] Dodać tagged unions z `deny_unknown_fields` i normalized direction.
- [ ] Dodać `HDrive`, `EDrive`, `EdenDrive` do quantity identity bez aliasowania `HAnt`.
- [ ] Test: `cargo test -p fullmag-ir` jako kontrola warstwy Rust; nie jest dowodem native FEM.

### Task 4 — Typed SceneDocument i authoring projection

**Pliki:**

- Modify: `crates/fullmag-authoring/src/scene.rs`
- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-authoring/src/validation.rs`
- Test: inline tests w powyższych modułach

- [ ] Dodać `field_drives: Vec<SceneRegionalFieldDrive>` jako canonical scene state.
- [ ] Nie rozszerzać `SceneCurrentModulesState` o kolejny luźny wariant.
- [ ] Test Python/Scene/IR exact equality.
- [ ] Test revision semantics: authoring drive invaliduje plan/run/analysis, ale nie mesh przy zmianie
      waveformu; zmiana geometry mask/profile invaliduje projekcję pola, nie samą topologię mesh.
- [ ] Test legacy adapter i wykrycie konfliktu podwójnego źródła.
- [ ] Uruchomić `cargo test -p fullmag-authoring`.

### Task 5 — Planner: target descriptor, PBC legality i capability

**Pliki:**

- Add: `crates/fullmag-plan/src/regional_field_drive.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-plan/src/quantities.rs`
- Replace/deprecate: `crates/fullmag-plan/src/antenna_zeeman.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

- [ ] Failing tests global/object/region/mask descriptor, overlap superposition i deterministic order.
- [ ] Testy rozwiązania canonical mesh ownership do markerów i zamkniętego drzewa geometrii.
- [ ] Testy odrzucenia geometrii bez stabilnego predicate oraz `fe_order != 1`.
- [ ] PBC legality test: brak klas lub nieperiodyczny profil na osi PBC fail przed run.
- [ ] Dodać plan signature, basis diagnostics i event schedule.
- [ ] Planner wymuszonego niewspieranego backendu musi fail przed run.
- [ ] Test `cargo test -p fullmag-plan`; testy nie mogą implementować produkcyjnej kwadratury FEM.

### Task 6 — Wspólny evaluator czasu i scheduler zdarzeń

**Pliki:**

- Add: `crates/fullmag-runner/src/time_dependence.rs`
- Add: `crates/fullmag-runner/src/time_events.rs`
- Modify: `crates/fullmag-runner/src/antenna_fields.rs`
- Test: inline property/table tests

- [ ] Table-driven oracle dla wszystkich funkcji w punktach regularnych, przy sinc zero i granicach.
- [ ] Cross-language golden JSON/CSV używany później przez C++/CUDA tests.
- [ ] Test event conversion stage-local → absolute, dedup, left/right pulse i PWL knots.
- [ ] Test FSAL invalidation token po stage/drive revision.
- [ ] Stare `combined_antenna_zeeman_mask_field_at_time` deleguje do canonical evaluator albo zostaje
      usunięte po migracji wszystkich callerów.
- [ ] Uruchomić focused tests `cargo test -p fullmag-runner time_dependence` i `time_events`.

### Task 7 — FDM CPU: poprawne czasy RK i canonical quantities

**Pliki:**

- Modify: `crates/fullmag-engine/src/fdm/shared/types.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/terms.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime/fdm/cpu.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `crates/fullmag-engine/src/lib.rs`
- Modify: `crates/fullmag-engine/tests/physics_guardrails.rs`
- Add: `crates/fullmag-runner/tests/physics_validation/regional_field_drive.rs`
- Modify: `crates/fullmag-runner/tests/physics_validation.rs`

- [ ] Najpierw test odróżniający frozen-per-step od per-stage sinus/sinc.
- [ ] Rozszerzyć `ExchangeLlgProblem` o osobne immutable `regional_field_drives`, nie dokładać ich
      do przeciążonego `per_node_field`; istniejący Oersted również pozostaje osobnym interaction.
- [ ] Dodać `effective_field_into_ws_at(m, evaluation_time_s, ...)` i odpowiednik SoA; metody bez
      czasu delegują wyłącznie dla stanów/statycznych obserwabli albo zostają usunięte z callerów
      dynamicznych.
- [ ] `step_with_buffers*` bierze `state.time_seconds` jako `t_n`, a każdy tableau w
      `cpu/integrators.rs` przekazuje dokładne `t_n+c_i dt` do obu ścieżek AOS i SoA.
- [ ] Dodać event capping i exact output cadence.
- [ ] Dodać `H_drive/E_drive/eden_drive` z tej samej rewizji pola.
- [ ] Wykazać rząd czasowy i zero-drive regression.
- [ ] FDM CPU może zostać promowany dopiero po managed physics gate, nie po unit testach.

### Task 8 — ABI C i Rust FFI

**Pliki:**

- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `backends/fem/src/api.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp`
- Modify: `crates/fullmag-runner/src/native_fem/tests.rs`
- Modify: `backends/fem/tests/source_facade_contract.cpp`
- Modify: `backends/fem/tests/state_io_contract.cpp`
- Modify: `backends/fem/tests/step_metrics_contract.cpp`

- [ ] Static layout/size/version tests i Rust/C mirror assertions.
- [ ] Invalid null/count/value_count/version tests fail bez segfault.
- [ ] Zaimplementować descriptor z rozdz. 10.1 i owned native copy.
- [ ] Dodać stage start/reconfigure/revision API i test invalidacji.
- [ ] Dodać observable `H_drive`, `drive_energy_joules`, total-energy composition i C/Rust layout
      assertions; `H_ext`/`external_energy_joules` zachowują dotychczasową semantykę.
- [ ] Nie uruchamiać host-first native build; dodać test do `just verify-fem-time-domain-native-contract`.

### Task 9 — FEM CPU interaction

**Pliki:**

- Modify: `backends/fem/cpu/mfem/interactions/zeeman.hpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_regional_field_projection.hpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_regional_field_projection.cpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_time_dependence.hpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_time_dependence.cpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_regional_field.hpp`
- Add: `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/effective_field.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/effective_field.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/zeeman_energy.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/zeeman_energy.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/snapshot.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/tests/zeeman_contract.cpp`
- Modify: `backends/fem/tests/rk_explicit_contract.cpp`
- Modify: `backends/fem/tests/state_io_contract.cpp`
- Modify: `backends/fem/tests/step_metrics_contract.cpp`
- Modify: `backends/fem/tests/source_facade_contract.cpp`

- [ ] Native unit oracle dla waveformów z golden table Task 6.
- [ ] Manufactured tetra tests dla lumped-L2 z analitycznym wynikiem.
- [ ] Refinement tests geometry mask, Box/Cylinder volume i exact global uniform `w=1`.
- [ ] PBC pair test: zgodna baza pass, niespójna fail z id pary/osi/max mismatch; bez uśredniania.
- [ ] Global constant manufactured test: dokładne H, E i zero dodatkowych alokacji per RHS.
- [ ] Regional basis test: H_eff difference równe H_drive dokładnie raz.
- [ ] Multi-drive superposition/cancellation test.
- [ ] RK stage-time trace test zapisujący `evaluation_time_s` i `lambda` dla Heun/RK4/RK23/RK45.
- [ ] Zaimplementować `ZeemanRuntimeState` bez dodawania nowej fizyki do `Context`/`mfem_bridge.cpp`.
- [ ] Dodać `just verify-fem-regional-field-drive-contract` i uruchomić po rebuild runtime.

### Task 10 — FEM CPU zbieżność, events i energia

**Pliki:**

- Add: `scripts/validate_fem_regional_field_drive_rk_order.py`
- Add: `scripts/test_validate_fem_regional_field_drive_rk_order.py`
- Add: `examples/fem_regional_field_drive_manufactured.py`
- Modify: `justfile`

- [ ] Oracle: pojedynczy spin w znanym polu stałym i czasowym z rozwiązaniem referencyjnym o bardzo
      małym dt albo analitycznym przypadkiem.
- [ ] Dla każdego jawnego RK oszacować slope błędu trajektorii/fazy; przy stałym dt wymagać slope
      zgodnego z rzędem w przedziale tolerancji 0.5.
- [ ] Pulse/PWL event test wykazuje brak crossing contamination i poprawną FSAL invalidację.
- [ ] Energy quadrature test porównuje `-mu0/2`-nieużywane: dla zadanego pola zewnętrznego właściwy
      oracle to pełne `-mu0 ∫ Ms m·H_drive dV`, bez czynnika 1/2.
- [ ] Dodać/uruchomić `just verify-fem-regional-field-drive-rk-time-convergence`.

### Task 11 — FEM GPU double

**Pliki:**

- Add: `backends/fem/gpu/cuda/interactions/zeeman/time_dependence_device.cuh`
- Add: `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cuh`
- Add: `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_state.hpp`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp`
- Modify: `backends/fem/gpu/cuda/fields/field_buffer_upload.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_external_energy_reductions.cu`
- Modify: `backends/fem/gpu/cuda/interactions/zeeman/zeeman_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/interactions/zeeman/zeeman_kernels.cu`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Modify: `backends/fem/tests/source_facade_gpu_state_contract.cpp`
- Modify: `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`
- Modify: `backends/fem/tests/gpu_state_runtime_contract.cpp`
- Modify: `backends/fem/tests/state_io_contract.cpp`

- [ ] Device waveform golden tests przeciw Task 6 dla double.
- [ ] Memory lifecycle test: create/reconfigure/destroy, zero leak, zero upload pełnego pola per stage.
- [ ] Kernel test superposition, PWL points i exact evaluation times.
- [ ] `H_drive` readback i `E_drive` z tej samej device revision.
- [ ] CPU/GPU double parity dla manufactured case i małej siatki.
- [ ] Dodać `just verify-fem-regional-field-drive-cpu-gpu-parity-runtime`.
- [ ] Nie promować single; utworzyć osobną przyszłą gate lub jawnie `unsupported`.

### Task 12 — Runner stage lifecycle i provenance

**Pliki:**

- Modify: `crates/fullmag-runner/src/fem_reference.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Add: `crates/fullmag-runner/src/regional_field_drive_artifacts.rs`

- [ ] Test relax → snapshot → run zachowuje m0 bitwise na tym samym backendzie przed pierwszym RHS.
- [ ] Test drive inactive w minimize i active tylko w podanym run stage.
- [ ] Test stage-local restart oraz absolute continuity.
- [ ] Test forced unsupported GPU fails; allowed fallback zachowuje requested/resolved i ponownie
      sprawdza capability.
- [ ] Zapis `regional_field_drive.v1`, revision map i event statistics.
- [ ] Usunąć obecny warunek `has_time_varying` oparty tylko o antenna field basis.

### Task 13 — OpenAPI v2

**Pliki:**

- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/scalars.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`
- Add: `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis.rs`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Generate: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`

- [ ] Contract tests CRUD z base_revision, conflict 409, validation diagnostics i scene projection.
- [ ] OpenAPI schema tests wymagają discriminators i nie dopuszczają loose map.
- [ ] Field/scalar/analysis resources testują metadata i binary refs bez heavy arrays w status.
- [ ] Zaimplementować routes z rozdz. 12.1.
- [ ] Uruchomić `cargo test -p fullmag-api router_v2`.
- [ ] Wygenerować klienta: `pnpm --dir apps/control-room generate:api`.
- [ ] Uruchomić `pnpm --dir apps/control-room check:api-hygiene`.

### Task 14 — Frontend facade, hooks i authoring model

**Pliki:**

- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Add: `apps/control-room/src/kernel/resources/fieldDriveResources.ts`
- Add: `apps/control-room/src/kernel/resources/fieldDriveResources.test.ts`
- Modify: `apps/control-room/src/kernel/resources/resourceTypes.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts`
- Add: `apps/control-room/src/shared/domain/physics/fieldDrive.ts`
- Add: `apps/control-room/src/shared/domain/physics/fieldDrive.test.ts`

- [ ] Failing tests dla typed CRUD, revision conflict i invalidation.
- [ ] Wszystkie komponenty korzystają z facade/hooks; brak direct fetch i endpoint literals.
- [ ] Pierwszy client render ma SSR-safe snapshot.
- [ ] Usunąć command tworzący loose `current_modules` mask payload; zastąpić canonical mutation.
- [ ] Test Python-exported scene → UI read → UI write → Python script semantic equality.

### Task 15 — Explorer i Inspector drive

**Pliki:**

- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
- Add: `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Add: `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanelModel.ts`
- Add: `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanelModel.test.ts`
- Add: `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`

- [ ] Każdy drive node ma osobny Inspector, nie generic fallback.
- [ ] Unit-aware inputs i exact conversion mT↔T; waveform chart pokazuje definicję sinc.
- [ ] Target/profile selectors filtrują tylko legalne object/region ids.
- [ ] Stage selector używa stabilnych id; usunięcie stage daje actionable validation.
- [ ] Capability/diagnostics pokazują source-visible/executable/validated bez fałszywego success.
- [ ] Legacy mask renderuje migration banner i po Apply zapisuje canonical drive.

### Task 16 — Preview i runtime quantities

**Pliki:**

- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Modify: `apps/control-room/src/kernel/resources/dataPreviewResources.ts`
- Modify: `apps/control-room/src/kernel/resources/dataPreviewResources.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

- [ ] Preview przestrzenne korzysta z canonical mesh/region membership, nie z luźnego bounding box.
- [ ] `H_drive` jest selectable w viewport; `B_drive` to unit transform.
- [ ] Runtime badge wyświetla revision/time użytego pola.
- [ ] Test wykrywa preview istniejące przy braku runtime capability i pokazuje `not executable`.
- [ ] Browser smoke sprawdza widoczne canvas, nieutracony WebGL context i non-zero drawing buffer.

### Task 17 — Γ pipeline i UI analysis

**Pliki:**

- Add: `crates/fullmag-runner/src/spin_wave_response.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Add: `scripts/validate_fem_periodic_antidot_gamma_spectrum.py`
- Add: `scripts/test_validate_fem_periodic_antidot_gamma_spectrum.py`
- Add: `examples/fem_periodic_antidot_time_domain_gamma.py`
- Add: `apps/control-room/src/modules/analysis-plots/spinWaveGammaModel.ts`
- Add: `apps/control-room/src/modules/analysis-plots/spinWaveGammaModel.test.ts`
- Add: `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
- Modify: `justfile`

- [ ] Unit tests moment-weighted average, detrend, Hann normalization, FFT axes, susceptibility mask.
- [ ] Example zachowuje bazowy relax case, dodaje stable stages i explicit state handoff.
- [ ] Validator sprawdza Nyquist, linearity, dt/mesh convergence, CPU/GPU peaks i quantities.
- [ ] API/UI pokazują time trace, source spectrum, PSD i peak table.
- [ ] Dodać `just verify-fem-periodic-antidot-gamma-pulse-runtime`.
- [ ] Gate musi wykonać solver, przeczytać artifact i zakończyć się nonzero przy niespełnieniu progów.

### Task 18 — finite-k pipeline i UI analysis

**Pliki:**

- Add: `crates/fullmag-runner/src/spin_wave_sampling.rs`
- Modify: `crates/fullmag-runner/src/spin_wave_response.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Add: `scripts/validate_fem_antidot_waveguide_dynamic_structure_factor.py`
- Add: `scripts/test_validate_fem_antidot_waveguide_dynamic_structure_factor.py`
- Add: `examples/fem_antidot_waveguide_time_domain_finite_k.py`
- Add: `apps/control-room/src/modules/analysis-plots/dynamicStructureFactorModel.ts`
- Add: `apps/control-room/src/modules/analysis-plots/dynamicStructureFactorModel.test.ts`
- Add: `apps/control-room/src/modules/analysis-plots/DynamicStructureFactorView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
- Modify: `justfile`

- [ ] Manufactured FE sampling test: pole liniowe P1 reprodukowane dokładnie na probe grid.
- [ ] FFT test z syntetyczną falą o znanych `(k0,f0)` i poprawnym znaku.
- [ ] Absorber comparison i reflection metric test.
- [ ] Example ma open x, transverse PBC, local mask, damping ramp i excluded absorber region.
- [ ] API/UI heatmap ma units, line cuts, invalid masks, bounded data i zero idle redraw.
- [ ] Dodać `just verify-fem-antidot-waveguide-finite-k-runtime`.

### Task 19 — Browser smoke i round-trip end-to-end

**Pliki:**

- Add: `apps/control-room/scripts/smoke-regional-field-drive.mjs`
- Add: `apps/control-room/scripts/smoke-spin-wave-response.mjs`
- Modify: `apps/control-room/package.json`

- [ ] Smoke tworzy drive globalny sinc, przypisuje go do run stage, zapisuje i ponownie odczytuje.
- [ ] Eksportowany Python zawiera canonical API i uruchamia ten sam normalized IR.
- [ ] Smoke uruchamia kwalifikacyjny mały case, obserwuje active stage i pobiera runtime H_drive.
- [ ] Smoke otwiera Γ plot i finite-k heatmap; sprawdza units/tooltips oraz brak console errors.
- [ ] Viewport assertion obejmuje canvas visible, `gl.isContextLost()==false` i nonzero drawing buffer.

### Task 20 — Końcowa promocja capability i pełna weryfikacja

**Pliki:**

- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/physics/0920-regional-time-domain-field-drive.md`
- Modify: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive-implementation-plan.md`
- Modify: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive.md`

- [ ] Najpierw zebrać artefakty każdej managed gate z commit hash/runtime image/backend/precision.
- [ ] FEM CPU double promować do `validated` dopiero po Tasks 9–10, 12, 17.
- [ ] FEM GPU double promować dopiero po Tasks 11, 17 i CPU/GPU parity.
- [ ] finite-k capability promować osobno od Γ; brak finite-k nie blokuje uczciwej promocji Γ.
- [ ] FDM GPU i FEM GPU single pozostają niepromowane bez własnych gates.
- [ ] Uruchomić:

```bash
python -m pytest packages/fullmag-py/tests/test_regional_field_drive.py \
  packages/fullmag-py/tests/test_study_stages.py \
  packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
cargo test -p fullmag-ir
cargo test -p fullmag-authoring
cargo test -p fullmag-plan
cargo test -p fullmag-runner
cargo test -p fullmag-api
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
just verify-fem-regional-field-drive-contract
just verify-fem-regional-field-drive-rk-time-convergence
just verify-fem-regional-field-drive-cpu-gpu-parity-runtime
just verify-fem-periodic-antidot-gamma-pulse-runtime
just verify-fem-antidot-waveguide-finite-k-runtime
```

- [ ] Sprawdzić świeży `git diff --check`, dokładny changed-file list i brak ręcznych zmian generated.
- [ ] Zarchiwizować raporty pod `.fullmag/reports/fem-regional-field-drive/` z manifestem v1.

## 14. Macierz dowodów i promocji

| Ścieżka | Source visible | Executable | Validated | Wymagany dowód |
|---|---:|---:|---:|---|
| FDM CPU double | po Tasks 1–7 | po Task 7 | po physics gate | per-stage RK, energy, Γ |
| FDM GPU double | nie dziedziczy | osobne wdrożenie | osobna gate | CPU/GPU parity |
| FEM CPU double | obecnie częściowo | po Tasks 8–12 | po Tasks 10+17 | managed runtime + Γ |
| FEM GPU double | obecnie unsupported | po Task 11 | po parity+Γ | managed GPU artifact |
| FEM GPU single | source po ABI | niepromowane | niepromowane | osobny phase/frequency budget |
| Γ/PBC analysis | po Task 17 | po Task 17 | po convergence | peak/PSD/PBC certificate |
| finite-k analysis | po Task 18 | po Task 18 | po absorber/sampling study | `S(k,f)` artifact |

`source_visible` oznacza wyłącznie możliwość zapisania/wyświetlenia kontraktu. `executable` wymaga,
że pole wchodzi do RHS właściwego backendu. `validated` wymaga artefaktu numerycznego i progów.

## 15. Ryzyka i zabezpieczenia

1. **Fałszywy sukces przez preview:** runtime quantity ma osobną availability/revision.
2. **Frozen field per step:** obowiązkowy trace czasów RK i convergence slope.
3. **Niespójna PBC maska:** fail-closed certificate, bez averaging.
4. **Błąd jednostek T/A/m:** tylko amplitude B w publicznym API; jednorazowe dzielenie przez `mu0`
   w planowaniu; runtime i quantities H w A/m.
5. **Podwójne dodanie pola:** test `H_eff_with-H_eff_without == H_drive`.
6. **Niepoprawna energia 1/2:** dla pola zadanego zewnętrznie brak czynnika 1/2.
7. **FFT nieregularnych czasów:** exact output events, fail bez równomierności.
8. **FFT raw FEM nodes:** wyłącznie wersjonowany operator próbkowania na regularny grid.
9. **Odbicia udające branch:** absorber metric i length convergence.
10. **Ukryty fallback:** ponowna capability resolution i requested/resolved provenance.
11. **Stary payload UI:** one-way migration i zakaz nowego zapisu do `current_modules`.
12. **GPU transfer bottleneck:** resident bases, scalar/device evaluation per stage.
13. **Zmiana waveformu z użyciem starego FSAL:** revision token unieważnia wszystkie RHS caches.
14. **Sinc aktywny przed startem:** tail diagnostic i jawny `t0`, bez ukrytego truncation.

## 16. Zakres odroczony

Poniższe elementy nie są częścią tej implementacji i nie mogą być sugerowane jako gotowe:

- dowolne callbacki użytkownika `f(r,t)`;
- importowane mapy pola z pliku i czasowo zmienne bazy wielomodowe;
- bezpośredni Bloch/Floquet time-domain dla dowolnego `k`;
- pełna dyspersja nieskończonego kryształu z jednego run;
- stochastyczne pola termiczne;
- GPU single promotion;
- automatyczne dopasowanie modów pomiędzy różnymi siatkami bez osobnego kontraktu tracking;
- nieliniowa spektroskopia dużego sygnału i harmonic generation jako gate podstawowa.

Odroczenie nie blokuje kompletnego globalnego/regionalnego napędu, Γ spectroscopy ani finite-k
supercell response w zakresie zdefiniowanym powyżej.

## 17. Ostateczny scenariusz użytkownika

Po wdrożeniu użytkownik może:

1. otworzyć istniejący przykład antidot;
2. zachować statyczne pole polaryzujące i etap równowagi;
3. dodać `RegionalFieldDrive` globalny, 1 mT w y, `SincPulse(20 GHz, 100 ps)`;
4. przypisać drive tylko do `excite_gamma`;
5. dodać run do 4 ns z output co 5 ps;
6. wykonać FEM CPU/GPU double z jawnym resolved capability;
7. zobaczyć `H_drive(t)`, `delta m(t)`, PSD Γ i profile peaków;
8. wyeksportować ten sam canonical Python;
9. dla propagacji przejść do osobnego przykładu falowodu, lokalnej maski i `S(k,f)` — bez
   fałszywej interpretacji pojedynczej komórki PBC jako propagującego pakietu.
