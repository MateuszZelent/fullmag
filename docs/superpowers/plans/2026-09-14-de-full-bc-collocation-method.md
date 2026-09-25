# Niezależna referencja DE z pełnymi warunkami brzegowymi

Status: pomocnicza, interpretowana diagnostyka kolokacji Czebyszewa. Ten
artefakt nie jest solverem FEM, produkcyjną ścieżką Fullmag ani dowodem
kwalifikacji runtime. Jego celem jest niezależne sprawdzenie równań
LL--Poissona i warunków brzegowych względem referencji Galerkina.

## 1. Problem i zakres

Rozważany jest jednorodny film Py o grubości $t=100\,\mathrm{nm}$,
magnetyzowany wzdłuż osi $x$, z falą płaską w kierunku $y$. Film zajmuje
bezwymiarowy przedział $x=z/t\in[-1/2,1/2]$. Po obu stronach znajduje się
warstwa powietrza o grubości $20t$ zakończona potencjałem Dirichleta. Nie ma
DMI, tłumienia, anizotropii powierzchniowej ani pinningu wymiany.

| Symbol | Znaczenie | Wartość/jednostka |
|---|---|---|
| $t$ | grubość filmu | $100\,\mathrm{nm}$ |
| $M_s$ | magnetyzacja nasycenia | $8\times10^5\,\mathrm{A\,m^{-1}}$ |
| $A$ | stała wymiany | $13\times10^{-12}\,\mathrm{J\,m^{-1}}$ |
| $B_0$ | indukcja pola wzdłuż $x$ | $0.1\,\mathrm T$ |
| $\gamma_0$ | współczynnik w konwencji $\gamma_0=\mu_0\gamma$ | $2.211\times10^5\,\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $k$ | podpisany wektor falowy wzdłuż $y$ | $\mathrm{rad\,m^{-1}}$ |
| $\kappa=kt$ | wektor falowy bezwymiarowy | bez jednostki |
| $q=|\kappa|$ | moduł wektora falowego | bez jednostki |
| $d$ | grubość warstwy powietrza w jednostkach $t$ | $20$ |

Używane skale to

```{math}
:label: eq-de100-collocation-scales
\ell_{\mathrm{ex}}^2=\frac{2A}{\mu_0M_s^2},\qquad
\ell_2=\frac{\ell_{\mathrm{ex}}^2}{t^2},\qquad
\Omega_H=\frac{B_0}{\mu_0M_s},\qquad
f=\frac{\gamma_0M_s}{2\pi}\Omega.
```

## 2. Konwencja fazy i równania

Skrypt używa

```{math}
:label: eq-de100-collocation-phasor
 m_y=i u(x)\exp(i k y-i\omega t),\qquad
 m_z=v(x)\exp(i k y-i\omega t),\qquad
 \phi=M_s t\,\psi(x)\exp(i k y-i\omega t).
```

Przy $a=\Omega_H+\ell_2q^2$ otrzymuje się układ bezwymiarowy

```{math}
:label: eq-de100-collocation-bulk
\ell_2 u''-a u-\kappa\psi=\Omega v,
\qquad
\ell_2 v''-a v-\psi'=\Omega u,
\qquad
\psi''-q^2\psi+\kappa u-v'=0.
```

Pierwsze dwa równania są liniowym LL dla składowych poprzecznych. Trzecie
jest równaniem magnetostatycznym dla potencjału skalara. Zapis $m_y=i u$
jest częścią konwencji, dlatego znaki sprzężenia z $\kappa\psi$ muszą być
kontrolowane razem z fazą, a nie przez samo uporządkowanie częstotliwości.

## 3. Pełne warunki brzegowe

Na obu powierzchniach filmu obowiązują naturalne warunki wymiany

```{math}
:label: eq-de100-collocation-exchange-bc
u'(-1/2)=u'(+1/2)=0,\qquad
v'(-1/2)=v'(+1/2)=0.
```

Eliminacja rozwiązania Laplace'a w warstwie powietrza z warunkiem
$\psi=0$ na jej zewnętrznej granicy daje

```{math}
:label: eq-de100-collocation-air-eta
\eta(q)=q\coth(qd),\qquad
\eta(0)=d^{-1}=0.05.
```

Przy węzłach uporządkowanych od góry do dołu, czyli od $x=+1/2$ do
$x=-1/2$, warunki potencjału są

```{math}
:label: eq-de100-collocation-magnetostatic-bc
\psi'(+1/2)+\eta\psi(+1/2)-v(+1/2)=0,
```

```{math}
\psi'(-1/2)-\eta\psi(-1/2)-v(-1/2)=0.
```

Dla $q=0$ dają one $N_z=1/(1+1/(2d))=40/41$, więc jednorodny mod ma
$f=9.2059719924\,\mathrm{GHz}$ przy zadanym finite airbox.

## 4. Kolokacja i uogólniony pencil

