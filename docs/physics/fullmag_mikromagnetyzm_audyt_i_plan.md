
# Fullmag — audyt poprawności implementacji oddziaływań mikromagnetycznych oraz plan rozszerzenia o kompletne sprzężenia FDM/FEM

**Autor opracowania:** GPT-5.4 Thinking  
**Data:** 2026-03-29  
**Repozytorium analizowane:** `MateuszZelent/fullmag` (`master`)  
**Charakter dokumentu:** audyt techniczno-fizyczny + projekt architektury implementacyjnej + plan walidacji

---

## 0. Cel dokumentu

Celem tego dokumentu jest:

1. **uczciwa ocena aktualnego stanu Fullmag** na podstawie bieżącego repozytorium;
2. **ocena poprawności fizycznej i numerycznej** istniejących oraz zaprojektowanych oddziaływań;
3. **zaprojektowanie kompletnej, spójnej architektury** dla wszystkich kluczowych oddziaływań mikromagnetycznych;
4. **zaproponowanie właściwego sposobu implementacji pełnego, dwustronnego sprzężenia magnetoelastycznego**, a nie uproszczonego jednostronnego modelu;
5. **zaprojektowanie ścieżki dla symulacji z prądem elektrycznym** w obu metodach: **FDM** i **FEM**;
6. wskazanie **kolejności wdrożenia**, testów walidacyjnych i kryteriów „done”.

Dokument jest napisany tak, aby mógł pełnić równocześnie rolę:

- wewnętrznej specyfikacji fizycznej,
- specyfikacji implementacyjnej,
- checklisty walidacyjnej,
- podstawy do dalszych not `docs/physics/*.md` w repo.

---

## 1. Uczciwy stan aktualny Fullmag

### 1.1. Co repo już deklaruje architektonicznie

Aktualne repo jest zorganizowane bardzo sensownie z punktu widzenia długofalowego rozwoju:

- wspólny **Python DSL** (`packages/fullmag-py`) opisuje **problem fizyczny**, nie siatkę numeryczną;
- wspólny **ProblemIR** ma być backend-neutral;
- backendi mają być rozdzielone na:
  - **FDM**,
  - **FEM**,
  - **Hybrid**;
- projekt ma już silną kulturę „**physics-first**”, czyli wymóg spisywania not fizycznych przed kodem;
- planowany jest ciężki backend FEM oparty o:
  - **MFEM**,
  - **libCEED**,
  - **hypre**;
- FDM ma już publiczną ścieżkę wykonawczą i ścieżkę CUDA.

To jest bardzo dobry fundament.

### 1.2. Co jest faktycznie wykonawcze dziś

Na podstawie README, `ProblemIR` i `Capability matrix`, **uczciwie public-executable** są dziś przede wszystkim:

- geometria `Box`,
- materiały z `Ms`, `A`, `alpha`,
- ferromagnet z `m0`,
- `Exchange`,
- `Demag`,
- `Zeeman`,
- `LLG(heun)`,
- część algorytmów relaksacji,
- FDM CPU/CUDA,
- węższy bootstrapowy wycinek FEM.

### 1.3. Co już istnieje semantycznie, ale jeszcze nie jest policzone end-to-end

Repo ma już dobrze opisane lub częściowo przygotowane semantyki dla:

- `InterfacialDMI`,
- `BulkDMI` (w notach fizycznych),
- bardziej zaawansowanych relaksacji,
- rozszerzeń FEM.

Natomiast **bardzo ważne**: to jeszcze nie oznacza pełnej realizacji numerycznej we wszystkich backendach.  
W szczególności:

- wiele oddziaływań jest na poziomie **specyfikacji fizycznej**,
- część jest na poziomie **IR/API**,
- część ma dopiero **plan implementacyjny**,
- a nie pełny „public executable”.

### 1.4. Najważniejszy wniosek audytowy

Fullmag **nie jest dziś jeszcze kompletnym solverem mikromagnetycznym** obejmującym wszystkie standardowe oddziaływania, STT/SOT, pełną magnetoelastykę i pełne sprzężenie transportowe.

Natomiast:

- ma **bardzo dobry rdzeń architektoniczny**,
- ma **dobrze obrany kierunek fizyczny**,
- i da się z niego zrobić system znacznie bardziej naukowo poprawny niż wiele historycznych kodów, **jeśli utrzyma się rygor wspólnej semantyki energii, operatorów i warunków brzegowych**.

---

## 2. Kluczowa zasada: semantyka musi być energetyczna, nie „field-first only”

To jest najważniejsza zasada całego projektu.

Dla każdego oddziaływania trzeba definiować:

1. **energię** \(E[m,\dots]\),
2. **wariację**,
3. **pole efektywne** \(H_\mathrm{eff}\),
4. **warunki brzegowe / interfejsowe**,
5. **dyskretyzację zgodną energetycznie**,
6. **obserwable i testy zgodności**.

Nie wolno budować solvera jako zestawu „heurystycznych pól” bez zakotwiczenia w energii, bo wtedy:

- łatwo zgubić znaki,
- łatwo zgubić jednostki,
- łatwo źle potraktować granice,
- a FDM i FEM rozjadą się semantycznie.

Dlatego **wspólnym inwariantem FDM i FEM ma być funkcjonał energii i jego wariacja**, a nie identyczny stencil lub identyczna forma macierzowa.

---

## 3. Docelowa klasyfikacja oddziaływań w Fullmag

Docelowo Fullmag powinien objąć co najmniej:

### 3.1. Lokalno-różniczkowe oddziaływania magnetyczne

- exchange,
- uniaxial anisotropy,
- cubic anisotropy,
- surface/interface anisotropy,
- interfacial DMI,
- bulk DMI,
- wyższe rzędy exchange / biquadratic / exchange frustration (opcjonalnie później).

### 3.2. Nielokalne oddziaływania magnetostatyczne

- demag / dipolar field,
- interlayer dipolar coupling,
- stray field coupling do zewnętrznych ciał magnetycznych.

### 3.3. Oddziaływania prądowe i spintronikowe

- Zeeman z pola zewnętrznego,
- pole Oersteda od prądu,
- STT typu **Zhang–Li** (CIP),
- STT typu **Slonczewski** (CPP),
- SOT:
  - damping-like,
  - field-like,
- spin diffusion / spin accumulation jako wariant pełny.

