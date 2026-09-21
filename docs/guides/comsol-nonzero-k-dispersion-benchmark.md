# Przepis referencyjny COMSOL: dyspersja filmu Permalloy z antykropkami

Data: 2026-09-13. Identyfikator: `comsol-py-antidot-square-v1`.
Status: procedura do wykonania przez operatora; nie została uruchomiona w COMSOL-u przez autora. Wynik nie jest jeszcze referencją numeryczną ani dowodem kwalifikacji Fullmag. Właściciel kontraktu fizycznego: [0828](../physics/0828-fem-frequency-domain-floquet-demag.md). Przepis korzysta z niestandardowego **Micromagnetics Module V2.13 Weichao Yu** (interfejsy `mm` i `mmf`) opisanego w lokalnym manualu, a nie zakłada istnienia LLG w standardowym module AC/DC.

Pliki wejściowe: [parametry SI JSON](comsol-dispersion-benchmark/parameters.json) oraz [61 punktów ścieżki CSV](comsol-dispersion-benchmark/kpath.csv).

## 1. Co policzyć i w jakiej kolejności

1. **C0:** pełny film bez otworu, bez demagnetyzacji, jeden punkt Γ. Kontrola gamma, jednostek i ekstrakcji częstotliwości.
2. **C1:** pełny film bez otworu, z demagnetyzacją, Γ, a następnie ścieżka Γ–X–M–Γ. Kontrola pola dipolowego i PBC. To film opisany sztuczną komórką, więc wyższe gałęzie będą złożone do jej strefy Brillouina.
3. **A1:** film z otworem, zrelaksowany stan równowagi, pełna ścieżka Γ–X–M–Γ. To właściwy benchmark.
4. Kontrole zbieżności siatki, wysokości powietrza i liczby wyznaczanych modów opisane dalej. Zachowaj również wyniki, które nie spełnią tolerancji.

Nie zastępuj Eigenfrequency skanem wymuszonej odpowiedzi Frequency Domain. Do pierwszego porównania potrzebujemy częstotliwości własnych i zespolonych wektorów własnych.

## 2. Parametry do Global Definitions → Parameters

| Nazwa | Wyrażenie COMSOL | Znaczenie |
|---|---|---|
| `a_lat` | `200[nm]` | okres w x i y |
| `t_film` | `10[nm]` | grubość filmu |
| `r_hole` | `50[nm]` | promień otworu A1 |
| `d_air` | `2[um]` | powietrze nad i pod powierzchnią filmu |
| `Ms_ref` | `8e5[A/m]` | magnetyzacja nasycenia |
| `Aex_ref` | `13e-12[J/m]` | fizyczna stała wymiany |
| `mu0_ref` | `4*pi*1e-7[H/m]` | jawnie ustalona przenikalność próżni |
| `Bbias` | `0.1[T]` | μ0 H zewnętrznego |
| `Hbias` | `Bbias/mu0_ref` | 79577.4715459477 A/m, kierunek +x |
| `gamma_ref` | `2.211e5[m/(A*s)]` | współczynnik równania LLG z pochodną po czasie |
| `A_field` | `2*Aex_ref/(mu0_ref*Ms_ref)` | 2.58626782524330e-11 A·m |
| `alpha_relax` | `0.5` | tłumienie wyłącznie relaksacji |
| `alpha_eig` | `0` | tłumienie zadania własnego |
| `jpath` | `0` | indeks punktu, później sweep 0…60 |
| `k_sign` | `1` | znak k, kontrola odwrotna: −1 |
| `kx_b` | `k_sign*pi/a_lat*if(jpath<=20,jpath/20,if(jpath<=40,1,(60-jpath)/20))` | rad/m |
| `ky_b` | `k_sign*pi/a_lat*if(jpath<=20,0,if(jpath<=40,(jpath-20)/20,(60-jpath)/20))` | rad/m |
| `kz_b` | `0[1/m]` | brak periodyczności w z |

