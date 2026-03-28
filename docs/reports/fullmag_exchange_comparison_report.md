# Fullmag — analiza implementacji pola wymiany przy krawędzi dziury / antidotu

## Cel

Zadanie: sprawdzić, czy „dziwne” pole wymiany przy krawędzi kropki/dziury wynika z błędu fizycznego, błędu dyskretyzacji, różnicy implementacyjnej względem **mumax/amumax**, albo z innej semantyki warunków brzegowych.

Ten raport skupia się na:

1. aktualnej implementacji **Fullmag**,
2. porównaniu z **mumax**,
3. porównaniu z **amumax**,
4. porównaniu z **Boris**,
5. wnioskach praktycznych dla Twojego konkretnego przypadku.

> Uwaga metodologiczna: dla **Fullmag**, **mumax** i **amumax** porównanie opiera się na aktualnych plikach źródłowych. Dla **Boris** porównanie opiera się głównie na manualu i publikacjach, bo w trakcie analizy nie udało się jednoznacznie wskazać pojedynczego kernela exchange w dużym repo kodu.

---

## Materiał wizualny

- [Zrzut: okolica dziury — lokalny widok pola](sandbox:/mnt/data/26d2d138-848b-49ee-836d-a8bcc0c128eb.png)
- [Zrzut: pole demagnetyzujące](sandbox:/mnt/data/18707056-0907-4342-8c8a-d7589c9e8137.png)
- [Zrzut: magnetyzacja](sandbox:/mnt/data/a1d58cfc-bac5-4438-9449-00e71b0c3c03.png)

### Co widać wizualnie

- Profil **magnetyzacji** wokół dziury wygląda spójnie i fizycznie sensownie: wektory płynnie omijają otwór, nie widać jawnego „rozsypania” rozwiązania.
- To, co wygląda podejrzanie, dotyczy bardziej **pola pochodnego od gradientów/krzywizny**, a nie samego `m`.
- To ważne: pole wymiany jest w praktyce **drugą pochodną przestrzenną** z `m`, więc nawet niewielka schodkowość brzegu na siatce kartezjańskiej może dać dużo bardziej „agresywny” obraz niż sama magnetyzacja.

---

## Wniosek główny

Najważniejsza obserwacja jest taka:

**Fullmag nie liczy pola wymiany przy krawędzi dziury w sposób jawnie absurdalny fizycznie.** Dla granicy typu „brak materiału / wolna powierzchnia” implementacja jest wprost semantyką **free surface / Neumann / zero normal derivative** poprzez zastąpienie brakującego sąsiada komórką centralną.

Natomiast jest też druga, dużo ważniejsza rzecz:

**Fullmag używa tej samej semantyki również dla granic regionów**, czyli po zmianie `region_mask` sąsiad też jest zastępowany komórką centralną. To oznacza, że w aktualnej implementacji **granica region–region jest traktowana jak całkowicie odsprzęgnięta powierzchnia**, a nie jak interfejs z własnym `A_ij`.

To właśnie tutaj Fullmag rozjeżdża się z **mumax/amumax** najmocniej.

---

## Wzory fizyczne — poziom ciągły

Dla jednorodnego materiału i znormalizowanej magnetyzacji `m = M / Ms` klasyczna mikromagnetyka daje:

- gęstość energii wymiany:

```text
w_ex = A [ (∇m_x)^2 + (∇m_y)^2 + (∇m_z)^2 ]
```

- efektywne pole wymiany w notacji `H`:

```text
H_ex = (2 A / (μ0 Ms)) ∇² m
```

- albo równoważnie w notacji `B = μ0 H`:

```text
B_ex = (2 A / Ms) ∇² m
```

Jeśli `A` zmienia się przestrzennie albo są interfejsy materiałowe, naturalna forma ciągła jest bliższa:

```text
H_ex = (2 / (μ0 Ms)) ∇ · ( A ∇m )
```

To rozróżnienie jest ważne, bo:

