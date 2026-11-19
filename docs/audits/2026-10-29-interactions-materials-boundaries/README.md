# Pogłębiony audyt oddziaływań FEM/FDM CPU/GPU, materiałów i granic

**Data:** 2026-10-29. **Wynik:** potwierdzono błędy, które mogą zmieniać zadany materiał przed uruchomieniem solvera, oraz rozbieżności obsługi interfejsów między realizacjami. Obecny stan nie uzasadnia deklaracji równoważnej obsługi heterogenicznych materiałów i granic we wszystkich czterech ścieżkach.

Raport jest audytem źródeł i kontraktów. Nie jest kwalifikacją wyników konkretnej symulacji użytkownika. Nie otrzymano reproduktora tej symulacji; opisane wyzwalacze pozwalają zawęzić przyczynę, ale nie dowodzą, który z nich wystąpił w obserwowanym przypadku.

## 1. Zakres i tożsamość dowodu

- Główny checkout: `/home/kkingstoun/git/fullmag/fullmag`, branch `master`, HEAD na początku audytu `e6a58cc7b12bc92b96c271cacb4cd1e19118659e`.
- Uwzględniono bieżące niezacommitowane źródła. Nie wykonano resetu, stash, pull/fetch, zmiany brancha, commita ani modyfikacji implementacji. Nowe pliki tego zadania są wyłącznie raportami/dowodami w tym katalogu.
- Drugi dostępny checkout, `/mnt/c/git/fullmag/fullmag`, miał HEAD `c276a163baff54d728ff0030f2f9caced97dc261` i własne niezacommitowane zmiany. Nie przenoszono wniosków na jego runtime i nie audytowano go jako drugiej wersji solvera.
- Zapisano odciski 2042 plików obszaru przeglądu; końcową kontrolę opisuje `source-verification.json`. Zestaw hashy nie oznacza, że każdy plik został przeczytany linia po linii. Zakres merytoryczny wynika z macierzy i indeksów źródeł.
- FDM CPU oznacza aktualną legalną ścieżkę Rust `CpuReference`. Sam katalog natywnego CPU nie dowodzi jej zastąpienia. FEM CPU/GPU oznacza natywną ścieżkę MFEM/hypre/libCEED/CUDA, nie referencyjny FEM Rust.
- Sprawdzono authoring Python/UI, IR, walidację, planowanie, ABI/runner, współczynniki i wybrane operatory/energie, maski, topologię oraz istniejące testy. Szczegółowe ścieżki źródłowe są w aneksach.

### Klasy dowodów

| Klasa | Co oznacza w tym audycie |
|---|---|
| Potwierdzone w źródłach | Prześledzony producent, warunek, konsument i konkretny wyzwalacz; nie tylko wyszukanie nazwy |
| Izolowana reprodukcja algebraiczna | Mały rachunek bez importowania Fullmaga, odtwarzający istotną operację; wyniki w `isolated-evidence.json` |
| Jawnie niewspierane | Planner/adapter odrzuca kombinację; to luka capability, nie ciche wykonanie błędnej fizyki |
| Ryzyko / NOT VERIFIED | Brak wystarczającego dowodu wykonania, wielkości błędu lub kwalifikacji naukowej |

Nie uruchomiono testów projektu, buildów, solverów, Docker ani przeglądarki. Repozytoryjny `AGENTS.md` zabrania obecnie kompilowania testów jednostkowych; zadanie jest audytem, bez zlecenia napraw. Istniejących plików testowych nie przedstawiono jako wyników PASS. Managed runtime, rzeczywisty GPU, parytet CPU/GPU i naukowa poprawność wyników pozostają **NOT VERIFIED**.

## 2. Najważniejsze ustalenia

P1 oznacza możliwość cichej zmiany modelu/wyniku lub zasadniczy błąd jego realizacji. P2 oznacza istotną lukę authoringu, diagnostyki albo obsługi kombinacji. Priorytet nie zastępuje klasy dowodu.