### 3.4. Oddziaływania magnetoelastyczne i wielofizyczne

- jednoosiowa magnetoelastyka,
- kubiczna magnetostrykcja,
- pełne sprzężenie:
  - magnetyzacja → odkształcenie/naprężenie,
  - naprężenie/odkształcenie → pole magnetoelastyczne,
- ewentualnie dalej:
  - termika,
  - piezoelektryka,
  - elektrostatyka / przewodnictwo zależne od magnetyzacji.

### 3.5. Oddziaływania termiczne

- stochastyczne pole termiczne zgodne z FDT,
- ewentualnie sprzężenie z równaniem ciepła.

---

## 4. Wspólny model stanu dla FDM i FEM

Nie da się poprawnie rozbudować Fullmag bez jawnego rozdzielenia kilku poziomów opisu.

## 4.1. Poziom wspólnej semantyki (`ProblemIR`)

Na tym poziomie powinny istnieć jedynie wielkości fizyczne:

- geometria,
- regiony,
- materiały,
- pola współczynników,
- lista energii/torque/solvers,
- study / outputs / policy.

Bez:

- indeksów siatki FDM,
- numeracji elementów FEM,
- szczegółów FFT,
- szczegółów MFEM/libCEED/hypre.

## 4.2. Poziom planu backendowego

Osobno:

- `FdmPlanIR`,
- `FemPlanIR`,
- `HybridPlanIR`.

Tu dopiero pojawiają się:

- grid dimensions,
- cell size,
- active mask,
- mesh, spaces, quadrature, operators,
- padding FFT,
- wybór solvera potencjału,
- wybór solvera transportowego,
- typ BC.

## 4.3. Poziom operatorów

Każde oddziaływanie powinno mieć docelowo cztery reprezentacje:

1. **semantyczną** — w IR,
2. **energetyczną** — funkcjonał,
3. **operatorową** — field/torque/jacobian/eigen-linearization,
4. **wykonawczą** — CPU/GPU.

To jest szczególnie ważne dla:

- DMI,
- demag,
- magnetoelastyki,
- STT/SOT,
- linearyzacji do eigenmodes.

---

## 5. Exchange — poprawność i rekomendacja

## 5.1. Model fizyczny

Dla izotropowego exchange:

\[
E_\mathrm{ex}[m] = \int_\Omega A(\mathbf{x}) |\nabla m|^2 \, dV
\]

Pole efektywne:

\[
H_\mathrm{ex} = \frac{2}{\mu_0 M_s}\nabla\cdot(A\nabla m)
\]

Dla stałego \(A\):

\[
H_\mathrm{ex} = \frac{2A}{\mu_0 M_s}\Delta m
\]

## 5.2. Ocena kierunku w repo

Kierunek obrany w Fullmag jest poprawny:

- w FDM noty promują **face-based energy** zamiast „naiwnego Laplasjanu z lokalnym A”;
- w FEM noty idą w **słabą formę** zgodną z energią;
- rozdział między semantyką a realizacją backendową jest poprawny.

To jest dokładnie to, co trzeba robić.

## 5.3. Co jeszcze trzeba doprecyzować

### 5.3.1. Interface exchange

Przy skokach materiałowych nie wolno implementować exchange jako:

\[
A_i \Delta_h m_i
\]

bo to jest błędne przy nieciągłych współczynnikach.

Poprawna podstawa:

- współczynnik na ścianie/interfejsie,
- zwykle harmonic mean,
- albo jawna polityka `exchange_interface_model`.

### 5.3.2. Interlayer exchange / RKKY

To musi być osobny termin, nie „sprytna sztuczka” w demag albo exchange.

Na interfejsie \(\Gamma\):

\[
E_\mathrm{RKKY} = -\int_\Gamma J_\mathrm{RKKY} (m_1\cdot m_2)\, dS
\]

W Fullmag to powinien być osobny term np.:

```python
fm.InterlayerExchange(J=..., region_a="...", region_b="...")
```

To jest szczególnie ważne dla multilayers, SAF, spintronics.

## 5.4. Rekomendacja implementacyjna

**FDM**:
- face-based exchange energy,
- obsługa skoków materiałowych przez face coefficients,
- ghost closure dla klasycznych BC,
- w CUDA najlepiej fusion z lokalnymi terminami typu anisotropy i DMI.

**FEM**:
- operator dyfuzyjny / stiffness,
- mass-lumped lub consistent-mass recovery pola,
- partial assembly przez libCEED,
- operator reuse do eigenmodes i Newtona.

## 5.5. Testy obowiązkowe

- uniform state → zero field/energy,
- sinusoidal mode → znana odpowiedź,
- material jump convergence,
- FDM vs FEM under refinement,
- GPU parity.

---

## 6. Demag / dipolar field — poprawność i rekomendacja

## 6.1. Model fizyczny

\[
\nabla\times H_d = 0,\qquad \nabla\cdot(H_d + M) = 0
\]

\[
H_d = -\nabla u,\qquad \Delta u = \nabla\cdot M \text{ w } \mathbb{R}^3
\]

Energia:

\[
E_d = -\frac{\mu_0}{2}\int_\Omega M\cdot H_d\, dV
\]

## 6.2. Ocena repo

Fullmag bardzo słusznie rozdziela:

- FDM: tensor demag / FFT / Newell,
- FEM: Poisson-airbox, z ambicją dojścia do lepszego open-boundary solve.

To jest dobry kierunek, ale trzeba bardzo uważać, by **wariant airbox był jawnie walidowany
pod kątem rozmiaru domeny, warunków brzegowych i zbieżności**.

## 6.3. FDM — co jest poprawne

### 6.3.1. Regular grid + tensor convolution

To jest złoty standard dla FDM.

Warunki poprawności:

- poprawne self-terms,
- poprawne zero-padding,
- poprawna normalizacja FFT,
- poprawne jednostki,
- poprawne maskowanie nieaktywnych komórek.

### 6.3.2. Multi-body i multi-layer

Repo już myśli o globalnym demag dla wielu ciał, co jest bardzo ważne.  
To trzeba utrzymać jako twardy wymóg:

- kilka ferromagnetów w jednym problemie,
- globalny stray field,
- brak sztucznego odseparowania ciał.

## 6.4. FEM — co musi być docelowo