W obu interfejsach mikromagnetycznych ustaw `Ms=Ms_ref`, `gamma=gamma_ref`, **`A=A_field`**. Pole `A` w tym dodatku ma jednostkę A·m, nie J/m. Nie wpisuj tam bezpośrednio 13e-12. Gamma w tabeli manuala opisano jako Hz/(A/m), lecz równanie LLG używa gamma bez dodatkowego 2π; liczba 2.211e5 odpowiada temu równaniu. Nie dziel jej ponownie przez 2π. Kontrola C0 musi to potwierdzić dla zainstalowanej wersji dodatku.

Anizotropia objętościowa i powierzchniowa: zero (`K=0[A/m]`, `Ks=0[A]`). DMI: zero, oba warianty wyłączone. STT/SOT, prąd, temperatura, losowy szum, sprzężenia magnetoelastyczne: wyłączone. Jeśli pole osi anizotropii jest wymagane, wpisz (1,0,0); przy K=0 nie aktywuje anizotropii.

## 3. Geometria 3D i selekcje

Użyj jednego komponentu **3D**, długości w nm:

- Komórka: x,y od −100 do +100 nm.
- Film: blok 200×200×10 nm, środek (0,0,0), z od −5 do +5 nm.
- A1: odejmij cylinder o osi z, promieniu 50 nm i wysokości 10 nm, środku (0,0,0). Cylinder przechodzi przez całą grubość filmu. To otwór wypełniony powietrzem, nie drugi materiał magnetyczny.
- C0/C1: pomiń operację odejmowania cylindra, nie używaj degenerującego cylindra o promieniu zero.
- Cała domena potencjału: blok 200×200×4010 nm, z od −2005 do +2005 nm. Powietrze = ten blok minus magnetyk. **Uwzględnij powietrze w otworze.**
- Finalizacja Form Union, zachowaj wewnętrzne granice. Nie zostawiaj nakładających się domen ani szczelin.

Utwórz selekcje nazwane `mag`, `air`, `all_phi`, `xminus`, `xplus`, `yminus`, `yplus`, `ztop`, `zbottom`; osobne selekcje bocznych ścian magnetyka do mm/mmf. `all_phi` obejmuje mag i całe air. Objętość magnetyka A1 powinna wynosić `(a_lat^2-pi*r_hole^2)*t_film` ≈ 3.21460183660255e-22 m³.

To nieskończona sieć w x/y z **jawnie skończonym pudełkiem potencjału w z**. Nie używaj sfery, bocznych ścian izolujących, PML ani Infinite Elements w tej wersji benchmarku. Zbieżność w d_air oceni przybliżenie przestrzeni otwartej.

## 4. Stan równowagi: mm i statyczny potencjał

Dodaj Micromagnetics Module (Time Domain), tag `mm`, tylko na `mag`. Stan początkowy (1,0,0), alpha=alpha_relax. Wymiana ma naturalny warunek swobodny na górze, dole i ścianie otworu: brak pinningu i anizotropii powierzchniowej. Na x−/x+ i y−/y+ magnetyka ustaw **zwykłą periodyczność**, bez dynamicznego k.

Dla C1/A1 dodaj Mathematics → PDE Interfaces → **Weak Form PDE**, zmienna `phi0`, jednostka A, na `all_phi`. Źródło równania ma jednostkę A/m². Użyj liniowych funkcji Lagrange'a. Zdefiniuj zmienne domenowe:

| Domena | `M0x` | `M0y` | `M0z` |
|---|---|---|---|
| mag | `Ms_ref*mm.mX` | `Ms_ref*mm.mY` | `Ms_ref*mm.mZ` |
| air | `0[A/m]` | `0[A/m]` | `0[A/m]` |

Zastąp domyślne wyrażenie Weak Form PDE przez:

```text
-test(phi0x)*(phi0x-M0x)-test(phi0y)*(phi0y-M0y)-test(phi0z)*(phi0z-M0z)
```