Dla stopnia $n$ skrypt używa węzłów Lobatto

```{math}
:label: eq-de100-collocation-grid
\xi_j=\cos\frac{j\pi}{n},\qquad x_j=\frac{\xi_j}{2},\qquad
D=2D_{[-1,1]},\qquad D_2=D^2.
```

W kolejności zmiennych $Z=(u,v,\psi)^\mathsf T$ równania objętościowe są
zapisywane jako $LZ=\Omega BZ$:

```{math}
:label: eq-de100-collocation-pencil
L=\begin{bmatrix}
\ell_2D_2-aI&0&-\kappa I\\
0&\ell_2D_2-aI&-D\\
\kappa I&-D&D_2-q^2I
\end{bmatrix},\qquad
B=\begin{bmatrix}
0&I&0\\
I&0&0\\
0&0&0
\end{bmatrix}.
```

Sześć wierszy końcowych jest zastępowanych odpowiednio przez $u'=0$,
$v'=0$ oraz dwa równania magnetostatyczne; w tych wierszach macierz $B$
jest zerowana. To jest jawna realizacja wszystkich BC, a nie kara lub
przybliżony warunek na potencjale.

## 5. Osobliwość pencil, wybór modów i residual

Macierz $B$ jest osobliwa. Wywołanie `scipy.linalg.eig` w formie
jednorodnej zwraca pary $(\alpha_j,\beta_j)$ reprezentujące
$\Omega_j=\alpha_j/\beta_j$. Skrypt zachowuje tę reprezentację do
klasyfikacji:

- `finite`: $|\beta_j|$ przekracza tolerancję względną;
- `infinite`: $|\beta_j|$ jest małe, ale $|\alpha_j|$ nie jest małe;
- `algebraic`: oba współczynniki są małe;
- z finite odrzucane są pierwiastki z istotną częścią urojoną i wybierane są
  dodatnie rzeczywiste $\Omega$.

Wartości nie są dzielone przez małe $\beta$ przed klasyfikacją, więc
artefakt nieskończony nie staje się fałszywą bardzo dużą częstotliwością.
Residual dla każdego zachowanego wektora $Z$ jest liczony z pełnego pencil:

```{math}
:label: eq-de100-collocation-residual
r=\frac{\|LZ-\Omega BZ\|_2}
        {\max(\|LZ\|_2,\|\Omega BZ\|_2)}.
```

Profile $u$, $v$ i $\psi$ są skalowane tak, aby norma euklidesowa nodalnych
składowych magnetycznych $(iu,v)$ wynosiła jeden. Jest to normalizacja
diagnostyczna kolokacji; nie zastępuje normy masowej FEM ani normalizacji
Galerkinowskiej z całkowaniem.

## 6. Wyniki kontrolne

Uruchomienie `python scripts/de100_full_bc_collocation_diagnostic.py` dało:

| $n$ | $k$ [Mrad/m] | pierwsze trzy $f$ [GHz] | finite / infinite / algebraic |
|---:|---:|---|---:|
| 32 | 0 | 9.2059719924, 10.8533855113, 14.8609413322 | 62 / 37 / 0 |
| 48 | 0 | 9.2059719924, 10.8533855113, 14.8609413322 | 94 / 53 / 0 |
| 64 | 0 | 9.2059719923, 10.8533855113, 14.8609413322 | 126 / 69 / 0 |
| 32 | 20 | 11.2321529865, 15.2050320243, 17.4347599683 | 62 / 37 / 0 |
| 48 | 20 | 11.2321529865, 15.2050320243, 17.4347599684 | 94 / 53 / 0 |
| 64 | 20 | 11.2321529867, 15.2050320235, 17.4347599717 | 126 / 69 / 0 |
| 32 | 40 | 12.6748034310, 16.1487489401, 19.0876135284 | 62 / 37 / 0 |
| 48 | 40 | 12.6748034320, 16.1487489401, 19.0876135284 | 94 / 53 / 0 |
| 64 | 40 | 12.6748034312, 16.1487489401, 19.0876135287 | 126 / 69 / 0 |

W badanym zakresie wszystkie zachowane finite roots były rzeczywiste; liczba
ujemnych była równa liczbie dodatnich. Maksymalny zaobserwowany residual
dodatnich korzeni wynosił około $10^{-9}$ dla $n=64$. Rozstęp pierwszych
trzech gałęzi między $n=32,48,64$ był mniejszy niż
$4\times10^{-9}\,\mathrm{GHz}$ dla tych trzech punktów $k$.

W punkcie $k=20\,\mathrm{Mrad\,m^{-1}}$ różnica pierwszych trzech wartości
względem referencji Galerkina $N=24$, $Q=1280$ wyniosła odpowiednio około
$2.7\times10^{-5}$, $3.0\times10^{-5}$ i $4.5\times10^{-6}$ GHz. Jest to
zgodność niezależnych metod dla tego eksperymentu, nie dowód poprawności
FEM.