Dla prawdziwego FEM demag są trzy poważne opcje:

1. **air-box scalar potential** — łatwe, ale przybliżone,
2. **transformed infinite domain / shell mapping**,
3. **FEM-BEM coupling** — najbardziej naukowo eleganckie i produkcyjnie mocne.

### Moja rekomendacja

Dla Fullmag:

- **krótkoterminowo**: air-box jako bootstrap,
- **średnioterminowo**: transformed open boundary lub shell/infinite elements,
- **docelowo**: FEM-BEM coupling jako ścieżka high-fidelity.

Jeżeli celem jest solver klasy publikacyjnej i długofalowo lepszy od „airbox-only”, to sam airbox nie wystarczy.

## 6.5. Krytyczny wniosek

Demag w FEM nie może zostać na poziomie „jakiejś siatki powietrza” bez:

- badania wpływu rozmiaru airbox,
- badania wpływu kształtu airbox,
- walidacji energii,
- walidacji na known demag factors.

## 6.6. Testy obowiązkowe

- sphere / ellipsoid demag factors,
- thin film,
- rod/needle,
- multi-body stray coupling,
- FDM/FEM convergence,
- influence of airbox size.

---

## 7. Zeeman i pole zewnętrzne

## 7.1. Uwaga o jednostkach

To jest jeden z najważniejszych punktów praktycznych.

Repo już zauważa problem `B` vs `H`.  
To trzeba **naprawić systemowo**.

Solver LLG potrzebuje pola w **A/m**.  
Jeżeli API przyjmuje `B` w T, to musi istnieć jawna konwersja:

\[
H = \frac{B}{\mu_0}
\]

ale tylko przy jasno określonej konwencji.

## 7.2. Rekomendacja

Docelowo w API powinny istnieć jawne typy:

```python
fm.ZeemanH(H=(...))
fm.ZeemanB(B=(...))
```

albo jeden typ z obowiązkową jednostką:

```python
fm.Zeeman(value=(...), unit="A/m")
fm.Zeeman(value=(...), unit="T")
```

Bez tego użytkownik będzie popełniał ciche błędy.

## 7.3. Rozszerzenia

Pole zewnętrzne powinno wspierać:

- uniform static,
- time-dependent waveform,
- sampled spatial field,
- imported field map,
- field sweep / ramp / pulse trains,
- coupling with transport (Oersted).

---

## 8. Jednoosiowa anizotropia — projekt implementacji

Repo jeszcze nie ma tego kompletnego end-to-end, a to powinien być jeden z pierwszych kolejnych kroków.

## 8.1. Model fizyczny

Dla anizotropii jednoosiowej:

\[
w_\mathrm{u} = K_{u1}(1-(m\cdot u)^2)
\]

opcjonalnie z drugim rzędem:

\[
w_\mathrm{u} = K_{u1}(1-(m\cdot u)^2) + K_{u2}(1-(m\cdot u)^2)^2
\]

Pole:

\[
H_\mathrm{u} = \frac{2K_{u1}}{\mu_0 M_s}(m\cdot u)u
\]

dla najprostszego wariantu.

## 8.2. Co musi być w IR

```json
{
  "kind": "uniaxial_anisotropy",
  "Ku1": ...,
  "axis": [ux, uy, uz],
  "Ku2": ...
}
```

z możliwością:

- region-wise,
- field-wise,
- texture-wise axis.

## 8.3. FDM

To jest lokalny termin i powinien być policzony razem z:

- exchange,
- DMI,
- maybe thermal preparation,
- local torque assembly.

## 8.4. FEM

To też jest lokalny termin, świetny do partial assembly.  
Powinien być łatwy i być wdrożony **przed** bardziej złożonymi torque.

## 8.5. Testy

- easy-axis alignment,
- hard-axis instability,
- switching barrier,
- porównanie z analitycznym Stoner–Wohlfarth w prostych limitach.

---

## 9. Kubiczna anizotropia — projekt implementacji

To jest absolutnie obowiązkowe, jeśli Fullmag ma być solverem materiałowym, a nie tylko „thin-film toy”.

## 9.1. Model fizyczny

Dla osi krystalograficznych \(\alpha_1,\alpha_2,\alpha_3\) będących składowymi \(m\) w bazie krystalicznej:

\[
w_\mathrm{cub} = K_{c1}(\alpha_1^2\alpha_2^2 + \alpha_2^2\alpha_3^2 + \alpha_3^2\alpha_1^2)
\]

opcjonalnie:

\[
+ K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2
\]

## 9.2. Krytyczny wymóg architektoniczny

Nie wolno zakładać, że osie krystaliczne zawsze pokrywają się z globalnym układem \(x,y,z\).  
Potrzebny jest jawny obiekt orientacji kryształu:

```python
fm.CubicAnisotropy(Kc1=..., axes=((...),(...),(...)))
```

albo kwaternion / rotation matrix.

## 9.3. FDM i FEM

To nadal termin lokalny, ale:

- wymaga porządnego modelu orientacji materiału,
- musi współgrać z regionami i imported geometry,
- musi dać się linearyzować do eigenmodes.

## 9.4. Testy

- minima energii w <100>, <110>, <111> zależnie od znaków stałych,
- rotacja bazy kryształowej,
- porównanie energii między backendami.

---

## 10. Surface / interface anisotropy

W ultracienkich warstwach to jest kluczowe.

## 10.1. Model fizyczny

Na powierzchni/interfejsie \(\Gamma\):

\[
E_s = \int_\Gamma K_s(1-(m\cdot n)^2)\, dS
\]

Dla cienkiej warstwy czasem używa się efektywnego przejścia do objętości:

\[
K_\mathrm{eff} = K_v + \frac{2K_s}{t}
\]

ale to **nie może zastąpić ogólnej implementacji interfejsowej**, gdy:

- grubość nie jest stała,
- geometria jest 3D,
- interfejsów jest wiele,
- trzeba uwzględnić różne strony.

## 10.2. Implementacja

### FEM
To naturalne środowisko:
- boundary integral / facet integral,
- region interface markers.

### FDM
Możliwe przez:
- boundary-face contributions,
- half-cell realization,
- geometry-aware mask/facet extraction.

---

## 11. Interfacial DMI — ocena i rekomendacja

Repo ma tu już bardzo dobrą notę fizyczną. Kierunek jest poprawny.