- **Fullmag** implementuje prosty wariant z pojedynczym `A` i jawnym prefaktorem `2A/(μ0 Ms)`.
- **mumax/amumax** implementują wariant komórkowo-sąsiedzki z parowym `A_ij` i polem w notacji **Tesla** (`B`, nie `H`).
- **Boris** w dokumentacji opisuje exchange w kontekście operatorów różniczkowych i energii `-μ0/2 M·H`.

---

## Tabela 1 — porównanie wzorów i jednostek

| Aspekt | Fullmag | mumax | amumax | Boris |
|---|---|---|---|---|
| Wielkość przechowywana | `H_ex` | `B_ex` | `B_ex` | w dokumentacji `H_ex` |
| Jednostka | A/m | T | T | w manualu notacja `H` |
| Prefaktor ciągły | `2A/(μ0 Ms)` | `2A/Ms` (bo `B=μ0H`) | jak mumax | dokumentacja zgodna z `H`-notacją |
| Model materiałowy | jeden skalar `A`, jeden `Ms` w jądrze | parowe `A_ij` przez LUT regionów | jak mumax | dokumentacja/multi-material |
| Granice | clamped/self-neighbor | clamp/wrap + missing-cell replacement | jak mumax | dokumentacja: operatory różniczkowe z warunkami Neumanna / PBC |

---

## Tabela 2 — dokładne porównanie implementacji krok po kroku

| Krok | Fullmag | mumax | amumax | Boris | Co to oznacza praktycznie |
|---|---|---|---|---|---|
| 1. Reprezentacja pola | Kernel liczy `hx, hy, hz` jako pole wymiany | Kernel liczy `Bx, By, Bz` jako effective field w Tesla | jak mumax | w manualu exchange opisywany przez `H` i energię `-μ0/2 M·H` | Przy porównaniu wartości liczbowych trzeba pilnować `H` vs `B`. |
| 2. Komórka centralna | bierze `m(idx)` | bierze `m0 = m(i)` | jak mumax | dokumentacja nie pokazuje tego kroku jawnie | Standard. |
| 3. Sąsiedzi | 6-punktowy stencil | 6-punktowy stencil | 6-punktowy stencil | dokumentacja: differential operators | Wszystkie trzy solvery są w tej samej klasie FDM dla exchange. |
| 4. Brzeg zewnętrzny | indeks sąsiada clampowany do siebie | clamp albo wrap wg PBC | clamp albo wrap wg PBC | dokumentacja/publikacje wspominają PBC dla exchange operators | Fullmag ma prostszy model brzegu niż mumax/amumax. |
| 5. Brakujący sąsiad / dziura | brakujący sąsiad -> `idx` (self) przez `active_mask` | jeśli sąsiad ma `m=0`, wtedy `m_ = m0` | jak mumax | dokumentacja wskazuje Neumann BC dla operatorów | Dla „void” wszystkie trzy idą semantycznie w stronę free surface. |
| 6. Granica regionów | jeśli `region_mask` różny, sąsiad -> `idx` | bierze `A_ij = LUT(region_i, region_j)` | jak mumax | dokumentacja Boris jest multi-material, ale bez wyciągniętego tu pojedynczego kernela | Tu Fullmag odcina coupling, mumax/amumax go zachowują. |
| 7. Inter-regional exchange | brak jawnego `A_ij` | harmonic mean domyślnie, z możliwością override | harmonic mean domyślnie, z możliwością override | dokumentacja i architektura multi-mesh/material sugerują jawne traktowanie interfejsów | To jest główna różnica architektoniczna. |
| 8. Waga dyskretyzacji | klasyczne `1/dx²`, `1/dy²`, `1/dz²` w laplasjanie | `wx = 2/dx²`, `wy = 2/dy²`, `wz = 2/dz²`, potem mnożenie przez `A_ij/Ms` | jak mumax | dokumentacja nie pokazuje tu jawnie kodu | Matematycznie to spójne po uwzględnieniu definicji pola. |
| 9. Ms=0 / nie-magnetyk | Fullmag nie ma tu semantyki typu mumax-owego LUT+Ms=0, tylko `active_mask`/`region_mask` | aktualne mumax 3.11.1 naprawia problem z `Msat=0` | amumax deklaruje solver-equivalence z mumax | brak precyzyjnego kodu w tej analizie | Reprezentacja dziury jako „region z Ms=0” to nie to samo co `active_mask`. |
| 10. Energia exchange | forward-neighbor pair sum | `-0.5 * cellVolume * M·B_ex` | jak mumax | manual: `e_exch = - μ0/2 M·H` | Same pole może wyglądać ostro, a energia nadal być poprawna. |
| 11. PBC | w oglądanym kernelu brak jawnego PBC | jawny `PBC_code()` | jawny `PBCCode()` | publikacje Boris mówią o PBC dla exchange operators | To może zmieniać obraz przy porównaniu 1:1. |
| 12. Walidacja | parity GPU vs CPU referencyjne Fullmag | dojrzały solver + literatura + warsztaty/docs | README: solver/results unchanged | publikacje/manual | Fullmag dziś bardziej waliduje zgodność z własnym CPU niż z zewnętrznym gold standardem. |

