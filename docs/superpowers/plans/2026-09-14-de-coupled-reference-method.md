# Referencja sprzężonej dyspersji DE dla filmu Py 100 nm

Status: pomocniczy, interpretowany model Galerkina do diagnostyki. Nie jest
to solver FEM ani dowód kwalifikacji runtime. Implementacja znajduje się w
`scripts/de100_coupled_reference_diagnostic.py`.

## Zakres i parametry

Rozważany jest nieskończony w kierunkach bocznych film z
$\mathbf M_0=M_s\hat{x}$ i falą w kierunku $y$, bez DMI, tłumienia,
anizotropii powierzchniowej i pinningu wymiany. Grubość filmu wynosi
$t=100\,\mathrm{nm}$, a potencjał magnetostatyczny ma Dirichleta na
zewnętrznych płaszczyznach airboxu. Współrzędna grubości jest
$x=z/t$, film zajmuje $[-1/2,1/2]$, a airbox $[-h,h]$, gdzie
$h=20.5$ odpowiada paddingowi $2\,\mu\mathrm m$ z każdej strony.

| Symbol | Znaczenie | Wartość/jednostka |
|---|---|---|
| $t$ | grubość filmu | $100\,\mathrm{nm}$ |
| $M_s$ | magnetyzacja nasycenia | $8\times10^5\,\mathrm{A\,m^{-1}}$ |
| $A$ | stała wymiany | $13\times10^{-12}\,\mathrm{J\,m^{-1}}$ |
| $B_0$ | zewnętrzna indukcja wzdłuż (x) | $0.1\,\mathrm T$ |
| $\gamma_0$ | (μ_0γ) | $2.211\times10^5\,\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $k$ | podpisany wektor falowy wzdłuż (y) | $\mathrm{rad\,m^{-1}}$ |
| $\kappa=kt$, $q=|\kappa|$ | zmienne bezwymiarowe | wyliczane z $k$ |
| $h$ | połowa airboxu w jednostkach (t) | $20.5$ |

Używane skale to

```{math}
:label: eq-de100-reference-scales
\ell_{\mathrm{ex}}^2=\frac{2A}{\mu_0M_s^2},
\qquad
\frac{\ell_{\mathrm{ex}}^2}{t^2}=\texttt{lex2},
\qquad
\Omega_H=\frac{B_0}{\mu_0M_s}=\texttt{field},
\qquad
f=\frac{\gamma_0M_s}{2\pi}\Omega.
```

Dla tego przypadku $\ell_{\mathrm{ex}}=5.6858\,\mathrm{nm}$,
$t/\ell_{\mathrm{ex}}=17.5877$, a zakres
$|k|\le40\times10^6\,\mathrm{rad\,m^{-1}}$ daje
$|\kappa|\le4$.

## Konwencja fazowa i demagnetyzacja

Skrypt liczy z konwencją

```{math}
:label: eq-de100-reference-convention
\widetilde{\mathbf m}(y,z,t)
 =\mathbf m(z)\exp(-i\omega t+i k y),
\qquad \mathbf h_d=-\nabla\phi.
```

Wtedy źródło dodatniego operatora
$L_q=-\partial_x^2+q^2$ ma postać
$S=-\nabla\cdot\mathbf m=-i\kappa m_y-\partial_xm_z$.
Po całkowaniu przez części część $m_z$ zawiera również ładunki
powierzchniowe wynikające z przedłużenia magnetyzacji zerem poza filmem.

Dirichletowy Green na $[-h,h]$ jest

```{math}
:label: eq-de100-reference-green
G_q^D(x,x')=
\frac{\sinh[q(x_<+h)]\sinh[q(h-x_>)]}
     {q\sinh(2qh)},
\qquad q>0,
```

gdzie $x_<=\min(x,x')$, $x_>=\max(x,x')$. Dla $q=0$ kod używa
regularnej granicy

```{math}
:label: eq-de100-reference-green-zero
G_0^D(x,x')=\frac{(x_<+h)(h-x_>)}{2h}.
```

W bazie Neumanna
$b_n(x)=\{1,\sqrt2\cos[n\pi(x+1/2)]\}$ bloki demagnetyzacji są

```{math}
:label: eq-de100-reference-demag-blocks
D_{yy}=q^2 B^\mathsf T G_q^D B,
\qquad
D_{yz}=+i\kappa B^\mathsf T(\partial_{x'}G_q^D)B,
\qquad
D_{zz}=I+B^\mathsf T K_{\mathrm{reg}}B,
```

gdzie

```{math}
:label: eq-de100-reference-delta
K_{\mathrm{reg}}(x,x')=
-\frac{q\cosh[q(x_<+h)]\cosh[q(h-x_>)]}{\sinh(2qh)},
\qquad
\partial_x\partial_{x'}G_q^D=\delta(x-x')+K_{\mathrm{reg}}.
```