W dodatkowej, ograniczonej kontroli profili wykonanej na 256-punktowej
kwadraturze Gaussa po interpolacji barycentrycznej minimalny moduł overlapu
między pierwszymi trzema profilami kolokacji i Galerkina wyniósł
$0.9999999873943459$. Największa różnica częstotliwości w tej próbie wyniosła
$68.98699456\,\mathrm{kHz}$ (drugi mod, indeks 1, przy $k=40\,\mathrm{Mrad\,m^{-1}}$),
a maksymalny residual kolokacji wyniósł $2.3844\times10^{-10}$. To bounded
cross-check profili, nie niezależna certyfikacja FEM ani dowód poprawności
każdej gałęzi poza badanym zakresem.

## 7. Kontrole znaków i testy

`test_de100_full_bc_collocation_diagnostic.py` zawiera pięć lekkich testów
interpretowanych:

1. różniczkowanie wielomianów przez macierz Czebyszewa oraz jawne znaki
   bloków $\kappa$ i wszystkich sześciu BC;
2. zgodność $k=0$ z wartościami $\Gamma_0$, $n=1$ i trzeciego modu;
3. zgodność $k=20\,\mathrm{Mrad\,m^{-1}}$ oraz reciprocity $f(k)=f(-k)$;
4. pełne rozliczenie finite/infinite/algebraic roots i residuale;
5. zbieżność dla $n=32,48,64$ oraz back-transform profili magnetycznych.

Ostatni test nie traktuje samej symetrii widma jako dowodu znaku. Znaki są
sprawdzane bezpośrednio w macierzy i w residualu równań o konwencji
$\exp(i k y-i\omega t)$. Przejście do konwencji Fullmag wymaga sprzężenia
profili i odpowiedniej zmiany znaków fazowych.

## 8. Interpretacja backendowa i granice

Skrypt jest odrębną referencją naukową. Nie dodaje obiektu do publicznego
Python API, `ProblemIR`, capability matrix, planera, sesji ani artefaktów
runtime. FDM może użyć go jako testu porównawczego, a FEM jako niezależnego
cross-checku po uruchomieniu właściwego solvera; żadna z tych ścieżek nie jest
przez ten plik implementowana ani automatycznie kwalifikowana.

Metoda ma następujące ograniczenia:

- jest kolokacją różniczkowego układu 1D, a nie shootingiem 6×6 ani solverem
  FEM;
- `eta(q)` zakłada jednorodną warstwę powietrza i dokładnie narzucony
  potencjał Dirichleta na jej zewnętrznej granicy;
- nie ma automatycznego śledzenia gałęzi przez avoided crossings;
- nie przeprowadzono jeszcze osobnego skanu grubości airboxu, precyzji ani
  zbieżności względem niezależnego shooting/full-BC;
- liczba infinite roots jest własnością osobliwego dyskretnego pencil i nie
  może być interpretowana jako fizyczne mody.

Następnym krokiem walidacji może być porównanie profili i częstotliwości z
niezależnym shootingiem oraz z FEM dla identycznych $t$, $d$, materiału,
konwencji fazy i normalizacji. Do tego czasu wynik ma status
`DIAGNOSTIC_ONLY / NOT VERIFIED`.

## 9. Mapowanie implementacji

- `scripts/de100_full_bc_collocation_diagnostic.py` — siatka, operator
  $L$, macierz $B$, sześć BC, klasyfikacja pierwiastków, profile i residuale;
- `scripts/test_de100_full_bc_collocation_diagnostic.py` — pięć testów
  interpretowanych opisanych wyżej;
- referencja źródłowa: Harms i Duine, *Theory of the dipole-exchange spin
  wave spectrum for ferromagnetic films with in-plane magnetization
  revisited*, [arXiv:2109.10597v2](https://arxiv.org/html/2109.10597v2).

### Dalsza zbieżność Galerkina względem kolokacji

Dla k=40 Mrad/m zwiększenie bazy i kwadratury zmniejsza różnicę
częstotliwości pierwszych trzech modów. Różnice w kHz:

| N | Q | mod 0 | mod 1 | mod 2 |
|---:|---:|---:|---:|---:|
| 16 | 640 | 220.811 | 348.773 | 149.426 |
| 24 | 1280 | 30.475 | 68.987 | 30.396 |
| 24 | 2560 | 27.596 | 34.321 | 14.084 |
| 32 | 2560 | 7.168 | 17.059 | 7.529 |
| 48 | 2560 | 1.758 | 12.294 | 5.719 |

Ograniczenie bazy i całkowanie wpływają niezależnie na błąd diagnostyki
Galerkinowskiej. Nie należy traktować różnicy dla N=24,Q=1280 jako
nieusuwalnego błędu fizycznego ani jako tolerancji akceptacji FEM.