Nie dodawaj pochodnej czasowej potencjału. Jest to algebraiczna magnetostatyka sprzężona z LLG w każdym kroku. Na całych bocznych ścianach pudełka ustaw Periodic Condition → Continuity, osobno x i y. Na ztop/zbottom ustaw Dirichlet `phi0=0[A]`. Na granicach wewnętrznych nie dodawaj izolacji: wspólna słaba postać sama zawiera ciągłość potencjału i właściwy skok normalnej pochodnej przez źródło M. Nie dodawaj dodatkowego warunku średniej zero/pinu: Dirichlet już usuwa swobodę stałej.

W mm wpisz zewnętrzne pola:

```text
H1 = Hbias-phi0x
H2 = -phi0y
H3 = -phi0z
```

Nie dodawaj tu ponownie pola wymiany: moduł liczy je wewnętrznie. Nie włączaj dodatkowego demagu z innego interfejsu równocześnie z tym potencjałem. Dla C0 usuń sprzężenie potencjału i ustaw (Hbias,0,0).

Study Relax: Time Dependent, rozwiązuj wspólnie mm i phi0; mmf i dynamiczny potencjał wyłączone. BDF, maksymalny rząd 2, tolerancja względna 1e-7, maksymalny krok 5 ps, startowy 0.1 ps, zakres wyjściowy `range(0,10[ps],5[ns])`. Użyj w pełni sprzężonego rozwiązania z bezpośrednim solverem, np. PARDISO. Zapisz rzeczywiste ustawienia skalowania i solver log.

5 ns to pierwszy odcinek, nie automatyczny dowód równowagi. Kontynuuj od ostatniego stanu odcinkami 5 ns do spełnienia jednocześnie:

- maksymalna norma `m(t)-m(t-0.5 ns)` w magnetyku <1e-6;
- maksymalna norma `m × H_eff` <1 A/m; H_eff zawiera również wymianę w realizacji modułu — użyj jego pola efektywnego/diagnostyki torque z Equation View, nie samego H1/H2/H3;
- maksymalne `abs(norm(m)-1)` <1e-6.

Jeżeli nie ma wiarygodnego dyskretnego torque, zaznacz jego brak i dostarcz log oraz kontrolę zmiany stanu; nie zastępuj go drugą pochodną liniowego pola wewnątrz elementu. Dla A1 stan nie jest z definicji jednorodny. Zachowaj finalne mm i phi0 jako oddzielne rozwiązanie `sol_eq`; nie relaksuj od nowa dla każdego k.

## 5. Eigenfrequency: magnetyzacja z Floquet

Dodaj Micromagnetics Module (Frequency Domain), tag `mmf`, tylko na `mag`. Ustaw alpha=0 oraz te same Ms/gamma/A/K. Equilibrium Magnetization `m01,m02,m03` pobierz z finalnego `sol_eq`. Statyczne pola `h01,h02,h03` to (Hbias−phi0x,−phi0y,−phi0z) z tego samego zapisanego rozwiązania. W Study → Values of variables not solved for wybierz Solution → Study Relax → ostatni czas; sprawdź, że phi0 i mm nie pochodzą z zerowego initial value. Dla C0 ustaw m0=(1,0,0), h0=(Hbias,0,0).

Na magnetycznych ścianach ustaw Floquet Periodic Condition:

- x: source x=−a/2, destination x=+a/2;
- y: source y=−a/2, destination y=+a/2;
- wektor `kFX=kx_b`, `kFY=ky_b`, `kFZ=kz_b`.

Manual definiuje `dm_dst=dm_src*exp(-i*k·(r_dst-r_src))`. W szczególności faza na parze x wynosi `exp(-i*kx_b*a_lat)`. Nie włączaj periodyczności w z. Na fizycznych powierzchniach pozostaje swobodna wymiana. Kopiuj siatkę source→destination i sprawdź zgodne wiązania narożników obu par.

## 6. Dynamiczny demag: dokładnie ta sama faza Blocha

Standardowy interfejs Magnetic Fields, No Currents nie jest tutaj zakładany jako posiadający dowolny Floquet. Poniższa jawna realizacja używa **periodycznej obwiedni potencjału** w Weak Form PDE. To autorskie przekształcenie równania magnetostatyki do konfiguracji COMSOL; jego uruchomienie i kontrola C1 są wymagane, nie są już wykonanym dowodem.

