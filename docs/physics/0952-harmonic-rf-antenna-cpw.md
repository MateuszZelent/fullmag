# Harmoniczne źródło antenowe RF dla CPW

- Status projektu fizyki · szkic do przeglądu
- Data · 22 listopada 2026
- Zakres · pole anteny dla zadanej częstotliwości, pierwszy przypadek CPW2
- Powiązane kontrakty · [model anteny DC](0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-assumptions-and-validity), [etap i baza pola w potoku](../adr/0017-staged-antenna-field-basis-workflow.md), [API zasobów v2](../specs/resource-first-control-room-api-v2.md)

(rf-problem-statement)=
## 1. Problem i decyzja projektowa

Dla zadanej geometrii przewodnika GSG, dielektryka, pobudzenia i terminacji
wyznaczamy zespolone pola prądu i pola magnetycznego w stanie harmonicznym.
Pole ma być przewidywane z geometrii, materiałów i portu. Podstawowym
rezultatem jest wektor pola w ustalonych punktach obszaru próbki, z fazą
odniesioną do jawnie wskazanego prądu. Eksport widma przestrzennego następuje
po obliczeniu pola. Dynamika magnetyzacji jest kolejnym niezależnym etapem.

Archiwalna walidacja ma trzy rodzaje dowodów.

| Pochodzenie | Obserwacja | Znaczenie dla projektu |
| --- | --- | --- |
| Natywny Fullmag DC | Profil pola ze znakiem odbiega od wektorów z końcowego PDF o 24,85% dla CPW1 i 42,89% dla CPW2 we względnym L2. Minimum CPW2 wypada ok. 19,9 rad/µm. | Tor DC jest punktem odniesienia. |
| Kontrola analityczna z archiwalnego prądu Fullmaga | Niezależna całka Biota–Savarta odtwarza zapisane pole do maksymalnego względnego błędu wektorowego ok. $1{,}04\cdot10^{-6}$. Dla CPW2 model rezystancyjno-indukcyjnego arkusza z rzeczywistą przewodnością miedzi pozostawia ok. 42,6% błędu profilu. | Priorytetem jest samouzgodniony prąd RF, w tym rozkład prądu powrotnego. |
| Dane z publikacji, symulacja CST | Rys. 1c podaje profil ze znakiem poprzeczny, a 2b moduł jego transformaty przestrzennej. Wektory z PDF dają minimum CPW2 przy ok. 18,41 rad/µm. | Brakuje oryginalnego portu, terminacji, surowego prądu i fazy CST. Zgodność z reprodukcją wymaga osobnej analizy niepewności wejść. |