| ID | Priorytet | Ustalenie | Zasięg | Dowód / szczegóły |
|---|---|---|---|---|
| A1 | P1 | `alpha=0` zmienia się na `0.1`, `Aex=0` na `1e-11` przy odczycie draftu i późniejszym Apply | Inspector → wszystkie dopuszczone solvery | [Authoring A1](authoring-materials.md#a1--p1-edytor-regionu-zmienia-poprawne-zera-materiałowe-na-wartości-domyślne) |
| A2 | P1 | Liniowe/radialne `material_overrides` mogą zostać zapisane jako stałe przy edycji regionu | Inspector → model | `resolveMaterialOverrideDrafts` → `buildObjectRegionPatch`; [aneks](authoring-materials.md) |
| D1 | P1 | Próg `1e-12 J/m` usuwa realną heterogeniczność Aex; np. zmiana `1e-11` → `1.05e-11` znika | FDM single-grid CPU | `fdm.rs::plan_fdm`, okolice 3160; [aneks FDM](fdm.md) |
| D2 | P1 | Materiał/region w układzie obiektu nie odejmuje translacji właściciela | FDM single-grid CPU | `plan_fdm` przekazuje `[0;3]` do resolvera Ms/Aex/Alpha mimo punktów world; [FDM](fdm.md) |
| F1 | P1 | Drugi obiekt może użyć osi anizotropii kubicznej pierwszego, jeśli podstawowe Ms/A/alpha/Ku/anisU są równe | FEM CPU/GPU, multi-object | Warunkowe wywołanie guardu osi w `plan_fem`; [FEM](fem.md) |
| F2 | P1 | Nazwa regionu może nadpisać ID innego regionu i skierować niewłaściwe Ms/Aex do jego elementów | FEM sharp conformal DG0, wykonywalny ograniczony CPU | `build_conformal_region_element_fields`, mapa ID i name we wspólnej przestrzeni; [FEM](fem.md) |
| A3 | P1 | `mesh_relative` używa globalnego minimum różnic współrzędnych zamiast lokalnego rozmiaru siatki | Wspólny resolver FDM/FEM | [Authoring A3](authoring-materials.md#a3--p1-szerokość-przejścia-materiałowego-zależy-od-najmniejszej-różnicy-współrzędnych-nie-od-lokalnej-siatki) |
| D3 | P1 | DMI może przejść przez styk dwóch odrębnych obiektów, chociaż wymiana między nimi jest wyłączona | FDM GPU, multilayer zrealizowany jako native single-grid, styk x/y | Kernel DMI ma union active mask, bez object/region mask; CPU ma odrębne konteksty; [FDM](fdm.md) |
| F3 | P2 | Rozdzielenie węzłów dwóch stykających się magnesów narusza kontrakt typed facets natywnego buildera | FEM shared-domain multi-object | Opisany typed interfejs jest odrzucany przez native mesh builder; nie ogólna awaria magnes–air; [FEM](fem.md) |
| A4 | P2 | Globalna tablica materiałowa może zostać opisana jako realizacja konkretnego assignmentu/regionu | API danych, diagnostyka | Fallback po samym parametrze; [Authoring A4](authoring-materials.md) |
| A5 | P2 | Python handle przyjmuje nieobsługiwane atrybuty materiałowe bez błędu, ale nie przenosi ich do IR | Authoring `MagnetHandle` | Np. Ku2/Kc2/anisC1/Ms_field; [Authoring A5](authoring-materials.md) |

Identyfikatory w tej tabeli są indeksem przekrojowym; lokalne numery w aneksach mogą być inne. Opisy obejmują warunki zawężające. Nie należy generalizować pojedynczej luki na wszystkie realizacje danego oddziaływania.

## 3. Co może bezpośrednio wyjaśniać zgłoszony objaw

**Jeżeli parametry zmieniają się po Apply:** w pierwszej kolejności A1/A2. Obecny edytor nie gwarantuje bezstratnego round-trip istniejących nadpisań. Weryfikować różnicę kanonicznego IR przed/po, nie tylko wartości widoczne w panelu.

**Jeżeli materiał pozostaje taki sam mimo zmiany Aex:** D1 jest konkretną przyczyną dla małych, fizycznie istotnych zmian w FDM CPU. Próg musi być dobrany do jednostki i skali, a najlepiej nie powinien usuwać jawnie zadanego niejednorodnego pola.

**Jeżeli profil nie przesuwa się razem z obiektem:** D2. Porównać identyczny obiekt w początku układu i po translacji, zachowując `frame="object"`; światowy profil powinien być translacją poprzedniego.

**Jeżeli granica materiału jest rozmyta:** domyślny `material_transition=None` dla regionalnych Ms/Aex oznacza trzy komórki, a nie ostry interfejs. Jest to zapisany kontrakt, lecz nie jest czytelnie sterowany w Inspectorze. Dodatkowo A3 może zmienić rzeczywistą szerokość w sposób zależny od siatki.

**Jeżeli problem występuje tylko na GPU lub przy styku obiektów:** rozdzielić D3, F3 oraz jawne ograniczenia capability. Błąd z planera o unsupported nie jest dowodem, że solver zignorował materiał — może być poprawnym zatrzymaniem takiego wykonania.

**Jeżeli zły materiał pojawia się po nazwaniu/importowaniu regionów:** sprawdzić F2 i zasób A4. Błąd danych podglądu trzeba odróżnić od błędnego współczynnika w solverze.

## 4. Trzy różne granice fizyczne

| Przypadek | Poprawna semantyka | Co należy sprawdzać |
|---|---|---|
| Region materiałowy wewnątrz jednego obiektu | Jeden ciągły stopień swobody magnetyzacji; skok współczynników lub jawny profil przejścia | Lokalny Ms w normalizacji, współczynnik wymiany na ścianie/kwadraturze, ciągłość strumienia wymiany |
| Dwa odrębne stykające się obiekty | Oddzielne magnetyzacje; brak bezpośredniej wymiany bez jawnego coupling | Własność sąsiada, brak przecieku exchange/DMI, poprawne jawne sprzężenie powierzchniowe |
| Magnes–powietrze i zewnętrzna granica airboxu | Powietrze nie ma LLG, ale uczestniczy w magnetostatyce; zewnętrzny warunek Poissona nie jest granicą materiału | Ciągłość potencjału i źródło z fizycznego M; brak błędnego Dirichleta na powierzchni samego magnesu |

Kanoniczne równania i jednostki: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`, symbole/etykiety `material-exchange-energy`, `material-exchange-flux`, `material-fdm-harmonic-exchange`, `material-fem-weighted-mass`, `material-rkky-energy`. Audyt nie zastępuje tych równań nową wersją kontraktu.

Zmiana Ms jest fizyczną zmianą źródła demagnetyzacji, ponieważ fizyczne M jest iloczynem Ms i zredukowanego m. Nie wolno z góry uznawać każdego pola przy skoku Ms za artefakt. Z kolei wygładzenie ostrego skoku zmienia model i wymaga jawnej decyzji.

DMI ma naturalny warunek brzegowy wynikający z energii chiralnej. Zwykłe wyzerowanie pochodnej albo samo wyłączenie międzyobiektowej wymiany nie dowodzi właściwego warunku DMI. Efekt DMI na brzegu jest opisany w pracy [Rohart i Thiaville, PRB 88, 184422](https://doi.org/10.1103/PhysRevB.88.184422); implementację Fullmaga oceniono na podstawie jego własnych operatorów i guardów.

## 5. Macierz materiałów — authoring nie oznacza realizacji

| Forma materiału | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Jednorodne Ms/A/alpha | Źródłowa ścieżka istnieje | Źródłowa ścieżka istnieje | Źródłowa ścieżka istnieje | Źródłowa ścieżka istnieje |
| Różne materiały odrębnych obiektów | Multilayer/per-body; ograniczenia modeli | Strategie i guardy zależne od układu, materiałów, integratora | Nodalne/per-object; luka osi kubicznych F1 | Nodalne/per-object; luka osi kubicznych F1 |
| Regionalne Ms/Aex/Alpha constant/linear/radial | Resolver istnieje; D1/D2/A3 | Jawnie blokowane przy forced CUDA | Resolver istnieje; A3 | Nodalna realizacja w dopuszczonych kombinacjach; sharp DG0 odrębnie blokowane |
| Sharp conformal Ms/Aex DG0 | Nie dotyczy FEM DG0; FDM ma własny face operator | Nie przenosić statusu CPU | Ograniczona ścieżka z consistent mass i guardami konsumentów; F2 | Jawnie niewspierane w aktualnej ścieżce |
| Regionalne Ku1/Ku2/Kc/osi/DMI przez nowe assignment/override | Jawny reject | Jawny reject | Jawny reject | Jawny reject |
| Sampled parameter assignment | Odrębne assety autora nie mają ogólnego pointwise runtime | Nie zakładać realizacji | Nie utożsamiać z istniejącymi tablicami MaterialIR | Nie utożsamiać z uploadem dowolnego pola |

Tablice starszego `MaterialIR.*_field`, nowe `material_parameter_fields`, `object_regions.material_overrides` i elementowe DG0 są odmiennymi wejściami. Test jednej ścieżki nie jest dowodem pozostałych. Pełne macierze oddziaływań oraz boundary conditions są w [FDM](fdm.md) i [FEM](fem.md).

## 6. Pokrycie oddziaływań i warunków brzegowych

Przegląd obejmuje: exchange, demag, Zeeman/pola przestrzenne/czasowe/regionalne, anizotropię jednoosiową i kubiczną, interfacial/bulk/rotated DMI, jawne exchange/RKKY/interlayer couplings, STT Zhang–Li/Slonczewski/CPP, SOT/transport spinowy, thermal Brown, Oersted/źródła antenowe i magnetoelastykę. Uwzględniono także constrained/frozen spins, absorbery, PBC, Floquet i powierzchniową anizotropię w zakresie ich odrębnych ścieżek czasowych/częstotliwościowych.

Dla sprzężonych transportów i mechaniki audyt obejmuje właścicieli, mapowanie materiałów, dostępność i wejścia do micromagnetycznego RHS. Nie stanowi niezależnej, pełnej kwalifikacji wszystkich równań transportu ładunku/spinu, falowodu, obwodu anteny ani mechaniki. Aneksy wskazują, gdzie ograniczono się do mapy źródeł/guardów. Nie dodano niezweryfikowanej pozytywnej oceny tych podsystemów.

Istotne działające zabezpieczenia w źródłach:

- nieobsługiwane regionalne parametry i wymuszony CUDA są odrzucane jawnie;
- sharp FEM ma osobny kontrakt DG0 i kontrolę konsumentów; nie jest bezwarunkowo uśredniany do węzłów;
- różne obiekty FEM mają odrębne magnetyczne DOF, regiony tego samego obiektu mogą dzielić DOF;
- pojedynczy styk magnes–powietrze nie jest automatycznie rozcinany przez packer — węzły air-adjacent korzystają z mapy magnetycznej;
- sprzężenia powierzchniowe nie są utożsamiane ze zmianą objętościowego Aex;
- źródłowy fallback/availability nie jest traktowany jako dowód wykonania na GPU.

## 7. Plan napraw z kryteriami odbioru

### Etap 1 — bezstratny zapis i diagnostyka

Właściciel: Inspector/authoring. Pliki: `ObjectRegionsPanelModel.ts`, `ObjectRegionsPanel.tsx`, regionalne panele materiałowe i testy, `world.py` dla nieobsługiwanych właściwości, `data/material_fields.rs` dla scoping.

Kryteria: edycja samej nazwy nie zmienia żadnego parametru, pola, jednostki, transition ani priority; zero pozostaje zerem; nieobsługiwany wariant jest zachowany albo jawnie nieedytowalny; zasób assignmentu nie otrzymuje obcych próbek. UI pokazuje authored vs executable oraz wybraną ścieżkę CPU/GPU. Ekspansja funkcjonalności nie jest konieczna do usunięcia utraty danych.

### Etap 2 — jednoznaczna tożsamość i materializacja współczynników

Właściciel: IR/planner. Pliki: `material.rs`, `material_transition.rs`, `fdm.rs`, `fem.rs`, `mesh.rs` i odpowiadające testy.

Kryteria: tylko immutable region ID jest kluczem fizyki; kolizja z display name nie zmienia mapy. Każde jawnie niejednorodne pole Aex zachowuje zmienność także dla małych zmian. Przesunięcie obiektu zachowuje profil object-frame. Lokalny transition nie zależy od odległych węzłów ani arbitralnego obrotu. Weryfikacja osi kubicznych jest bezwarunkowa względem częściowo porównywanych skalarów; do czasu implementacji osi per-object niezgodna konfiguracja jest odrzucana.

### Etap 3 — kontrakty interfejsów solverów

Właściciele: osobno FDM GPU i FEM mesh/demag.

- FDM: neighbor acceptance dla DMI musi uwzględniać własność obiektu i deklarowany model sprzężenia. Regresja ma dwa stykające się w x/y obiekty, identyczne D, wyłączone demag i cross-object exchange, oraz porównanie z dwoma izolowanymi ciałami. Styk wyłącznie w z nie wystarcza do testowania stencila iDMI x/y.
- FEM: najpierw uzgodnić packer, typed material facets i native admission po rozcięciu kontaktu. Zachować odrębne magnetyczne DOF ciał. Dla realizacji z potencjałem sprawdzić wymagane mapy/constraints wspólnej przestrzeni magnetostatycznej; audyt nie dowiódł wykonanego błędnego solve Poissona i nie narzuca przebudowy tej przestrzeni bez osobnego projektu. Przypadek dwóch stykających się ciał musi poprawnie przejść mesh validation, a ciągłość potencjału mieć oddzielny dowód.

### Etap 4 — jawny zakres wsparcia

Właściciel: wspólny kontrakt capability UI/Python/IR/planner/runtime. Najpierw usunąć rozbieżność komunikatów i zachować fail-closed. Dopiero potem rozszerzać regionalne Ku/DMI, sharp GPU, IEC i transporty na kolejne lane. Każde rozszerzenie wymaga energii/weak form, jednostek, material location, operatora brzegowego, field/energy parity oraz źródła provenance. Usunięcie guardu bez operatora i dowodów nie jest naprawą.

### Etap 5 — walidacja naukowa i parytet

| Test | Cel / kryterium | Lane |
|---|---|---|
| Round-trip parametrów i pól | IR przed/po zmianie metadanych identyczne w części fizycznej | UI/Python/IR |
| Dwa ciała, potem zmiana jednego | Lokalny operator zmienia się wyłącznie na właściwym owner; demag może fizycznie zmienić się globalnie | Każda wspierana ścieżka |
| Pręt dwufazowy — skoki A, K, Ms osobno i razem | Pinning/depinning wobec wyniku analitycznego; zbieżność siatki i szybkości rampy | FDM CPU/GPU, FEM CPU/GPU tam, gdzie capability rzeczywiście istnieje |
| Exchange flux na interfejsie | Ciągłość właściwego strumienia i spójność energii z polem, nie arbitralne uśrednienie Ms | Heterogeniczne FDM/FEM |
| Tangent directional derivative | Zgodność zmiany energii z polem dla każdej energii i sumy; kilka wielkości perturbacji | CPU i rzeczywiste GPU |
| DMI edge/interface | Znak i skala naturalnego BC; wszystkie normalne, maski z otworem, styk ciał, PBC | Dopuszczone DMI lane |
| Demag multi-body/airbox | Źródło z Ms*m, ciągłość potencjału, odpowiedź krzyżowa, zbieżność airboxu/strategii | Poisson oddzielnie od FEM/BEM/FFT |
| Anizotropia kubiczna obrócona o 45° | Dla m=x i Kc1>0: gęstości 0 i Kc1/4 we właściwych ramach | FEM CPU/GPU oraz FDM |
| Thermal/STT/SOT/magnetoelastic | Lokalne Ms/alpha/objętości i maski target; dla momentów nie konserwatywnych właściwa walidacja momentu/statystyki | Każda rzeczywiście dopuszczona kombinacja |
| Odrzucenia capability | Unsupported daje dokładny powód bez wykonania modelu z pominiętym składnikiem | Wszystkie lane |

Pręt dwufazowy opiera się na [Heistracher i in., JMMM 548, 168875](https://doi.org/10.1016/j.jmmm.2021.168875), zaprojektowanym właśnie do sprawdzania nieciągłości A, K i Ms w FDM/FEM. To właściwy dodatkowy benchmark; jednorodny SP4 nie zastępuje testu granic materiałowych. Tolerancje trzeba określić osobno dla discretization error, solver residual, czasu i fp32/fp64; sam mały błąd CPU/GPU może oznaczać wspólny błąd obu implementacji.

## 8. Artefakty i dalsza kwalifikacja

- [Authoring i wspólna materializacja](authoring-materials.md): szczegółowe A1–A6, źródła, wyzwalacze i regresje.
- [FDM CPU/GPU](fdm.md): dispatch, oddziaływania, materiały, granice, ustalenia i indeks źródeł.
- [FEM CPU/GPU](fem.md): DG0/nodalne współczynniki, operator/BC, guardy, ustalenia i indeks źródeł.
- [Izolowana arytmetyka](isolated-evidence.json): zera, tolerancja Aex, skala przejścia, osie kubiczne, kolizja ID/name.
- [Tożsamość źródeł](source-verification.json) i [hashy źródeł](source-manifest.json): granica aktualności odczytów.

Najpierw należy naprawić cichą utratę intencji i błędy identyfikacji/materializacji. Następnie naprawić oraz wykonać testy interfejsów operatorów. Dopiero wyniki zarządzanych uruchomień z zapisanym SHA, wersją modelu, siatką, rzeczywistym device/precision, per-interaction energies i zbieżnością mogą zamknąć kwalifikację naukową.

Przyjęte metody: `code-review-and-quality`, repozytoryjne `scientific-documentation-contract`, `backend-golden-masterplan`, `fem-native-backend-architecture`. To raport wewnętrzny, nie publikowana terminalna strona naukowa; brak wykonania przykładów/solverów nie jest ukrywany przez formalną walidację dokumentacji. Context7 zgłosił przekroczony miesięczny limit przy lookupie MFEM. Semantykę DOF sprawdzono w [oficjalnym opisie topologii i przestrzeni MFEM](https://mfem.org/mesh-format-v1.x/): numery globalne DOF wynikają z topologii siatki, nie z samej równości współrzędnych. Z tego i kodu Fullmaga wynika analiza topologiczna F3; nie zastępuje to wyniku runtime.