Pełna magnetyzacja `dm` z mmf ma fazę exp(−ik·r). Definiujemy potencjał pełny `dphi=exp(-i*k·r)*psi`, gdzie `psi` jest zwyczajnie periodyczne. Dodaj drugi Weak Form PDE, zmienna `psi`, jednostka A, źródło A/m², liniowy Lagrange, na `all_phi`. Zdefiniuj wszędzie:

```text
phase_b = exp(i*(kx_b*x+ky_b*y+kz_b*z))
```

Osobne Variables na rozłącznych selekcjach:

| Domena | `Menvx` | `Menvy` | `Menvz` |
|---|---|---|---|
| mag | `Ms_ref*phase_b*mmf.dmX` | `Ms_ref*phase_b*mmf.dmY` | `Ms_ref*phase_b*mmf.dmZ` |
| air | `0[A/m]` | `0[A/m]` | `0[A/m]` |

Zdefiniuj `Fx=psix-i*kx_b*psi-Menvx`, analogicznie Fy/Fz. Wpisz **jedno** wyrażenie słabe, zastępując domyślne:

```text
-(test(psix)+i*kx_b*test(psi))*Fx
-(test(psiy)+i*ky_b*test(psi))*Fy
-(test(psiz)+i*kz_b*test(psi))*Fz
```

To suma trzech wierszy, nie trzy niezależne równania. Nie wstawiaj `conj(psi)` ani `real(psi)` do operatora. Ta postać reprezentuje `div_k(grad_k psi-Menv)=0`, gdzie `grad_k=grad-i*k`; plus i*k przy funkcji testowej wynika z całkowania przez części. Dla k=0 redukuje się do statycznej postaci powyżej. Nie ma członu zależnego od częstotliwości ani sztucznej masy potencjału. Ustaw rząd kwadratury 6 dla tej słabej postaci; na trzech punktach kontrolnych sprawdź rząd 8. Czynniki wykładnicze nie są wielomianami, więc kontrola kwadratury jest odrębna od zagęszczenia siatki.

Przekształcenie jest równoważne na poziomie równania ciągłego. Liniowa obwiednia psi pomnożona przez fazę nie jest identyczną przestrzenią FE jak liniowy pełny potencjał z więzami Floquet. Przy porównaniu z takim Fullmag wymagamy zbieżności częstotliwości/pól, nie identycznych macierzy na jednej siatce.

Dla psi: **zwykła Periodic Condition → Continuity** na całych parach x/y, Dirichlet psi=0 na ztop/zbottom, brak warunków izolujących na granicach mag/air. Nie dodawaj fazy Floquet do psi — jest już obwiednią, a nie pełnym potencjałem.

W mmf ustaw:

```text
dh1 = -exp(-i*(kx_b*x+ky_b*y+kz_b*z))*(psix-i*kx_b*psi)
dh2 = -exp(-i*(kx_b*x+ky_b*y+kz_b*z))*(psiy-i*ky_b*psi)
dh3 = -exp(-i*(kx_b*x+ky_b*y+kz_b*z))*(psiz-i*kz_b*psi)
```

Są to indukowane pola w A/m. **Nie dodawaj niezależnego RF, np. +1[A/m], cosinusów ani źródła harmonicznego.** W C0 dh=(0,0,0) i psi nie jest rozwiązywane. W C1/A1 Study Eigenfrequency rozwiązuje mmf i psi jednocześnie; mm oraz phi0 pozostają zamrożone. Równania muszą być liniowe w niewiadomych własnych. Nie dodawaj przesuniętych gradientów do wymiany mmf: tam liczymy pełne pole z warunkiem Floquet.

### 6.1. Analityczna kontrola demagnetyzacji dynamicznej

Przed porównaniem z geometrią A1 należy wykonać kontrolę C1 dla jednorodnego
filmu. Dla tej kontroli używamy zerowego rzędu modelu Kalinikosa–Slawina,
czyli cienkiego filmu o tej samej grubości, `Ms`, `Aex`, `Hbias` i `gamma0`.
Model zawiera zarówno wymianę, jak i dynamiczny demag przez

