# Audyt fizyki solverów Fullmag FDM / FEM

Data: 2026-09-08. Checkout: `C:/git/fullmag/fullmag`. Punkt odniesienia Git: `6cc5e5e0396050f5f859a0e2b28dd3f963d3f7bb`.

Czytanie raportu: najważniejsze problemy i wyprowadzenia znajdują się na początku. Szczegółowe części są dalej w tym samym pliku: [FDM](#audit-fdm), [FEM](#audit-fem), [dynamika i transport](#audit-dynamics), [Python/IR i capability](#audit-dsl). Osobny JSON zawiera inwentarz i fingerprint źródeł.

## Cel, zakres i znaczenie wyniku

Raport sprawdza, czy opisane oddziaływania mają spójne równania, dyskretyzację, implementację, ścieżkę uruchomienia i dowody weryfikacji. Rozróżnia FDM CPU, FDM GPU, FEM CPU i FEM GPU. Obejmuje również integrację LLG, relaksację, transport spinowy i ładunkowy, pole Oersteda, termikę, mody własne oraz obserwable energii. Jest audytem kodu, wyprowadzeń i istniejących kontraktów, z wykonanymi lekkimi testami. Nie jest certyfikatem wszystkich kombinacji parametrów ani nową kampanią symulacji.

**Nie ma podstaw do stwierdzenia, że wszystkie oddziaływania są w całości poprawnie wdrożone i zwalidowane we wszystkich czterech realizacjach.** Istnieją zarówno rzeczywiste niespójności, jak i celowo odrzucane kombinacje oraz brakujące dowody. Te trzy sytuacje wymagają różnych działań. W szczególności błąd mapy energii nie oznacza automatycznie błędu pola używanego przez LLG, a brak kwalifikacji nie dowodzi, że równanie jest błędne.

W fazie odczytowej audytu nie zmieniano implementacji solverów, parametrów benchmarków, istniejących instrukcji ani konfiguracji runtime. Potwierdzone defekty poprawiono później; ich bieżący stan i dowody zawiera [addendum remediacji](#addendum-remediacji--2026-09-08). Zmieniony przez inne zadania checkout zachowano. Początkowe modyfikacje dotyczyły viewportu, dokumentów planu optymalizacji FEM i submodułów solverów zewnętrznych; nie wykorzystano zmienionych submodułów jako źródła dowodu poprawności Fullmag.

### Poziomy dowodów

| Oznaczenie | Co rzeczywiście oznacza |
|---|---|
| **POTWIERDZONE — źródła** | Bieżący kod i jego wywołania potwierdzają daną właściwość; wskazano plik i symbol. |
| **POTWIERDZONE — algebra** | Wyprowadzenie lub kontrprzykład pokazuje zgodność albo sprzeczność pod jawnymi założeniami; nie jest pomiarem backendu. |
| **TEST PASS** | W tym audycie wykonano podaną komendę z wynikiem pozytywnym. Zakres testu pozostaje ograniczony. |
| **HIPOTEZA / RYZYKO** | Istnieje podejrzany mechanizm, ale brakuje dowodu pozwalającego nazwać go potwierdzonym błędem. |
| **UNSUPPORTED** | Kombinacja jest jawnie odrzucana; nie należy opisywać jej jako działającego oddziaływania. |
| **NOT VERIFIED** | Brakuje aktualnego dowodu wykonania, parytetu, zbieżności lub kwalifikacji wskazanej realizacji. |

Priorytet P1 oznacza wynik mogący zmieniać interpretację fizyczną albo przyjmowanie problemu; P2 oznacza ograniczenie obserwabli, przenośności weryfikacji lub kontroli dokumentacji. Priorytet nie zastępuje oceny zasięgu: defekt ścieżki referencyjnej nie jest przypisywany automatycznie produkcyjnemu FEM.

### Tożsamość materiału audytowego

Inwentaryzacja objęła **145 plików Markdown w `docs/physics/`**. Sprawdzono wszystkie **43 istniejące mapy źródeł** w tym drzewie za pomocą repozytoryjnego `validate_page`. Wynik: **34 PASS i 9 FAIL**. Brak mapy przy pozostałych 102 plikach nie jest automatycznie naruszeniem kontraktu: część to indeksy, stare noty lub plany. Nie oznacza jednak, że te pliki przeszły walidację mapowania do kodu.

Zapisano SHA-256 **1625 plików** z drzew backendów, silnika referencyjnego, plannera, IR, runnera, Python DSL i not fizycznych. SHA-256 uporządkowanego zestawu ścieżka→hash:

`269ce0d7a4e0336c68aa498e0365f54a87b96830ecc8ddcc935d2f7f4f20ac90`.

Pełny spis, hashe i błędy walidacji zawiera [pakiet dowodowy JSON](2026-09-08-physics-evidence.json). Ten fingerprint identyfikuje odczytane źródła, **nie** jest manifestem zbudowanego runtime ani kwalifikującym receipt.

Przegląd semantyczny koncentrował się na operatorach, ich wywołaniach, lowering i testach opisanych niżej. Inwentaryzacja całego drzewa nie jest deklaracją ręcznego sprawdzenia każdej linii wszystkich plików. Dla niewykonanych ścieżek runtime pozostaje jawne `NOT VERIFIED`.

## Najważniejsze ustalenia do decyzji

| ID | Obszar | Wniosek i wpływ | Pewność |
|---|---|---|---|
| OBS-01 | FEM CPU/GPU, mapa energii | `Ku2` daje dwukrotnie zły wkład w rekonstrukcji `eden_ani`; globalna energia natywna jest liczona osobno | źródła + algebra |
| OBS-02 | FDM GPU, energia pola zewnętrznego | statyczna mapa może działać w LLG, a znikać z energii; pola regionalne są pomijane w mapach energii | źródła, bez nowego wykonania CUDA |
| OBS-03 | FDM GPU, częściowe komórki | miara całki mapy energii nie zgadza się z wagą skalaru | źródła + algebra |
| OBS-04 | FEM, energia obiektów | podział globalnej sumy wagami węzłów nie daje lokalnej energii obiektu | źródła + kontrprzykład |
| OBS-05 | FEM, początkowe skalary live | żądanie samych skalarów może opublikować `StepStats::default()` | przepływ źródeł; runtime NOT VERIFIED |
| DOC-03 | publiczny Python | docstring `UniaxialAnisotropy` używa konwencji sinusowej niezgodnej z loweringiem `Ku2` | źródła + algebra |
| DOC-01/02 | kontrola dokumentacji | bramka pomija nowe drzewa backendów, 9 map źródeł wymaga naprawy lub wyjaśnienia matchera | wykonane kontrole |
| VAL-01/02 | kwalifikacja | 9 wpisów LLG nadal `unvalidated`; 16 testów FDM blokuje obsługa ścieżek Windows | odczyt rejestru + testy |

Dalsze części rozdzielają zaakceptowane modele, jawne odmowy plannera i brak implementacji. Każde zalecenie naprawy w tym dokumencie jest wynikiem audytu, a nie wykonaną zmianą solvera.

## Podstawa matematyczna audytu

Poniższe równania są kryteriami porównania implementacji. Nie zastępują kanonicznych not poszczególnych oddziaływań. Wyprowadzenia są własną analizą wariacyjną wskazanych funkcjonałów; źródła literaturowe podano przy modelach i w bibliografii.

### Symbole i jednostki

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m=\mathbf M/M_s$ | kierunek zredukowanej magnetyzacji w materiale magnetycznym | $1$ |
| $M_s,\mathbf M,\mathbf H$ | nasycenie, magnetyzacja, pole magnetyczne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{app}}=\mu_0\mathbf H_{\mathrm{app}}$ | zadane pole w konwencji indukcji używanej przez API; nie ogólne $\mathbf B$ wewnątrz magnesu | $\mathrm T$ |
| $\mu_0$ | przenikalność próżni przyjęta w solverze | $\mathrm{N\,A^{-2}}$ |
| $E,w$ | energia i jej gęstość objętościowa | $\mathrm J$, $\mathrm{J\,m^{-3}}$ |
| $A$ | sztywność wymiany | $\mathrm{J\,m^{-1}}$ |
| $K_{u1},K_{u2},K_{c1},K_{c2},K_{c3}$ | współczynniki anizotropii | $\mathrm{J\,m^{-3}}$ |
| $D$ | współczynnik gradientowego DMI w konwencji objętościowej not Fullmag | $\mathrm{J\,m^{-2}}$ |
| $\gamma_H=\mu_0|\gamma_e|$ | dodatnia stała precesji dla pola $\mathbf H$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | tłumienie Gilberta | $1$ |
| $t,\Delta t$ | czas fizyczny i krok czasu | $\mathrm s$ |
| $\boldsymbol\tau$ | już rozwiązany wkład do $d\mathbf m/dt$ | $\mathrm{s^{-1}}$ |
| $\Omega_m,\Omega,\partial\Omega$ | obszar magnetyczny, domena potencjału, jej brzeg | miary $\mathrm{m^3}$, $\mathrm{m^2}$ |
| $dV,dS,\mathbf n$ | element objętości, powierzchni i jednostkowa normalna | $\mathrm{m^3}$, $\mathrm{m^2}$, $1$ |
| $\varphi_i,V_i,V_c$ | udział magnetyczny komórki, objętość magnetyczna, pełna objętość komórki | $1$, $\mathrm{m^3}$, $\mathrm{m^3}$ |
| $N_i,\mathbf v$ | funkcja bazowa FEM i wariacja/test magnetyzacji | $1$ |
| $\mathsf K,\mathsf W$ | macierz sztywności wymiany i macierz masy ważona $M_s$ | $\mathrm J$, $\mathrm{A\,m^2}$ |
| $u,v,\beta$ | potencjał magnetostatyczny, funkcja testowa potencjału, współczynnik Robina | $\mathrm A$, $\mathrm A$ w zapisie wymiarowym, $\mathrm{m^{-1}}$ |
| $\mathbf a,q=\mathbf m\cdot\mathbf a$ | jednostkowa oś anizotropii i rzut magnetyzacji | $1$ |
| $\epsilon$ | bezwymiarowa amplituda perturbacji kierunkowej | $1$ |

### Pole oddziaływań konserwatywnych musi pochodzić z tej samej energii co obserwable i minimizer

W tej tożsamości $\mathbf H_{\mathrm{eff}}$ oznacza sumę rozpatrywanych pól konserwatywnych. Nie przypisujemy przez nią funkcjonału energii losowemu szumowi ani dowolnemu torque transportowemu; ich wkład do bilansu wymaga osobnego modelu.

```{math}
:label: audit-functional-field
\delta E[\mathbf m;\mathbf v]
=-\mu_0\int_{\Omega_m} M_s\,\mathbf H_{\mathrm{eff}}\cdot\mathbf v\,dV.
```

Dla więzu $|\mathbf m|=1$ istotna jest część styczna pola: dodanie wielokrotności $\mathbf m$ nie zmienia momentu LLG. Nie usprawiedliwia to jednak dowolnej zmiany raportowanej energii.

W FDM sprawdzenie dyskretne wymaga **tych samych objętości komórek**, masek, parametrów i reguł brzegowych:

```{math}
:label: audit-directional-derivative
\frac{E(\mathbf m+\epsilon\mathbf v)-E(\mathbf m-\epsilon\mathbf v)}{2\epsilon}
\simeq -\mu_0\sum_i M_{s,i}V_i\,\mathbf H_i\cdot\mathbf v_i,
\qquad V_i=\varphi_i V_c.
```

Jeżeli test normalizuje perturbacje, musi porównywać pochodną po odpowiedniej krzywej na sferze. Bezwarunkowe normalizowanie wejścia podczas testu swobodnej pochodnej zmienia testowany funkcjonał. Jedna wartość $\epsilon$ nie wystarcza: należy znaleźć zakres zbieżności przed dominacją odejmowania bliskich liczb.

### LLG i bilans energii

```{math}
:label: audit-llg
\frac{d\mathbf m}{dt}
=-\frac{\gamma_H}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}})\right]
+\boldsymbol\tau.
```

To jest konwencja pola w $\mathrm{A/m}$. Użycie $\gamma_e$ z takim polem bez $\mu_0$ zmienia skalę czasu. Dla dodatniego $\alpha$, pola pochodzącego z energii i braku wymuszeń zależnych od czasu oraz torque:

```{math}
:label: audit-llg-dissipation
\frac{dE}{dt}
=-\mu_0\int_{\Omega_m}
\frac{M_s\gamma_H\alpha}{1+\alpha^2}
\left|\mathbf m\times\mathbf H_{\mathrm{eff}}\right|^2dV\leq0.
```

Wniosek wynika z $\mathbf H\cdot[\mathbf m\times\mathbf H]=0$ oraz $\mathbf H\cdot[\mathbf m\times(\mathbf m\times\mathbf H)]=-|\mathbf m\times\mathbf H|^2$. Wymuszane, termiczne lub transportowe LLG nie musi spełniać monotoniczności energii konserwatywnej. Zbieżność relaksacji wymaga osobno kryterium momentu/gradientu i jawnego powodu zakończenia; skończenie budżetu kroków nie jest minimum.

Źródło kontraktu: `docs/physics/llg_conventions.md`, rozdziały Equation, Gamma Convention i Validation Status. Właściciel realizacji FEM: `backends/fem/cpu/mfem/integrators/llg_rhs.cpp`. Szczegóły wszystkich integratorów i torque znajdują się w części audytu dynamiki.

### Wymiana: pochodna, warunek brzegowy i masa FEM

```{math}
:label: audit-exchange-variation
E_{\mathrm{ex}}=\int_{\Omega_m}A|\nabla\mathbf m|^2dV,
\qquad
\delta E_{\mathrm{ex}}=2\int_{\Omega_m}A\nabla\mathbf m:\nabla\mathbf v\,dV.
```

Całkowanie przez części daje w objętości $\mathbf H_{\mathrm{ex}}=2\nabla\cdot(A\nabla\mathbf m)/(\mu_0M_s)$ i składnik brzegowy $2A\partial_n\mathbf m$. Zastąpienie operatora przez $2A\Delta\mathbf m/(\mu_0M_s)$ wymaga stałego $A$ w rozważanym obszarze. Na idealnie zespolonym interfejsie niejednorodnego materiału trzeba zachować strumień wymienny; dla niezależnych magnesów i jawnego sprzężenia interfejsowego obowiązuje inny model.

Po dyskretyzacji $\mathbf m_h=\sum_iN_i\mathbf m_i$:

```{math}
:label: audit-fem-exchange
K_{ij}=\int_{\Omega_m}A\nabla N_i\cdot\nabla N_j\,dV,
\quad W_{ij}=\int_{\Omega_m}M_sN_iN_j\,dV,
\quad \mu_0\mathsf W\mathbf h=-2\mathsf K\mathbf m.
```

Przy lumpingu $W_{ii}=\int M_sN_i\,dV$. Użycie jednej globalnej objętości lub innej projekcji $M_s$ po stronie pola i energii narusza dyskretną tożsamość wariacyjną. Siatki tet4, prism6 i pyramid5 wymagają zgodnej kwadratury i mapowania; wymuszenie P1 dla potencjału na siatce mieszanej jest ograniczeniem dokładności, nie samo w sobie dowodem błędu fizycznego.

### Demagnetyzacja: energia, Poisson i granica nieskończona

```{math}
:label: audit-demag
\nabla\times\mathbf H_d=0,
\qquad \nabla\cdot(\mathbf H_d+\mathbf M)=0,
\qquad \mathbf H_d=-\nabla u,
\qquad E_d=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_d\,dV.
```

W FDM macierz splotu musi zachować wzajemność ważoną objętościami. Dla różnych siatek źródła i celu poprawny pojedynczy kernel nie wystarcza: transfery między siatkami także muszą być odpowiednio sprzężone względem iloczynu energetycznego. Padding otwartej domeny i periodyczne sumowanie obrazów odpowiadają różnym zagadnieniom.

W FEM z jednorodnym warunkiem Robina na zewnętrznym brzegu:

```{math}
:label: audit-poisson-robin
\int_\Omega\nabla u\cdot\nabla v\,dV
+\int_{\partial\Omega}\beta uv\,dS
=\int_{\Omega_m}M_s\mathbf m\cdot\nabla v\,dV.
```

Wybierając $v=u$, otrzymujemy dodatnią formę energii $\mu_0[\int|\nabla u|^2+\int\beta u^2]/2$ dla $\beta\geq0$, pod warunkiem spójnej dyskretyzacji źródła i odzyskiwania pola. Mały residual liniowego solve'a mówi o rozwiązaniu **tego skończonego zagadnienia**, a nie o dokładności modelu otwartej przestrzeni. Robin z ustalonym $\beta$ wymaga badania wielkości airboxu i zbieżności siatki. FEM/BEM Fredkina–Koehlera ma odrębne warunki, operatory i błędy aproksymacji; nie jest inną nazwą Poissona z airboxem. Rozróżnienie geometrii obu metod jest zgodne z [oryginalnym opisem metody hybrydowej](https://research.ibm.com/publications/hybrid-method-for-computing-demagnetizing-fields).

### Anizotropia: dlaczego $-\tfrac12\mu_0M_s\mathbf m\cdot\mathbf H$ nie jest uniwersalne

```{math}
:label: audit-uniaxial
w_u=-K_{u1}q^2-K_{u2}q^4,
\qquad
\mathbf H_u=\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\mathbf a.
```

Stąd bezpośrednio:

```{math}
:label: audit-uniaxial-half-field-error
-\frac12\mu_0M_s\mathbf m\cdot\mathbf H_u
=-K_{u1}q^2-2K_{u2}q^4\ne w_u\quad(K_{u2}q\ne0).
```

Ogólniej dla jednorodnego wielomianu stopnia $p$ twierdzenie Eulera daje $w_p=-\mu_0M_s\mathbf m\cdot\mathbf H_p/p$. Stopnie 2, 4, 6 i 8 wymagają różnych współczynników. Dla sumy tych wyrazów nie istnieje jeden uniwersalny prefaktor. To rozróżnienie wykorzystano w findingu OBS-01.

### Anizotropia cubic: osobna pochodna każdego współczynnika

Dla ortonormalnych osi kryształu $\mathbf c_i$ definiujemy bezwymiarowe $q_i=\mathbf m\cdot\mathbf c_i$ oraz $S=q_1^2q_2^2+q_2^2q_3^2+q_3^2q_1^2$. Odczytany funkcjonał Fullmag ma postać

```{math}
:label: audit-cubic-energy
w_c=K_{c1}S+K_{c2}q_1^2q_2^2q_3^2+K_{c3}S^2.
```

Dla cyklicznych, różnych indeksów $(i,j,k)$ otrzymujemy

```{math}
:label: audit-cubic-field
\mathbf H_c=-\frac1{\mu_0M_s}\sum_{i=1}^3\mathbf c_i
\left[2K_{c1}q_i(q_j^2+q_k^2)
+2K_{c2}q_iq_j^2q_k^2
+4K_{c3}S q_i(q_j^2+q_k^2)\right].
```

`backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp::compute_cubic_anisotropy_field` używa odpowiednio prefaktorów −2, −2 i −4, a energii $K_{c1}S+K_{c2}q_1^2q_2^2q_3^2+K_{c3}S^2$. W `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu::cubic_anisotropy_field_energy_blocks_kernel` występuje ten sam wielomian. To potwierdza lokalną zgodność algebraiczną pola i energii tych dwóch implementacji; nie dowodzi kwadratury dla każdego pola materiałowego ani wykonania CUDA. Parametr `Kc3` oznacza tu $S^2$, a nie dowolny inny niezmiennik ósmego stopnia używany w literaturze.

### Prescribed-strain magnetoelastyka: tensor odkształceń i czynniki dwa

Dla małych, zadanych odkształceń tensorowych $\varepsilon_{ij}$, bezwymiarowych, i współczynników $B_1,B_2$ w $\mathrm{J/m^3}$:

```{math}
:label: audit-magnetoelastic-field
w_{me}=B_1\sum_i\varepsilon_{ii}m_i^2+2B_2\sum_{i<j}\varepsilon_{ij}m_im_j,
\qquad
H_{me,i}=-\frac{2}{\mu_0M_s}
\left(B_1\varepsilon_{ii}m_i+B_2\sum_{j\ne i}\varepsilon_{ij}m_j\right).
```

Pochodna energii daje wskazane czynniki dwa. `backends/fem/cpu/mfem/interactions/magnetoelastic_prescribed_strain.cpp::compute_magnetoelastic_field` mnoży trzy składowe shear wejścia Voigta przez `0.5`, a następnie używa tensorowych $\varepsilon_{ij}$ w polu i energii. Jest to spójne z wejściowym shear inżynierskim $\gamma_{ij}=2\varepsilon_{ij}$. Przekazanie tensorowego shear do tak zdefiniowanego wejścia bez konwersji zmniejszy ten wkład o połowę. To kontrakt danych, nie wykazana usterka kernela.

Pole i energia zgadzają się algebraicznie dla prescribed strain. Nie wynika z tego rozwiązanie równań elastodynamiki, zgodność obrotu układu kryształu ani poprawne sprzężenie zwrotne magnetyzacji z mechanicznym solve'em. Te rozszerzenia wymagają własnego loweringu i dowodów.

### DMI: konwencja funkcjonału przed oceną znaku kernela

Dla przyjętych tutaj funkcjonałów, stałego $D$ i osi normalnej $+z$:

```{math}
:label: audit-dmi
w_b=D\mathbf m\cdot(\nabla\times\mathbf m),
\quad \mathbf H_b=-\frac{2D}{\mu_0M_s}\nabla\times\mathbf m,
\qquad
w_i=D\left[m_z\nabla_\parallel\cdot\mathbf m_\parallel
-\mathbf m_\parallel\cdot\nabla_\parallel m_z\right],
\quad
\mathbf H_i=\frac{2D}{\mu_0M_s}
\left[\nabla_\parallel m_z-(\nabla_\parallel\cdot\mathbf m_\parallel)\mathbf e_z\right].
```

$\nabla_\parallel=(\partial_x,\partial_y,0)$ ma jednostkę $\mathrm{m^{-1}}$, a $\mathbf e_z$ jest jednostkowym wektorem bezwymiarowym. Różny znak definicji $D$ w publikacji nie jest błędem implementacji, jeżeli energia, pole i oczekiwana chiralność są przeliczone konsekwentnie. Dla zmiennego $D$ nie można bez uzasadnienia użyć wzoru dla stałego współczynnika: wariacja wnosi dodatkowe wkłady gradientowe/interfejsowe.

Wariacja DMI daje również człon brzegowy, który trzeba połączyć z wymianą. Pozostawienie zwykłego zerowego strumienia wymiany po dodaniu DMI może rozwiązywać inne zagadnienie niż zamierzony model. Znaczenie warunków brzegowych dla skręcenia magnetyzacji przy krawędzi opisują [Rohart i Thiaville](https://journals.aps.org/prb/abstract/10.1103/PhysRevB.88.184422). W audycie porównano również rotated-interfacial DMI; nie jest ono aliasem zwykłego interfacial DMI.

## Potwierdzone problemy przekrojowe i obserwable

### OBS-01 — P1: mapa anizotropii FEM błędnie rekonstruuje człon $K_{u2}$

**Status: POTWIERDZONE — źródła i algebra. Zakres: materializacja `eden_ani` i `eden_total` przez adapter natywnego FEM; osobno helper referencyjny. Nie wykazano błędu natywnej energii skalarnej anizotropii.**

- `crates/fullmag-runner/src/native_fem.rs`, `NativeFemEnergyDensityTerms::observables_for`, około 1494 i 1517: dodaje `("H_ani", -0.5)` dla anizotropii uniaxial.
- Ten sam plik, `copy_energy_density_values`, około 4519, i `NativeFemEnergyDensitySnapshot::into_live_preview_field`, około 4974: mnożą pole przez magnetyzację i zadany prefaktor. Specjalna rekonstrukcja wielomianu istnieje dla cubic, lecz nie dla $K_{u2}$.
- `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`, `compute_uniaxial_anisotropy_field`, około 203–222: pole zawiera $4K_{u2}q^3/(\mu_0M_s)$, a energia $-K_{u2}q^4$.
- `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`, `uniaxial_anisotropy_field_energy_blocks_kernel`, około 48–68: taki sam współczynnik cztery w polu i jeden w energii.
- `crates/fullmag-runner/src/fem_reference.rs`, `fem_energy_density_values`, około 204: także używa `-0.5` dla całego pola anizotropii. Jest to helper testów/podglądu, nie produkcyjny solver MFEM.

Kontrprzykład algebraiczny: $K_{u1}=0$, $K_{u2}=20000\ \mathrm{J/m^3}$ i $q=0.5$ daje właściwe $w_u=-1250\ \mathrm{J/m^3}$, natomiast rekonstrukcja z połowy iloczynu pola daje $-2500\ \mathrm{J/m^3}$. Błąd występuje także dla jednorodnego stanu, więc nie wyjaśnia go projekcja pola ani rozdzielczość siatki.

**Zalecenie:** materializować funkcjonał uniaxial z tych samych współczynników i osi co backend; zachować osobno projekcję do payloadu. Dodać regresję $K_{u1}=0$, $K_{u2}\ne0$ dla snapshotu synchronicznego i asynchronicznego oraz zgodności całki ze skalarem. Istniejący test wielomianu cubic nie pokrywa tego przypadku.

### OBS-02 — P1: FDM GPU pomija energię statycznej mapy; mapy energii pomijają też regionalne pola

**Status: POTWIERDZONE — źródła. Zakres: energia skalarna i przestrzenna statycznej mapy oraz materializacja energii pól regionalnych. Pole LLG ma osobną ścieżkę i nie wykazano jego pominięcia. Pomiar uruchomionego kernela: NOT VERIFIED.**

- `backends/fdm/gpu/cuda/runtime/context.cu`, `context_mark_static_external_field_profile`, około 4447: zapisuje mapę w `h_oe_static` i ustawia `has_static_external_field_profile=true`, nie ustawia `has_oersted_field`. Setter C ABI również nie zmienia tej drugiej flagi; role pól mają pozostać oddzielne.
- `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`, `reduce_external_energy_fp64`, około 1377: warunek wczesnego zwrotu i wybór wskaźników `oe_x/y/z` sprawdzają `has_oersted_field`, pomijając flagę statycznej mapy. Późniejszy warunek skali `has_static_external_field_profile ? 1.0 : ...` nie naprawia braku wskaźnika ani wcześniejszego `return 0.0`. Wariant FP32 ma tę samą konstrukcję. Pola regionalne natomiast trafiają do redukcji skalarnej przez `external_energy_blocks_kernel`.
- `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu`, `energy_density_kernel`, około 137: gałąź `EDEN_EXT` bierze wyłącznie trzy wartości `external_x/y/z`; regionalnych pól ani statycznej mapy nie dostaje jako składnika Zeemana. `launch_energy_density_observable` przekazuje w tym miejscu `ctx.external_field`.
- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`, tworzenie `NativeFdmBackend`, około 1470 i 1936: statyczna mapa jest przesyłana odrębnym setterem `fullmag_fdm_backend_set_static_external_field_f64`.
- `docs/physics/0971-static-external-field-map.md`, równanie `static-field-map-zeeman-energy`: statyczna mapa jest częścią energii Zeemana.

Dla niezerowej mapy przestrzennej i zerowego pola jednorodnego **zarówno skalar, jak i mapa mogą dać zero**, mimo niezerowej fizycznej energii Zeemana i aktywnego pola w LLG. Dla pól regionalnych skalar otrzymuje pole, a `eden_ext` go nie otrzymuje. Ponieważ `EDEN_TOTAL` korzysta z tej samej gałęzi gęstości, problem przechodzi do mapy sumarycznej. Samo porównanie dwóch zerowych energii nie ujawni pierwszego błędu — potrzebny jest niezależny wynik analityczny.

`backends/fdm/tests/oersted_cuda_runtime.cu` w scenariuszu profilu statycznego porównuje `H_ext` i `H_eff` z profilem, lecz dla `stats.external_energy_joules` sprawdza jedynie `std::isfinite`. Błędne zero przechodzi taką asercję. Test w `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::native_fdm_static_external_profile_reaches_single_grid_effective_field_when_cuda_is_available` również skupia się na polach.

**Ważne rozróżnienie:** test `backends/fdm/tests/energy_density_observable_contract.cpp::cuda_materialization_contract_is_present` celowo utrzymuje oddzielne `EDEN_DRIVE`. To nie wystarcza do uzasadnienia pominięcia **statycznej mapy Zeemana**. Konserwatywny static field, niekonserwatywna diagnostyka transportu M2 oraz dowolne regionalne wymuszenie muszą mieć jawnie różną semantykę. Nie należy naprawiać problemu przez bezwarunkowe dodanie wszystkich torque do energii.

**Zalecenie:** zachować odrębną rolę static map, ale uwzględniać ją w warunku aktywności i wskaźnikach redukcji; ujednolicić semantykę rozwiązanych składowych pola zewnętrznego dla redukcji i map. Regresje static-map-only i regional-field-only muszą porównywać pole, energię analityczną oraz $\sum\mathrm{eden}_{ext}V=E_{ext}$.

### OBS-03 — P2: gęstość FDM GPU i energia skalarna stosują różną miarę częściowej komórki

**Status: POTWIERDZONE — niespójność z udokumentowaną całką pełnokomórkową. Nie jest to dowód błędu lokalnej gęstości liczonej na jednostkę objętości samego materiału.**

- `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`, `external_energy_blocks_kernel` oraz kernele energii anizotropii: używają `volume_fraction` i wagi $\varphi_i$.
- `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu`, `energy_density_kernel`: zna maskę aktywności, ale nie otrzymuje udziału objętościowego.
- `backends/fdm/api/c_api.cpp`, tworzenie backendu, około 1396: korekcja granicy wraz z `volume_fraction` jest przekazywana do runtime FP64; nie jest to wyłącznie niedostępny parametr.
- `docs/physics/0890-energy-density-observables.md`: opisuje całkę FDM jako $E_i=\sum_c\varepsilon_i(c)V_c$ dla objętości komórki.

Przy $\varphi=0.5$ całka gęstości z pełnym $V_c$ jest dwukrotnie większa co do modułu od skalaru. Trzeba rozstrzygnąć kontrakt: gęstość uśredniona po pełnej komórce wymaga wagi $\varphi$, a gęstość na objętość magnetyczną wymaga jawnego $V_i$ w integracji i metadanych. Nie wolno mieszać obu interpretacji ani dodawać wagi drugi raz po stronie konsumenta.

Istniejący `backends/fdm/tests/partial_cell_energy_contract.cpp` sprawdza obecność `volume_fraction` w redukcjach skalarów poprzez tekst źródeł. Nie testuje całki przestrzennego `eden_*` dla częściowo zapełnionej komórki.

### OBS-04 — P1: energie przypisane obiektom FEM są podziałem globalnej sumy

**Status: POTWIERDZONE — źródła. Zakres: `per_object_scalars` natywnego FEM i helperów referencyjnych. Nie zmienia globalnego pola ani globalnej energii backendu.**

`crates/fullmag-runner/src/scalar_metrics.rs::weighted_object_scalars`, około 142, kopiuje globalne skalary, następnie mnoży sześć energii przez znormalizowaną wagę obiektu. Nie całkuje lokalnej energii i nie otrzymuje pola magnetyzacji ani materiału obiektu. Korekta zaokrągleń wymusza jedynie zgodność sumy obiektów z globalnym skalarem.

Wywołania produkcyjne: `crates/fullmag-runner/src/native_fem.rs` około 3491, 3933 i 4282. Późniejsze `attach_native_object_average_m` zastępuje średnie `mx/my/mz`, lecz nie zastępuje energii. `crates/fullmag-runner/src/fem/relax/scalars.rs::ensure_fem_object_scalars` używa tego samego mechanizmu w ścieżce uzupełniania statystyk.

Co więcej, `native_fem_segment_weight` w `native_fem.rs`, około 1871, bierze liczbę węzłów segmentu/obiektu, nie całkę objętości. Zmiana zagęszczenia siatki jednego obiektu może więc zmienić przypisaną mu część globalnej energii bez odpowiadającej zmiany fizycznej.

Kontrprzykład: dwa równe magnesy, jedno stałe pole, magnetyzacje równoległa i antyrównoległa do pola. Rzeczywiste energie Zeemana to $-C$ i $+C$, gdzie $C=M_sBV>0$ ma jednostkę dżula. Suma wynosi zero. Podział globalnego zera dowolnymi dodatnimi wagami daje dwa zera. Nie jest to fizyczna energia żadnego z magnesów. Dla wymiany lub anizotropii niejednorodność energii prowadzi do analogicznych błędów nawet bez problemu rozdziału wzajemnej energii demagnetyzacyjnej.

**Zalecenie:** lokalne energie integrować po faktycznej domenie obiektu; dla oddziaływań nielokalnych jawnie zdefiniować podział energii wzajemnej. Do czasu implementacji wyniki podziału oznaczać jako estymację/alokację albo nie udostępniać ich jako fizycznego `E_*` obiektu. Test samej równości sumy jest niewystarczający.

### OBS-05 — P2: odbiorca samych skalarów może dostać domyślne statystyki początkowe FEM

**Status: POTWIERDZONE — przepływ w źródłach. Reprodukcja z rzeczywistym runtime w tym audycie: NOT VERIFIED.**

`crates/fullmag-runner/src/dispatch.rs::native_fem_requires_initial_snapshot` przyjmuje argument `live_present`, ale jego wywołanie w `execute_native_fem`, około 3254, przekazuje `consumer.initial_snapshot`. Odbiorca live, który nie żąda pola początkowego, jest więc potraktowany tak jak brak odbiorcy. Gdy dodatkowo nie ma bezpośredniego minimizera ani harmonogramu pól, kod około 3356 wybiera `StepStats::default()` zamiast `backend.snapshot_step_stats`.

Następnie `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs::execute_llg_overdamped`, około 208, wywołuje `publish_initial_scalar_without_field_snapshot`. Ten helper w `fem/relax/scalars.rs`, około 10, właśnie dla `live && !initial_snapshot` publikuje przekazane statystyki jako wiersz skalarów. Zatem deklaracja braku pełnego snapshotu pola może skutkować publikacją zer domyślnych jako danych początkowych, choć stan magnetyczny i energia nie są zerowe.

**Zalecenie:** rozdzielić obecność odbiorcy skalarów od żądania pełnego snapshotu pola. Test ma obejmować callsite i kombinację `live=Some`, `initial_snapshot=false`, brak scheduled fields, ścieżkę LLG. Sam test trzech booli helpera nie chroni przed przekazaniem niewłaściwego boola. Nie należy interpretować takiego zerowego pierwszego wiersza jako fizycznego stanu równowagi.

### DOC-01 — P2: bramka aktualizacji not fizycznych nie obejmuje aktualnych backendów

**Status: POTWIERDZONE — źródła i wykonany test klasyfikacji ścieżek.**

`scripts/check_physics_docs_gate.py::PHYSICS_FACING_PREFIXES` obejmuje `native/`, `packages/fullmag-py/`, `crates/fullmag-ir/`, `docs/specs/` i `examples/`, ale nie obejmuje `backends/` ani `crates/fullmag-engine/`.

Wykonane sprawdzenie zwróciło `False` dla ścieżek operatorów FDM i FEM w `backends/` oraz CPU FDM w silniku Rust, a `True` dla `native/example.cpp`. Zatem uruchomienie tego skryptu na zmianie ograniczonej do obecnego kernela nie wymusi noty fizycznej. Nie dowodzi to, że każdy pipeline CI jest nieskuteczny — nie przypisano tej bramce wyłącznej roli w całym CI.

**Zalecenie:** objąć aktualnych właścicieli fizyki; odróżnić zmiany naukowe od formatowania, lecz nie pozostawiać całych drzew operatorów poza filtrem.

### DOC-02 — P2: dziewięć map źródeł nie przechodzi aktualnego walidatora

| Mapa w `docs/physics/` | Wynik i charakter problemu |
|---|---|
| `0100-mesh-and-region-discretization` | Brak dopasowania wskazanej deklaracji walidacji certyfikatu siatki. |
| `0400-fdm-exchange-demag-zeeman` | Mapa wskazuje starą lokalizację `build_full_grid_materialized_fields`. |
| `0431-fem-demag-mixed-order-potential` | Niejednoznaczne dopasowanie `compute_device_demag_for_device_stage`; może wymagać dokładniejszego anchora lub obsługi przeciążeń. |
| `0530-magnetic-preset-textures` | Cztery odnośniki do nieistniejącego `apps/legacy_web`. |
| `0580-canonical-relaxation-equilibrium-contract` | Osiem problemów mapowania równania, symboli i indeksu źródeł. |
| `0830-fem-poisson-airbox-modal-eigen` | Siedem niedopasowanych/starych wskazań funkcji i ścieżki artefaktów. |
| `0880-active-effective-field-terms` | Niejednoznaczna deklaracja klasy testowej `ProblemApiTests`. |
| `0981-fem-oet0-sparse-kkt` | Sześć problemów deklaracji usług/skryptów i indeksu źródeł; matcher deklaracji nie musi rozumieć wszystkich formatów. |
| `0995-physics-module-scope-and-activation` | Sześć problemów deklaracji metody, tabeli parametru, mapowania IR i indeksu. |

Wynik `FAIL` tutaj **nie** oznacza dziewięciu błędnych teorii fizycznych. Część usterek to drift dokumentacji, a część ograniczenia identyfikacji symboli przez walidator. Wynik `PASS` potwierdza strukturę i kotwice, nie poprawność całego wyprowadzenia. Testy samego walidatora: 29/29 PASS.

### DOC-03 — P1: docstring publicznej anizotropii podaje inny model członu drugiego rzędu

**Status: POTWIERDZONE — dokumentacja publicznej klasy, lowering i algebra. Nie jest to kolejny dowód błędu pola backendu.**

`packages/fullmag-py/src/fullmag/model/energy.py::UniaxialAnisotropy` opisuje energię jako $K_{u1}\sin^2\theta+K_{u2}\sin^4\theta$. Kanoniczna nota `docs/physics/0402-uniaxial-anisotropy.md`, sekcja Physical model, i natywny operator używają $-K_{u1}q^2-K_{u2}q^4$, gdzie $q=\cos\theta$. Dla niezerowego $K_{u2}$ te zapisy nie różnią się wyłącznie stałą:

```{math}
:label: audit-uniaxial-docstring-convention
K_{u1}(1-q^2)+K_{u2}(1-q^2)^2
=(K_{u1}+K_{u2})-(K_{u1}+2K_{u2})q^2+K_{u2}q^4.
```

Lowering legacy termu w `packages/fullmag-py/src/fullmag/model/problem.py` przez `_merged_legacy_material_value` przypisuje `term.ku1` i `term.ku2` bezpośrednio do `Ku1/Ku2`. Nie wykonuje transformacji współczynników, która mogłaby uzgodnić te dwa modele. Użytkownik przenoszący parametry z konwencji $\sin^2/\sin^4$ może zatem zadać inne pole i inne minima energii, niż sugeruje docstring.

**Zalecenie:** uzgodnić docstring z kanoniczną notą i jawną konwencją energii. Przy imporcie danych z konwencji sinusowej stosować udokumentowaną transformację współczynników: $K_{u1}^{\rm Fullmag}=K_1^{\sin}+2K_2^{\sin}$ oraz $K_{u2}^{\rm Fullmag}=-K_2^{\sin}$, z osobno określoną stałą energii. Nie zmieniać kernela tak, by przypadkowo dopasować go do starego docstringa.

### VAL-01 — brak zarejestrowanej kwalifikacji LLG dla obecnej macierzy

**Status: POTWIERDZONE — odczyt rejestru i wykonanie walidatora.**

`benchmarks/fem-llg/qualification-registry-v1.json` zawiera dziewięć wpisów, wszystkie `unvalidated`, bez artifact path/hash i ukończonych bramek. `scripts/validate_llg_qualification_registry.py::validate_registry` zaakceptował plik, ponieważ jawny brak kwalifikacji jest legalnym i uczciwym stanem.

Także odczytane `tests/fem_fdm_mumax3_sinc_layer/results/current/fdm_gpu/qualification.json` oraz wariant `fdm_gpu_dt50fs_diagnostic_retry` mają `status=not_evaluated`, `checks=[]`, `validation_state=unvalidated`, mimo zapisanych 105 accepted steps. To bieżący odczyt istniejących plików, nie świeżo wykonany benchmark. Nie przenosi się na niego tożsamości audytowanego HEAD.

**Wniosek:** wykonanie solvera, licznik accepted steps i pliki wynikowe nie zastępują sprawdzenia trajektorii, błędu integratora, zgodności energii i dokładnej tożsamości źródeł. Nie należy uzupełniać rejestru deklaratywnie; potrzebny jest odpowiadający wpisowi artefakt.

### Historyczny dowód Zhang–Li nie kwalifikuje obecnego HEAD

Odczytany `docs/validation/fem-zhang-li-skew-tetra-runtime-v1.json` ma status `completed_managed_workload_evidence_no_capability_promotion`. Opisuje CPU/GPU, Heuna z dziesięcioma krokami, odwrócenie prądu, kontrolę J=0 i osobne badanie Richardsona. Wskazuje historyczny `repository_head=ec9e68893a9932de4bbea940ff608356402d9cc5`. Jego wskazany plik `summary.json` w `.fullmag/audits/2026-07-09-backend-llg/remediation/artifacts/fem_td_zhang_li_skew_tet_affine_v1/` zawiera inny `repository_head=faa6a81cf396a5cd0f46cc889f71061a0142fa93` i nie zawiera pola `status`.

To dostępny historyczny materiał wykonania, którego nie wolno ignorować, ale oba identyfikatory różnią się od audytowanego HEAD. Dodatkowo ich wzajemna różnica wymaga wyjaśnienia przed przeniesieniem twierdzeń między manifestem i summary. W tym audycie nie ponawiano jego walidatora ani runtime i nie nadano mu statusu bieżącej kwalifikacji. `capability_promotion` w samym manifeście wynosi `none`.

### VAL-02 — ograniczenie testów kwalifikacji na Windows

Seria łączna czterech plików testowych dała **29 passed, 8 subtests passed, 16 failed**, exit 1. Wszystkie 16 niepowodzeń dotyczyło `scripts/test_validate_fdm_relaxation_qualification.py` i wystąpiło podczas tworzenia fixture, przed właściwą oceną fizyki: `WinError 206`, zbyt długa ścieżka.

Ponowienie wyłącznie tej serii z nowym katalogiem TEMP i prefiksem długiej ścieżki Windows `\\?\` ominęło pierwszy problem, lecz dało **16 failed**, exit 1: `QualificationError: repo_root is not the Git worktree root`. W `scripts/validate_fdm_relaxation_qualification.py::source_identity` porównanie ścieżki zwróconej przez Git z `Path.resolve()` nie zaakceptowało obu reprezentacji tego samego katalogu. Nie osłabiono kontroli tożsamości ani nie zmieniano kodu walidatora w audycie.

**Wniosek:** te 16 testów pozostaje niezweryfikowanych funkcjonalnie na tym hoście; nie są to 16 wykrytych usterek solvera. Naprawa przenośności fixture i kanonizacji ścieżek jest osobnym zadaniem narzędziowym.

## Obserwable topologii: zbadany zakres

`crates/fullmag-api/src/analysis/topological_charge.rs::compute_oriented_charge` liczy zorientowaną sumę kątów bryłowych trójkątów metodą Berg–Lüscher:

```{math}
:label: audit-topological-charge
Q_h=\frac1{4\pi}\sum_{(a,b,c)}2\operatorname{atan2}
\left(\mathbf a\cdot(\mathbf b\times\mathbf c),
1+\mathbf a\cdot\mathbf b+\mathbf b\cdot\mathbf c+\mathbf c\cdot\mathbf a\right).
```

$Q_h$ jest bezwymiarowe, a $\mathbf a,\mathbf b,\mathbf c$ są jednostkowymi magnetyzacjami na uporządkowanych wierzchołkach. Kod sprawdza próbki, trójkąty antypodalne i niejednoznaczne, stosuje kompensowane sumowanie oraz zwraca ocenę rozdzielczości. `qualify_support_topology` i `qualify_boundary` oddzielają wartość całki od uprawnienia do interpretowania jej jako bliskiej liczbie całkowitej. To poprawne rozdzielenie kontraktów.

Widziane testy Rust sprawdzają odwrócenie orientacji, niepoprawne próbki, trójkąty antypodalne, brzeg, wieloskładowość i topologię niebędącą rozmaitością (`nonmanifold`). Nie uruchamiano ich przez build Rust. Wykonano testy walidatora dowodów runtime dla tej wielkości w serii 29 PASS; testują one strukturę i odrzucanie niepoprawnych dowodów, nie obliczenie skyrmiona na rzeczywistym backendzie.

Ograniczenia kanoniczne z `docs/physics/0940-topological-charge-observable.md`: obserwacja planarna FDM lub cięcie tetrahedralnego FEM P1; nie dowolna zakrzywiona powierzchnia, nie Hopf invariant, nie automatyczna obsługa wyższego rzędu i wszystkich topologii mieszanych. Orientacja `xz` ma normalną $-y$; porównując znaki $Q$, trzeba zachować kolejność osi.

## Wykonane kontrole i granice dowodów

| Kontrola | Faktyczny wynik | Co potwierdza |
|---|---|---|
| `git rev-parse HEAD`, `git status --short` | odczytano HEAD i istniejące zmiany | tożsamość checkoutu i zakres zachowania cudzej pracy |
| `validate_page` dla wszystkich 43 map w `docs/physics/` | 34 PASS, 9 FAIL; komplet błędów w JSON | kontrola struktury, symboli, mapowania dokumentacji |
| `python -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'` | 29 testów PASS, exit 0, 13.927 s | testy narzędzia dokumentacji |
| `python scripts/validate_llg_qualification_registry.py benchmarks/fem-llg/qualification-registry-v1.json --repo-root .` | `LLG qualification registry PASS` | poprawność schematu rejestru, który ma 9 wpisów `unvalidated` |
| `python -m pytest -q -p no:cacheprovider scripts/test_validate_llg_qualification_registry.py scripts/test_validate_fem_demag_analytic_qualification.py scripts/test_validate_topological_charge_runtime.py scripts/test_validate_fdm_relaxation_qualification.py` | 29 passed, 8 subtests passed, 16 failed; exit 1, 16.61 s | pierwsze trzy pliki pozytywne; czwarty zablokowany przez długość ścieżek fixture |
| Ponowienie ostatniego pliku z prefiksem długiej ścieżki | 16 failed, exit 1, 9.95 s | problem zgodności reprezentacji ścieżki Git, nie test fizyki |
| Kontrprzykłady algebraiczne OBS-01 i OBS-03 w Python 3.12.2 | asercje PASS, exit 0 | rachunek współczynnika 2 i wagi objętości; **nie wykonanie C++/CUDA** |
| Gradient cubic (3 składowe) i transformacja sinus→Fullmag (5 orientacji), Python | asercje PASS, exit 0 | algebra równań raportu; bez wykonania backendu |
| Predykat `PHYSICS_FACING_PREFIXES` dla obecnych drzew operatorów | 3 × False; stary prefiks `native/` True | luka w klasyfikacji tej konkretnej bramki |
| Nowy managed runtime FDM/FEM | **NOT VERIFIED — nie uruchamiano** | brak nowego dowodu urządzenia, trajektorii i parytetu |
| Nowa walidacja µMAG / analityczna solverów | **NOT VERIFIED — nie uruchamiano** | nie zastąpiono jej testami walidatorów |
| Browser/WebGL i kwalifikacja wydania | **NOT VERIFIED — poza wykonanymi kontrolami** | brak twierdzenia o gotowości wydania lub wizualizacji |

W testach Python ustawiono `PYTHONDONTWRITEBYTECODE=1`; pytest nie zapisywał swojego cache. Nie instalowano zależności i nie budowano backendów. Odczytano `justfile`, w tym właścicieli testów Poissona, FEM/BEM, LLG, transportu, relaksacji i SP4. Kampania managed runtime wymaga odrębnych wykonań oraz artefaktów przypiętych do wejść i źródeł. Stan dirty nie został ukryty ani zamieniony w status release-qualified.

## Jak domknąć walidację fizyczną

Każdy zaakceptowany model i wariant brzegowy powinien mieć własną macierz. Nie wystarczy jeden test całego solvera, ponieważ różne błędy mogą się kompensować.

| Obszar | Minimalny rozstrzygający dowód |
|---|---|
| Jednostki i LLG | macrospin w stałym polu: kierunek precesji, częstość, tłumienie, norma, zbieżność w czasie |
| Każda energia konserwatywna | pochodna kierunkowa z tą samą kwadraturą, maską, objętością i stanem; osobno suma aktywnych oddziaływań |
| Wymiana | jednorodny stan, analityczna fala, skok $A$ i $M_s$, interfejs, brzeg swobodny i PBC; przestrzenna zbieżność |
| Demag FDM | tensor/self-term, wzajemność, energia i orakl bez FFT; padding, obrazy PBC i multilayer osobno |
| Demag FEM | macierz symetryczna, dyskretna praca pola, analityczna bryła, niezależna zbieżność siatki i airboxu; FK z bramką błędu BEM |
| Uniaxial i cubic | każda potęga oddzielnie, także $K_{u1}=0,K_{u2}\ne0$; osie obrócone, pola materiałowe; całka mapy i skalar |
| DMI | znak chiralności, derivative test, skręcenie krawędzi, stałe i skokowe $D$, równoczesna wymiana; rotated DMI osobno |
| Magnetoelastyka | tensor odkształceń i czynniki shear, obrót osi, pochodna energii, jawna granica prescribed strain vs sprzężona mechanika |
| STT/SOT | zmiana znaku prądu, orientacja polaryzacji, skalowanie $M_s$ i grubości, maska targetu, pole jednorodne i gradient; każda wersja operatora oddzielnie |
| Transport i Oersted | bilans ładunku, domknięcie obwodu, wspólna tożsamość prądu, rozwiązanie analityczne i zbieżność, pole w tym samym czasie etapu |
| Termika | wariancja i kowariancja, skalowanie $T$, $V$, $\Delta t$, równowagowy rozkład; strumień losowy przy retry i wznowieniu |
| Integratory | tableau/order, czas etapów, accepted/rejected state, koniec interwału, FSAL, normowanie, rollback zależnych pól; każdy wspierany integrator |
| Relaksacja | spadek właściwej energii, moment/gradient, brak akceptacji samego limitu kroków, potwierdzenie pola końcowego |
| Eigensolve | linearizacja tego samego funkcjonału i równowagi, styczna przestrzeń, Kittel, residual, zbieżność siatki i bazy; free/PBC/Floquet osobno |
| FDM↔FEM | ta sama geometria i parametry oraz badanie zbieżności obu metod, a nie wymóg równości dwóch arbitralnych siatek |
| CPU↔GPU | identyczne wejścia, urządzenie i precyzja w receipt, bez fallbacku; pola i energie oddzielnie przed trajektorią |
| Obserwable | wspólny snapshot i miara całki, komplet aktywnych składników, `E_total` odróżnione od pracy wymuszeń i diagnostyki niekonserwatywnej |

Repozytorium ma odpowiednich właścicieli wykonania, m.in. `verify-fem-demag-poisson-contract`, `verify-fem-demag-fem-bem-contract-focused`, `verify-fem-demag-analytic-qualification`, `verify-fem-demag-mesh-airbox-convergence`, `verify-fem-exchange-runtime`, `verify-fem-thermal-cpu-runtime`, `verify-fdm-gpu-dmi-boundary-runtime`, `verify-fem-llg-time-domain-qualification-production` i `verify-fem-standard-problem-4`. Samo istnienie recipe nie jest dowodem przejścia bramki. Na Windows obowiązują zarządzane ścieżki projektu i storage poza checkoutem.

Pierwszeństwo mają potwierdzone niespójności pola, energii, aktywacji i semantyki, następnie testy ich regresji, następnie pomiary parytetu i zbieżności. Nie należy optymalizować ani deklarować pełnej kwalifikacji na podstawie samej obecności operatora.

## Bibliografia i rola źródeł zewnętrznych

Źródła zewnętrzne służą sprawdzaniu modeli i metod. Nie dowodzą, że kod Fullmag implementuje je prawidłowo.

1. [NIST µMAG — Micromagnetic Modeling Activity Group](https://www.nist.gov/programs-projects/mmag-micromagnetic-modeling-activity-group): niezależne problemy standardowe jako podstawa walidacji numerycznej.
2. [NIST OOMMF — model energii i pole efektywne](https://math.nist.gov/oommf/doc/userguide10/userguide/2D_Micromagnetic_Solver_mmS.html): konwencje pola i składowych energii; nie jest to specyfikacja capability Fullmag.
3. [Newell, Williams, Dunlop, 1993](https://agupubs.onlinelibrary.wiley.com/doi/abs/10.1029/93JB00694): tensor demagnetyzacyjny niejednorodnej magnetyzacji.
4. [Fredkin, Koehler, 1990 — Hybrid method for computing demagnetizing fields](https://research.ibm.com/publications/hybrid-method-for-computing-demagnetizing-fields): hybrydowa metoda FEM/BEM bez siatki całej przestrzeni zewnętrznej.
5. [Rohart, Thiaville, Phys. Rev. B 88, 184422 (2013)](https://journals.aps.org/prb/abstract/10.1103/PhysRevB.88.184422): warunki brzegowe DMI i skręcenie krawędzi.
6. [Brown, Phys. Rev. 130, 1677 (1963)](https://journals.aps.org/pr/abstract/10.1103/PhysRev.130.1677): fluktuacje termiczne i związek szumu z tłumieniem. Nie jest to automatyczna walidacja dyskretyzacji FEM ani adaptacyjnego SDE.
7. [Berg, Lüscher, Nuclear Physics B 190, 412–424 (1981)](https://doi.org/10.1016/0550-3213(81)90568-X): zorientowana geometryczna definicja ładunku topologicznego, wskazana również w nocie Fullmag.

## Szczegółowe audyty implementacji

Poniższe części zawierają inwentarz operatorów, ich realizacji, powiązań Python/IR, ograniczeń i konkretnych wyprowadzeń. Wyniki trzeba czytać łącznie z poziomami dowodów powyżej: `implemented` nie oznacza `qualified`.

<!-- integrated-audit-sections -->

<a id="audit-fdm"></a>

## Sekcja audytu fizyki FDM Fullmag

Data audytu: **2026-09-08**. Checkout audytowany: `C:/git/fullmag/fullmag`, punkt odniesienia źródeł: `6cc5e5e0396050f5f859a0e2b28dd3f963d3f7bb`. Ten dokument jest sekcją dołączaną do [audytu fizyki solverów FDM/FEM](2026-09-08-fdm-fem-physics-audit.md). Zachowuje ustalenia dotyczące obu realizacji FDM: referencyjnej/produkcyjnej CPU w silniku Rust oraz produkcyjnej GPU w natywnym CUDA.

### Zakres i granice wyniku

Audyt porównuje równania, dyskretyzację komórek, przepływ pól i energii, lowering przez runner oraz istniejące testy kontraktowe. `POTWIERDZONE — źródła` oznacza odczyt bieżącego kodu i wywołań; `POTWIERDZONE — algebra` oznacza niezależny rachunek; `TEST PASS` oznacza wyłącznie komendę opisaną w audycie nadrzędnym. `NOT VERIFIED` oznacza brak aktualnego dowodu wykonania, parytetu, zbieżności lub kwalifikacji. Źródła zewnętrzne i referencyjne solvery nie są dowodem działania Fullmag.

Zgodnie z kontraktem backendu role są rozdzielone:

| Realizacja | Rola | Właściciel źródła | Stan dowodu w tym audycie |
|---|---|---|---|
| FDM CPU | referencja i produkcyjna ścieżka CPU | `crates/fullmag-engine/src/fdm/cpu/` oraz `crates/fullmag-engine/src/fdm/shared/` | źródła i testy kontraktowe odczytane; nowy runtime/parytet **NOT VERIFIED** |
| FDM GPU | produkcyjna ścieżka native CUDA | `backends/fdm/gpu/cuda/`, C ABI `backends/fdm/api/`, adapter `crates/fullmag-runner/src/fdm/gpu/cuda/` | źródła odczytane; nowy runtime, urządzenie, precision receipt i parytet **NOT VERIFIED** |

Nie wolno przenosić wyniku z FDM CPU na FDM GPU ani odwrotnie. CPU reference może służyć jako orakl po udowodnieniu zgodności geometrii, maski, objętości, parametrów, stanu początkowego i warunków brzegowych. Sam fakt, że oba drzewa zawierają operator o tej samej nazwie, nie jest dowodem parytetu.

### Wspólny zapis fizyczny i dyskretny

Niech komórka $i$ ma środek $\mathbf r_i$, pełną objętość $V_i^c=\Delta x\Delta y\Delta z$, udział magnetyczny $\varphi_i\in[0,1]$ i objętość materiału $V_i=\varphi_iV_i^c$. Magnetyzacja w aktywnej komórce to $\mathbf M_i=M_{s,i}\mathbf m_i$, gdzie $|\mathbf m_i|=1$ w tym w komórkach zamrożonych; komórki nieaktywne wymagają odrębnej maski. Pole gęstości zapisane jako energia na pełną komórkę i pole gęstości zapisane na objętość materiału są dwiema różnymi konwencjami:

```{math}
:label: fdm-cell-measure
E=\sum_i w_iV_i,
\qquad
w_i^{(c)}=\frac{E_i}{V_i^c},
\qquad
w_i^{(m)}=\frac{E_i}{V_i},
\qquad
V_i=\varphi_iV_i^c.
```

Jeżeli payload `eden_*` używa pierwszej konwencji, całka musi mnożyć przez $V_i^c$ i odpowiednio ważyć składnik przez $\varphi_i$. Jeżeli używa drugiej, całka musi używać $V_i$ i ujawniać tę jednostkę w metadanych. W obu przypadkach skalar i mapa muszą używać tej samej maski, materiału, kwadratury oraz miary.

Dla konserwatywnego pola efektywnego obowiązuje dyskretna wersja relacji wariacyjnej:

```{math}
:label: fdm-discrete-variation
\delta E
=-\mu_0\sum_i M_{s,i}\,\mathbf H_{\mathrm{eff},i}\cdot\delta\mathbf m_i\,V_i.
```

Tożsamość jest użytecznym testem operatora, ale nie obejmuje automatycznie szumu termicznego ani niekonserwatywnego torque transportowego. Dla $\alpha>0$, stałych parametrów i wyłącznie pól konserwatywnych konwencja LLG używana w audycie ma postać:

```{math}
:label: fdm-llg
\frac{d\mathbf m_i}{dt}
=-\frac{\gamma_H}{1+\alpha^2}
\left[\mathbf m_i\times\mathbf H_{\mathrm{eff},i}
+\alpha\mathbf m_i\times
(\mathbf m_i\times\mathbf H_{\mathrm{eff},i})\right]
+\boldsymbol\tau_i,
\qquad
\gamma_H=\mu_0|\gamma_e|.
```

Pole $\mathbf H$ ma jednostkę $\mathrm{A\,m^{-1}}$, $\gamma_H$ ma jednostkę $\mathrm{m\,A^{-1}\,s^{-1}}$, a $\boldsymbol\tau$ ma jednostkę $\mathrm{s^{-1}}$. Brak $\mu_0$ przy użyciu $\gamma_e$ z polem $\mathbf H$ zmienia skalę czasu. Dla niezakłóconej relaksacji:

```{math}
:label: fdm-llg-dissipation
\frac{dE}{dt}
=-\mu_0\sum_iV_iM_{s,i}
\frac{\gamma_H\alpha}{1+\alpha^2}
\left|\mathbf m_i\times\mathbf H_{\mathrm{eff},i}\right|^2\leq0.
```

Nierówność nie jest kryterium dla wymuszeń, termiki, STT/SOT ani dynamicznego pola transportowego. Relaksacja musi raportować osobno moment/gradient, normę, accepted/rejected state i jawny powód zakończenia.

### Operatory FDM i ich realizacje

#### Wymiana

Dla stałego $A$ operator kontinuum wynika z

```{math}
:label: fdm-exchange
E_{\mathrm{ex}}=\int A|\nabla\mathbf m|^2dV,
\qquad
\mathbf H_{\mathrm{ex}}
=\frac{2}{\mu_0M_s}\nabla\cdot(A\nabla\mathbf m).
```

FDM dyskretyzuje gradient przez różnice sąsiednich komórek i musi zachować właściwe współczynniki dla $A$, $M_s$, odległości $\Delta x,\Delta y,\Delta z$, maski oraz częściowych komórek. Przy interfejsie niejednorodnego $A$ zachowanie strumienia wymiennego nie jest równoważne bezwarunkowemu użyciu jednego $A\Delta\mathbf m$; brzeg swobodny, zamrożony i PBC są odrębnymi zadaniami.

Źródła implementacji to `crates/fullmag-engine/src/fdm/cpu/fields.rs` i `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms` po stronie CPU oraz `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu::exchange_field_fp64_kernel` i `exchange_fp32.cu` po stronie GPU. Warstwa wielowarstwowa jest rozbita na `multilayer_exchange.cu` i odpowiadające jej `multilayer_effective_field.cu`. Testy `crates/fullmag-engine/tests/exchange_density_study.rs`, `fdm_aos_soa_parity.rs` i kontrakty źródłowe CUDA potwierdzają obecność wybranych reguł, ale nie zamykają pełnej macierzy interfejsów, PBC i zbieżności.

#### Demagnetyzacja

Pole FDM ma postać splotu dyskretnego tensora demagnetyzacyjnego:

```{math}
:label: fdm-demag
\mathbf H_{d,i}=\sum_j\mathsf N_{ij}\mathbf M_j,
\qquad
E_d=-\frac{\mu_0}{2}\sum_iV_i
\mathbf M_i\cdot\mathbf H_{d,i}.
```

Tutaj $\mathsf N$ oznacza podpisany operator pola (ujemny diagonalny self-term), a nie dodatni tensor współczynników odmagnesowania. W otwartej domenie FFT wymaga właściwego paddingu i self-termu. W PBC suma obrazów definiuje inne zagadnienie. W multilayer $V_i$, warstwa źródłowa, warstwa celu i transfer między różnymi rastrami muszą być zgodne względem iloczynu energetycznego; sama obecność wspólnego kernela nie dowodzi wzajemności.

CPU prowadzi ścieżkę referencyjną w `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra` i `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs::FdmFftBackend`; dane stanu oraz pola są w `crates/fullmag-engine/src/fdm/cpu/state.rs::ExchangeLlgState`. Produkcyjna GPU ścieżka jest w `backends/fdm/gpu/cuda/interactions/demag_fp64.cu::launch_demag_field_fp64`, `demag_fp32.cu` oraz `demag_boundary_fp64.cu`; planowanie i endpoint cache należą do `backends/fdm/gpu/cuda/runtime/`.

Istniejące źródła i testy wskazują osobne ścieżki dla otwartej domeny, PBC, multilayer i transferów (`crates/fullmag-engine/tests/multilayer_unequal_transfer.rs`, `fdm_fft_cpu_performance.rs`, `backends/fdm/tests/endpoint_cache_cuda_runtime.cpp`). Nie ma w tym audycie nowego wykonania, które jednocześnie potwierdzałoby tensor, wzajemność, self-term, energię, padding, obrazy PBC i zgodność CPU/GPU. Aktualne kwalifikowanie demag FDM pozostaje **NOT VERIFIED**.

#### Zeeman, statyczna mapa i regionalne pole

Dla konserwatywnego zewnętrznego pola:

```{math}
:label: fdm-zeeman
E_{\mathrm{ext}}
=-\mu_0\sum_iV_i\mathbf M_i\cdot\mathbf H_{\mathrm{ext},i},
\qquad
\mathbf H_{\mathrm{ext},i}
=\mathbf H_{\mathrm{uniform},i}
+\mathbf H_{\mathrm{static},i}
+\mathbf H_{\mathrm{regional},i}.
```

`static external field map` jest polem zadanym w czasie i zgodnie z `docs/physics/0971-static-external-field-map.md` należy do energii Zeemana. Regionalny field drive może być konserwatywnym polem, ale osobne transportowe lub diagnostyczne torque nie powinny być bezwarunkowo dopisywane do $E_{\mathrm{total}}$. Rola pola, jego jednostka, etap czasu i provenance muszą być jawne.

Wspólna CPU/IR warstwa znajduje się w `crates/fullmag-engine/src/fdm/shared/problem.rs::ExchangeLlgProblem`, `shared/terms.rs::EffectiveFieldTerms`, `shared/vector_field.rs` i `crates/fullmag-ir/src/model.rs`/mapowaniu `static_external_field_map`. GPU mapę zapisuje `backends/fdm/gpu/cuda/runtime/context.cu::context_mark_static_external_field_profile`; C ABI i adapter przekazują ją przez `backends/fdm/api/c_api.cpp::fullmag_fdm_backend_set_static_external_field_f64` oraz `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::NativeFdmBackend`.

#### Anizotropia

Uniaxialny model w konwencji audytu to

```{math}
:label: fdm-uniaxial
w_u=-K_{u1}q^2-K_{u2}q^4,
\qquad
\mathbf H_u
=\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\mathbf a,
\qquad q=\mathbf m\cdot\mathbf a.
```

Cubic jest oddzielnym wielomianem osiowym i nie wolno uogólniać prefaktora $-1/2$ z energii pola na wszystkie wyrazy. Dla jednorodnego wyrazu stopnia $p$ zachodzi $w_p=-\mu_0M_s\mathbf m\cdot\mathbf H_p/p$. Znaleziony błąd `OBS-01` dotyczy materializacji mapy energii natywnego FEM; nie jest dowodem tego samego błędu w FDM. FDM-owe ścieżki GPU znajdują się w `backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu::multilayer_anisotropy_field_kernel`, a wspólna semantyka termów w `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`. W tym audycie nie wykonano osobnego FDM testu pochodnej $K_{u1}$/$K_{u2}$ ani mapy energii; status FDM pozostaje **NOT VERIFIED**, bez przypisywania FDM potwierdzonego defektu FEM.

#### DMI

Dla stałego $D$ w konwencji objętościowej:

```{math}
:label: fdm-bulk-dmi
w_b=D\mathbf m\cdot(\nabla\times\mathbf m),
\qquad
\mathbf H_b=-\frac{2D}{\mu_0M_s}\nabla\times\mathbf m.
```

Dla interfacial DMI względem normalnej $+z$:

```{math}
:label: fdm-interfacial-dmi
w_i=D\left[m_z\nabla_\parallel\cdot\mathbf m_\parallel
-\mathbf m_\parallel\cdot\nabla_\parallel m_z\right],
\qquad
\mathbf H_i=\frac{2D}{\mu_0M_s}
\left[\nabla_\parallel m_z
-(\nabla_\parallel\cdot\mathbf m_\parallel)\mathbf e_z\right].
```

Znak $D$ jest konwencją, o ile energia, pole i chiralność są zmieniane spójnie. Dla skokowego lub przestrzennie zmiennego $D$ dochodzą składniki interfejsowe. Człon brzegowy DMI musi być zestawiony z warunkiem wymiany; zwykły zerowy strumień może oznaczać inne zadanie.

FDM GPU ma źródła `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu::multilayer_dmi_field_kernel` i `dmi_boundary.cuh`; lowering wspólnego termu przechodzi przez `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`. FDM CPU ma referencyjne obliczenia gradientów w `crates/fullmag-engine/src/fdm/cpu/fields.rs` oraz scenariusze w `crates/fullmag-engine/tests/`. Istnieje recipe `just verify-fdm-gpu-dmi-boundary-runtime`, lecz w tym audycie nie wykonano go, dlatego FDM CPU i FDM GPU dla obsługiwanych wariantów bulk/interfacial DMI są **NOT VERIFIED**; rotated-interfacial DMI ma osobną ścieżkę Python/IR/planner oraz implementacje źródłowe CPU/GPU, ale bez bieżących managed receipts jego runtime pozostaje **NOT VERIFIED**.

#### Termika, transport spinowy, SOT/STT i pole Oersteda

Termiczny składnik Brownowski nie jest polem wynikającym z funkcjonału deterministycznego. W dyskretyzacji komórkowej wariancja białego pola musi zależeć od temperatury, tłumienia, $M_s$, objętości magnetycznej i kroku czasu; jakościowy zapis skali to

```{math}
:label: fdm-thermal-scale
\left\langle H_{\mathrm{th},i}^a(t)H_{\mathrm{th},j}^b(t')\right\rangle
\propto
\frac{\alpha k_BT_i}{\mu_0\gamma_HM_{s,i}V_i}
\delta_{ij}\delta_{ab}\delta(t-t').
```

Dokładny prefaktor i sposób próbkowania przy retry/wznowieniu muszą pochodzić z kanonicznej noty i implementacji. Źródła CPU są w `crates/fullmag-engine/src/fdm/cpu/integrators.rs` oraz `crates/fullmag-engine/src/fdm/cpu/state.rs::ExchangeLlgState`; testy kontraktowe obejmują `fdm_cpu_transactionality.rs` i `fdm_adaptive_cpu.rs`. Nie wykonano w tym audycie statystycznej kwalifikacji temperatury ani niezależnego FDM GPU thermal runtime.

Transport ładunkowy i spinowy rozwiązują dodatkowe pola, których torque nie może być mylony z energią Zeemana:

```{math}
:label: fdm-transport-boundary
\nabla\cdot\mathbf j_c=0,
\qquad
\mathbf n\cdot\mathbf j_c\big|_{\mathrm{insulator}}=0,
\qquad
\boldsymbol\tau_{\mathrm{STT/SOT}}
\not\equiv-\frac{\gamma_H}{\mu_0M_s}
\mathbf m\times\frac{\delta E}{\delta\mathbf m}.
```

CPU realizacje są rozdzielone między `crates/fullmag-engine/src/fdm/cpu/transport/charge.rs::StructuredChargeProblem`, `coupled_charge_spin.rs`, `spin_drift_diffusion.rs`, `transient_spin.rs`, `oersted.rs` oraz natywne kernels `backends/fdm/cpu/transport/charge_transport_v1.cpp` i `spin_transport_v1.cpp`. Wspólne lowering torque jest w `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`.

CUDA ma osobny stan transportu w `backends/fdm/gpu/cuda/transport/context.cu` oraz integratory `backends/fdm/gpu/cuda/integrators/llg_fp32.cu` i `llg_dp45_fp32.cu`. W tym audycie nie ma nowego dowodu, że wszystkie wersje STT/SOT, transportu i Oersteda mają zgodny snapshot pola, bilans ładunku, jednostki i parity CPU/GPU. Istniejące testy `backends/fdm/tests/oersted_cuda_runtime.cu` sprawdzają głównie pola i finiteness; nie stanowią pełnej kwalifikacji energii ani transportu.

#### Integratory, relaksacja, frozen spins i obserwable

FDM CPU integratory są w `crates/fullmag-engine/src/fdm/cpu/integrators.rs`; GPU w `backends/fdm/gpu/cuda/integrators/`. Wymagane są: tableau/order dla każdego wspieranego integratora, rollback po odrzuceniu kroku, zachowanie accepted state, końce interwałów, norma magnetyzacji, etap czasu i źródło losowości. `crates/fullmag-engine/tests/fdm_abm3_cpu.rs`, `fdm_adaptive_cpu.rs`, `fdm_cpu_transactionality.rs` oraz `fdm_aos_soa_parity.rs` są dowodami ograniczonymi do swoich kontraktów.

`crates/fullmag-engine/src/fdm/shared/frozen_spins.rs::FrozenSpinsState` rozdziela zamrożenie stanu od nieaktywnej komórki. Test musi potwierdzić, że frozen spin nie jest aktualizowany, ale nadal ma jawny wpływ lub brak wpływu na każdy operator zgodnie z kontraktem. Sama maska aktywna nie rozstrzyga semantyki frozen spin.

Obserwable CPU są materializowane przez `crates/fullmag-engine/src/fdm/shared/observables.rs::EffectiveFieldObservables`, `crates/fullmag-engine/src/fdm/cpu/fields.rs` i adapter `crates/fullmag-runner/src/fdm/cpu/reference/direct_snapshot.rs::DirectFieldSnapshotCache`. GPU używa `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel`, `launch_energy_density_observable` oraz redukcji `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::reduce_external_energy_fp64`. Każdy składnik mapy musi mieć ten sam snapshot magnetyzacji i pól, indeksowanie, maskę, miarę komórki oraz metadane jednostki co skalar.

### Potwierdzone findingi FDM

#### FDM-OBS-01 / OBS-02 — P1: statyczna mapa i regionalne pola są gubione w GPU energy observables

**Status: POTWIERDZONE — źródła. Wykonanie kernela i niezależna wartość analityczna: NOT VERIFIED.**

1. `backends/fdm/gpu/cuda/runtime/context.cu::context_mark_static_external_field_profile` zapisuje mapę do `h_oe_static` i ustawia `has_static_external_field_profile=true`. Nie ustawia `has_oersted_field`; odrębna rola static map jest poprawna sama w sobie.
2. `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::reduce_external_energy_fp64` sprawdza `has_oersted_field` zarówno w warunku wcześniejszego zwrotu, jak i przy wyborze `oe_x/oe_y/oe_z`. Późniejsza gałąź `has_static_external_field_profile ? 1.0 : ...` nie naprawia wcześniejszego wyboru wskaźnika ani zwrotu `0.0`. Wariant FP32 ma tę samą konstrukcję.
3. `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel` w gałęzi `EDEN_EXT` używa wyłącznie trzech wartości `external_x/y/z`; nie ma w niej regionalnego pola ani `h_oe_static`. `launch_energy_density_observable` przekazuje kontekstowe `ctx.external_field`, więc mapowanie do payloadu nie obejmuje wszystkich rozwiązanych składowych pola.
4. Przekazanie mapy z adaptera potwierdza `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::NativeFdmBackend` i setter `fullmag_fdm_backend_set_static_external_field_f64` w `backends/fdm/api/c_api.cpp`.

Dla niezerowej mapy statycznej, zerowego pola jednorodnego i niezerowej magnetyzacji energia fizyczna $-\mu_0\sum_iV_i\mathbf M_i\cdot\mathbf H_{\mathrm{static},i}$ jest niezerowa, choć obecna ścieżka może zwrócić zero. Dla regionalnego pola skalar może otrzymać pole przez `external_energy_blocks_kernel`, a `eden_ext` nie otrzymuje tego samego składnika. Ponieważ `EDEN_TOTAL` korzysta z tej mapy gęstości, defekt przechodzi również do sumarycznego payloadu.

Test `backends/fdm/tests/oersted_cuda_runtime.cu` w scenariuszu profilu statycznego porównuje `H_ext` i `H_eff`, ale `stats.external_energy_joules` sprawdza tylko `std`; błędne zero przechodzi tę asercję. Test runnera `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::native_fdm_static_external_profile_reaches_single_grid_effective_field_when_cuda_is_available` również skupia się na polach. `backends/fdm/tests/energy_density_observable_contract.cpp::cuda_materialization_contract_is_present` potwierdza rozdzielenie `EDEN_DRIVE`, lecz nie uzasadnia pominięcia konserwatywnej static mapy Zeemana.

Naprawa musi zachować odrębne role static map, Oersteda, regionalnego pola i niekonserwatywnego drive. Potrzebne są regresje static-map-only i regional-field-only sprawdzające jednocześnie: pole, skalar analityczny, mapę oraz $\sum_i\mathrm{eden}_{ext,i}V_i=E_{ext}$. Nie należy dopisywać bezwarunkowo wszystkich torque do `E_total`.

#### FDM-OBS-02 / OBS-03 — P2: mapa gęstości i skalar rozchodzą się na częściowej komórce

**Status: POTWIERDZONE — niespójność miary z udokumentowaną całką; lokalna definicja gęstości pozostaje do rozstrzygnięcia.**

`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu::external_energy_blocks_kernel` i kernele energii anizotropii używają `volume_fraction` oraz wagi $\varphi_i$. `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu::energy_density_kernel` zna maskę aktywności, ale nie otrzymuje udziału objętościowego. `backends/fdm/api/c_api.cpp` przekazuje korekcję granicy wraz z `volume_fraction` do runtime FP64. `docs/physics/0890-energy-density-observables.md` opisuje jednak całkę jako $E_i=\sum_c\varepsilon_i(c)V_c$ z pełną objętością komórki.

Przy $\varphi=0.5$ i stałej energii na objętość magnetyczną całka mapy z pełnym $V_c$ ma dwukrotnie większy moduł niż redukcja skalarna ważona $\varphi$. To może być poprawne tylko wtedy, gdy mapa jawnie reprezentuje inną gęstość; bez takiej deklaracji skalar i mapa łamią kontrakt obserwable. Istniejący `backends/fdm/tests/partial_cell_energy_contract.cpp` sprawdza tekstową obecność `volume_fraction` w redukcjach, ale nie całkuje `eden_*` na częściowej komórce. Potrzebny jest test z jedną częściowo zapełnioną komórką, znanym $E$, oboma konwencjami i jednoznaczną metadanych miary.

### Macierz dowodów FDM CPU/GPU

Tabela opisuje stan materiału już zebranego w audycie. `Źródła` oznacza implementację widoczną w bieżącym checkoutcie; `kontrakt` oznacza test strukturalny lub jednostkowy; `runtime` wymaga rzeczywistego wykonania i artefaktu z provenance.

| Obszar | FDM CPU | FDM GPU | Wspólny warunek akceptacji | Stan |
|---|---|---|---|---|
| Wymiana | `crates/fullmag-engine/src/fdm/cpu/fields.rs`, `cpu/integrators.rs` | `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu::exchange_field_fp64_kernel`, `exchange_fp32.cu`, `multilayer_exchange.cu` | pochodna kierunkowa, jednorodny stan, interfejs $A/M_s$, brzeg i PBC, zbieżność | źródła obecne; pełny runtime/parytet **NOT VERIFIED** |
| Demag open | `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra`, `cpu/fft_backend.rs::FdmFftBackend` | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu::launch_demag_field_fp64`, `demag_fp32.cu` | self-term, wzajemność ważona $V_i$, padding, energia, analityczny orakl | **NOT VERIFIED** |
| Demag PBC/multilayer | `crates/fullmag-engine/src/fdm/cpu/fft.rs::compute_newell_kernel_spectra` i `crates/fullmag-engine/tests/multilayer_unequal_transfer.rs` | `demag_boundary_fp64.cu`, `runtime/` endpoint/cache | osobne obrazy PBC, transfer nierównych warstw i zgodność indeksowania | **NOT VERIFIED** |
| Zeeman uniform | `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms`, `shared/observables.rs::EffectiveFieldObservables` | `backends/fdm/gpu/cuda/runtime/context.cu` i reductions | $E=-\mu_0\sum V_i\mathbf M_i\cdot\mathbf H_i$, wspólny snapshot | źródła; runtime **NOT VERIFIED** |
| Static external map | mapowanie `crates/fullmag-ir/src/model.rs` i adapter FDM CPU | `context_mark_static_external_field_profile`, setter C ABI, `NativeFdmBackend` | static map w polu, skalarze, `eden_ext`, `eden_total`, z niezależną energią | **P1 POTWIERDZONE** pominięcie w GPU observables |
| Regional field | `crates/fullmag-engine/src/fdm/shared/terms.rs::EffectiveFieldTerms` | `backends/fdm/gpu/cuda/interactions/regional_field_drive.cuh`, `external_energy_blocks_kernel` | rozdział konserwatywnego pola od drive torque; pole=skalar=mapa | pominięcie w mapie GPU **POTWIERDZONE — źródła, OBS-02** |
| Uniaxial/cubic | wspólna term/materializacja CPU w `fdm/shared/terms.rs` | `multilayer_anisotropy.cu` | osobne potęgi $K_{u1},K_{u2}$, osie, pole, skalar i mapa | FDM **NOT VERIFIED**; `OBS-01` dotyczy FEM |
| Bulk/interfacial DMI | `fdm/cpu/fields.rs`, shared terms | `multilayer_dmi.cu`, `dmi_boundary.cuh` | znak, chiralność, pochodna, boundary term, $D$ stałe/skokowe | recipe istnieje; runtime **NOT VERIFIED** |
| Termika | `fdm/cpu/integrators.rs`, `cpu/state.rs::ExchangeLlgState` | integratory CUDA `llg_fp32.cu`, `llg_dp45_fp32.cu` | wariancja/kowariancja vs $T,V,\Delta t$, retry i resume | **NOT VERIFIED** |
| Charge/spin transport | `cpu/transport/charge.rs::StructuredChargeProblem`, `coupled_charge_spin.rs`, `spin_drift_diffusion.rs` | `backends/fdm/gpu/cuda/transport/context.cu` | bilans, BC izolatora, wspólny prąd, jednostki, snapshot czasu | CPU źródła; GPU/parytet **NOT VERIFIED** |
| Oersted | `cpu/transport/oersted.rs`, `backends/fdm/cpu/interactions/oersted/` | `cuda/transport/context.cu`, runtime field buffers | pole z tego samego prądu i etapu, odrębna energia/drive semantyka | test pola ograniczony; energia **NOT VERIFIED** |
| STT/SOT | `fdm/shared/terms.rs::EffectiveFieldTerms` i CPU transport | GPU integrator/context; brak w tym audycie osobnego dowodu każdego wariantu | zmiana znaku prądu, polaryzacja, maska celu, skala $M_s$/grubości | **NOT VERIFIED** |
| LLG/integratory | `cpu/integrators.rs`, `fdm_abm3_cpu.rs`, `fdm_adaptive_cpu.rs` | CUDA integrator files i runtime transaction | order, accepted/rejected state, norma, czas, brak cichego fallbacku | **NOT VERIFIED** |
| Frozen spins | `shared/frozen_spins.rs` | wspólny stan przekazany do CUDA | frozen vs inactive, wpływ na każdy operator, serializacja | kontrakty częściowe; pełna macierz **NOT VERIFIED** |
| Energy observables | `shared/observables.rs::EffectiveFieldObservables`, CPU direct snapshot | `energy_density_fp64.cu::energy_density_kernel`, `reduce_external_energy_fp64` | ta sama miara, maska, snapshot i składniki; suma mapy=skalar | **P1/P2 POTWIERDZONE** niespójności GPU |
| Topological charge | FDM planar sample w warstwie API/analizy | brak dowodu native GPU sampler w tym audycie | orientacja, normalna `xz=-y`, support topology, zbieżność | struktura walidatora PASS; backend runtime **NOT VERIFIED** |

### Braki kwalifikacji i istniejące dowody

- `benchmarks/fem-llg/qualification-registry-v1.json` ma dziewięć wpisów, wszystkie `unvalidated`; nie jest to rejestr ukończonej kwalifikacji FDM. Odczytane `tests/fem_fdm_mumax3_sinc_layer/results/current/fdm_gpu/qualification.json` i `fdm_gpu_dt50fs_diagnostic_retry/qualification.json` mają `status=not_evaluated`, `checks=[]`, `validation_state=unvalidated`, mimo zapisanych 105 accepted steps. Licznik kroków nie potwierdza trajektorii, błędu integratora, energii ani source identity.
- Seria walidatorów dała `29 passed, 8 subtests passed, 16 failed`; wszystkie 16 porażek należały do fixture `scripts/test_validate_fdm_relaxation_qualification.py`, najpierw `WinError 206`, a po próbie extended path `QualificationError: repo_root is not the Git worktree root`. To blocker narzędzia Windows przed oceną fizyki, a nie 16 znalezionych błędów solvera. Wynik pozostaje **NOT VERIFIED**.
- `scripts/check_physics_docs_gate.py::PHYSICS_FACING_PREFIXES` nie obejmuje `backends/` ani `crates/fullmag-engine/`; predykat dla drzew FDM zwrócił `False`. Zmiana kernela FDM może więc nie wymusić noty fizycznej. Jest to luka bramki, nie dowód błędu operatora.
- Wykonane testy dokumentacji: `validate_page` dla 43 istniejących map dał 34 PASS i 9 FAIL; testy walidatora dokumentacji dały 29/29 PASS. Nie dowodzi to kwalifikacji FDM runtime.
- Pakiet [physics-evidence.json](2026-09-08-physics-evidence.json) zawiera fingerprint `269ce0d7a4e0336c68aa498e0365f54a87b96830ecc8ddcc935d2f7f4f20ac90` dla 1625 odczytanych plików backendu, IR, runnera, DSL i not fizycznych. Fingerprint identyfikuje źródła, nie zbudowany runtime ani receipt.
- W audycie nie uruchamiano nowego managed FDM CPU/GPU runtime, CUDA device qualification, benchmarku CPU/GPU, walidacji µMAG ani browser/WebGL. Wszystkie takie twierdzenia pozostają **NOT VERIFIED**.

### Minimalne bramki domknięcia FDM

1. **Static/regional energy regression.** Dwa izolowane scenariusze: tylko static map oraz tylko regional field. Dla każdego sprawdzić `H_ext`, `H_eff`, skalar analityczny, `eden_ext`, `eden_total`, całkę z tą samą miarą oraz rozdzielenie `EDEN_DRIVE`.
2. **Partial-cell measure regression.** Jedna i kilka komórek z $0<\varphi<1$; jawnie wybrać `full-cell averaged density` albo `material-volume density`, zapisać canonical unit/measure i sprawdzić $\sum\mathrm{eden}_iV_i=E_i$.
3. **Operator derivative tests.** Wspólna kwadratura i maska dla exchange, demag, Zeeman, anisotropy i DMI; osobno boundary/PBC/multilayer oraz skok $A$, $M_s$, $D$.
4. **CPU/GPU parity.** Identyczne wejście, raster, maska, volume fraction, precision i source identity w receipt. Porównać pola i każdy skalar przed porównaniem trajektorii. Wymuszony GPU ma kończyć się błędem przy braku urządzenia, bez cichego CPU fallbacku.
5. **Dynamics and stochastic lanes.** Macrospin w stałym polu (kierunek i częstotliwość), norma, order/convergence każdego integratora, rollback accepted/rejected, thermal variance and equilibrium, transport current balance, Oersted same-stage snapshot.
6. **Qualification artifact.** Receipt musi zawierać requested/resolved backend/device/precision, source identity, input identity, completed exit status, output hashes, accepted/rejected steps, stop reason i niezależne bramki fizyczne. `unvalidated` lub sama obecność pliku wynikowego nie kwalifikuje lane.

Do czasu przejścia tych bramek nie należy opisywać FDM CPU/GPU jako w pełni poprawnego i zwalidowanego we wszystkich oddziaływaniach. Najsilniejsze bieżące ustalenia FDM to dwa problemy obserwabli GPU: pominięcie statycznej/regionalnej energii w materializacji pól oraz niespójna miara częściowej komórki. Pozostałe oddziaływania mają źródła, ale brak im aktualnego, przypiętego do źródeł dowodu pełnej kwalifikacji.


<a id="audit-fem"></a>

## Aneks audytowy FEM — operatory, strategie demagnetyzacji i topologia

Data: 2026-09-08. Aneks odnosi się do raportu nadrzędnego
`docs/audits/2026-09-08-fdm-fem-physics-audit.md`. Nie powtarza jego ustaleń
OBS-01–OBS-05; wskazuje ich zakres tam, gdzie dotyczy on FEM.

### Zakres i poziomy dowodów

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

### Wspólna postać wariacyjna

Dla magnetyzacji zredukowanej `m=M/Ms` oraz pola w amperach na metr obowiązuje
kontrakt

```{math}
:label: fem-audit-variation
\delta E[\mathbf m;\mathbf v]
=-\mu_0\int_{\Omega_m}M_s\mathbf H_{\rm term}\cdot\mathbf v\,dV.
```

$\mathbf m$ i $\mathbf v$ są bezwymiarowe, $M_s$ i $\mathbf H$ mają jednostkę $\mathrm{A/m}$, a energia ma jednostkę $\mathrm J$. Każdy test pola musi używać tej samej kwadratury, maski domeny,
wartości `Ms` i warunku brzegowego co obliczenie energii. Część równoległa do $\mathbf m$ nie zmienia momentu LLG ani pracy stycznej wariacji; może jednak zmienić niepoprawną rekonstrukcję energii z iloczynu $\mathbf m\cdot\mathbf H$.

### Wymiana

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

### Demagnetyzacja Poisson–Robin/Dirichlet

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

### Fredkin–Koehler FEM/BEM

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

### DMI

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
jest więc odrzucane bez fallbacku. Rotated-interfacial DMI ma pełną ścieżkę
źródłową Python → IR → planner → CPU/GPU dla time-domain, w tym osobne
`H_rotated_dmi` i `eden_rotated_dmi`; brak bieżących managed receipts
pozostawia wykonanie i parytet **NOT VERIFIED**.

### Anizotropia

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

### Magnetoelastyka

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

### Mixed-P1 i fail-closed topology

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

### Macierz statusu FEM

| Obszar | FEM CPU: źródło | FEM GPU: źródło | Runtime / physics qualification |
|---|---|---|---|
| exchange | `implemented` | operator/kontrakt obecny | `NOT VERIFIED` |
| Poisson airbox | assemble/solve/recovery present | CUDA/Hypre path present | `NOT VERIFIED` |
| FK FEM/BEM | CPU dense/H2 | device path present | `NOT VERIFIED` |
| bulk/interfacial DMI | `implemented` | kernel present, mixed guard | `NOT VERIFIED`; GPU mixed unsupported |
| uniaxial/cubic | local fields present | kernels present | `NOT VERIFIED`; OBS-01 dotyczy mapy |
| prescribed magnetoelastic | field + energy present | kernel present | `NOT VERIFIED`; mixed scope excludes |
| mixed prism/pyramid/tet P1 | fail-closed guard | fail-closed guard | source only; `NOT VERIFIED` |

Minimalny następny pakiet dowodowy powinien mieć osobne receipt’y dla
Poisson i FK, exchange derivative/energy, DMI chirality i boundary tilt,
anizotropii `Ku2`, magnetoelastyki oraz mixed-P1 CPU/GPU. Każdy receipt musi
przypinać wejścia, siatkę, precision, requested/resolved device, operator IDs,
residual i brak fallbacku; sama kompilacja, znaleziony kernel lub recipe
`just` nie wystarczają.

<a id="audit-dynamics"></a>

## Sekcja audytu: dynamika, relaksacja i transport

Data audytu: **2026-09-08**. Checkout i fingerprint źródeł są opisane w raporcie nadrzędnym
`docs/audits/2026-09-08-fdm-fem-physics-audit.md`, dla którego punktem odniesienia jest
`6cc5e5e0396050f5f859a0e2b28dd3f963d3f7bb`. Ta sekcja porządkuje wykonawczą stronę
LLG, relaksacji, termiki, STT/SOT, transportu ładunku i spinu, pola Oersteda oraz
problemów modalnych. Równania bazowe są w raporcie głównym; tutaj najważniejsze są
ścieżki kodu, odmowy plannera, granice realizacji i status dowodów.

### Jak czytać wynik

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

### Wyprowadzenia kontrolne dla dynamiki i sprzężeń

#### Torque Gilberta a jawny RHS

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

#### Brownowski szum termiczny

Dla niezależnych standardowych zmiennych normalnych $\xi_i^a$ i pola stałego w próbkowanym interwale $\Delta t$:

```{math}
:label: dyn-audit-brown-sigma
H_{{\rm th},i}^{a}=\sigma_i\xi_i^a,
\qquad
\sigma_i^2=\frac{2\alpha k_BT}{\mu_0\gamma_HM_{s,i}V_i\Delta t}.
```

$k_B$ ma jednostkę $\mathrm{J/K}$, $T$ — $\mathrm K$, $V_i$ — $\mathrm{m^3}$, a $\sigma_i$ — $\mathrm{A/m}$. Średnia pola to zero, wariancja skaluje się jak $T/(V_i\Delta t)$. `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp::thermal_brown_sigma` implementuje dokładnie ten prefaktor z nieprzeskalowanym przez Gilberta `gyromagnetic_ratio`. Dla niepoprawnych lub niedodatnich argumentów helper zwraca zero; nie zastępuje to walidacji publicznego wejścia.

Lumping masy FEM przypisuje tu węzłową objętość $V_i$; nie jest automatycznie pełną kowariancją szumu dla consistent mass. Ta wymaga osobnego wyprowadzenia względem macierzy masy. Wspólne losowanie Heuna, interpretacja Stratonovicha i równowagowy rozkład muszą być sprawdzone razem. Sama prawidłowa sigma nie dowodzi poprawnego stochastycznego integratora. Wymaganie identycznych trajektorii różnych generatorów CPU/GPU nie zastępuje kwalifikacji statystycznej.

#### Zachowanie ładunku i pole Oersteda

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

#### Linearizacja modalna

Dla stanu bazowego $\mathbf m_0$ i stycznej perturbacji $\boldsymbol\eta$:

```{math}
:label: dyn-audit-modal
\mathbf m=\mathbf m_0+\epsilon\boldsymbol\eta+O(\epsilon^2),
\quad \mathbf m_0\cdot\boldsymbol\eta=0,
\quad \mathsf B\dot{\boldsymbol\eta}=\mathsf A\boldsymbol\eta,
\quad \mathsf A\mathbf x=\lambda\mathsf B\mathbf x.
```

W konwencji $\boldsymbol\eta(t)=e^{\lambda t}\mathbf x$ częstotliwość to $|\operatorname{Im}\lambda|/(2\pi)$ w hercach, a $\operatorname{Re}\lambda$ określa wzrost lub tłumienie w $\mathrm{s^{-1}}$. Residual eigensolve nie potwierdza równowagi $\mathbf m_0$ ani zgodności z funkcjonałem energii. Operator musi uwzględniać tę samą masę, demag, aktywne oddziaływania i warunki brzegowe co dynamika. Właściciel: `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`. Normalność operatora ani ortogonalność modów w zwykłym iloczynie euklidesowym nie są ogólną własnością tłumionego LLG.

### Integracja LLG i transakcja kroku

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

### Relaksacja i znaczenie czasu

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

### STT, SOT i torques z transportu

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

### Termika i retry

FDM CPU przechowuje temperaturę, seed i `thermal_step`; `crates/fullmag-engine/src/fdm/cpu/integrators.rs::set_thermal_dt_for_attempt`
ustawia rozmiar interwału próby, a akceptacja wywołuje `advance_thermal_step`. Mechanizm próby ponownie używa tego samego losowania interwału i skaluje je do nowego `dt`, nie zwiększając licznika przy odrzuceniu. Publiczny planner `crates/fullmag-plan/src/fdm.rs` odrzuca jednak połączenie Brown thermal z adaptive timestep oraz ABM3; obecność tego mechanizmu nie kwalifikuje adaptacyjnego SDE. To chroni od przedwczesnego przesunięcia procesu
losowego, lecz wymaga niezależnej walidacji rozkładu i korelacji czasowej.

CPU FEM ma `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp::thermal_brown_sigma`, `backends/fem/cpu/mfem/interactions/thermal_brown_field.cpp` i
`backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp`; test `backends/fem/tests/thermal_brown_contract.cpp` sprawdza
konwencję sigma i politykę nieprawidłowych danych. GPU FEM ma `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu` oraz `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu`, lecz `crates/fullmag-plan/src/fem.rs` jawnie odrzuca strict FEM GPU `ThermalNoise` przez `CAP-THERM-GPU-001`. Obecność tych plików nie oznacza publicznie dostępnej realizacji. CUDA FDM ma odpowiadający kontrakt i test FSAL/thermal, lecz żaden
z tych testów nie jest pełnym receiptem GPU z seedem, urządzeniem, trajektorią i statystyką.

### Charge, spin i sprzężenie czasowe

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

### Oersted i pola zależne od czasu

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

### Próbkowanie oraz mody

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

### Ustalenia i ryzyka

| ID | Priorytet | Ustalenie | Status |
|---|---:|---|---|
| DYN-01 | P1 | Źródła integratorów istnieją w czterech drzewach, lecz brak kompletu świeżych managed receipts obejmującego LLG, energię, normę i parytet CPU/GPU. | `NOT VERIFIED` |
| DYN-02 | P1 | FDM CPU odrzuca nie-Heunowy/adaptive wariant dla nieprzejściowego spin transportu; fallback jest zabroniony. | `POTWIERDZONE — fail-closed` |
| DYN-03 | P1 | FDM GPU odrzuca adaptive device graph z aktywnym GPU transportem (`adaptive_device_loop_gpu_transport_unsupported`). | `POTWIERDZONE — ograniczenie` |
| DYN-04 | P1 | Termika ma transakcyjny retry CPU, ale rozkład, seed parity, GPU execution i statystyka nie są kwalifikowane. | `NOT VERIFIED` |
| DYN-05 | P2 | Accepted-step scheduling nie dostarcza sam z siebie równomiernej serii do widma. | `POTWIERDZONE — ograniczenie` |
| DYN-06 | P1 | Mody są opisane przez FEM linearized pencil; brak dowodu wykonania i zgodności z nieliniowym LLG. | `NOT VERIFIED` |
| DYN-07 | P2 | Direct minimization publikuje synthetic step metrics, nie fizyczny czas i nie dynamiczne próbki. | `POTWIERDZONE — semantyka` |

### Warunki domknięcia

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

<a id="audit-dsl"></a>

## Audyt Python DSL → ProblemIR → planner: capability i provenance

Data: 2026-09-08  
Checkout audytowany: `C:/git/fullmag/fullmag`  
Zakres: publiczne modele autora, ich lowering do `ProblemIR`, reguły planera
oraz deklarowane realizacje FDM/FEM CPU/GPU. Ten rozdział jest dowodem
źródłowym i kontraktowym. Nie jest dowodem wykonania solvera ani kwalifikacji
runtime.

### Zasada oceny

Model obecny w Pythonie nie oznacza jeszcze, że można go uruchomić na każdym
lane. Rozdzielam cztery stany: authorable, planner-legal, executable oraz
validated. `source_visible`, `implemented` i `semantic_only` nie są zamieniane
na `production_executable` bez odpowiadającego receipts i workloadu.

`ProblemIR` ma przechowywać fizyczną intencję, a planner ma dopiero rozstrzygać
realizację. `auto` może zostać rozwiązane, lecz nie może zniknąć z provenance.
Żądanie GPU jest twardym ograniczeniem; odrzucenie braku capability musi
nastąpić przed wejściem do backendu i nie może być opisane jako CPU fallback.

### Macierz modeli Python → IR → lane

| Model publiczny | Python → IR | Planner / runtime | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|---|---|
| Demag `model="airbox"` | `Demag.to_ir` → `EnergyTermIR::Demag` | Poisson airbox po jawnej legalizacji | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | source/contract path obecny; runtime NOT VERIFIED | source/contract path obecny; runtime NOT VERIFIED |
| Demag `realization="poisson_robin"` | `Demag.to_ir` → `RequestedFemDemagIR::PoissonRobin` | konkretny resolved FEM Poisson–Robin | NOT VERIFIED | NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED |
| Demag `realization="poisson_dirichlet"` | `Demag.to_ir` → `RequestedFemDemagIR::PoissonDirichlet` | konkretny resolved FEM Poisson–Dirichlet | NOT VERIFIED | NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED | planner-legal w bounded mixed-P1 scope; managed proof NOT VERIFIED |
| Demag `fredkin_koehler` | `Demag.to_ir` → `RequestedFemDemagIR::FredkinKoehler` | body-only FEM/BEM realization, osobna od airbox | unsupported jako FDM model | unsupported jako FDM model | source path / planner state present; managed runtime NOT VERIFIED | source path / planner state present; managed runtime NOT VERIFIED |
| Demag `bem` | `Demag.to_ir` → `RequestedFemDemagIR::Bem` | jawnie odrzucany jako niezrealizowany wariant | unsupported | unsupported | unsupported; planner rejection | unsupported; planner rejection |
| Demag `fmm` | `Demag.to_ir` → `RequestedFemDemagIR::Fmm` | jawnie odrzucany jako niezrealizowany wariant | unsupported | unsupported | unsupported; planner rejection | unsupported; planner rejection |
| Exchange | `Exchange.to_ir` → `EnergyTermIR::Exchange` | zwykły konserwatywny term; lane proof zależny od workloadu | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | bounded mixed-P1 source/contract scope; runtime NOT VERIFIED | bounded mixed-P1 source/contract scope; runtime NOT VERIFIED |
| Zeeman | `Zeeman.to_ir` → `EnergyTermIR::Zeeman` | jawnie modelowane pole zewnętrzne | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | bounded scope; runtime NOT VERIFIED | bounded scope; runtime NOT VERIFIED |
| Interfacial DMI | `InterfacialDMI.to_ir` → `EnergyTermIR::InterfacialDmi` | tylko zwykły wariant z obecnym loweringiem | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | capability/status zależne od planera; runtime NOT VERIFIED | wybrane mixed-P1 konfiguracje odrzucane; runtime NOT VERIFIED |
| Bulk DMI | `BulkDMI.to_ir` → `EnergyTermIR::BulkDmi` | planner zachowuje jawne ograniczenia boundary/normal | source present; runtime NOT VERIFIED | source present; runtime NOT VERIFIED | capability/status zależne od planera; runtime NOT VERIFIED | wybrane mixed-P1 konfiguracje odrzucane; runtime NOT VERIFIED |
| Rotated-interfacial DMI | `RotatedInterfacialDMI.to_ir` → `EnergyTermIR::RotatedInterfacialDmi` | authoring/lowering/planning; frequency-domain jawnie odrzucany | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED | source/contract PASS; runtime NOT VERIFIED |
| `StaticFieldMap` | `StaticFieldMap.to_ir` → zewnętrzny field payload | FEM jest jawnie odrzucany przez planner | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | unsupported w bieżącym plannerze | unsupported w bieżącym plannerze |
| `ThermalNoise` | `ThermalNoise.to_ir` → term termiczny | FEM GPU jest jawnie odrzucany | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | status tego audytu: NOT VERIFIED | unsupported w bieżącym plannerze |

Anizotropie są serializowane inaczej niż `EnergyTermIR`: legacy obiekty `UniaxialAnisotropy` i `CubicAnisotropy` z `packages/fullmag-py/src/fullmag/model/energy.py` są migrowane przez `packages/fullmag-py/src/fullmag/model/problem.py` do parametrów materiałowych `MaterialIR` w `crates/fullmag-ir/src/model.rs`. Dotyczy to `uniaxial_anisotropy`, `uniaxial_anisotropy_k2`, osi oraz `cubic_anisotropy_kc1/kc2/kc3`. Źródła operatorów są obecne we wszystkich czterech realizacjach; kwalifikacja pozostaje NOT VERIFIED. Rozbieżność docstringa i konwencji Ku2 opisuje DOC-03, a materializację mapy FEM — OBS-01.

Pozostałe jawne warianty `EnergyTermIR` to `OerstedCylinder`, `OerstedField` z `OerstedFieldModelIR::FromCurrentSolution` oraz `Magnetoelastic { magnet, body, law }`. Torque i transport nie są sprowadzane do tych wariantów energii; mają odrębne źródła, modele i relacje w grafie fizyki. Ich zakres czterech realizacji i ograniczenia podaje rozdział dynamiki/transportu, a prescribed-strain — aneks FEM. Klasy transportowe i sam graf nie dowodzą sprzężonego wykonania.

`Demag()` bez argumentów serializuje `realization="auto"`; `Demag(model="airbox")` serializuje już `poisson_robin`. Nie są to identyczne żądania. Wiersze jawnych metod airbox dotyczą FEM; nie zweryfikowano w tej macierzy skutku przekazania tych metod do FDM i nie należy interpretować komórek NOT VERIFIED jako potwierdzenia obsługi Poissona przez FDM.

#### Ścieżki źródłowe macierzy

- `packages/fullmag-py/src/fullmag/model/energy.py::Demag` definiuje publiczny
  wybór modelu demagnetyzacji i jego serializację.
- `packages/fullmag-py/src/fullmag/model/energy.py::InterfacialDMI`,
  `BulkDMI` i `RotatedInterfacialDMI` są oddzielnymi wariantami DMI.
- `packages/fullmag-py/src/fullmag/model/energy.py::StaticFieldMap` i
  `packages/fullmag-py/src/fullmag/model/energy.py::ThermalNoise` są
  authorable, ale ich obecność nie znosi plannerowych ograniczeń lane.
- `crates/fullmag-ir/src/plan.rs::RequestedFemDemagIR` zawiera warianty
  `PoissonDirichlet`, `PoissonRobin`, `Bem`, `FredkinKoehler` i `Fmm`.
- `crates/fullmag-ir/src/plan.rs::ResolvedFemDemagIR` nie ma wariantu `Auto`;
  resolved plan musi być konkretny przed runnerem.
- `crates/fullmag-ir/src/study.rs::EnergyTermIR` jest wspólnym miejscem
  loweringu termów fizycznych i zawiera `RotatedInterfacialDmi`.
- `packages/fullmag-py/src/fullmag/model/problem.py::Problem.to_ir` tworzy
  canonicalny dokument z `backend_policy`, `validation_profile`, energią,
  materiałami i runtime metadata.
- `crates/fullmag-plan/src/lib.rs::physics_graph_realization_provenance`
  należy do warstwy, która opisuje realizację grafu fizycznego w planie.
- `crates/fullmag-runner/src/capabilities.rs::mixed_p1_feature_capabilities`
  publikuje bounded capability mixed-P1, ale sama publikacja nie jest receipt.
- `docs/specs/capability-matrix-v0.json::features` utrzymuje osobne statusy
  implementation, executability, validation i qualification.

### Finding DSL-CAP-01 — rotated-interfacial DMI zostało zintegrowane w DSL

**Status poprawki: source/contract PASS; runtime i kwalifikacja czterech lane’ów
pozostają NOT VERIFIED.**

`RotatedInterfacialDMI` zachowuje podpisane $D$ dla `D21=D32=D` w osobnym
wariancie `EnergyTermIR::RotatedInterfacialDmi`. Walidacja odrzuca wartości
nieskończone i duplikaty, planner zachowuje term dla FDM/FEM CPU/GPU w
time-domain oraz jawnie odrzuca wykonanie częstotliwościowe. Round-trip
Python/IR i testy operatorów przechodzą.

Brak bieżących managed receipts oznacza, że integracja źródłowa nie dowodzi
wykonania ani parytetu. Testy znaku, energii i pola wymagają nadal kwalifikacji
osobno dla FDM CPU/GPU i FEM CPU/GPU.

### Finding DSL-CAP-02 — `RuntimeSelection.precision()` gubi politykę FDM

**Status: POTWIERDZONE zachowanie settera; ocena jako defekt kontraktu pozostaje RYZYKIEM do rozstrzygnięcia.**

`packages/fullmag-py/src/fullmag/model/problem.py::RuntimeSelection.precision`
tworzy nowy wybór precyzji, ale nie zachowuje `fdm_precision_policy`. W
zweryfikowanym przypadku przejście przez `.precision("double")` usuwa wcześniej
ustaloną politykę `single_storage_fp64_reduction`. Wynikowy `to_runtime_metadata`
nie niesie wtedy tego żądania dalej.

To nie jest dowód, że kernel użył złej precyzji. Jest to dowód utraty jawnej
intencji przed plannerem i potencjalnej niespójności między skryptem, IR,
planem i receipt. Wywołanie `precision("double")` może być świadomym zastąpieniem wcześniejszej polityki przez użytkownika. Samo zniknięcie poprzedniego wyboru nie dowodzi wtedy błędu. Należy określić kontrakt kolejności setterów, w tym zachowanie po ustawieniu tej samej precyzji; potrzebna jest udokumentowana zasada zastąpienia, zachowania lub jawnego odrzucenia konfliktu.

Obszar dotknięty:

- `RuntimeSelection.fdm_precision_policy` — pole żądania;
- `RuntimeSelection.precision` — mutator zwracający nowy obiekt;
- `RuntimeSelection.to_runtime_metadata` — granica eksportu do IR;
- `Problem.to_ir` — miejsce zapisu `runtime_selection` i `backend_policy`.

Status walidacji fizycznej i runtime tego findingu: NOT VERIFIED. Potrzebny
focused test powinien ustawić `single_storage_fp64_reduction`, wywołać setter
precyzji, sprawdzić zachowanie polityki i porównać canonicalny IR.

### Finding DSL-CAP-03 — override urządzenia ma osobną granicę provenance

`packages/fullmag-py/src/fullmag/runtime/loader.py::apply_ir_runtime_device_override`
zapisuje launcherowy override w osobnym `runtime_device_override`, natomiast
`apply_ir_runtime_device_selection` modyfikuje mapy `runtime_selection` i ich
`gpu_count`/`device_index`. `Problem.to_ir` używa override także do preflightu
bounded mixed-P1, lecz nie powinien udawać, że override jest authored intent.

**Wniosek: POTWIERDZONE rozdzielenie warstw; ryzyko provenance wymaga kontroli
runnera.** Loader/runner musi przechować authored request, effective request i
resolved execution jako trzy rozróżnialne wartości. Nie wolno wyprowadzać
resolved device tylko z nazwy engine ani nadpisywać authored `auto` bez śladu.

Warstwa artefaktów zachowuje ten rozdział w
`crates/fullmag-runner/src/artifacts.rs::final_execution_resolution_provenance`:
publikuje osobno `authored_request`, `effective_request` i
`resolved_execution`, odrzuca niezgodny wymuszony backend, device lub precision
oraz fallback w trybie strict. Regresja
`final_metadata_preserves_authored_request_and_managed_effective_override`
sprawdza przypadek authored CPU, managed GPU override i resolved GPU.

### Finding DSL-CAP-04 — fail-closed combinations są poprawnym ograniczeniem

`crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation` odrzuca
niekonserwatywne torque w workflow relaksacji, zamiast traktować je jako
minimum energii. Ten sam plannerowy kontrakt rozdziela także obecność modelu
od legalności lane.

Potwierdzone przykłady odrzucenia:

- `StaticFieldMap` w planie FEM nie jest obecnie automatycznie uznawany za
  executable tylko dlatego, że ma klasę DSL;
- `ThermalNoise` na FEM GPU jest odrzucany przed uruchomieniem;
- mieszany P1 z GPU DMI jest odrzucany przez stabilny predicate
  `gpu_dmi_kernel_not_mixed_p1`;
- `Bem` i `Fmm` są jawnie niezaimplementowanymi wariantami
  `RequestedFemDemagIR`;
- `TangentPlaneImplicit` w FDM jest FEM-only i nie może spaść do CPU bez
  jawnej, dozwolonej zmiany żądania.

Te odrzucenia są dowodem kontroli kontraktu, nie dowodem pełnej poprawności
operatorów. Każdy unsupported path powinien nadal przekazać requested
backend/device/precision/mode oraz reason code do diagnostyki.

### Provenance i granice dowodu

`Problem.to_ir` zapisuje requested backend oraz precision w
`backend_policy`, a execution mode w `validation_profile`. To potwierdza
serializację intencji, ale nie potwierdza resolved device ani wykonania.

`RequestedFemDemagIR` i `ResolvedFemDemagIR` potwierdzają, że auto-resolution
ma dwa poziomy reprezentacji. `ResolvedFemDemagIR` nie może pozostać `auto`.
Brak managed receipt, source identity, device identity, fallback mask i
completed artifact oznacza NOT VERIFIED niezależnie od statusu `implemented`.

W szczególności source/contract test `mixed_p1_feature_capabilities` nie
promuje FEM CPU/GPU do `production_executable`; obecny status opisuje bounded
zakres i wymaga świeżego managed workloadu. Podobnie obecność publicznego
modelu DMI nie promuje każdej jego realizacji.

### Konkluzja zakresowa

Najmocniejsze ustalenia DSL/capability to źródłowo zamknięta ścieżka
rotated-interfacial DMI bez kwalifikacji runtime, naprawiony kontrakt
`fdm_precision_policy` w `precision()` oraz osobna granica
launcherowego override oraz poprawne fail-closed odrzucenia unsupported
combination. Żaden z tych punktów nie upoważnia do twierdzenia o parytecie
FDM/FEM CPU/GPU. Do kwalifikacji pozostają niezależne testy round-trip,
planner acceptance/rejection, managed execution, source-bound provenance i
physics validation.

## Addendum remediacji — 2026-09-08

Poniższe statusy opisują bieżący working tree po poprawkach. Oryginalne
findings wyżej pozostają historycznym zapisem stanu audytowanego źródła.

| Finding | Stan poprawki | Bieżący dowód |
|---|---|---|
| OBS-01 | naprawiono materializację `eden_ani` i `eden_total` w natywnym FEM oraz helperze referencyjnym przez bezpośredni funkcjonał $-K_{u1}q^2-K_{u2}q^4$ | regresja $K_{u1}=0$, $K_{u2}=20000\ \mathrm{J/m^3}$, $q=0.5$ daje $-1250\ \mathrm{J/m^3}$ — PASS |
| OBS-02 | statyczny profil i regionalne pola są uwzględniane w skalarze oraz mapie energii FDM GPU; dodano analityczną regresję static-map-only dla FP64/FP32 | natywna biblioteka CUDA oraz kontrakt źródłowy zbudowane w managed obrazie; cztery focused testy runnera FP64/FP32, w tym observable CPU/GPU parity — PASS; pełny receipt recepty wydaniowej `NOT VERIFIED`, bo jej twardo zakodowany linuksowy bind mount nie działa na tym hoście Windows |
| OBS-03 | `volume_fraction` waży materializowane mapy energii zgodnie z kontraktem pełnej komórki; DMI zachowuje dotychczasową miarę skalaru | focused CUDA energy-density snapshot/global-energy parity dla FP64/FP32 — PASS; pełna kwalifikacja wydaniowa pozostaje `NOT VERIFIED` z powodu granicy recepty opisanej przy OBS-02 |
| OBS-04 | natywny FEM przypisuje obiektom elementy z `object_segments`/`mesh_parts`, całkuje na nich średnią magnetyzację i rzeczywiste składniki energii przez kwadraturę MFEM oraz odrzuca nakładający się lub niepełny podział; `__air__` jest wykluczony | focused Rust regression wspólnych węzłów — PASS; `fem_object_stats_contract` z dwoma tetraedrami współdzielącymi ścianę przeszedł w managed FEM CPU, potwierdzając analityczne energie Zeemana, sumę domeny oraz fail-closed duplicate/out-of-range — PASS; ten sam kontrakt przeszedł także z `FULLMAG_OBJECT_STATS_DEVICE=cuda`, potwierdzając device readback i identyczne sumy — PASS |
| OBS-05 | oddzielono potrzebę początkowych statystyk od potrzeby początkowych payloadów pól; scalar-only live wymusza rzeczywisty snapshot statystyk | ukierunkowana regresja — PASS |
| DOC-01 | bramka obejmuje `backends/` i `crates/fullmag-engine/` | physics documentation gate — PASS |
| DOC-02 | poprawiono walidator deklaracji i wszystkie wskazane mapy źródeł | 41/41 map — PASS; testy walidatora 17/17 — PASS |
| DOC-03 | docstring `UniaxialAnisotropy` opisuje kanoniczną konwencję potęgową i mapowanie z konwencji sinusowej | focused Python API tests — PASS |
| VAL-01 | bez zmiany statusu: dziewięć wierszy LLG pozostaje `unvalidated`, bo raport nie zawiera wymaganych nowych kampanii managed CPU/GPU/parity | brakujące dowody kwalifikacji pozostają jawne; nie zastąpiono ich testem źródłowym |
| VAL-02 | walidator kwalifikacji porównuje ścieżki przez `Path.samefile()`, a fixture mieści się w limitach ścieżek Windows | validator tests 16/16 — PASS |
| DSL-CAP-02 | ponowienie tej samej precyzji zachowuje zgodną politykę FDM, a rzeczywista zmiana precyzji jawnie ją usuwa | focused Python API tests 2/2 — PASS |
| DSL-CAP-03 | artefakt zachowuje osobno authored request, managed effective override i resolved execution oraz odrzuca sprzeczne wymuszenie lub strict fallback | focused runner provenance regression — PASS |

DSL-CAP-01 jest zintegrowane źródłowo: publiczne `RotatedInterfacialDMI`,
`ProblemIR`, planner oraz implementacje FDM/FEM CPU/GPU są obecne i mają
skupione testy kontraktowe. FDM CPU przeszedł trzy testy wzoru, energii i
materializacji; FDM GPU przeszedł boundary runtime na RTX 4080 SUPER z
device-only receipt. Focused managed test natywnego FEM potwierdza na CPU i
GPU niezerowe `H_rotated_dmi` dla aktywnego termu, a test pochodnej energii
FEM także przeszedł; nie jest to jednak
kwalifikacja scenariusza bimeronu ani parytet czterech lane’ów, które nadal
pozostają `NOT VERIFIED`.