---

## Co dokładnie robi dziś Fullmag

Z aktualnego `exchange_fp64.cu` wynika ten schemat:

1. bierze 6 sąsiadów,
2. na brzegu domeny clampuje indeks do komórki centralnej,
3. jeśli sąsiad jest nieaktywny (`active_mask == 0`), też zamienia go na komórkę centralną,
4. jeśli sąsiad ma inny `region_mask`, też zamienia go na komórkę centralną,
5. liczy laplasjan każdej składowej,
6. mnoży przez `2A/(μ0 Ms)`.

W skrócie:

```text
neighbor outside / inactive / other-region  =>  neighbor := center
```

czyli:

```text
(m_neighbor - m_center) = 0
```

w kierunku normalnym do takiej granicy.

To jest de facto dyskretna forma:

```text
∂m/∂n = 0
```

na tej granicy.

### Konsekwencja

Dla **dziury jako pustej przestrzeni** jest to sensowna implementacja wolnej powierzchni.

Dla **interfejsu dwóch regionów magnetycznych** jest to już zbyt agresywne uproszczenie, bo exchange jest po prostu gaszony przez interfejs.

---

## Co robi mumax / amumax

W `mumax` i `amumax` jądro exchange robi w praktyce:

```text
B += w_dir * A_ij * (m_j - m_i)
B *= 1 / Ms_i
```

z wagami:

```text
wx = 2/dx², wy = 2/dy², wz = 2/dz²
```

Dodatkowo:

- gdy sąsiad odpowiada „brakującej” komórce geometrii, jego `m` jest zerowe i wtedy solver robi:

```text
m_neighbor := m_center
```

czyli znów dostajesz free-surface/open boundary dla void.

Ale na granicy **region i ↔ region j** solver **nie zeruje** exchange automatycznie. Zamiast tego bierze **parowe `A_ij` z LUT**.

Domyślna wartość `A_ij` jest harmonic mean, ale można ją jawnie skalować albo podać ręcznie.

### Dlaczego to jest ważne

To oznacza, że w mumax/amumax masz rozdzielone trzy przypadki:

1. **brzeg geometrii / vacuum / missing cell**,
2. **interfejs region-region**,
3. **nie-magnetyczny region (`Ms=0`)**.

W Fullmag dzisiaj przypadek 1 i 2 są praktycznie wrzucone do jednego worka: „sąsiad jest nieważny, więc zastąp go centralnym”.

---

## Co sugeruje Boris

Na podstawie manuala i publikacji Boris można bezpiecznie powiedzieć tyle:

- exchange i pokrewne operatory są opisywane przez klasyczne operatory różniczkowe,
- przy powierzchniach stosowane są warunki typu **Neumann**,
- Boris wspiera **PBC** dla operatorów różniczkowych, w tym exchange,
- dokumentacja jest osadzona w architekturze multi-material / multi-mesh.

To znaczy, że Boris jest koncepcyjnie bliżej dojrzałego podejścia „warunek brzegowy + jawne traktowanie materiałów/interfejsów” niż do prostego „region mismatch => self clamp wszędzie”.

Nie chcę jednak udawać większej pewności niż mam: w tej analizie **nie wyciągnąłem jednego, konkretnego pliku źródłowego Boris odpowiedzialnego za exchange kernel**, więc część porównania z Boris jest porównaniem **dokumentowanej semantyki**, a nie linia-w-linię z kodem CUDA/C++.