```text
P00(kt) = 1 - (1 - exp(-k*t))/(k*t),    P00(0) = 0
H_ex(k) = 2*Aex*k^2/(mu0*Ms).
```

Przy konwencji Fullmag `gamma0` ma jednostkę
`rad/(s*(A/m))`, a `Hbias` i `H_ex` są w A/m. Częstotliwości referencyjne są

```text
f_BV(k) = gamma0/(2*pi) * sqrt((H+H_ex) * (H+H_ex + Ms*(1-P00))),
f_DE(k) = gamma0/(2*pi) * sqrt((H+H_ex + Ms*(1-P00)) * (H+H_ex + Ms*P00)).
```

BV oznacza `k` równoległe do równowagowego `m0`, a DE — `k` prostopadłe w
płaszczyźnie filmu. Obie gałęzie w Γ przechodzą w tę samą formułę Kittela.
Generator zapisuje tę referencję z pełną precyzją:

```powershell
python scripts/generate_comsol_analytic_reference.py
```

Wynikiem jest
`comsol-dispersion-benchmark/kalinikos_slab_n0_reference.csv`, zawierający
`k`, `P00`, pole wymiany, częstotliwość, geometrię BV/DE oraz jawne parametry
SI. Domyślny zakres `0..pi/a_lat` kończy się w punkcie X. Dla parametrów C1
częstotliwość w Γ wynosi około **9.309813711 GHz** (granica nieskończonego
filmu), a skończony airbox z tego przepisu ma osobną kontrolę około
**9.299249697 GHz**. Różnica jest oczekiwana i nie może być korygowana przez
zmianę `gamma0`.

CSV jest analityczną referencją do nakładki na `eigen/dispersion.csv`; nie jest
wynikiem FEM ani dowodem wykonania dynamicznego operatora `demag-k`. Jednorodny
C1 jest właściwą bramką analityczną. Otwór A1 nie ma dokładnej jednorodnej
referencji slab i po przejściu C1 należy porównywać go bezpośrednio z COMSOL-em
(oraz, pomocniczo, z TetraX) przy tych samych warunkach brzegowych.

W bramce naukowej pełna ścieżka 61 punktów C1 jest porównywana z otwartofilmowym
jądrem Kalinikosa–Slawina `P00`. Korekta `Nz` z finite airboxa służy wyłącznie
do kontroli jednorodnego modu w Γ i zbieżności wysokości airboxa. Nie wolno
zastępować nią jądra dla `k != 0`, ponieważ stały skalar nie jest dokładną
funkcją Greena skończonego airboxa.

Ścieżka Γ–X–M–Γ nie zawiera czystego punktu Damon–Eshbach: na tej ścieżce
`sin²(phi)` osiąga najwyżej `1/2`. Dlatego bramka C1 wymaga dodatkowego,
niezależnego kontrolnego przebiegu slabowego dla `k=(0,10^7,0) rad/m` (DE)
oraz `k=(10^7,0,0) rad/m` (BV), zgodnie z blokiem
`analytic_controls.kalinikos_slab_n0` w `parameters.json`. Kontrola DE nie może
być zastąpiona dowolnym punktem ścieżki ani jedynie kolumną analityczną w CSV.

## 7. Siatka i rozwiązanie własne

Zbuduj trzy siatki; dla pierwszego uruchomienia wystarczy L1, przed całym sweepem wykonaj kontrole C0/C1.

| Siatka | maksymalny rozmiar w płaszczyźnie magnetyka i na otworze | warstwy przez grubość |
|---|---:|---:|
| L0, wstępna | 10 nm | 2 |
| L1, podstawowa | 5 nm | 3 |
| L2, dokładna | 2.5 nm | 4 |