Człon $I$ w $D_{zz}$ jest zatem dystrybucyjnym członem delta, a nie
dodatkowym przybliżeniem. Przy $q=0$ daje dla modu jednorodnego

```{math}
:label: eq-de100-reference-nz
N_z=1-\frac{1}{2h}=\frac{40}{41}=0.9756097561.
```

Konwencja Fullmag jest sprzężona:
$\exp(+i\omega t-i k y)$. Wymaga ona zmiany znaku zarówno w bloku
$D_{yz}$, jak i w operatorze czasowym. Zmienność widma nie rozstrzyga
tego znaku; profile muszą być sprzężone zespolenie i porównywane po
wyrównaniu fazy.

## Dyskretny operator i mody

Lokalny blok wymiany i pola jest diagonalny:

```{math}
:label: eq-de100-reference-local
K_{\mathrm{loc},nn}=\Omega_H+
\frac{\ell_{\mathrm{ex}}^2}{t^2}
\left(\kappa^2+n^2\pi^2\right),
\qquad
K=\begin{bmatrix}
K_{\mathrm{loc}}+D_{yy}&D_{yz}\\
D_{yz}^{\mathsf H}&K_{\mathrm{loc}}+D_{zz}
\end{bmatrix}.
```

Macierz $K$ jest sprawdzana jako hermitowska i dodatnio określona.
Po rozkładzie $K=U\operatorname{diag}(\lambda)U^\mathsf H$ kod buduje
$\sqrt K$ oraz $K^{-1/2}$. Dla

```{math}
:label: eq-de100-reference-modal
J=\begin{bmatrix}0&-I\\I&0\end{bmatrix},
\qquad
H_{\mathrm{modal}}=+i\sqrt KJ\sqrt K,
```

rozwiązywane są dodatnie pierwiastki $\Omega$. Wektor własny $u$ z
przestrzeni przeskalowanej jest odwzorowywany do fizycznych współczynników

```{math}
:label: eq-de100-reference-backtransform
m=K^{-1/2}u,
\qquad
m=(m_y,m_z),
```

a następnie normalizowany w normie $L^2$. Dla każdego modu sprawdzany jest
oryginalny residual LL

```{math}
:label: eq-de100-reference-residual
r=\frac{\|iJKm-\Omega m\|_2}
        {\max(\|iJKm\|_2,\|\Omega m\|_2)},
```

z odpowiednią zmianą znaku $i$ dla konwencji sprzężonej. Oczekiwanych jest
dokładnie $N$ dodatnich i $N$ ujemnych pierwiastków.

## Zakres kontroli

`N=1` oznacza wyłącznie bazę $n=0$, więc jest kontrolą diagonalnego KS
$n=0$, a nie izolowanego KS $n=1$. Przy $k=0$ drugi mod pełnej bazy
redukuje się do znanego $n=1$, ponieważ sprzężenia parzystości znikają.
Przy niezerowym $k$ różnice względem KS są oczekiwanym skutkiem sprzężenia
modów.

Testy w
`scripts/test_de100_coupled_reference_diagnostic.py` sprawdzają: wartość
Γ i pierwszy mod grubości przy $k=0$, zgodność `N=1` z otwartym KS
(n=0) przy $20$ i $40\,\mathrm{Mrad\,m^{-1}}$, normalizację i residual
LL, reciprocity $f(k)=f(-k)$, oraz zmianę znaku sprzężenia i zespolenie
profili przy przejściu między konwencjami.

## Ograniczenia

Model jest diagnostycznym Galerkinem z dokładnym w kierunku $z$ jądrem
Dirichleta, ale nie zastępuje pełnego 6×6 shooting/full-BC. Nie zawiera
automatycznego śledzenia profilu DE przez avoided crossings ani zbieżności
względem paddingu i siatki FEM. Wyniki nie są kwalifikacją żadnej ścieżki
FDM/FEM CPU/GPU.

## Źródła i mapowanie implementacji

- Harms i Duine, *Theory of the dipole-exchange spin wave spectrum in
  ferromagnetic films with in-plane magnetization revisited*,
  [arXiv:2109.10597v2](https://arxiv.org/html/2109.10597v2), pełne sprzężenie
  modów i warunki magnetostatyczne.
- `_assemble_stiffness`: `scripts/de100_coupled_reference_diagnostic.py` —
  Green, bloki $D_{yy},D_{yz},D_{zz}$, wymiana i Zeeman.
- `_factor_stiffness` oraz `_positive_modes`: ten sam plik — kontrola
  hermitowskości, dodatniości, pierwiastków, transformacja $K^{-1/2}$ i
  residual LL.
- `De100CoupledReferenceTests`: `scripts/test_de100_coupled_reference_diagnostic.py`.