---

## Dlaczego magnetyzacja może wyglądać dobrze, a pole wymiany źle

To jest bardzo częsty i bardzo ważny punkt.

Magnetyzacja `m` jest polem „łagodnym” — oglądasz orientację wektora. Pole wymiany jest w praktyce związane z **krzywizną** tekstury magnetycznej. To oznacza, że:

- gładne `m` nie gwarantuje gładkiego `H_ex`,
- każda schodkowość brzegu koła na siatce prostokątnej wzmacnia się w `H_ex`,
- pierwsza warstwa aktywnych komórek przy dziurze jest najbardziej wrażliwa,
- kolorowanie i autoskala bardzo łatwo przesadzają kontrast przy `H_ex`.

Dlatego sam fakt, że „profil magnetyzacji wygląda bardzo dobrze”, a `H_ex` wygląda dziwnie, **nie jest jeszcze dowodem na złą fizykę**.

Może to oznaczać jedną z trzech rzeczy:

1. pole jest fizycznie poprawne, ale wizualnie ostre, bo to druga pochodna,
2. pole jest poprawne dla free-surface, ale użytkownik oczekuje semantyki region-coupling jak w mumax,
3. w implementacji granic regionów Fullmag rzeczywiście gubi fizykę interfejsu.

---

## Diagnoza dla Twojego konkretnego przypadku

### Co wygląda na poprawne

- Sama tekstura `m` wokół dziury wygląda sensownie.
- Jeśli dziura jest prawdziwym „voidem”, to zero normalnej pochodnej na brzegu jest sensowne.
- Z punktu widzenia czystej fizyki free-surface obecny model Fullmag nie jest absurdalny.

### Co wygląda na podejrzane

- Jeżeli ta „kropka” jest modelowana przez **region**, a nie przez prawdziwie nieaktywną geometrię, to Fullmag traktuje tę granicę jak całkowicie odciętą dla exchange.
- Jeżeli chcesz porównywać się do mumax/amumax, to właśnie to jest najbardziej prawdopodobne źródło rozjazdu.
- Dodatkowo Fullmag liczy `H_ex` w **A/m**, a mumax/amumax operują na `B_ex` w **Tesla**. Jeśli pipeline wizualizacji albo eksport porównuje to bez pilnowania jednostek, obraz może wyglądać „dziwnie”, mimo że liczbowo po przeskalowaniu byłby spójny.

### Najbardziej prawdopodobny rdzeń problemu

Nie powiedziałbym dziś: „exchange w Fullmag jest po prostu błędne”.

Powiedziałbym raczej:

> **Implementacja Fullmag jest fizycznie akceptowalna dla wolnej powierzchni, ale zbyt uproszczona dla interfejsów regionów i przez to nie jest parytetowa wobec mumax/amumax.**

I to bardzo dobrze pasuje do Twojej obserwacji:

- `m` wygląda dobrze,
- a pole wymiany przy granicy wygląda nienaturalnie lub zbyt „klockowato”.

---

## Najważniejsze rozjazdy Fullmag vs mumax/amumax

### 1. Brak parowego `A_ij`

To jest numer 1.

W Fullmag w oglądanym kernelu jest jedno `ctx.A` oraz prosty test region mismatch -> self.

W mumax/amumax regiony mają **LUT inter-region exchange** i domyślny **harmonic mean**, plus możliwość override.

To jest zasadnicza różnica fizyczna, nie detal implementacyjny.

### 2. Granica regionów jest traktowana jak wolna powierzchnia

To jest dobre dla void, ale nie dla materiał-materiał.

### 3. Brak rozdzielenia semantyki:

- outside geometry,
- inactive cell,
- nonmagnetic region,
- magnetic region with different `A`.

Mumax i amumax to rozdzielają dużo lepiej.

### 4. Jednostki `H` vs `B`

To nie jest błąd fizyki, ale częste źródło błędnej interpretacji porównań i debug view.

---

## Rekomendowane poprawki w Fullmag

### Priorytet A — konieczne dla parytetu z mumax/amumax