Użyj swept mesh przez film, a jeśli wymagane są tetraedry — podziel zgodnie i zachowaj powyższe ograniczenia. Zapisz typy elementów. Pole magnetyzacji i potencjał: **liniowe funkcje kształtu**, również w mm/mmf; nie pozostawiaj automatycznego wyższego rzędu. W powietrzu do 20 nm od filmu rozmiar ≤5 nm dla L1 (odpowiednio 10/2.5 nm dla L0/L2), dalej wzrost ≤1.3 i maksimum 100 nm. Można podzielić powietrze na warstwy geometryczne, bez zmiany materiału/warunków wewnętrznych. Rzeczywista siatka i liczba DOF są częścią eksportu; podane limity nie wyznaczają unikatowej triangulacji.

Eigenfrequency: jednostka wyświetlania GHz, complex arithmetic, bezpośredni solver liniowy PARDISO, względna tolerancja eigensolvera 1e-8, jawny limit **64 iteracji zewnętrznych EPS** i **128 iteracji wewnętrznych KSP**, szukaj wokół **1 GHz**, początkowo **24 wartości własne**. Limity EPS/KSP dotyczą iteracji rozwiązania własnego i liniowego; nie są limitem montażu siatki, montażu operatora ani faktoryzacji. Osiągnięcie limitu oznacza niezakwalifikowaną próbę i wymaga diagnozy iteracji, bez rozluźniania tolerancji. Zwiększ do 48 w kontroli. Jeśli wersja oferuje wybór algorytmu, użyj ARPACK ze shift-invert i zapisz rzeczywistą konfigurację. Nie używaj sztucznego dodatniego damping do usuwania błędu osobliwej macierzy.

Celem porównania jest **pierwszych 8 dodatnich fizycznych gałęzi**. Wyeksportuj jednak wszystkie znalezione wartości, w tym ujemne i podejrzane. Jeżeli nie znaleziono 8 fizycznych modów, zwiększ liczbę do 48/96 i dodaj szukanie wokół 5, 15 oraz 30 GHz; zachowaj rozdzielone wyniki każdego wyszukiwania. Sprawdź, że podstawowy zestaw najniższych 8 nie zmienia się przy zwiększeniu liczby. Bliskie częstotliwości nie wystarczają do kasowania duplikatów: degeneracja może mieć kilka niezależnych wektorów. Ten protokół nie certyfikuje kompletności widma ani pełnej przerwy pasmowej.

Parametric Sweep na `jpath=range(0,1,60)`, k_sign=1; jeden i ten sam sol_eq. Γ: j=0; X:20; M:40; Γ:60. Załączony CSV podaje SI i rzeczywistą długość łamanej w przestrzeni k. Powtórzone końcowe Γ zachowaj jako osobną próbkę.

## 8. Kontrole przed kosztownym liczeniem A1