Archiwum robocze walidacji znajduje się w `gruszecki-validation/`. Dane
pochodzą z not `2026-11-22-cpw-electromagnetic-solver-audit.md`,
`2026-11-22-cpw-vector-mesh-sampling.md` i
`2026-11-22-cpw-sheet-resistance-crossover.md`. Publikacja opisuje wyniki
elektromagnetyczne z CST i odrębne wyniki LLG z MuMax3. [Gruszecki i in. (2016)](https://doi.org/10.1038/srep22367).

Najpierw powstaje referencja pełnego Maxwella w dziedzinie częstotliwości.
Monolityczny model Darwina z warunkiem Coulomba jest kandydatem do natywnego
wykonania, jeśli spełni bramki dokładności pola, pasywności i kosztu.
Porównanie modeli wykorzysta identyczne terminale obwodowe i geometrię.
Referencja pełnofalowa może też zbadać port falowy na osobnym przypadku.
W pracy Ciupriny i Sabriego wybór warunku gauge i typu pobudzenia zmieniał
wyniki CPW, a Darwin w analizowanych przypadkach częstotliwościowych nie
wykazał przewagi numerycznej. [Ciuprina i Sabriego (2024), §4–6](https://doi.org/10.1186/s13362-024-00165-6).

(rf-governing-equations)=
## 2. Model fizyczny

### Konwencja fazy i materiał

Wektory używają prawoskrętnej ramy. Oś $x$ biegnie wzdłuż CPW, $y$ w poprzek,
a $z$ rośnie ku górze. Poziom $z=0$ oznacza dolną powierzchnię miedzi.
Pola i wartości terminalowe są fazorami **szczytowymi**. Eksporty w RMS
wymagają jawnej konwersji amplitudy i fazy przed porównaniem.

```{math}
:label: rf-phase-law

\omega=2\pi f,\qquad
Q(t)=\operatorname{Re}\{\hat Q\exp[\mathrm i\omega(t-t_0)]\}.
```

(rf-maxwell-contract)=
### Pełny Maxwell w dziedzinie częstotliwości

Dla liniowych materiałów izotropowych oraz pobudzenia ograniczonego do
brzegu mamy

```{math}
:label: rf-full-wave-maxwell

\begin{aligned}
\nabla\times\hat{\mathbf E}&=-\mathrm i\omega\hat{\mathbf B},
&\nabla\times\hat{\mathbf H}&=\hat{\mathbf J}_{\rm tot},\\
\hat{\mathbf J}_{\rm c}&=\sigma\hat{\mathbf E},
&\hat{\mathbf J}_{\rm tot}&=\hat{\mathbf J}_{\rm c}+\mathrm i\omega\hat{\mathbf D},\\
\hat{\mathbf D}&=\varepsilon\hat{\mathbf E},
&\hat{\mathbf B}&=\mu\hat{\mathbf H},\\
\nabla\cdot\hat{\mathbf B}&=0,
&\nabla\cdot\hat{\mathbf D}&=\hat\rho_f .
\end{aligned}
```

W domenach bez źródła objętościowego równanie na pole elektryczne i sposób
odczytu pola magnetycznego przy $f>0$ są następujące.

```{math}
:label: rf-electric-curl-curl

\nabla\times(\mu^{-1}\nabla\times\hat{\mathbf E})
+(\mathrm i\omega\sigma-\omega^2\varepsilon)\hat{\mathbf E}=0,\qquad
\hat{\mathbf H}=-\frac{\mu^{-1}\nabla\times\hat{\mathbf E}}{\mathrm i\omega}.
```

Na styku materiałów bez zadanego prądu powierzchniowego stosujemy ciągłość
stycznych pól $E,H$, normalnej składowej $B$ i normalnej składowej prądu
całkowitego w sensie słabym. Ładunek swobodny na interfejsie dopuszcza skok
normalnego $D$. Przepływ prądu przez przekrój samej miedzi i prąd całkowity
mierzony przez terminal mają różne definicje.

(rf-ece-contract)=
### Wspólny warunek terminalowy ECE do porównania modeli

Ograniczamy pierwszą parę porównawczą do spójnej, po prostu spójnej domeny
o spójnym brzegu, z rozłącznymi, spójnymi powierzchniami terminali $S_k$.
W formulacji pełnofalowej E–V ślad $\hat V$ na brzegu spełnia
$\hat{\mathbf E}_{\rm tan}=-\nabla_\Gamma\hat V$ i jest stały na każdym
terminale. W formulacji potencjałowej używamy na obwiedni
$\hat{\mathbf A}_{\rm tan}=0$ oraz $\hat\varphi|_{S_k}=\hat V_k$.
Te warunki dają zerową normalną składową $B$ na obwiedni.
Poza terminalami narzucamy zerowy normalny prąd **całkowity** w sensie
słabym. Konwencja terminalowa oraz pasywne obciążenie są następujące.

```{math}
:label: rf-ece-terminal-current

\hat I_k=-\int_{S_k}\mathbf n\cdot\hat{\mathbf J}_{\rm tot}\,\mathrm dS,
\qquad \sum_k\hat I_k=0,\qquad
\hat I_k=-\frac{\hat V_k}{Z_{\rm L}}\quad\text{dla terminala z obciążeniem do masy}.
```

Źródło ustala napięcie terminala sygnałowego względem masy, a prąd tego
terminala jest wielkością wynikową. Punkty odniesienia fazy i płaszczyzna
portu muszą być zapisane z polem. $Z_{\rm L}$ jest skończone i niezerowe, z
nieujemną częścią rzeczywistą w pierwszym wariancie. Zwarcie lub rozwarcie
opisuje się warunkiem napięcia lub prądu. Pasywna terminacja jest liczbą
w omach zadawaną jawnie dla konkretnej częstotliwości. ECE, port skupiony
Palace i port falowy są odrębnymi problemami brzegowymi.

W zapisie słabym $(\,\cdot\,,\,\cdot\,)_\Omega$ całkuje iloczyn pierwszego
argumentu i sprzężenia drugiego. W E–V test $\mathbf w$ ma ślad
$-\nabla_\Gamma q$ równy gradientowi ze znakiem minus testowego potencjału
brzegowego. Ślad $q$ jest stały na terminalach i zerowy tam, gdzie zadano
napięcie. $q_k$ oznacza wartość tego śladu na terminalu. Wstawienie
orientacji $\hat I_k$ do formuły brzegowej daje

```{math}
:label: rf-maxwell-ece-weak

(\mu^{-1}\nabla\times\hat{\mathbf E},\nabla\times\mathbf w)_\Omega
+((\mathrm i\omega\sigma-\omega^2\varepsilon)\hat{\mathbf E},\mathbf w)_\Omega
=\mathrm i\omega\sum_k\hat I_k\,\overline{q_k}.
```

Wkład obciążenia wynika z podstawienia równania terminalowego. Warunki
ECE i znak członu brzegowego należy testować we wspólnym przypadku
referencyjnym, niezależnie od testu portu modalnego.
[Ciuprina, Ioan i Sabariego (2022), §2–3](https://doi.org/10.1186/s13362-022-00122-1).

(rf-darwin-contract)=
### Kandydat EMQS typu Darwina

Używamy $\hat{\mathbf B}=\nabla\times\hat{\mathbf A}$ i
$\hat{\mathbf E}=-\mathrm i\omega\hat{\mathbf A}-\nabla\hat\varphi$.
Pozostają indukcja w przewodnictwie i część przesunięcia
$\hat{\mathbf D}_{\rm D}=-\varepsilon\nabla\hat\varphi$. Dla tej samej
konwencji czasowej zapis potencjałowy ma postać

```{math}
:label: rf-darwin-operator

\begin{aligned}
\mathbf F_{\rm D}
&=\mathrm i\omega\sigma\hat{\mathbf A}
  +(\sigma+\mathrm i\omega\varepsilon)\nabla\hat\varphi,\\
\mathbf F_{\rm FW}
&=\mathbf F_{\rm D}-\omega^2\varepsilon\hat{\mathbf A},\\
\nabla\times(\mu^{-1}\nabla\times\hat{\mathbf A})+\mathbf F&=0,\qquad
\nabla\cdot\mathbf F=0,\qquad \hat{\mathbf J}_{\rm tot}=-\mathbf F .
\end{aligned}
```

Wybór $\mathbf F_{\rm D}$ lub $\mathbf F_{\rm FW}$ obowiązuje jednocześnie
w Ampère, ciągłości i prądzie terminala. Pominięty człon znika z obu równań.
Przy niejednorodnym $\varepsilon$ warunek $\nabla\cdot\hat{\mathbf A}=0$
nie zapewnia $\nabla\cdot(\varepsilon\hat{\mathbf A})=0$.

Stosujemy monolitycznie warunek Coulomba $(\hat{\mathbf A},\nabla\chi)_\Omega=0$
dla $\chi\in H^1_0(\Omega)$ wraz z osobną referencją napięciową
$\hat V_{\rm ground}=0$. Test wektorowy $\mathbf a$ ma zerowy ślad styczny.
Test skalarny $q$ jest stały na każdym terminalu i ma zerową wartość na
terminalach napięciowych. Sformułowanie mieszane definiuje

```{math}
:label: rf-darwin-mixed-weak

\begin{aligned}
(\mu^{-1}\nabla\times\hat{\mathbf A},\nabla\times\mathbf a)_\Omega
+(\mathbf F,\mathbf a)_\Omega+(\nabla\lambda_g,\mathbf a)_\Omega&=0,\\
(\mathbf F,\nabla q)_\Omega&=\sum_k\hat I_k\,\overline{q_k},\\
(\hat{\mathbf A},\nabla\chi)_\Omega&=0.
\end{aligned}
```

Mnożnik $\lambda_g$ należy do $H^1_0$. Przy zgodnej dyskretyzacji gradientu i
ciągłości jego wkład ma zanikać w granicach tolerancji. Weryfikacja obejmuje
ten wkład, rzeczywisty residuum oraz osobne bilanse terminalowe. W
niejednorodnym dielektryku inne wybory gauge mogą definiować inne
przybliżenie elektromagnetyczne. [Ciuprina i Sabriego (2024), §4 i dodatek C.3](https://doi.org/10.1186/s13362-024-00165-6) · [Clemens i in., §2–3](https://arxiv.org/abs/2404.18767).

Dla określonej obwiedni ECE, bez objętościowych źródeł i bez strat
dielektrycznych, moc czynna i jej rozbicie wynoszą

```{math}
:label: rf-active-power

\begin{aligned}
P_{\rm in}
&=\tfrac12\operatorname{Re}\sum_k\hat V_k\overline{\hat I_k},\qquad
P_{\rm J}=\tfrac12\int_\Omega\sigma\lvert\hat{\mathbf E}\rvert^2\,\mathrm d\mathcal V,\\
P_{\rm mix}
&=\tfrac{\omega^2}{2}\operatorname{Re}\int_\Omega
\varepsilon\hat{\mathbf A}\cdot\overline{\nabla\hat\varphi}\,\mathrm d\mathcal V,\\
P_{\rm in}&=P_{\rm J}\quad\text{(pełny Maxwell)},\qquad
P_{\rm in}=P_{\rm J}+P_{\rm mix}\quad\text{(wybrany Darwin)}.
\end{aligned}
```

Wynik pochodzi z rzeczywistej części tożsamości Poyntinga. W modelu
Darwina człon $\operatorname{Re}(\hat{\mathbf E},\mathrm i\omega\hat{\mathbf D}_{\rm D})_\Omega$
zostawia $P_{\rm mix}$, który przy niejednorodnym dielektryku może być
niezerowy. Mierzymy go jawnie i porównujemy pasywność z pełnym Maxwellem.
Przypadek otwarty w pełnym Maxwellu wymaga doliczenia wypływającej mocy.


(rf-symbols-and-si-units)=
### Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
| --- | --- | --- |
| $f$ | Częstotliwość wzbudzenia | $\mathrm{Hz}$ |
| $\omega$ | Częstość kołowa | $\mathrm{rad\,s^{-1}}$ |
| $\mathrm i$ | Jednostka urojona | $1$ |
| $t$ | Czas | $\mathrm{s}$ |
| $t_0$ | Chwila odniesienia fazy | $\mathrm{s}$ |
| $x$ | Współrzędna wzdłuż CPW | $\mathrm{m}$ |
| $y$ | Współrzędna w poprzek CPW | $\mathrm{m}$ |
| $z$ | Współrzędna normalna do płaszczyzny CPW | $\mathrm{m}$ |
| $\hat Q$ | Fazor szczytowy wielkości fizycznej | $[Q]$ |
| $Q(t)$ | Odtworzona rzeczywista wielkość fizyczna | $[Q]$ |
| $\operatorname{Re}$ | Część rzeczywista | $1$ |
| $\overline{(\cdot)}$ | Sprzężenie zespolone argumentu | $1$ |
| $\hat\rho_f$ | Objętościowy ładunek swobodny w pełnym modelu | $\mathrm{C\,m^{-3}}$ |
| $\hat{\mathbf E}$ | Pole elektryczne | $\mathrm{V\,m^{-1}}$ |
| $\hat{\mathbf B}$ | Indukcja magnetyczna | $\mathrm{T}$ |
| $\hat{\mathbf H}$ | Natężenie pola magnetycznego | $\mathrm{A\,m^{-1}}$ |
| $\hat{\mathbf D}$ | Indukcja elektryczna w pełnym modelu | $\mathrm{C\,m^{-2}}$ |
| $\hat{\mathbf D}_{\rm D}$ | Indukcja elektryczna zachowana przez model Darwina | $\mathrm{C\,m^{-2}}$ |
| $\hat{\mathbf J}_{\rm c}$ | Gęstość prądu przewodzenia | $\mathrm{A\,m^{-2}}$ |
| $\hat{\mathbf J}_{\rm tot}$ | Całkowita gęstość prądu zgodna z wybranym modelem | $\mathrm{A\,m^{-2}}$ |
| $\sigma$ | Przewodność objętościowa | $\mathrm{S\,m^{-1}}$ |
| $\varepsilon$ | Przenikalność elektryczna | $\mathrm{F\,m^{-1}}$ |
| $\varepsilon_0$ | Przenikalność elektryczna próżni | $\mathrm{F\,m^{-1}}$ |
| $\varepsilon_r$ | Względna przenikalność elektryczna | $1$ |
| $\mu$ | Przenikalność magnetyczna | $\mathrm{H\,m^{-1}}$ |
| $\mu_0$ | Przenikalność magnetyczna próżni | $\mathrm{H\,m^{-1}}$ |
| $c_0$ | Prędkość światła w próżni | $\mathrm{m\,s^{-1}}$ |
| $\nabla\times$ | Rotacja pola przestrzennego | $\mathrm{m^{-1}}$ |
| $\nabla\cdot$ | Dywergencja pola przestrzennego | $\mathrm{m^{-1}}$ |
| $\nabla$ | Gradient objętościowy | $\mathrm{m^{-1}}$ |
| $\nabla_\Gamma$ | Gradient styczny do brzegu | $\mathrm{m^{-1}}$ |
| $\Omega$ | Domena elektromagnetyczna w fizycznych współrzędnych | $1$ |
| $\Gamma$ | Brzeg domeny elektromagnetycznej | $1$ |
| $S_k$ | Oznaczona powierzchnia terminala o indeksie k | $1$ |
| $\mathbf n$ | Normalna jednostkowa skierowana na zewnątrz domeny | $1$ |
| $\mathbf e_x$ | Wektor jednostkowy osi podłużnej | $1$ |
| $(\cdot)_{\rm tan}$ | Rzut styczny pola na brzeg | $1$ |
| $\mathrm d\mathcal V$ | Miara całkowania po objętości | $\mathrm{m^3}$ |
| $\mathrm dS$ | Miara całkowania po powierzchni | $\mathrm{m^2}$ |
| $\mathrm dy$ | Miara całkowania po linii poprzecznej | $\mathrm{m}$ |
| $k$ | Indeks terminala | $1$ |
| $\hat V$ | Potencjał ECE na powierzchni brzegu w pełnej formulacji E–V | $\mathrm{V}$ |
| $\hat V_k$ | Napięcie terminala względem ustalonej masy | $\mathrm{V}$ |
| $\hat I_k$ | Całkowity prąd terminala dodatni do wnętrza domeny | $\mathrm{A}$ |
| $Z_{\rm L}$ | Impedancja pasywnej terminacji względem masy | $\Omega$ |
| $\hat{\mathbf A}$ | Magnetyczny potencjał wektorowy | $\mathrm{Wb\,m^{-1}}$ |
| $\hat\varphi$ | Elektryczny potencjał skalarny | $\mathrm{V}$ |
| $\mathbf F$ | Ujemna całkowita gęstość prądu w zapisie potencjałowym | $\mathrm{A\,m^{-2}}$ |
| $\mathbf F_{\rm FW}$ | Całkowity człon potencjałowy pełnego Maxwella | $\mathrm{A\,m^{-2}}$ |
| $\mathbf F_{\rm D}$ | Całkowity człon potencjałowy modelu Darwina | $\mathrm{A\,m^{-2}}$ |
| $\mathbf a$ | Pole testowe potencjału magnetycznego | $\mathrm{Wb\,m^{-1}}$ |
| $\mathbf w$ | Pole testowe pola elektrycznego | $\mathrm{V\,m^{-1}}$ |
| $q$ | Skalarny potencjał testowy lub testowy ślad ECE | $\mathrm{V}$ |
| $q_k$ | Stała wartość potencjału testowego na terminalu | $\mathrm{V}$ |
| $\chi$ | Skalarna funkcja testowa warunku Coulomba | $\mathrm{Wb}$ |
| $\lambda_g$ | Mnożnik Lagrange'a usuwający gradientowe jądro operatora w równaniu Ampère'a | $\mathrm{A\,m^{-1}}$ |
| $(\,\cdot\,,\,\cdot\,)_\Omega$ | Iloczyn hermitowski liniowy w pierwszym argumencie o jednostkach argumentów u i v | $[u][v]\,m^3$ |
| $P_{\rm in}$ | Suma mocy czynnej wpływającej przez terminale ECE | $\mathrm{W}$ |
| $P_{\rm J}$ | Moc strat omowych w objętości | $\mathrm{W}$ |
| $P_{\rm mix}$ | Człon mieszany pola elektrycznego i wektorowego potencjału modelu Darwina | $\mathrm{W}$ |
| $\delta_{\rm Cu}$ | Głębokość naskórkowa w jednorodnej miedzi | $\mathrm{m}$ |
| $t_{\rm Cu}$ | Grubość miedzi | $\mathrm{m}$ |
| $R_\square$ | Rezystancja arkuszowa w granicy prądu jednorodnego po grubości | $\Omega$ |
| $\lambda_{\rm d}$ | Długość fali w jednorodnym bezstratnym dielektryku | $\mathrm{m}$ |
| $z_{\rm obs}$ | Wysokość sondy względem spodniej powierzchni Cu | $\mathrm{m}$ |
| $x_{\rm obs}$ | Położenie podłużne sondy | $\mathrm{m}$ |
| $\hat I_{\rm ref}$ | Zespolony prąd odniesienia wejściowego zacisku sygnałowego | $\mathrm{A}$ |
| $\hat I_{{\rm c},b}(x)$ | Podłużny prąd przewodzenia w przekroju paska b | $\mathrm{A}$ |
| $b$ | Indeks paska miedzianego | $1$ |
| $\Sigma_b(x)$ | Przekrój poprzeczny paska miedzianego o oznaczeniu b | $1$ |
| $h_{1\rm A,y}$ | Składowa poprzeczna zespolonej bazy pola przeliczonej na amper | $\mathrm{m^{-1}}$ |
| $\mathbf h_{1\rm A}$ | Zespolona baza przestrzenna pola anteny przeliczona na amper | $\mathrm{m^{-1}}$ |
| $\mathbf H_{\rm ant}(t)$ | Pole rzeczywiste przygotowane dla konsumenta magnetycznego | $\mathrm{A\,m^{-1}}$ |
| $\hat I_{\rm drive}$ | Autorski fazor szczytowy prądu napędu w tej samej konwencji odniesienia | $\mathrm{A}$ |
| $\kappa$ | Poprzeczna liczba falowa w widmie przestrzennym | $\mathrm{rad\,m^{-1}}$ |
| $y_a,\ y_b$ | Końce okna próbkowania poprzecznego | $\mathrm{m}$ |
| $\mathcal F_y$ | Poprzeczna transformata bazy pola na ograniczonym oknie | $1$ |
| $d_{\rm min}$ | Stosunek amplitudy w minimum do szczytowej amplitudy widma tej samej anteny | $1$ |
| $N$ | Liczba porównywanych wartości | $1$ |
| $u_j,\ v_j$ | Zgodne jednostkowo zespolone próbki kandydata i referencji w punkcie j | $[u]$ |
| $j$ | Indeks próbki | $1$ |
| $e_2$ | Względny błąd dyskretny L2 | $1$ |
| $C$ | Pojemność testowego kondensatora | $\mathrm{F}$ |
| $R$ | Rezystancja testowego przewodnika | $\Omega$ |
| $S$ | Pole przekroju testowego przewodnika lub okładki | $\mathrm{m^2}$ |
| $L$ | Długość testowego przewodnika lub odległość między okładkami | $\mathrm{m}$ |
| $\hat V_{\rm ground}$ | Potencjał referencyjny połączonych elektrycznie mas | $\mathrm{V}$ |
| $G$ | Zbiór dwóch pasków powrotnych CPW | $1$ |
| $B_b(x)$ | Ustalona część przekroju paska b przy szczelinie | $1$ |
| $p_{\rm gap}(x)$ | Udział modułu podłużnego prądu powrotnego w pasach przy szczelinach | $1$ |
| $d_1,\ d_2$ | Grubości warstw testowego kondensatora | $\mathrm{m}$ |
| $\varepsilon_1,\ \varepsilon_2$ | Przenikalności warstw testowego kondensatora | $\mathrm{F\,m^{-1}}$ |
| $\gamma,\ \gamma_{\rm D},\ \gamma_{\rm FW}$ | Zespolona stała przestrzenna w przewodzącej płycie | $\mathrm{m^{-1}}$ |
| $z'$ | Współrzędna normalna od płaszczyzny środkowej płyty | $\mathrm{m}$ |
| $\hat E_x(z')$ | Pole osiowe w testowej płycie | $\mathrm{V\,m^{-1}}$ |
| $\hat E_s$ | Zadana amplituda stycznego pola na obu powierzchniach płyty | $\mathrm{V\,m^{-1}}$ |
| $\hat K_x$ | Prąd osiowy zintegrowany po grubości płyty | $\mathrm{A\,m^{-1}}$ |
| $H^1,\ H^1_0$ | Przestrzeń węzłowa i jej podprzestrzeń o zerowym śladzie | $1$ |
| $H(\mathrm{curl})$ | Przestrzeń wektorowa ze słabą całkowalną kwadratowo rotacją | $1$ |

(rf-assumptions-and-validity)=
### Założenia oraz jawne wejścia pierwszego przypadku

| Wielkość | CPW2 | Pochodzenie |
| --- | --- | --- |
| Częstotliwość | 22,12 GHz | Artykuł |
| Szerokość sygnału / szczelin / całego CPW | 260 nm / 95 nm na stronę / 1,5 µm | Artykuł. Z tego po 525 nm na każdą symetryczną masę. |
| Miedź | 10 nm, $5{,}88\cdot10^7$ S/m | Artykuł. W modelu liniowa i izotropowa. |
| Przekładka i sonda | Przekładka 5 nm, $\varepsilon_r=14{,}7$. Sonda 7,5 nm pod miedzią. | Artykuł |
| Obszar YIG i dalsze podłoże | Warstwa YIG 20 nm. Dla testu źródła pasywny dielektryk z $\mu=\mu_0$. Początkowo $\varepsilon_r=14{,}7$ w YIG i podłożu. Sprawdzamy wrażliwość przynajmniej na zmianę $\varepsilon_r$ w obszarze YIG. | Grubość YIG z artykułu. Właściwości elektromagnetyczne poza przekładką są jawnie oznaczonymi założeniami. |
| Rama i obwiednia ECE | Paski proste od $x=-1$ do $+1$ µm. Początkowy przekrój domeny obejmuje $y,z\in[-3,3]$ µm. Poniżej warstw dominuje podłoże, powyżej miedzi powietrze. | Konfiguracja referencyjna Fullmaga. Zmiana szerokości obwiedni jest testem odcięcia. Zmiana odległości portów jest oddzielną zmienną fizyczną. |
| Zasilanie i terminacja ECE | Wejściowy koniec sygnału $1\angle0^\circ$ V szczytowo. Wyjściowy koniec sygnału obciążony $50\,\Omega$ do masy. Cztery oddzielne powierzchnie końców mas połączone z tym samym węzłem odniesienia, każda z raportem prądu. | Jawne założenie projektowe. Oryginalne wejście i wyjście CST są nieznane. $50\,\Omega$ to określone obciążenie, jego dopasowanie do CPW wymaga osobnego sprawdzenia. |
| Próbkowanie | $x_{\rm obs}=0$, $z_{\rm obs}=-7{,}5$ nm, $y\in[-1{,}6,1{,}6]$ µm. Porównania na wspólnej masce, krok 20 nm dla odtworzenia archiwum, 5 i 2,5 nm do kontroli odczytu. | Wysokość z artykułu. Początek i krok są ustawieniami benchmarku Fullmaga. |

Cel walidacji przenoszenia ustawień, CPW1, ma sygnał 65 nm oraz masy
po 622,5 nm przy pozostałych wymiarach poprzecznych wspólnych.
Podane warianty portów nie przypisują autorom publikacji konkretnej
terminacji. Zarówno surowe dane CST, jak i dopuszczalne odchylenie
geometrii portu są warunkami interpretacji porównania.
[Gruszecki i in. (2016), Fig. 1–2 i Methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC4789604/).

```{math}
:label: rf-material-scales

\delta_{\rm Cu}=\sqrt{\frac{2}{\omega\mu_0\sigma}},\qquad
R_\square=\frac{1}{\sigma t_{\rm Cu}},\qquad
\lambda_{\rm d}=\frac{c_0}{f\sqrt{\varepsilon_r}}
\quad\text{dla }\mu=\mu_0 .
```

Daje to około $441$ nm głębokości naskórkowej, $1{,}70\,\Omega$ na kwadrat
w jednorodnej cienkiej warstwie i $3{,}53$ mm długości fali w jednorodnym
dielektryku o $\varepsilon_r=14{,}7$. Dla $2$ µm długości modelowanego
odcinka faza odpowiadająca tej długości fali to około $0{,}0036$ rad.
Skala sprzyja sprawdzeniu EMQS w zadanej geometrii. W dielektryku i
szczelinach prąd przesunięcia wyznacza część sprzężenia. Dla referencji
zachowujemy miedź objętościową. Jednostronny warunek impedancji grubego
przewodnika ma inny zakres ważności przy $t_{\rm Cu}/\delta_{\rm Cu}\simeq0{,}023$.
[Haus i Melcher, rozdz. 10](https://ocw.mit.edu/courses/res-6-001-electromagnetic-fields-and-energy-spring-2008/c2c9f1b3799709c8dcc448356b30a382_10.pdf).

(rf-observables-contract)=
### Obserwable, faza odniesienia i normalizacja

Zapisujemy oba kwadraturowe składniki $\hat{\mathbf E}$,
$\hat{\mathbf J}_{\rm c}$ oraz $\hat{\mathbf H}$, jawny prąd
każdego terminala, źródłową częstotliwość oraz jednostki. Dla pełnej
fali można wyznaczyć pole z Faradaya. Gdy referencja eksportuje
$\hat{\mathbf B}$, przeliczamy $\hat{\mathbf H}=\mu^{-1}\hat{\mathbf B}$
na oznaczonym materiale sondy. Prawo Ampère'a w obu modelach używa prądu całkowitego zgodnego z ich równaniami.

Do walidacji kształtu pola definiujemy $\hat I_{\rm ref}$ jako prąd
całkowity wchodzący przez sygnałowy zacisk wybranego pobudzenia ECE.
Dla portu falowego osobny adapter musi określić fazę modu i przekrój
prądu odniesienia. Amplituda mocy portu nie jest równoważna prądowi
zacisku. Dla wybranego modelu źródła wynik obejmuje siłę i fazę tego
prądu oraz podstawę jego wyznaczania.

```{math}
:label: rf-phasor-field-basis

\hat I_{{\rm c},b}(x)=\int_{\Sigma_b(x)}
    \hat{\mathbf J}_{\rm c}\cdot\mathbf e_x\,\mathrm dS,\qquad
\mathbf h_{1\rm A}=\frac{\hat{\mathbf H}}{\hat I_{\rm ref}},\qquad
\mathbf H_{\rm ant}(t)=\operatorname{Re}\{
  \hat I_{\rm drive}\mathbf h_{1\rm A}\exp[\mathrm i\omega(t-t_0)]\}.
```

Prąd normalizujący musi być skończony, a moduł prądu ma przekraczać
100-krotność oszacowanego bezwzględnego błędu jego odczytu. Szacunek
łączy zmianę przy rafinacji siatki i błąd bilansu terminali. Do osiowej diagnozy rozkładu zapisujemy zespolone prądy
w trzech miedzianych paskach, wraz z osobnym prądem przesunięcia i
bilansem całkowitym. Frakcję geometryczną definiujemy przez moduł
podłużnej składowej prądu w obu paskach masy. Pas $B_b(x)$ ma szerokość
20 nm od wewnętrznej krawędzi każdej masy w kierunku poprzecznym,
przez całą grubość przewodnika.

```{math}
:label: rf-gap-current-fraction

p_{\rm gap}(x)=
\frac{\displaystyle\sum_{b\in G}\int_{B_b(x)}
      \lvert\hat{\mathbf J}_{\rm c}\cdot\mathbf e_x\rvert\,\mathrm dS}
     {\displaystyle\sum_{b\in G}\int_{\Sigma_b(x)}
      \lvert\hat{\mathbf J}_{\rm c}\cdot\mathbf e_x\rvert\,\mathrm dS}.
```

W metryce brak prądu w masach oznacza brak wyniku. Do porównania z DC
zapisujemy również całki ze znakiem i obie kwadratury przez te same pasy.
Złożenie dwóch fazorów przestrzennych przez
mnożenie jednym przebiegiem rzeczywistym zgubiłoby kwadraturę. Analiza
i projekcja zachowują obie składowe w tej samej ramie i konwencji.

```{math}
:label: rf-spectrum

\begin{aligned}
\mathcal F_y(\kappa)&=\int_{y_a}^{y_b}h_{1\rm A,y}(x_{\rm obs},y,z_{\rm obs})
                  \exp(-\mathrm i\kappa y)\,\mathrm dy,\\
d_{\rm min}&=\frac{\lvert\mathcal F_y\rvert_{\rm minimum}}
                  {\max\lvert\mathcal F_y\rvert}.
\end{aligned}
```

Współrzędna $y$ rośnie monotonicznie. Dla obu geometrii zachowujemy tę samą
definicję okna, kwadraturę i normalizację wspólnego wykresu. Część rzeczywistą
dla podpisanego porównania odczytujemy po ustawieniu fazy względem portu
lub oznaczonej konwencji publikacji. Moduł widma liczymy z zespolonej
transformaty. Głębokość minimum podajemy również względem szczytu
tej samej anteny. Archiwum publikacji zawiera podpisany profil oraz
moduł widma. Walidacja fazy wymaga osobnej zespolonej referencji.

(rf-discrete-realization)=
## 3. Realizacje numeryczne

| Rodzina | Urządzenie | Status i zakres |
| --- | --- | --- |
| FEM | CPU | Przygotowano samodzielne referencyjne operatory CPU FP64. Natywna realizacja Fullmaga i kwalifikacja CPW pozostają otwarte. |
| FEM | GPU | Nieobsługiwany solve RF. Wymagane byłyby złożone operatory, preconditioner, kontrola residuum i kwalifikacja na urządzeniu. |
| FDM | CPU | Nieobsługiwany solve RF. Docelowo projekcja obu kwadratur gotowej bazy na komórki magnetyczne. |
| FDM | GPU | Nieobsługiwany solve RF. Docelowo odbiór kwadratur jako przeniesione dane, po teście FP64 i zgodności fazy na urządzeniu. |

FEM CPU wymaga jednej zgodnej, nieprzecinającej się siatki miedzi,
przekładki, próbki i zewnętrznego otoczenia. Przestrzeń Nédéleca
$H(\mathrm{curl})$ służy do $\hat{\mathbf E}$ lub $\hat{\mathbf A}$, a
kompatybilna przestrzeń węzłowa $H^1$ do potencjału i warunku gauge.
Gradient dyskretny musi należeć do przestrzeni krawędziowej. Odczyt
rotacji i strumieni korzysta z odpowiedniej części dyskretnego ciągu
de Rhama. Początkowo przewidujemy elementy najniższego zgodnego rzędu,
sprawdzenie wyższego rzędu i oddzielne zagęszczanie okolic portu,
szczelin, grubości filmu oraz linii sondy. Na granicy dwóch ośrodków
czytany jest ślad z jawnie wskazanej strony materiału.

Pierwsza realizacja referencyjna używa jawnego zespolonego układu
(w razie potrzeby równoważnych bloków rzeczywistych). Dopuszczenie
większych siatek wymaga pomiaru kosztu montażu, pamięci i residuów
składowych, a nie samej tolerancji iteracyjnej. Składanie, blok
gradientowy i jednostki reszt wymagają osobnych testów. Preconditioner
układu z masą o zespolonym współczynniku i warunkiem gauge wymaga
weryfikacji dla zakresu przewodności od powietrza do miedzi.

FDM pozostaje odbiorcą przyszłego artefaktu. Przeniesienie zwalidowanej
bazy z siatki EM do FDM albo FEM jest jawną projekcją z kontrolą błędu
i odciskiem obu siatek. Backend obliczenia EM wybieramy niezależnie od solvera magnetyzacji. W pierwszym etapie badamy jedynie pole antenowe.


### Samodzielna realizacja referencyjna

`scripts/rf_fullwave_reference.py` składa zespolony operator Maxwella na
krawędziowej bazie Whitneya Tet4. Dekompozycja drzewo–kodopełnienie eliminuje
działanie części curl-curl na gradient analitycznie. Prąd zacisków pochodzi
z reakcji przewodzenia i przesunięcia, dzięki czemu odejmowanie dużych
składników curl-curl nie zasłania prądu pojemnościowego w małej domenie.
Pole magnetyczne mierzymy z tej części pola elektrycznego, która wnosi
rotację. `scripts/rf_darwin_reference.py` wykorzystuje tę samą bazę i
materiały, rozwiązuje mieszany układ oraz osobno raportuje sprawdzian gauge
i bilans z członem mieszanym. Oba warianty zapisują obie kwadratury.

Preflight siatki i eksport niezależnego przypadku Palace nie uruchamiają
obliczeń elektromagnetycznych. Eksport Palace używa dwóch portów falowych
i osłony PEC. Obliczony wynik będzie wymagał osobnej kwalifikacji modu
i wrażliwości na obwiednię.

```bash
python3 -B scripts/rf_cpw_reference.py --cpw 2 --refinement 0 --model maxwell
python3 -B scripts/rf_cpw_reference.py --cpw 2 --refinement 0 --model darwin
python3 -B scripts/rf_palace_preflight.py --cpw 2 --mode 1 --output /tmp/fullmag-cpw2-palace
```

Tryb `--solve --output NOWY_KATALOG` zapisuje wyniki samodzielnego
referencyjnego solvera. `scripts/compare_rf_cpw_reference.py` przyjmuje dwa
katalogi w kolejności Maxwell, Darwin i sprawdza zgodność wejść przed
porównaniem. Załączone testy obejmują prosty kondensator, stabilizację
przy małej długości elektrycznej, znak fali biegnącej, zaciski, odczyt
obu kwadratur i spójność formatu siatki Palace. Kwalifikacja CPW wymaga
wyników całych przebiegów.

(rf-python-api)=
## 4. Python i ProblemIR

### Publiczny kontrakt na dziś

Aktualny konstruktor akceptuje tylko `quasistatic_conduction_biot_savart3d`.
W poniższych komórkach sprawdzamy rzeczywiste obniżenie jednego obiektu
oraz odrzucenie przyszłej nazwy modelu. Obiektowi przekazujemy ID zależności
do celów inspekcji serializacji. Wykonywalne studium wymaga dodatkowo tych
obiektów, siatki i rejestracji w potoku. Aktualny przykład kompletnego
scenariusza jest opisany w [nocie 0950](0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md#antenna-problem-statement).

```python
# %%
import json

import fullmag as fm

# %%
target = fm.FieldTarget.object("sampling")
inputs = {
    "id": "inspect_cpw",
    "source_object_id": "antenna",
    "current_transport_id": "cpw_charge",
    "port_mode_ids": ["cpw_port"],
    "field_sampling_domain": target,
    "target_refs": [target],
    "outputs": [fm.AntennaNamedOutput("cpw_inspection", "H_ant_basis")],
}
stage = fm.AntennaFieldSolveStage(**inputs)
print(json.dumps(stage.to_ir(), indent=2))

# %%
try:
    fm.AntennaFieldSolveStage(**inputs, model="harmonic_emqs_darwin")
except ValueError as error:
    if str(error) != "unsupported antenna field model":
        raise
    print(error)
else:
    raise AssertionError("The current constructor accepted an unimplemented RF model.")
```

Uruchomienie zwraca poniższy fragment i komunikat
`unsupported antenna field model`. Wartości domyślne w tym wyjściu
pochodzą z publicznego konstruktora. Archiwum CPW używało jawnej
polityki `volume_inspection_v1`.

```json
{
  "id": "inspect_cpw",
  "source_object_id": "antenna",
  "current_transport_id": "cpw_charge",
  "port_mode_ids": [
    "cpw_port"
  ],
  "model": "quasistatic_conduction_biot_savart3d",
  "oersted_realization": "direct_tetra_quadrature",
  "conductor_mesh_policy": "authored_shared_domain",
  "field_sampling_domain": {
    "kind": "object",
    "object_id": "sampling"
  },
  "target_refs": [
    {
      "kind": "object",
      "object_id": "sampling"
    }
  ],
  "solver_policy": "production_default",
  "outputs": [
    {
      "id": "cpw_inspection",
      "quantity": "H_ant_basis"
    }
  ]
}
```

| Parametr użyty lub zmaterializowany w przykładzie | Typ | Domyślnie | SI | Walidacja | Znaczenie | Obsługa | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AntennaFieldSolveStage.id` | str | wymagany | $1$ | niepusty, unikatowy w potoku | tożsamość etapu | DC / FEM CPU | `antenna_field_solve_stages[].id` |
| `AntennaFieldSolveStage.source_object_id` | str | wymagany | $1$ | niepuste ID obiektu źródła | właściciel geometrii CPW | DC / FEM CPU | `antenna_field_solve_stages[].source_object_id` |
| `AntennaFieldSolveStage.current_transport_id` | str | wymagany | $1$ | niepuste ID kompletnego transportu w plannerze | powiązanie z transportem DC | DC / FEM CPU | `antenna_field_solve_stages[].current_transport_id` |
| `AntennaFieldSolveStage.port_mode_ids` | Sequence[str] | wymagany | $1$ | dokładnie jedno niepuste ID zgodne ze źródłem | wybrany port etapu | DC / FEM CPU | `antenna_field_solve_stages[].port_mode_ids` |
| `AntennaFieldSolveStage.field_sampling_domain` | FieldTarget | wymagany | $1$ | instancja FieldTarget, zgodny nośnik w plannerze | nośnik próbek pola | DC / FEM CPU | `antenna_field_solve_stages[].field_sampling_domain` |
| `AntennaFieldSolveStage.target_refs` | Sequence[FieldTarget] | wymagany | $1$ | co najmniej jeden typowany cel | cele pola | DC / FEM CPU | `antenna_field_solve_stages[].target_refs` |
| `AntennaFieldSolveStage.outputs` | Sequence[AntennaNamedOutput] | wymagany | $1$ | dokładnie jedno wyjście H_ant_basis | nazwane wyjście bazy | DC / FEM CPU | `antenna_field_solve_stages[].outputs` |
| `AntennaFieldSolveStage.model` | str | quasistatic_conduction_biot_savart3d | $1$ | konstruktor dopuszcza wyłącznie model DC, RF kończy się ValueError | wybór fizyki źródła | DC / FEM CPU | `antenna_field_solve_stages[].model` |
| `AntennaFieldSolveStage.oersted_realization` | str | direct_tetra_quadrature | $1$ | słownik dopuszczalnych realizacji, surface wymaga oddzielnej polityki | metoda złożenia pola DC | DC / FEM CPU | `antenna_field_solve_stages[].oersted_realization` |
| `AntennaFieldSolveStage.conductor_mesh_policy` | str | authored_shared_domain | $1$ | niepusta nazwa polityki, wykonanie rozstrzyga planner | intencja siatkowania przewodnika | DC / FEM CPU | `antenna_field_solve_stages[].conductor_mesh_policy` |
| `AntennaFieldSolveStage.solver_policy` | str | production_default | $1$ | niepusta nazwa polityki, wykonanie rozstrzyga planner | intencja numeryczna | DC / FEM CPU | `antenna_field_solve_stages[].solver_policy` |
| `FieldTarget.object(object_id)` | str | wymagany | $1$ | niepuste ID istniejącego celu dla wykonywalnego etapu | obiekt nośnika | DC / FEM CPU | `field_sampling_domain lub target_refs[].object_id` |
| `AntennaNamedOutput.id` | str | wymagany | $1$ | niepuste ID, unikatowe w opisie etapu | identyfikator rezultatu | DC / FEM CPU | `outputs[].id` |
| `AntennaNamedOutput.quantity` | str | wymagany | $1$ | dla użytego wyjścia H_ant_basis | fizyczna wielkość rezultatu | DC / FEM CPU | `outputs[].quantity` |

(rf-problem-ir)=
### Proponowany kontrakt harmoniczny

Zachowujemy jeden jawny etap przygotowania pola w istniejącej hierarchii
`antenna_field_solve`. Definicja źródła RF jest wariantem
modelu fizycznego, obok istniejącej definicji DC. Dla tego wariantu nie ma
powiązania z DC `current_transport_id`, jego szwem potencjału ani
wyborem istniejącej całki Oersteda. Port ECE potrzebuje własnego wariantu
fizycznego opisu portu. Podane niżej pola to projekt obniżenia, a nazwy
publicznych konstruktorów zależą od późniejszej migracji Python i IR.

| Intencja projektowana dla DSL | Typ i jednostki | Domyślnie i walidacja | Planowane obniżenie w definicji etapu |
| --- | --- | --- | --- |
| Wybór fizyki | enum, $1$ | Wariant harmoniczny tylko po jawnym wyborze. Wersja operatora rozpoznana przez planner. | `model` oznacza rodzaj równań, na początek `harmonic_emqs_darwin`. |
| Częstotliwość źródła | finite float, $\mathrm{Hz}$ | Wymagana, dodatnia. Brak zgody na przejście do DC przy zerze. | `harmonic.frequency_hz` |
| Geometria i materiały | identyfikatory, długości w $\mathrm m$, $\sigma$ w $\mathrm{S\,m^{-1}}$, $\varepsilon$ w $\mathrm{F\,m^{-1}}$, $\mu$ w $\mathrm{H\,m^{-1}}$ | Jawne przypisania do rozłącznych regionów, skończone $\sigma\ge 0$, $\varepsilon,\mu>0$. Współrzędne SI w jednym układzie. | `source_object_id` oraz jawne referencje z `harmonic.region_materials` |
| Terminale, potencjał odniesienia oraz wybrane pobudzenie | identyfikatory powierzchni, zespolone V/A jako pary FP64 | Wymagane rozłączne terminale, poprawna orientacja, jeden aktywny sygnał i jawna masa. W pierwszym wariancie źródło napięciowe ECE. | `port_mode_ids` oraz typowana deklaracja terminali i pobudzenia |
| Obciążenie | wariant fizyczny, zespolone $\mathrm\Omega$ dla impedancji | Wymagane dla wyjścia. Skończone i niezerowe z nieujemną częścią rzeczywistą, zwarcie i rozwarcie mają własne warianty. | deklaracja terminacji portu, adresowana przez jego ID |
| Normalizacja | enum i referencja zacisku, prąd wynikowy w $\mathrm A$ | Wymagana identyfikacja zacisku sygnału. Przy zbyt małym prądzie wyjście bazy jest odrzucone, a surowe pola mogą pozostać do diagnozy. | `harmonic.reference_current` |
| Faza i próbkowanie | stała konwencja peak i $e^{+\mathrm i\omega t}$, opcjonalne $t_0$ w $\mathrm s$ po stronie napędu, nośnik w $\mathrm m$ | Wymagany typowany, jawny nośnik. Układ współrzędnych i strona interfejsu weryfikowane przed alokacją. | `field_sampling_domain`, `target_refs`, identyfikator konwencji w modelu i artefakcie |
| Wykonanie | typowane żądanie backendu, numeryczne tolerancje bezwymiarowe lub we właściwych jednostkach SI | Pierwszy kandydat FEM CPU double strict. Brak cichego fallbacku i brak automatycznego podmieniania domeny, portu lub modelu. | dotychczasowy profil wykonania i typowana polityka operatora RF |
| Wyjście pola | identyfikator wersjonowanego wyniku i dwie kwadratury XYZ | Wymagany cel i nazwa. Typ bazy kompleksowej lub dane surowe są sprawdzane przez konsumenta. | `outputs` z jawnie rozróżnioną rodziną artefaktu |

Stare dokumenty zachowują własny układ pól i semantykę. Brak deklaracji
harmonicznej nigdy nie aktywuje RF. Dodatkowe pola przypisane omyłkowo
do wariantu DC lub konfiguracja RF wymagająca transportu DC mają
jawne błędy walidacji. W jednej ścieżce IR nie ma dwóch źródeł prawdy o
częstotliwości, fazie i orientacji portu.

(rf-round-trip-and-failure-semantics)=
### Round-trip, planner i cykl wykonania

- **Requested intent** zawiera model, częstotliwość, geometrię, zadany port,
  terminację, materiał, nośnik i żądanie wykonania. Skrypt eksportowany z UI
  odtwarza tę intencję w zakresie kwalifikowanych opcji.
- **Resolved execution** zapisuje konkretny backend, precyzję, numer wersji
  operatora, przestrzenie, siatkę rzeczywistą, zorientowane powierzchnie
  zacisków i warunki odczytu oraz tolerancje.
- **Validation errors** blokują rozwiązanie przy niejednoznacznej geometrii,
  portach niebędących osobnymi powierzchniami, błędnych jednostkach, braku
  referencji fazy, niezgodności maski albo przy nierozróżnialnym prądzie
  normalizacji.
- **Unsupported combinations** obejmują niezakwalifikowane GPU/FDM dla RF,
  przypadkowe zastąpienie terminala ECE portem falowym, wariant częstotliwości
  zero i brak fazy w bazie używanej przez napęd harmoniczny. Autorskie
  żądanie pozostaje widoczne z powodem odmowy.
- Etap jawnie przechodzi przez przygotowanie, rozwiązanie, kontrolę
  i atomową publikację katalogu wyjść. Błąd, anulowanie lub przerwanie nie
  tworzą gotowej bazy. Przebieg magnetyczny przyjmuje wyłącznie sprawdzoną
  referencję wcześniejszego etapu z właściwym hashem, częstotliwością i
  portem. Artefakt referencyjny solvera zewnętrznego ma osobne pochodzenie.

(rf-implementation-mapping)=
### Artefakty, API v2 i workspace

- Nośnik próbek, maska, identyfikatory regionów, układ XYZ, kolejność węzłów
  i składowych, konwencja fazy i jednostki są częścią manifestu pola. Dane
  wektorowe zawierają kwadratury real i imag w binarnym formacie FP64.
  Artefakt wiąże bufor z geometrią, siatką, wersją solvera, konfiguracją,
  portem, terminacją i rzeczywistymi prądami terminalowymi.
- Osobne produkty do porównania to zespolone $J_{\rm c}$, $H$ surowe,
  $H/I_{\rm ref}$, prądy pasków, residua, bilans mocy, próbki, widmo i
  metryki. Import z CST, zewnętrzna referencja Maxwella, natywny Fullmag,
  obliczenia analityczne i pomiary mają osobne klasy pochodzenia. Aktualny
  benchmark opiera się na symulacjach i analizie danych.
- Klucz tożsamości solve obejmuje częstotliwość, model, geometrię, materiały,
  port, terminację i siatkę. Zmiana nośnika unieważnia produkt próbkowany.
  Zmiana amplitudy lub wspólnej fazy późniejszego napędu nie musi odtwarzać
  solve'u znormalizowanego, przy tej samej częstotliwości i założeniu
  liniowości. Projekcja ma własną tożsamość z hashem siatki docelowej.
- OpenAPI v2 ma wystawiać stan etapu i katalog pola przez zasoby sesji.
  Bufory są osobno pobierane po rewizji i identyfikatorze zawartości. W UI
  jest jeden viewport i istniejący typed client oraz resource hooks.
  Inspektor portu pokazuje zaciski, orientacje, fazę odniesienia, model,
  częstotliwość i terminację. Warstwy viewportu rozróżniają geometrię
  przewodnika, znaczniki terminali i próbkowane pole. Widmo, faza i błędy
  są danymi wynikowymi w wynikach i diagnostyce etapu. Round-trip
  z workspace do skryptu i z powrotem jest warunkiem publicznego wydania.

(rf-validation)=
## 5. Walidacja i wybór realizacji

Założone niżej progi są kryteriami inżynierskimi tej noty. Nie są błędami
pomiarowymi publikacji. Metrykę dla zgodnych współrzędnych, jednostek i
referencji fazy definiujemy jako

```{math}
:label: rf-validation-l2

e_2=\left(\frac{\displaystyle\sum_{j=1}^{N}\lvert u_j-v_j\rvert^2}
 {\displaystyle\sum_{j=1}^{N}\lvert v_j\rvert^2}\right)^{1/2}.
```

Dla bliskiego zeru odniesienia wymagamy progu bezwzględnego w jednostce
porównywanej wielkości oraz raportu zakresu pomiaru. Wynik porównania
z fazą można liczyć bez dodatkowego obrotu po uzgodnieniu źródła.

### A. Modele o rozwiązaniach kontrolnych

1. Jednorodny przewodnik z zaciskami na końcach. W odpowiedniej granicy
   DC odzyskujemy opór i prąd na tym samym modelu końców. Sprawdzamy
   odwrócenie znaku napięcia, orientację prądu, proporcjonalność pola i
   zanik kwadratury przy zmniejszaniu częstotliwości.
2. Płaski kondensator w kierunku normalnym, najpierw jednowarstwowy,
   potem dwuwarstwowy. Odtwarzamy prąd w kwadraturze oraz ciągłość
   normalnego całkowitego prądu w dielektryku. Test wykrywa brak
   pojemności, niepoprawne przeniesienie współczynnika oraz znak
   `+iωt`. Wariant powtarzamy w obu formulacjach przy zaniedbywalnym
   rozproszeniu brzegowym.
3. Symetrycznie pobudzona przewodząca płyta i podany profil dyfuzji
   magnetycznej. Porównujemy profil głębokości i fazy w zakresie
   grubości mniejszej i większej od $\delta_{\rm Cu}$. To oddzielna
   kontrola efektu naskórkowego. Jednostronna półprzestrzeń jest kontrolą
   daleko od przeciwległej powierzchni.
4. Interfejsy i porty. Test z nałożonym źródłem, z pasywnym obciążeniem
   i z rozwarciem kontroluje znak mocy, $I_k$ po obu stronach, składową
   Coulomba i rzeczywiste residua. Dla E–V próbka z przewodem
   koncentrycznym ONELAB jest niezależnym sprawdzeniem terminali ECE.

```{math}
:label: rf-analytical-terminal-checks

R=L/(\sigma S),\qquad
C=\varepsilon S/L,\qquad
\hat I_k=\hat V_k/R\;\text{(DC)},\qquad
\hat I_k=\mathrm i\omega C\,\hat V_k\;\text{(kondensator w granicy EQS)} .
```

Dla dwóch warstw kondensatora o grubościach $d_1,d_2$ i przenikalnościach
$\varepsilon_1,\varepsilon_2$ oraz dla płyty o współrzędnej $z'$ mierzonej
od jej płaszczyzny środkowej wykorzystujemy

```{math}
:label: rf-capacitor-and-skin-oracles

\begin{aligned}
 C &= \frac{S}{d_1/\varepsilon_1+d_2/\varepsilon_2},\\
 \gamma_{\rm D}^2 &= \mathrm i\omega\mu\sigma,
 \qquad
 \gamma_{\rm FW}^2 = \mathrm i\omega\mu\sigma-\omega^2\mu\varepsilon,\\
 \hat E_x(z') &= \hat E_s\,\frac{\cosh(\gamma z')}{\cosh(\gamma t_{\rm Cu}/2)},\qquad
 \hat K_x = \frac{2\sigma\hat E_s}{\gamma}\tanh(\gamma t_{\rm Cu}/2).
\end{aligned}
```

$\hat E_s$ jest polem stycznym zadanym jednakowo na obu stronach płyty.
$\gamma$ jest odpowiednim pierwiastkiem o nieujemnej części rzeczywistej,
a $\hat K_x$ jest całką prądu przez grubość.

Dla modeli analitycznych zadajemy cel 1% dla prądu i wektora pola na
zbieżnej siatce. W normalizowanych bilansach zamkniętej referencji
początkowy próg prądu i mocy wynosi $10^{-4}$, odpowiednio względem
sumy modułów prądów oraz sumy modułów składników bilansu mocy. Norma
reszty algebraicznej i wkład mnożnika gauge są raportowane oddzielnie.
W pełnym Maxwellu z otwartą domeną bilans uwzględnia moc wypromieniowaną.

### B. Taki sam problem brzegowy w dwóch formulacjach

Przed CPW Gruszeckiego odtworzyć publiczny przypadek referencyjny.
Następnie użyć tej samej domeny, siatki, terminali **ECE**, parametrów
i fazy dla pełnej formulacji E–V oraz potencjałowej. Przewodnik
koncentryczny lub podstawowy model portu z ONELAB kalibruje odczyt
zacisków, a niezależny pełny Maxwell kontroluje obcięcie Darwina.
Wariant pełnofalowy z tą samą bazą $A$–$\varphi$ można dodatkowo uruchomić
z przywróconym członem w obu równaniach, aby odizolować samo przybliżenie.
Dwa biegi Palace z portem skupionym i portem falowym badają osobno wrażliwość
na rodzaj portu przy zachowaniu zgodnych materiałów i sond.

### C. CPW2 przy 22,12 GHz i przeniesienie do CPW1

1. Najpierw kwalifikujemy modelowanie źródła. Używamy trzech zagnieżdżonych
   poziomów zagęszczenia przy miedzi i szczelinie oraz niezależnego
   testu zewnętrznej obwiedni. Krok w grubości, rozmiar domeny, położenie
   portu, krok sond i okno widma zmieniamy osobno. Zbieżność dyskretna
   wymaga spadku różnic między kolejnymi poziomami i zmiany zespolonego
   profilu $H/I_{\rm ref}$ o najwyżej 1% L2 dla dwóch ostatnich siatek.
2. Warunek dopuszczenia Darwina w porównaniu z pełną falą dla **jawnego
   portu ECE** to najwyżej 2% L2 dla wektorowego znormalizowanego $H$,
   najwyżej 1 punkt procentowy różnicy udziału prądu powrotnego w pasie
   20 nm przy szczelinach i najwyżej $0{,}1\,\mathrm{rad\,\mu m^{-1}}$
   różnicy położenia minimum. Błąd głębokości minimum CPW2, zapisanej
   jako stosunek do własnego szczytu, ma być poniżej 0,1 punktu
   procentowego na wspólnej masce. Wymagamy też zbilansowania
   całkowitego prądu, pasywności oraz mierzalnego kosztu uzasadniającego
   tę realizację. Porównujemy wall time, szczyt RAM, liczbę DOF
   i alokację przechowywanych danych z pełną formulacją przy tej samej
   tolerancji obserwabli.
3. Osobno porównujemy modele z finalnym PDF. Patrzymy na $H_y$ ze znakiem,
   pełne moduły widma oraz położenie i głębokość minimum CPW2. Prąd
   wzorcowy i faza CST są brakującymi wejściami. Porównanie z wykresami
   używa wspólnej maski i opisanej konwencji fazy. Gdy potrzebna jest
   skala zastępcza, wybieramy jeden dodatni współczynnik wyłącznie na
   CPW2 i zapisujemy go przed porównaniem CPW1. W obu przypadkach
   przechowujemy niezależnie nienastrojoną bazę na amper. Zmianę założeń portu raportujemy
   jako wrażliwość, z własnym identyfikatorem konfiguracji.
4. Traktujemy CPW1 jako odłożony przypadek po wyborze konwencji i
   ustawień na CPW2. Późniejszy taper z rys. 4 wymaga przestrzennego
   modelu 3D. Dla każdego przebiegu zapisywane są wersje konfiguracji,
   dane i wykresy, a prezentacja walidacyjna otrzymuje po przebiegu
   datę i angielski komentarz z ustawieniami, metryką i ścieżką.

### D. Publikacja artefaktów i porównanie między backendami

Testy rejestracji planu pokrywają obsługiwane i odrzucone kombinacje.
Test importu sprawdza zamianę RMS na peak, znak części urojonej przy
zmianie konwencji czasu oraz przeliczenie $B$ do $H$. Powtarzalny
test binarny sprawdza dwie kwadratury, znaki XYZ, zgodny hash,
maskę, kolejność i jawny błąd dla brakującej składowej. Porównanie
przeniesienia na próbkę FEM/FDM jest oddzielne od walidacji źródła i od
kwalifikacji GPU. Dobór modelu ma zakres pola anteny.

Pierwszy uruchamialny preflight ma dostarczyć surowe wielkości siatki,
koszt pamięci, czas i plan rozwiązania. Podstawą akceptacji nowych
obliczeń jest oszacowanie na tym konkretnym modelu. Dotychczasowy
koszt przebiegów DC nie prognozuje złożonego solve'u Maxwella.


## 6. Lista kompletności

- [x] Równania, faza, jednostki, ograniczenia i docelowe obserwable.
- [x] Specyfikacja problemu porównawczego i mapa źródeł.
- [x] Zweryfikowany przykład bieżącego kontraktu DC i odmowa RF.
- [ ] Przebieg niezależnej referencji pełnofalowej i koszt na przypiętym modelu.
- [ ] Walidacja portu ECE oraz wybór modelu po porównaniu z pełną falą.
- [ ] Wdrożenie FEM CPU, Python, ProblemIR, planner i capability matrix.
- [ ] Rejestracja wyników, API v2 i zweryfikowany round-trip.
- [ ] Projekcja, konsumenci FEM/FDM i kwalifikacja na urządzeniach.
- [ ] Porównanie natywnego źródła harmonicznego z publikacją.

(rf-limitations)=
## 7. Ograniczenia i prace odłożone

Pierwszy etap obejmuje pojedynczą częstotliwość, jeden port pobudzany,
liniowe izotropowe materiały i pole anteny bez odpowiedzi magnetycznej YIG.
GPU, dyspersja materiałowa, szerokopasmowe S-parametry, nieliniowość
magnetyczna i wieloportowe aktywne wzbudzenie wymagają osobnej kwalifikacji.
Porty falowe i domena otwarta pełnego Maxwella służą najpierw jako niezależna
kontrola czułości. Wydanie funkcji harmonicznej zależy od spełnienia bramek
E–V, potencjałów i obserwabli CPW. Bieżący stan obejmuje samodzielne narzędzia referencyjne i testy. Integracja natywna pozostaje otwarta.

(rf-scientific-bibliography)=
## 8. Publikacje i narzędzia referencyjne

### Publikacje źródłowe

1. P. Gruszecki i in., *Microwave excitation of spin wave beams in thin
   ferromagnetic films*, Scientific Reports 6, 22367 (2016). Rys. 1c/2b,
   geometria i źródło referencji CST. [DOI](https://doi.org/10.1038/srep22367).
2. G. Ciuprina i R. V. Sabriego, *Electric circuit element boundary
   conditions for electromagneto-quasistatic and full wave models in A, φ
   potentials and their finite element implementation*, Journal of
   Mathematics in Industry 14, 27 (2024). Równania Darwina, gauge i
   porównanie CPW z pełną falą. [DOI](https://doi.org/10.1186/s13362-024-00165-6).
3. G. Ciuprina, D. Ioan i R. V. Sabariego, *Electric circuit element
   boundary conditions in the finite element method for full-wave passive
   electromagnetic devices*, Journal of Mathematics in Industry 12, 7
   (2022). Słaba formulacja E–V i prąd terminala. [DOI](https://doi.org/10.1186/s13362-022-00122-1).
4. M. Clemens i in., *A Port-Hamiltonian System Perspective on
   Electromagneto-Quasistatic Field Formulations of Darwin-Type*. Omówienie
   różnic między wariantami ciągłości i gauge przy niejednorodnych
   materiałach. [Praca źródłowa](https://arxiv.org/abs/2404.18767).
5. H. A. Haus i J. R. Melcher, *Electromagnetic Fields and Energy*,
   rozdział 10. Dyfuzja magnetyczna i testy efektu naskórkowego w przewodniku.
   [Tekst na MIT OpenCourseWare](https://ocw.mit.edu/courses/res-6-001-electromagnetic-fields-and-energy-spring-2008/c2c9f1b3799709c8dcc448356b30a382_10.pdf).

### Sprawdzone wskazówki implementacyjne

| Źródło | Co sprawdzono i do czego służy | Ograniczenie |
| --- | --- | --- |
| **Palace** · `be4b5d36ffe77933d4dbf86209d2bf21a2059fe3` | Są dwie czytelne konfiguracje wzorcowe, z portami falowymi i skupionymi. Dokumentacja opisuje odczyt próbek $E,B$ i normalizację mocy portu, a kod zawiera operator portu falowego. [Przykład](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/docs/src/examples/cpw.md) · [Port falowy](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/examples/cpw/cpw_wave_uniform.json) · [Port skupiony](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/examples/cpw/cpw_lumped_uniform.json) · [Kod portu](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/palace/models/waveportoperator.cpp) · [Sondy](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/docs/src/guide/postprocessing.md) | Gotowe konfiguracje modelują PEC w innej skali i z innym podłożem. Potrzebny nowy przypadek z regionem miedzi objętościowej i ustawieniami z §2. Palace współdzieli MFEM jako bibliotekę, dlatego wymagamy też rozwiązania analitycznego lub drugiej formulacji. |
| **MFEM** · `92021c45ce70eba81388a7543528bcec91c5355f` | `ex22p.cpp` ma zespoloną formę $H(\mathrm{curl})$ z tłumieniem kondukcyjnym i właściwym znakiem przyjętej konwencji. `ex25p.cpp` stosuje zespolone warunki PML dla pełnej fali. [Składanie](https://github.com/mfem/mfem/blob/92021c45ce70eba81388a7543528bcec91c5355f/examples/ex22p.cpp) · [PML](https://github.com/mfem/mfem/blob/92021c45ce70eba81388a7543528bcec91c5355f/examples/ex25p.cpp) | Przykłady biblioteki wyjaśniają klocki numeryczne. Terminale ECE, sprzężenie potencjałów, kwalifikacja wysokiego kontrastu i rzeczywiste możliwości wersji MFEM używanej przez Fullmaga wymagają osobnej pracy. |
| **ONELAB / GetDP** | Oficjalne `ECE_full_wave.zip` zawiera między innymi `FullWave_E_ece_SISO.pro`. `ECE_full_wave_E-H_Academic.zip` zawiera przypadek `geo_pro/coax3D.pro` i formulację `FullWave_E_ece_MIMO2terminals_secondOrder.pro`. Nadają się do kontroli zacisków i znaku prądu. [Zbiór przykładów](https://onelab.info/files/) · [Archiwum akademickie](https://onelab.info/files/ECE_full_wave_E-H_Academic.zip) · [Kod GetDP](https://github.com/getdp-project/getdp) | Sprawdzono listy plików obu archiwów. Dostęp do katalogu GitLab wskazanego przez publikację był ograniczony. Nie zidentyfikowano plików A–φ/Darwin dla konkretnego CPW z 2024 r. |
| **BORIS** · `048503d2ca6475e91b073eb1762ecf9d3634c3e1` | Odczytana implementacja stacjonarnego transportu i operatora Oersteda służy do dodatkowych kontroli DC i orientacji. [Transport](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Transport_Charge.cpp) · [Oersted](https://github.com/SerbanL/BORIS/blob/048503d2ca6475e91b073eb1762ecf9d3634c3e1/Boris/Oersted.cpp) | Audyt z 22 listopada wykazał przeciwny znak pola w kontrolowanym jądrze CPU. Jego przewodnictwo DC i Oersted same nie stanowią niezależnej referencji dla harmonik RF. |

Przy tworzeniu przypadku Palace nadaj miedzi własne znaczniki objętości
i ustaw w `Domains.Materials` parametr `Conductivity` w S/m. Przelicz
współrzędne siatki i sond tylko raz zgodnie z `Model.L0`. Wyznacz
prąd przewodzenia z zespolonego pola $E$ wewnątrz metalu, pole $H$ z
próbek $B$, a moc i prądy portów z danych przypisanych do tej samej
płaszczyzny odniesienia. Zachowaj oryginalne bufory wraz z opisem
konwersji. [Schemat konfiguracji Palace](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/scripts/schema/config-schema.json).

Sprawdzone tożsamości archiwów ONELAB w dniu sporządzenia noty.

- `ECE_full_wave.zip` · SHA-256
  `5421035b5e56cc1195a288796070aff14237d615d84d5226c182da2cde0d862f`.
- `ECE_full_wave_E-H_Academic.zip` · SHA-256
  `7c8546993eb018b4018e04ad9976be7a36c3eae7ea4f9cc60470143526e7757a`.

Kod zewnętrzny pozostaje materiałem porównawczym zgodnie z polityką
Fullmaga. Archiwa i przykładowe skrypty stanowią osobne uruchomienia
referencyjne, z identyfikacją wersji, danych i wykonania.

(source-code-index)=
## 9. Indeks kodu i status dowodów

Mapa [źródeł i równań](0952-harmonic-rf-antenna-cpw.source-map.json) oddziela
węzły projektowane od istniejących ścieżek DC. Symbole repozytorium poniżej
odnoszą się do drzewa walidacyjnego Fullmaga `2aa08033d00e3585b5233ecb35e4cac8e6508114`.
Projektowane równania mają własne kotwice dokumentu do czasu połączenia
z implementacją i zweryfikowanymi testami.

| Zastosowanie | Ścieżka | Symbol | Odpowiedzialność i dowód |
| --- | --- | --- | --- |
| Konwencja | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-governing-equations` | Wspólna konwencja fazorów. `planned_contract` |
| Maxwell | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-maxwell-contract` | Pełny Maxwell i odczyt pola. Ciuprina i in. (2022) oraz MFEM. `planned_contract` |
| Terminale | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-ece-contract` | Orientacja, obciążenie i planowany test ONELAB E–V. `planned_contract` |
| Darwin i energia | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-darwin-contract` | Ampère, ciągłość, gauge i bilans mocy. Planowany test ECE. `planned_contract` |
| Skale | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-assumptions-and-validity` | Założenia RF i skale z publikacji. `planned_contract` |
| Obserwable | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-observables-contract` | Prądy, baza zespolona, widmo i udział przy szczelinach. `planned_contract` |
| Bramki | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-validation` | Kontrole analityczne i porównanie ECE oraz CPW. `planned_contract` |
| IR planowany | `docs/physics/0952-harmonic-rf-antenna-cpw.md` | `DOC-ANCHOR:rf-problem-ir` | Przyszły wariant RF i port. `planned_contract` |
| Python | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaFieldSolveStage` | Obniżenie DC i odrzucenie RF, sprawdzone w przykładzie. `executed_object_lowering` |
| Python | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class FieldTarget` | Nośnik celu, sprawdzony w przykładzie. `executed_object_lowering` |
| Python | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaNamedOutput` | Opis wyniku, sprawdzony w przykładzie. `executed_object_lowering` |
| Potok | `packages/fullmag-py/src/fullmag/world.py` | `add_antenna_field_solve` | Rejestracja etapu i referencja autorska. `current_code` |
| IR DC | `crates/fullmag-ir/src/antenna.rs` | `AntennaFieldModelIR` | Istniejący enum fizyki źródła DC. `current_code` |
| IR DC | `crates/fullmag-ir/src/antenna.rs` | `AntennaFieldSolveStageIR` | Kształt IR etapu i powiązania DC. `current_code` |
| Planner | `crates/fullmag-plan/src/antenna_field_solve.rs` | `plan_antenna_field_solve_execution` | Uzgodnienie żądania wykonania i zależności DC. `current_code` |
| FEM CPU DC | `crates/fullmag-runner/src/antenna_field_solution/closed_loop_execution.rs` | `execute_antenna_closed_loop_inspection` | Punkt wejściowy inspekcji pętli DC. Historyczne wyniki mają własne manifesty. `current_code` |
| API zasobów | `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` | `get_antenna_field_solution` | Istniejący zasób v2, punkt przyszłej obsługi manifestu fazorowego. `current_code` |
| Workspace | `apps/control-room/src/kernel/resources/antennaResources.ts` | `useAntennaFieldSolutionResource` | Istniejąca warstwa zasobów UI dla gabarytów i wyników pola. `current_code` |
| Test Python | `packages/fullmag-py/tests/test_antenna_composition_contract.py` | `test_field_solve_projection_and_spectrum_are_typed_thin_references` | Kontrola typowanej kompozycji obecnego etapu, projekcji i widma. `current_test` |
| Referencja CPU | `scripts/rf_fullwave_reference.py` | `class MaxwellSystem` | Referencyjny operator ECE, testy fali, zakładek terminalowych i skali elektrycznej. `reference_fixture_tested` |
| Referencja CPU | `scripts/rf_darwin_reference.py` | `solve_darwin_ece` | Referencyjny operator Darwina, testy kondensatora, energii i obciążenia. `reference_fixture_tested` |
| Referencja CPU | `scripts/rf_cpw_reference.py` | `make_case` | Geometria przewodnika, materiały i terminale CPW z kontrolą orientacji. `reference_fixture_tested` |
| Referencja CPU | `scripts/rf_palace_preflight.py` | `write_case` | Wejścia Palace i test Gmsh meshio round-trip, przed wykonaniem referencji. `reference_fixture_tested` |
| Referencja CPU | `scripts/compare_rf_cpw_reference.py` | `compare` | Zespolone porównanie wspólnego portu ECE i odrzucanie niespójnych wejść. `reference_fixture_tested` |