## 11.1. Model

\[
w_\mathrm{iDMI} = D\left[m_z\nabla\cdot m - (m\cdot\nabla)m_z\right]
\]

dla osi \(\hat z\) w pierwszej implementacji.

Pole:

\[
H_\mathrm{iDMI}
=
\frac{2D}{\mu_0 M_s}
\left[
\nabla m_z - (\nabla\cdot m)\hat z
\right]
\]

z odpowiednią interpretacją thin-film/in-plane.

## 11.2. Najważniejszy punkt: warunek brzegowy

To nie jest detal.  
Trzeba narzucić sprzężony warunek exchange + DMI:

\[
2A\partial_\nu m + D[(\hat z\times \nu)\times m] = 0
\]

Jeżeli implementacja DMI nie obsłuży poprawnie granic, to:

- ściany Néela wyjdą źle,
- edge canting wyjdzie źle,
- skyrmiony będą miały zły promień i energię,
- FDM i FEM nie będą zgodne.

## 11.3. Rekomendacja

### FDM
- energy-first face formulation,
- ghost closure wynikające z BC,
- osobne testy na wszystkich czterech/sześciu ścianach.

### FEM
- słaba forma z poprawnym boundary term,
- nie wolno tego sprowadzać tylko do „lokalnego pola w objętości”.

## 11.4. Rozszerzenia docelowe

- arbitrary interface normal / axis,
- region-dependent \(D\),
- sign conventions explicite w IR,
- multilayer chirality.

---

## 12. Bulk DMI — ocena i rekomendacja

Repo ma poprawny szkic fizyczny.

## 12.1. Model

\[
E_\mathrm{bDMI}=D\int_\Omega m\cdot(\nabla\times m)\, dV
\]

Pole:

\[
H_\mathrm{bDMI}= -\frac{2D}{\mu_0 M_s}(\nabla\times m)
\]

## 12.2. Krytyczny punkt

Tak jak przy interfacial DMI, nie wolno pominąć warunku brzegowego:

\[
2A\partial_\nu m + D(m\times \nu)=0
\]

## 12.3. Rekomendacja

- osobny term `BulkDMI`, nie przeciążenie `InterfacialDMI`,
- osobny sign convention w IR,
- osobne testy na helisach Blocha.

---

## 13. Termiczne pole losowe

Jeśli Fullmag ma obsługiwać realistyczną dynamikę i switching, to termika jest konieczna.

## 13.1. Model

W LLG dodajemy \(H_\mathrm{th}\) o statystyce:

\[
\langle H_{\mathrm{th},i}(t)\rangle = 0
\]