- C0, jednorodny mod w Γ: `gamma_ref*Hbias/(2*pi)` = **2.80026421291511 GHz**. Tolerancja wstępna 0.1%. Odchylenie około 2π oznacza błąd konwencji gamma/częstotliwości.
- C1, najniższy jednorodny mod w Γ: granica nieskończonego filmu `gamma_ref/(2*pi)*sqrt(Hbias*(Hbias+Ms_ref))` = **9.30981371143336 GHz**. Dla jednorodnego modu i dokładnie naszego pudełka phi=0 współczynnik wynosi `Nz=1-t_film/(2*d_air+t_film)` = 0.997506234413965. Wynika to z ciągłości Bz i zerowej całki gradientu potencjału między dwiema ścianami Dirichlet. Oczekiwanie dla d_air=2 µm to `gamma_ref/(2*pi)*sqrt(Hbias*(Hbias+Nz*Ms_ref))` = **9.29924969706840 GHz** (kontrola wstępna 0.1%). Porównaj też d_air=1,2,4 µm; nie wymuszaj dokładnej zgodności z granicą nieskończonego filmu dla skończonego pudełka.
- Dla każdego k: norma części podłużnej `m0·dm` względem normy dm <1e-6 w L2; sprawdź rzeczywiste ograniczenie poprzeczne modułu. Nie identyfikuj modów o zerowej normie magnetycznej jako fal spinowych.
- Przy alpha=0 raportuj `abs(Im(f))/max(abs(Re(f)),1[Hz])`; >1e-6 to sygnał do diagnozy, nie automatyczne wycięcie urojeń.
- Sprawdź pary brzegowe pełnych dm i dphi: błąd względny fazy <1e-6. Sam zgodny wykres kolorów nie wystarcza. Wyeksportuj wartości po obu stronach.
- Dla A1 wykonaj k_sign=−1 przynajmniej dla j=10,30,50; symetria modelu bez DMI/asymetrii powierzchni przewiduje zgodność zestawów częstotliwości ±k po odpowiednim dopasowaniu modów. Nie wymuszaj identycznych wektorów zespolonych.
- Zbieżność siatki L1→L2 (przy tym samym airboxie) i zbieżność granicy d_air=2→4→8 µm na j=0,10,20,30,40,50,60 są osobnymi kontrolami. Dla siatki oraz liczby modów obowiązuje ścisła tolerancja numeryczna; dla sweepu wysokości airboxa procedura przyjmuje wcześniej ustalony budżet względnej zmiany <0.5% dla każdej z pierwszych 8 dopasowanych gałęzi. Jest to budżet kampanii aproksymacji granicy otwartej, a nie tolerancja porównania primary z analityką KS. Oceń trend przyrostów 2→4 i 4→8; nie porównuj bezpośrednio wariantu z innym airboxem do wyniku primary tak, jakby były tym samym problemem. Jeżeli trend nie maleje, dodaj L3 (1.25 nm/8 warstw) lub większy airbox. Sprawdź także reprezentatywne punkty unikniętego przecięcia/przerwy znalezione podczas sweepu. Dla nowej siatki/pudełka ponownie wyznacz równowagę.

Kontrole te są kryteriami przyjęcia danych, a nie obietnicą osiągalnego błędu. Docelowe porównanie Fullmag–COMSOL powinno najpierw używać identycznego skończonego airboxa i stanu równowagi, dopiero później porównywać granice zbieżności.

## 9. Dokładny eksport

Zachowaj **.mph z siatką, solverami i rozwiązaniami**, wersję COMSOL/build, wersję dodatku i SHA256 jego .jar. Wyeksportuj parametry z jednostkami, screenshoty/tekst ustawień par source/destination, selekcji domen, rzędów elementów, solvera i log zbieżności. Nie zapisuj wyłącznie obrazka dyspersji.

CSV: UTF-8, kropka dziesiętna, przecinek jako separator, co najmniej 15 cyfr znaczących. W Results → Derived Values → Global Evaluation wybierz właściwy Eigenfrequency dataset, wszystkie outer solutions (k) i wszystkie inner solutions (mody). Użyj wbudowanego wyrażenia eigenfrequency/frequency oferowanego przez **Replace Expression**; sprawdź jednostkę i zachowaj Re oraz Im. Nazwa surowego eigenvalue zależy od study — nie przeliczaj go z pamięci jako ±i lambda/2π. Sprawdź definicję w solverze i zapisz ją obok danych. C0 weryfikuje przeliczenie.

`dispersion.csv` — jeden wiersz na znaleziony mod i wyszukiwanie:

```text
case_id,mesh_id,air_padding_m,search_id,jpath,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,path_s_rad_per_m,raw_mode_index,frequency_real_hz,frequency_imag_hz
```

`raw_mode_index` = rzeczywisty numer rozwiązania COMSOL, bez udawania identyfikatora gałęzi. Dopisz surowy eigenvalue Re/Im i residual tylko jeśli COMSOL je udostępnia; brak oznacz pustym polem, nie zerem. Zostaw też oryginalny eksport COMSOL z jego nagłówkami.

`equilibrium.csv` na węzłach magnetycznych:

```text
node_id,x_m,y_m,z_m,m0x,m0y,m0z,Hdemag0x_A_per_m,Hdemag0y_A_per_m,Hdemag0z_A_per_m
```