1. **Wprowadzić parowe `A_ij` dla regionów** zamiast prostego `region mismatch -> self`.
2. **Rozdzielić semantics**:
   - void / outside geometry,
   - inactive mask,
   - region interface,
   - `Ms=0` region.
3. Dodać jawne testy:
   - magnetic / vacuum,
   - magnetic / magnetic with same `A`,
   - magnetic / magnetic with different `A`,
   - magnetic / nonmagnetic.

### Priorytet B — ważne dla diagnostyki

4. Dodać debug-quantity typu:
   - `neighbor_classification`,
   - `effective_A_ij`,
   - `exchange_laplacian_raw`,
   - `distance_to_void`,
   - `distance_to_region_boundary`.
5. Ujednolicić eksport jednostek i podpisów: czy viewer pokazuje `H_ex [A/m]`, czy `B_ex [T]`.

### Priorytet C — wygoda porównań z zewnętrznymi solverami

6. Dodać mały benchmark parity:
   - cienki film z dziurą,
   - identyczna geometria i siatka,
   - porównanie `m`, `|H_ex|`, energii exchange,
   - Fullmag vs mumax/amumax.

---

## Jak ja bym to zaimplementował docelowo

### Wariant docelowy

Dla każdej pary komórek `(i, j)`:

```text
if j is outside geometry:
    use free-surface BC   # neighbor = center
elif j is nonmagnetic / inactive:
    explicit rule for vacuum-like semantics
elif region(i) != region(j):
    use A_ij from inter-region LUT
else:
    use A_region(i)
```

oraz:

```text
H_ex(i) = (2/(μ0 Ms_i)) * Σ_dir [ A_ij * (m_j - m_i) / Δ_dir² ]
```

To da Ci:

- zgodność fizyczną dla void,
- zgodność architektoniczną z mumax/amumax,
- naturalną drogę do wsparcia interfejsów materiałowych,
- dużo lepszą interpretowalność przy debugowaniu.

---

## Odpowiedź na Twoje pytanie wprost

### Czy pole wymiany przy krawędziach kropki jest dziś „dziwne”, bo Fullmag liczy je źle?

**Nie powiedziałbym tego tak ostro.**

Dla **dziury jako wolnej powierzchni** obecna implementacja jest sensowna.

### Czy Fullmag jest dziś zgodny z mumax/amumax w traktowaniu granic?

**Nie.**

Największy rozjazd jest na **granicy regionów**, bo Fullmag ją wygasza, a mumax/amumax używają `A_ij`.

### Czy to może tłumaczyć różnicę „magnetyzacja dobra, exchange wygląda źle”? 

**Tak, bardzo mocno.**

### Czy Boris wygląda bliżej mumax czy bliżej obecnego Fullmag?

Na poziomie dokumentowanej semantyki i dojrzałości podejścia do interfejsów/brzegów — **bliżej dojrzałego podejścia mumax niż do obecnego uproszczenia Fullmag na granicy regionów**.

---

## Krótki werdykt końcowy

**Werdykt:**

1. **dla void/free-surface** — Fullmag jest zasadniczo OK,
2. **dla region interfaces** — Fullmag jest dziś zbyt uproszczony,
3. **dla porównania z mumax/amumax** — główny brak to `A_ij` / harmonic mean / jawna semantyka interfejsu,
4. dziwny wygląd `H_ex` przy brzegu nie obala jeszcze poprawności `m`, ale bardzo mocno wskazuje, że trzeba rozdzielić **void boundary** od **region boundary**.

---

## Co warto zrobić jako następny krok

Najbardziej sensowny następny eksperyment debugowy to:

1. uruchomić **ten sam przypadek** w dwóch wariantach geometrii:
   - dziura jako `active_mask == 0`,
   - dziura jako oddzielny region,
2. porównać mapę `H_ex`,
3. dodać chwilowo eksport `effective_A_ij` dla każdego sąsiedztwa.

To bardzo szybko pokaże, czy problem, który widzisz, jest:

- oczekiwanym efektem free-surface,
- czy skutkiem tego, że interfejs regionu jest dziś traktowany zbyt brutalnie.