\[
\langle H_{\mathrm{th},i}(t)H_{\mathrm{th},j}(t')\rangle
=
\frac{2\alpha k_B T}{\gamma \mu_0 M_s V_\mathrm{cell}}
\delta_{ij}\delta(t-t')
\]

w odpowiedniej dyskretyzacji czasowej i objętościowej.

## 13.2. Krytyczne wymagania

- poprawne skalowanie z objętością komórki / elementu,
- poprawne skalowanie z krokiem czasu,
- deterministyczne seed handling,
- inne ujęcie dla FDM i FEM, ale ta sama fizyka.

## 13.3. Nie wolno robić

- „losowego pola o jakiejś amplitudzie” bez FDT,
- mieszania temperatury z arbitralnym dampingiem,
- niejawnych konwencji.

---

## 14. Oersted field od prądu

To jest absolutnie obowiązkowe przy symulacjach z prądem.

## 14.1. Model

Jeżeli mamy gęstość prądu \(j\), to:

\[
\nabla\times H_\mathrm{Oe} = j,\qquad \nabla\cdot B = 0
\]

W quasistatic magnetostatics można liczyć:
- z Biot–Savarta,
- albo przez rozwiązanie pomocniczego zadania magnetostatycznego.

## 14.2. Rekomendacja architektoniczna

Nie implementować pola Oersteda jako ręcznie wpisanej funkcji „od użytkownika” jako głównej ścieżki.  
Powinien istnieć solver transportowo-magnetostatyczny:

1. solve electric potential \(\phi\),
2. wyznacz \(j\),
3. wyznacz \(H_\mathrm{Oe}\),
4. użyj w LLG.

W przeciwnym razie symulacje prądowe będą tylko pół-fizyczne.

---

## 15. STT typu Zhang–Li (CIP) — absolutny priorytet dla symulacji z prądem

Jeżeli zależy Ci na symulacjach z prądem, to to jest jeden z pierwszych terminów, które trzeba wdrożyć porządnie.

## 15.1. Model

Dla przepływu prądu w płaszczyźnie i dryftowej prędkości spinowej \(u\):

\[
\partial_t m =
-\gamma \mu_0 m\times H_\mathrm{eff}
+\alpha m\times \partial_t m
-(u\cdot\nabla)m
+\beta m\times (u\cdot\nabla m)
\]

gdzie:

- termin adiabatyczny: \(-(u\cdot\nabla)m\),
- nieadiabatyczny: \(\beta m\times (u\cdot\nabla m)\).

## 15.2. Najważniejszy problem implementacyjny

Ten torque wymaga **bardzo dobrej jakości pochodnych przestrzennych**.

Jeżeli użyje się prymitywnego schematu centralnego przy ostrych ścianach domenowych, mogą wyjść:

- niefizyczne oscylacje,
- zły drift velocity,
- błędy zależne od siatki.

## 15.3. Rekomendacja FDM

Dla STT CIP w FDM zalecam:

- schemat **upwind / high-resolution / TVD / WENO-lite** dla termu konwekcyjnego,
- nie zwykły centered-only stencil,
- oddzielne ścieżki:
  - „reference centered” do prostych testów,
  - „production transport-stable” do realnych symulacji.

To jest bardzo ważne.  
Wiele kodów psuje STT właśnie tutaj.

## 15.4. Rekomendacja FEM

W FEM to jest wprost problem advection-like na sferze:

- SUPG / streamline stabilization,
- ewentualnie DG/semi-DG dla termu transportowego,
- albo operator split.

Jeżeli zrobicie CIP STT w FEM bez stabilizacji, rozwiązanie będzie kruche.

## 15.5. Co musi wejść do IR

```json
{
  "kind": "zhang_li_stt",
  "beta": ...,
  "polarization": ...,
  "current_source": "...",
  "u_model": "from_current_density"
}
```

oraz osobny obiekt dla przewodnictwa.

---

## 16. STT typu Slonczewski (CPP)

To drugi filar symulacji z prądem, szczególnie dla MTJ, nanopillars, spin-valves.

## 16.1. Model uproszczony

\[
\tau_\mathrm{SL}
=
\gamma a_J m\times(m\times p)
+
\gamma b_J m\times p
\]

gdzie:

- \(p\) — polaryzacja,
- \(a_J\) — torque damping-like,
- \(b_J\) — field-like.

## 16.2. Problem z „zbyt prostą” implementacją

Najprostszy model z jednym wektorem \(p\) jest użyteczny, ale niewystarczający dla:
- geometry-dependent current crowding,
- angular dependence,
- multilayer stacks,
- spin dephasing,
- realistic interfaces.

## 16.3. Rekomendacja

W Fullmag powinny istnieć **dwa poziomy**:

### Poziom A — efektywny
Dobry na start:
```python
fm.SlonczewskiSTT(J=..., p=(...), eta=..., field_like=...)
```

### Poziom B — transportowy
Docelowy:
- current solve,
- spin accumulation / spin diffusion,
- interfejsy warstw,
- wynikowe torque z transportu spinowego.

---

## 17. SOT — spin orbit torques

Jeśli Fullmag ma być nowoczesny, SOT musi być traktowany jako first-class citizen.

## 17.1. Model efektywny

\[
\tau_\mathrm{DL} = \gamma \tau_\mathrm{DL}^0\, m\times(m\times \sigma)
\]

\[
\tau_\mathrm{FL} = \gamma \tau_\mathrm{FL}^0\, m\times \sigma
\]

gdzie \(\sigma\) jest kierunkiem polaryzacji spinowej generowanej np. przez spin Hall effect.

## 17.2. Docelowo

SOT nie powinien być tylko „ręcznie zadanym torque”.  
Dla właściwej ścieżki prądowej potrzebna jest opcjonalnie:

- warstwa heavy-metal,
- solve prądu,
- mapping current → spin Hall source,
- torque na interfejsie lub w warstwie FM.

---

## 18. Pełne symulacje z prądem elektrycznym — właściwa architektura

To jest sekcja krytyczna dla Twoich celów.

## 18.1. Nie wystarczy dodać torque do LLG

Jeżeli Fullmag ma robić **naprawdę dobre symulacje z prądem**, to trzeba rozdzielić poziomy modelowania:

### Poziom 1 — efektywny torque only
- szybki,
- prosty,
- użyteczny,
- ale ograniczony.

### Poziom 2 — sprzężony elektro-spinowy
- solve pola elektrycznego,
- solve current density,
- pole Oersteda,
- STT/SOT wynikające z prądu.

### Poziom 3 — pełny spin transport
- spin accumulation,
- diffusion,
- interfacial spin transfer,
- spin Hall / Rashba,
- ewentualnie Joule heating.

To powinno być jawnie rozróżnione w capability matrix.

## 18.2. Minimalny poprawny model transportowy

Dla przewodnictwa quasi-statycznego:

\[
\nabla\cdot(\sigma \nabla \phi)=0
\]

\[
j = -\sigma \nabla \phi
\]

gdzie \(\sigma\) może być:
- stałe,
- zależne od regionu,
- zależne od temperatury,
- zależne od magnetyzacji (AMR/SMR) — później.

Następnie:

- z \(j\) wyznaczamy \(H_\mathrm{Oe}\),
- z \(j\) wyznaczamy \(u\) do Zhang–Li,
- z \(j\) wyznaczamy źródło SOT/Slonczewski w odpowiednim modelu.

## 18.3. FDM — rekomendacja

FDM dla transportu:
- solver Poissona/kondukcji na regularnej siatce,
- maski przewodników i izolatorów,
- harmonic averaging przewodności na ścianach,
- FFT lub multigrid / conjugate gradient,
- potem postprocess \(j\).

To jest wykonalne i powinno być szybkie na GPU.

## 18.4. FEM — rekomendacja

FEM jest wręcz naturalne dla transportu:
- \(\phi\) w \(H^1\),
- mixed materials,
- złożone kontakty,
- realistic electrodes,
- curved devices.

Dla Twoich docelowych symulacji prądowych **FEM będzie ważniejszy niż FDM**, szczególnie przy realistycznych geometrach 3D.

## 18.5. Wniosek strategiczny

Jeżeli celem są **bardzo dobre symulacje z prądem**, to roadmapa powinna wyglądać tak:

1. FDM: Zhang–Li + Oersted + conduction Poisson,
2. FEM: conduction Poisson + Oersted + effective STT/SOT,
3. później FEM/FDM spin diffusion model.

---

## 19. Pełna, dwustronna magnetoelastyka — jak to zrobić poprawnie

To jest jedna z najważniejszych sekcji całego dokumentu.

Chcesz uniknąć uproszczenia w stylu „jak w MuMax3”, gdzie zwykle stosuje się model bardziej jednostronny lub uproszczony.  
Prawidłowa droga to **rzeczywiste sprzężenie dwukierunkowe**.

## 19.1. Co znaczy „pełne dwustronne”

Nie tylko:

- stres \(\sigma\) wpływa na magnetyzację przez \(H_\mathrm{me}\),

ale także:

- magnetyzacja generuje **magnetostrykcyjną deformację własną**,
- ta deformacja wymusza pole naprężeń/odkształceń,
- to pole wraca do LLG.

Czyli mamy pętlę:

\[
m \rightarrow \varepsilon^\mathrm{mag} \rightarrow \sigma \rightarrow H_\mathrm{me} \rightarrow m
\]

a nie jedynie:

\[
\sigma_\mathrm{zadane} \rightarrow H_\mathrm{me}
\]

## 19.2. Podstawowy model continuum

### 19.2.1. Kinematyka

Dla małych odkształceń:

\[
\varepsilon(u)=\frac{1}{2}(\nabla u + \nabla u^T)
\]

### 19.2.2. Odkształcenie własne magnetostrykcyjne

Dla materiału izotropowego, najprostszy model:

\[
\varepsilon^\mathrm{mag}
=
\frac{3}{2}\lambda_s
\left(
m\otimes m - \frac{1}{3}I
\right)
\]

Dla kryształu kubicznego potrzeba stałych \(\lambda_{100}\), \(\lambda_{111}\) i odpowiedniej projekcji na osie kryształu.

### 19.2.3. Prawo konstytutywne

\[
\sigma = \mathbb{C} : (\varepsilon(u) - \varepsilon^\mathrm{mag}(m))
\]

gdzie \(\mathbb{C}\) to tensor sprężystości.

### 19.2.4. Równowaga mechaniczna

Quasi-static:

\[
\nabla\cdot \sigma + f = 0
\]

lub dynamicznie:

\[
\rho \ddot u = \nabla\cdot \sigma + f
\]

### 19.2.5. Energia magnetoelastyczna

Równoważnie można pisać energię:

\[
E_\mathrm{el}[u,m]
=
\int_\Omega \frac{1}{2}
(\varepsilon(u)-\varepsilon^\mathrm{mag}(m))
:
\mathbb{C}
:
(\varepsilon(u)-\varepsilon^\mathrm{mag}(m))\, dV
\]

Pole magnetoelastyczne wynika z wariacji po \(m\):

\[
H_\mathrm{me}
=
-\frac{1}{\mu_0 M_s}
\frac{\delta E_\mathrm{el}}{\delta m}
\]

To jest właściwa droga.

## 19.3. Dlaczego FEM jest naturalnym backendiem głównym

Pełna magnetoelastyka jest **naturalna dla FEM**, bo:

- odkształcenie to pole w \(H^1\),
- naprężenia i warunki brzegowe są naturalne w weak form,
- geometrie 3D są realistyczne,
- można łatwo dodać warstwy, podłoża, kontakty, clamp, free boundary.

Dlatego moja rekomendacja jest jednoznaczna:

> **pełną, referencyjną, naukowo poprawną magnetoelastykę należy najpierw wdrożyć w FEM**,  
> a dopiero potem zbudować odpowiednik lub przybliżenie produkcyjne w FDM.

## 19.4. Jak to zaimplementować w FEM

### 19.4.1. Stan

- \(m \in [H^1(\Omega_m)]^3\) lub wariant równoważny dla magnetyzacji,
- \(u \in [H^1(\Omega_\mathrm{mech})]^3\) dla przemieszczeń.

### 19.4.2. Pętla sprzężenia

#### Wariant A — partitioned strong coupling
Na krok czasowy / iterację:
1. znając \(m^n\), zbuduj \(\varepsilon^\mathrm{mag}(m^n)\),
2. rozwiąż mechanikę dla \(u^n\),
3. policz \(\sigma^n\),
4. policz \(H_\mathrm{me}^n\),
5. zaktualizuj LLG do \(m^{n+1}\),
6. iteruj aż do zgodności, jeśli sprzężenie ma być silne.

#### Wariant B — monolithic
Rozwiązanie układu sprzężonego jednocześnie:
- trudniejsze,
- bardziej kosztowne,
- świetne docelowo,
- niepotrzebne na pierwszy krok.

### Moja rekomendacja
Na start:
- **strongly coupled partitioned fixed-point / Newton-like outer iterations**.

To jest najlepszy kompromis.

## 19.5. Jak to zaimplementować w FDM

To jest trudniejsze, ale możliwe.

### Wariant 1 — solver sprężystości na regularnej siatce
Rozwiązujemy elastostatykę na regularnym gridzie:
- displacement field na nodach lub cell corners,
- stress/strain na staggered arrangement,
- operator Naviera/Lamé,
- FFT-based elasticity dla periodycznych / prostych geometrii,
- albo multigrid na siatce regularnej.

### Wariant 2 — hybrid helper grid
Magnetyzacja w FDM, mechanika pomocniczo na siatce lub mesh-like auxiliary domain.

### Moja rekomendacja
Dla Fullmag:
- **najpierw FEM reference implementation**,
- potem FDM:
  - prosty regular-grid elastostatics,
  - dla box/layered geometries,
  - z jasnym zakresem obowiązywania.

## 19.6. Czego nie robić

Nie robić tylko:
- „user podaje stress tensor, a my liczymy field”  
jako jedynej implementacji.

To jest jedynie **jednostronna magnetoelastyka**.

## 19.7. Minimalne API

```python
fm.MagnetoElastic(
    model="isotropic",
    lambda_s=...,
    C11=..., C12=..., C44=...,   # albo pełny tensor C
    mechanical_bc=...,
    solver="quasistatic"
)
```

Docelowo też:
```python
fm.CubicMagnetostriction(lambda100=..., lambda111=..., crystal_axes=...)
```

## 19.8. Testy obowiązkowe

- single-domain bar under tension/compression,
- Villari effect,
- inverse magnetostriction,
- clamped thin film,
- bilayer/substrate mismatch,
- convergence vs mesh/grid,
- porównanie energetyczne \(E_\mathrm{el}+E_\mathrm{mag}\).

---

## 20. Dlaczego magnetoelastyka musi być zaprojektowana jako osobny subsystem

Magnetoelastyka nie jest „kolejnym lokalnym termem” jak anisotropy.

To jest subsystem wielofizyczny wymagający:

- drugiego pola stanu \(u\),
- drugiego solve,
- BC mechanicznych,
- operatorów transferu między polami,
- osobnych observabli:
  - displacement,
  - strain,
  - stress,
  - elastic energy,
  - magnetoelastic energy.

Dlatego w architekturze Fullmag powinien powstać osobny blok:

- `MechanicsIR`,
- `TransportIR`,
- `ThermalIR`,
- `CouplingIR`.

---

## 21. Właściwa architektura wielofizyczna dla Fullmag

## 21.1. Proponowany podział subsystemów

### Magnetic subsystem
- LLG / relaxation / eigenmodes,
- local and nonlocal magnetic interactions.

### Electric transport subsystem
- electrostatic potential,
- current density,
- conductivity tensors,
- contacts / electrodes.

### Spin transport subsystem
- spin accumulation,
- spin diffusion,
- interface transfer.

### Mechanics subsystem
- displacement,
- strain,
- stress,
- piezo/magnetostriction.

### Thermal subsystem
- heat equation,
- Joule heating,
- temperature-dependent parameters.

## 21.2. Coupling manager

Musi istnieć centralny coupling layer:

- mag ↔ elec,
- mag ↔ mech,
- elec ↔ thermal,
- thermal ↔ mag.

W przeciwnym razie projekt skończy jako zbiór niespójnych hacków.

---

## 22. Symulacje eigenmodes a operatorowa implementacja oddziaływań

Chociaż ten dokument dotyczy głównie oddziaływań, trzeba od razu myśleć o eigenproblemach.

Każde oddziaływanie powinno mieć nie tylko:

- energy,
- field,
- torque,

ale też:

- **linearized operator around equilibrium**.

To dotyczy szczególnie:

- exchange,
- anisotropy,
- demag,
- DMI,
- magnetoelastic coupling,
- current-induced effective torques w linearyzacji małosygnałowej.

Jeżeli teraz implementacje powstaną wyłącznie jako „funkcje do time steppingu”, to moduł eigenmodes będzie potem bardzo trudny.

---

## 23. Co powinno wejść do `ProblemIR` jako nowe termy

Poniżej proponowana lista minimalna.

### 23.1. Energia i pola magnetyczne

- `uniaxial_anisotropy`
- `cubic_anisotropy`
- `surface_anisotropy`
- `bulk_dmi`
- `interlayer_exchange`
- `thermal_noise`
- `oersted_from_current`

### 23.2. Torque prądowe

- `zhang_li_stt`
- `slonczewski_stt`
- `spin_orbit_torque`

### 23.3. Wielofizyka

- `electric_conduction`
- `spin_diffusion`
- `magnetoelastic`
- `heat_transfer`

### 23.4. Coupling policies

- `coupling_strategy = weak | strong | monolithic`
- `update_order`
- `outer_iterations`
- `tolerances`

---

## 24. Proponowana kolejność wdrażania — realistyczny plan

To jest najważniejszy plan wykonawczy.

## Etap 1 — domknięcie „klasycznej mikromagnetyki”

1. Uniaxial anisotropy
2. Cubic anisotropy
3. Surface anisotropy
4. Interfacial DMI
5. Bulk DMI
6. Pełna walidacja demag
7. Thermal field

**Cel:** solidny klasyczny solver magnetyczny.

## Etap 2 — prąd w FDM

1. conduction Poisson
2. current density \(j\)
3. Oersted
4. Zhang–Li STT
5. Slonczewski effective
6. SOT effective

**Cel:** szybkie, użyteczne symulacje spintroniczne na regular grid.

## Etap 3 — prąd w FEM

1. conduction Poisson on mesh
2. contacts/electrodes
3. Oersted
4. effective STT/SOT
5. później spin diffusion

**Cel:** realistyczne geometrie i urządzenia.

## Etap 4 — pełna magnetoelastyka w FEM

1. isotropic magnetostriction
2. cubic magnetostriction
3. strong partitioned coupling
4. validation

**Cel:** referencyjna implementacja naukowa.

## Etap 5 — magnetoelastyka w FDM

1. regular-grid elastostatics
2. coupling with magnetic state
3. limited-scope production path

**Cel:** szybka ścieżka dla prostych geometrii.

## Etap 6 — operator reuse for eigenmodes

1. Jacobians
2. linearized nonlocal operators
3. linearized coupled problems

---

## 25. Priorytety specjalnie pod Twoje wymagania

Ponieważ szczególnie zależy Ci na:

- symulacjach z prądem,
- FDM i FEM,
- poprawności fizycznej,
- magnetoelastyce pełnej, a nie uproszczonej,

to moja rekomendacja priorytetów jest taka:

### Priorytet A
- `UniaxialAnisotropy`
- `CubicAnisotropy`
- `InterfacialDMI`
- `BulkDMI`

### Priorytet B
- `ElectricConduction`
- `OerstedField`
- `ZhangLiSTT`
- `SlonczewskiSTT`
- `SOT`

### Priorytet C
- `MagnetoElastic` w FEM jako ścieżka referencyjna

### Priorytet D
- `MagnetoElastic` w FDM jako ścieżka ograniczona zakresem

---

## 26. Konkretne rekomendacje kodowe dla Fullmag

## 26.1. Każde oddziaływanie jako komplet obiektów

Dla każdego interaction term powinny istnieć:

- `TermSpec` — semantyka w IR,
- `FieldOperator` — liczenie pola,
- `EnergyOperator` — liczenie energii,
- `LinearizedOperator` — do eigenproblemów,
- `ValidationSuite` — benchmarki.

## 26.2. Dla FDM

Podział na:

- local terms kernel:
  - exchange,
  - anisotropy,
  - DMI,
  - thermal prep,
  - STT local parts;
- nonlocal terms:
  - demag,
  - Oersted if via convolution;
- auxiliary solvers:
  - conduction,
  - elasticity,
  - heat.

## 26.3. Dla FEM

Operator-first:

- weak forms,
- coefficient fields,
- operator composition,
- matrix-free/partial assembly gdzie się da,
- global solvers tam gdzie trzeba.

## 26.4. Dla backend parity

Każdy term powinien mieć:
- ten sam `kind`,
- te same jednostki,
- te same observables,
- te same nazwane testy benchmarkowe.

---

## 27. Lista benchmarków referencyjnych, które Fullmag powinien mieć

## 27.1. Klasyczne mikromagnetyczne

- uniform state,
- 1D domain wall,
- vortex in disk,
- skyrmion in PMA+DMI film,
- helix for bulk DMI,
- standard problem #4,
- ellipsoid demag.

## 27.2. Spintronika

- current-driven domain wall motion,
- CPP switching,
- SOT switching in bilayer,
- Oersted-assisted switching,
- pinning/unpinning with current.

## 27.3. Magnetoelastyka

- magnetostrictive rod,
- clamped film on substrate,
- strain-induced anisotropy switching,
- SAW-driven spin waves,
- magnetoelastic resonance splitting.

---

## 28. Kryteria „done” dla każdego nowego oddziaływania

Nowe oddziaływanie jest gotowe dopiero, gdy ma:

1. notę w `docs/physics/`,
2. API,
3. IR,
4. planner rules,
5. FDM implementation lub jawnie oznaczone „semantic-only”,
6. FEM implementation lub jawnie oznaczone „semantic-only”,
7. co najmniej jeden benchmark analityczny,
8. co najmniej jeden benchmark cross-backend,
9. outputs i provenance,
10. testy GPU parity jeśli dotyczy.

Bez tego nie powinno dostawać statusu „public-executable”.

---

## 29. Największe ryzyka techniczne

## 29.1. Ciche rozjechanie FDM i FEM

Największe ryzyko: ten sam term ma inną fizykę w dwóch backendach.

Antidotum:
- energia jako source of truth,
- wspólne benchmarki,
- wspólne sign conventions.

## 29.2. Prąd tylko jako „dodany torque”

To da szybki demo-effect, ale nie da wiarygodnych symulacji urządzeń.

## 29.3. Magnetoelastyka tylko jednostronna

To byłoby zbyt słabe względem Twojego celu.

## 29.4. Airbox jako „final FEM demag”

To byłby błąd strategiczny.

## 29.5. Brak linearyzacji operatorów

Utrudni eigenmodes.

---

## 30. Ostateczna rekomendacja strategiczna

### 30.1. Co robić natychmiast

1. Domknąć klasyczne termy lokalne:
   - uniaxial,
   - cubic,
   - DMI.
2. Dodać subsystem przewodnictwa.
3. Zbudować STT/SOT na bazie \(j\), nie tylko ręcznych torque.
4. Równolegle przygotować FEM mechanics.

### 30.2. Co robić jako ścieżkę referencyjną high-fidelity

- pełna magnetoelastyka w FEM,
- potem spin diffusion w FEM,
- potem ewentualnie monolithic coupling.

### 30.3. Co robić jako ścieżkę produkcyjnie szybką

- FDM:
  - exchange/demag/anisotropy/DMI,
  - conduction,
  - Oersted,
  - Zhang–Li,
  - effective Slonczewski/SOT,
  - uproszczona ale uczciwie opisana magnetoelastyka regular-grid.

---

## 31. Krótki werdykt końcowy

**Fullmag ma bardzo dobrą architekturę bazową i bardzo dobry kierunek fizyczny.**  
Najmocniejsze strony obecnego projektu to:

- backend-neutral `ProblemIR`,
- rozdział semantyki od planu wykonawczego,
- physics-first documentation,
- poprawny kierunek dla FDM exchange/demag,
- dobry kierunek dla DMI i przyszłego FEM.

Natomiast **żeby Fullmag stał się solverem naprawdę mocnym naukowo i praktycznie**, trzeba teraz bezwzględnie doprowadzić do końca:

1. **pełen zestaw klasycznych oddziaływań**,
2. **porządny subsystem prądowy**,
3. **pełną magnetoelastykę dwustronną, najpierw w FEM**,
4. **spójną walidację FDM/FEM/GPU**.

Jeżeli to zostanie zrobione z rygorem energetycznym i operatorowym, Fullmag może stać się systemem wyraźnie bardziej spójnym i naukowo poprawnym niż wiele starszych kodów, szczególnie w obszarze:
- sprzężeń wielofizycznych,
- symulacji z prądem,
- przyszłego eigenmode/FEM.

---

## 32. Proponowane następne pliki `docs/physics/`

Polecam dodać następujące noty, w tej kolejności:

1. `0445-fdm-uniaxial-anisotropy.md`
2. `0446-fem-uniaxial-anisotropy-mfem-gpu.md`
3. `0447-fdm-cubic-anisotropy.md`
4. `0448-fem-cubic-anisotropy-mfem-gpu.md`
5. `0530-electric-conduction-fdm.md`
6. `0531-electric-conduction-fem-mfem-gpu.md`
7. `0532-oersted-field-from-current.md`
8. `0533-fdm-zhang-li-stt.md`
9. `0534-fem-zhang-li-stt-mfem-gpu.md`
10. `0535-slonczewski-and-sot.md`
11. `0540-fem-full-magnetoelasticity-mfem-gpu.md`
12. `0541-fdm-regular-grid-magnetoelasticity.md`
13. `0542-coupled-magneto-electro-mechanical-runtime-policy.md`

---

## 33. Aneks — minimalny szkic przyszłego API

```python
fm.Exchange()
fm.Demag(realization="auto")
fm.ZeemanH(H=(0,0,1e5))

fm.UniaxialAnisotropy(Ku1=5e5, axis=(0,0,1))
fm.CubicAnisotropy(Kc1=2e4, axes=((1,0,0),(0,1,0),(0,0,1)))
fm.SurfaceAnisotropy(Ks=1.2e-3, interface="top")

fm.InterfacialDMI(D=2.5e-3, axis=(0,0,1))
fm.BulkDMI(D=1.0e-3)
fm.InterlayerExchange(J=-1.0e-4, region_a="fm1", region_b="fm2")

fm.ElectricConduction(
    sigma=5.8e7,
    contacts=[...],
)

fm.OerstedField(from_current=True)

fm.ZhangLiSTT(beta=0.02, polarization=0.6)
fm.SlonczewskiSTT(p=(0,0,1), eta=0.7, field_like_ratio=0.1)
fm.SpinOrbitTorque(
    sigma_spin=(0,1,0),
    damping_like=...,
    field_like=...,
)

fm.MagnetoElastic(
    model="isotropic",
    lambda_s=20e-6,
    elastic_tensor=...,
    mechanical_bc=...,
    coupling="strong"
)

fm.ThermalNoise(T=300, seed=1234)
```

---

## 34. Aneks — docelowe observables

Fullmag powinien publikować nie tylko `m`, `H_eff`, `E_total`, ale także:

### Magnetic
- `H_ex`
- `H_demag`
- `H_dmi`
- `H_anis`
- `H_me`
- `tau_stt`
- `tau_sot`

### Electric
- `phi`
- `j`
- `H_oe`
- `power_density`

### Mechanical
- `u`
- `strain`
- `stress`
- `E_elastic`
- `E_magnetoelastic`

### Coupled
- `E_total`
- `energy_breakdown`
- `max_torque`
- `max_velocity_dw`
- `skyrmion_radius`
- `mode_frequency` / `eigenvalue` w przyszłości

---

## 35. Podsumowanie w jednym zdaniu

**Najlepsza droga dla Fullmag to: klasyczna mikromagnetyka domknięta energetycznie, następnie prąd liczony z rzeczywistego solve transportowego, a pełna dwustronna magnetoelastyka najpierw jako referencyjny backend FEM, dopiero potem FDM.**