Pola statyczne to −grad(phi0), nie Hbias+demag. Osobno wyeksportuj phi0 na całej domenie. Do wiernego porównania FE dołącz siatkę: współrzędne w m, connectivity, typ/rząd elementu, indeksowanie, domain_id oraz mapę mag/air. Najprościej zachować .mph i dodatkowo eksport siatki COMSOL; nie zakładaj, że kolejność wierszy z różnych eksportów jest identyczna.

`modes/<case>_<mesh>_jNN_<search>_modeNN.csv` na węzłach magnetycznych, każdy mod osobno:

```text
node_id,x_m,y_m,z_m,dmx_re,dmx_im,dmy_re,dmy_im,dmz_re,dmz_im
```

Eksportuj `real(mmf.dmX)`, `imag(mmf.dmX)` i analogicznie Y/Z. To **pełny fazor Blocha**, bez mnożenia przez funkcję czasową. Nie eksportuj wyłącznie abs ani obrazka animacji. Wektor własny ma dowolną skalę i wspólną fazę: zachowaj skalę solvera, nie normalizuj składowych niezależnie.

`potential/...csv` na całej domenie:

```text
node_id,x_m,y_m,z_m,psi_re_A,psi_im_A,dphi_re_A,dphi_im_A,Hdx_re_A_per_m,Hdx_im_A_per_m,Hdy_re_A_per_m,Hdy_im_A_per_m,Hdz_re_A_per_m,Hdz_im_A_per_m
```

`dphi=exp(-i*(kx_b*x+ky_b*y+kz_b*z))*psi`; Hdx/Hdy/Hdz to wzory dh powyżej, także w powietrzu. Eksportuj bez wygładzania pochodnych (gradient P1 jest nieciągły); jeśli dane są próbkowane/gładzone, jawnie podaj ustawienie. Dodatkowo warto dać wspólny raster x,y=−97.5…97.5 nm co 5 nm, z=0, tylko punkty w magnetyku; punkty w otworze oznacz maską/brakiem, nie zerem. Raster służy szybkiemu oglądowi, nie zastępuje pełnej siatki.

**Minimalna pierwsza przesyłka:** C0/C1 w Γ, A1 na L1 w j=0,10,20,40,50,60, parametry, równowaga, częstotliwości oraz zespolone mody/potencjały. Najpierw sprawdzimy konwencje; dopiero potem warto przesyłać pełne 61 punktów i droższe kontrole L2.

## 10. Źródła i granice sprawdzenia

- Lokalny [Manual for Micromagnetics Module V2.13](../comsol/Manual_for_Micromagnetics_Module.pdf), SHA256 `91f8f602d82bdec0a7b6c6947c1919e127c6d4f1a71c69819e328b7d54a06e2d`: strony PDF 21–23 — linearyzacja i pola; 27 — znak Floquet; 30 — Eigenfrequency; 34–35 — jednostki i nazwy; 40–43 — sprzężenie demagu. Numery PDF obejmują okładkę. Przykład wymuszony z manuala nie jest gotowym benchmarkiem własnym A1.
- COMSOL [PDE boundary conditions](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_equationbased.32.025.html) — dostępność zwykłego Periodic Condition w PDE.
- COMSOL [Weak Contribution](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_equationbased.32.073.html) — składnia test i pochodnych; przepis potencjału jest wyprowadzony z równania, nie skopiowany z gotowego modelu.
- COMSOL [periodic RF models](https://www.comsol.com/blogs/how-to-numerically-simplify-your-periodic-rf-models) — pomocnicza ilustracja fazy source/destination; nie dowodzi dostępności Floquet w magnetostatyce AC/DC.

Zweryfikowano tekst manuala, jednostki, stałe, ciągłość ścieżki i algebraiczny znak transformacji potencjału. Nie zweryfikowano GUI ani wykonania tego modelu w zainstalowanym COMSOL-u. Nazwy tagów rozwiązania i wbudowanego eigenvalue należy odczytać z rzeczywistego modelu. Te dane są przeznaczone do przyszłej bramki porównania; sam przepis nie zamyka bramki V4 ani pozostałych etapów implementacji.
