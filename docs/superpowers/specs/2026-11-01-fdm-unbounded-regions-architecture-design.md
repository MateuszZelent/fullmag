# Regiony bez limitu 256: wspólny kontrakt Fullmaga i realizacje FDM CPU/CUDA oraz FEM

- Data korekty: 2026-11-01.
- Status: **projekt po przeglądzie źródeł; rekomendacje architektoniczne do dyskusji,
  nie zatwierdzona implementacja ani kwalifikacja runtime.**
- Odczytany checkout: `.claude/worktrees/distracted-newton-4fda3d`, branch
  `claude/elastic-pascal-6d4cc6`, HEAD `9bfa2f26589606fa20bab5d9e0d1a9c5fc20664c`.
  Nazwa katalogu nie określa brancha. Pierwotny plan wskazywał starszą bazę `8a7b0eb32`.
- Zakres tej korekty: dokument projektu. Nie uruchamiano solverów, buildów ani benchmarków.
- Kontrakty nadrzędne:
  [materiały i pola](../../specs/material-assignment-and-spatial-fields-v0.md),
  [nota fizyczna 0104](../../physics/0104-material-regions-parameter-fields-and-interface-couplings.md),
  [architektura backendów](../../architecture/backend-golden-masterplan.md),
  [capability matrix](../../specs/capability-matrix-v0.md).
- [Pierwotny materiał dowodowy](2026-11-01-fdm-unbounded-regions-architecture-evidence.md)
  pozostaje zapisem wcześniejszej analizy. Korekty jego interpretacji są poniżej;
  szacunki bajtów, limitu siatek Borisa i szybkości nie stanowią pomiarów.

## 0. Cel, zakres i znaczenie „bez limitu”

Usuwamy architektoniczny limit 256 wpisów/255 niezerowych regionów FDM i zależność
kosztu wymiany od gęstej tablicy wszystkich par regionów. Jednocześnie umożliwiamy
heterogeniczne `Ms/Aex/alpha` w FDM CUDA, zachowując wydajną ścieżkę jednorodną,
spójność pola z energią i semantykę regionów wspólną z FEM.

„Bez limitu 256” nie oznacza nieskończonej pojemności. Pozostają jawne ograniczenia
pamięci, indeksów, liczby komórek/elementów i możliwości danej realizacji. Domyślna
reprezentacja nie może wymagać kwadratu liczby regionów ani zależeć od największej
wartości ID; koszt jawnie zadanych reguł pozostaje proporcjonalny do ich liczby.
Zwiększenie stałej LUT lub zastąpienie bajtu przez `u16` bez zmiany architektury
nie realizuje celu.

**Rekomendowany kierunek:** trwałe regiony i przypisania materiałów w modelu
wspólnym; zwarte indeksy lokalne dla solvera; niezależny wybór reprezentacji każdego
parametru; w FDM symetryczny współczynnik wymiany na połączeniu sąsiednich komórek.
Tablice ścianowe są kandydatem realizacji tego operatora, a nie publiczną definicją
regionu. FEM zachowuje własną słabą postać i realizację współczynników.

W zakresie są także konsumenci wspólnego planu/ABI, zapis i odczyt wyników,
provenance oraz redukcje regionalne. Nowa fizyka RKKY, pełna heterogeniczna ścieżka
multilayer i zależności parametrów od czasu/temperatury pozostają osobnymi pracami.
Nie wolno jednak wyłączyć z migracji adaptera multilayer, który już tworzy plan
single-grid i korzysta ze zmienianego ABI.

## 1. Wyniki przeglądu bieżących źródeł

Poniższe ustalenia są źródłowe, nie dowodzą wykonania na urządzeniu.

| Obszar | Ustalenie i konsekwencja | Źródło: ścieżka + symbol |
|---|---|---|
| Limit FDM | Limit dotyczy zarówno liczby regionów, jak i wartości indeksów. Trzeba zmienić także admission runnera, nie tylko planer i CUDA. | `crates/fullmag-ir/src/execution.rs::MAX_FDM_REGION_IDS`, `validate_fdm_region_lut_indices`; `crates/fullmag-plan/src/fdm.rs::materialize_object_region_mask`; wywołanie walidatora w `crates/fullmag-runner/src/fdm/mod.rs`; `native/include/fullmag_fdm.h::FULLMAG_FDM_MAX_EXCHANGE_REGIONS`; `backends/fdm/api/c_api.cpp::fullmag_fdm_backend_create_impl`; `crates/fullmag-fdm-sys/src/lib.rs::FULLMAG_FDM_MAX_EXCHANGE_REGIONS` |
| ID publiczne | Region autora ma tekstowe `region_id`; `u32` jest indeksem realizacji, nie uniwersalnym ID Python/API. | `crates/fullmag-ir/src/model.rs::ObjectRegionIR`, `MaterialParameterAssignmentIR`; `crates/fullmag-ir/src/plan.rs::FdmRegionLegendEntryIR` |
| CPU i pary | Kernel CPU nie konsumuje par override, ale publiczny planer już blokuje niewspierane sprzężenia. Nie należy opisywać całej publicznej ścieżki jako cichego ignorowania. Bezpośrednio odtwarzany plan wymaga osobnej walidacji admission. | `crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs::cell_exchange_field`; `crates/fullmag-plan/src/validate.rs::region_coupling_is_executable_for_backend`; `crates/fullmag-plan/src/tests.rs::fdm_region_region_explicit_exchange_blocks_on_cpu_reference` |
| Scale | Lowering sprowadza `harmonic_mean × scale` do skalarnego `material_exchange * scale`. To nie zachowuje zamierzonej semantyki dla zmiennego A. Obecne bramki ograniczają wykonywalność tego przypadku. | `crates/fullmag-plan/src/fdm.rs::materialize_region_exchange_couplings` |
| CUDA | `Ms/A/alpha_field` odrzucają runner i backend. Odblokowanie ABI bez zmiany wszystkich konsumentów byłoby błędem. | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::NativeFdmBackend`; `backends/fdm/api/c_api.cpp::fullmag_fdm_backend_create_impl` |
| Koszt przygotowania | Rasteryzacja regionów sprawdza predykaty regionów dla każdej komórki; sam liniowy builder ścian nie zapewni skalowalnego planowania. Adapter wielu ciał generuje wszystkie pary disabled. | `crates/fullmag-plan/src/fdm.rs::materialize_object_region_mask`; `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::disabled_inter_body_exchange_pairs` |
| FEM | Atrybuty natywnej siatki są dodatnimi `int`, a część tablic ma rozmiar `attributes.Max()`. Dowolne `u32` i rzadkie duże markery wymagają mapowania. | `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp::volume_attributes`; `backends/fem/cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem` |
| ABI | `fullmag_fdm_plan_desc_v2` ma wersję, rozmiar i chroniony odczyt rozszerzeń. Samo pozostawienie starych pól przy odrzucaniu ich wartości nie zachowuje zgodności zachowania. | `native/include/fullmag_fdm.h::fullmag_fdm_plan_desc_v2`; `backends/fdm/api/plan_ingestion_v2.cpp::copy_plan_desc_v2_fields`; `backends/fdm/api/c_api.cpp::fullmag_fdm_backend_create_time_policy_v2_checked` |

`native/construction.rs` nie jest zadeklarowany jako moduł przez odczytany
`native.rs`; nie wolno traktować jego LUT jako aktywnej implementacji.

Pierwotna zależność od PR #374 i wynik „1.65×” wymagają przypiętego commita,
artefaktu i warunków pomiaru. W odczytanych `backends/fdm` nie znaleziono
`exchange_lut_uniform`. Bazę optymalizacji należy sprawdzić przed implementacją;
numer PR ani historyczny wynik nie zastępują aktualnego pomiaru.

## 2. Co przejmujemy z solverów referencyjnych

Źródła referencyjne znajdują się w **głównym checkoutcie** pod
`external_solvers/`; ten worktree nie zawiera ich kodu. Służą do nauki, nie kopiowania.

### Boris

Przydatny wzorzec to parametr z wartością skalarną i opcjonalną zależnością
przestrzenną. `MatP`/`MatPCUDA` mają bazową wartość oraz skalowanie tablicą lub
równaniem. `update_parameters_mcoarse_spatial` sprawdza `is_sdep()`; ścieżka bez
zależności przestrzennej omija odczyt tablicy. Bufor jest domyślnie pusty, może
powstać także przez import OVF, a równanie nie musi wymagać pełnego bufora.

Źródła: `external_solvers/BORIS/Boris/MaterialParameter.h::MatP`,
`MaterialParameterCUDA.h::MatPCUDA`,
`MeshParamsControlCUDA.h::update_parameters_mcoarse_spatial`,
`MaterialParameterPolicyCUDA.h`. Fullmag może użyć wariantu
`Uniform(value) | Dense(values)` bez przejmowania mnożnikowej semantyki Borisa.

Kolekcja `SuperMesh::pMesh` i osobne sprzężenia siatek nie odpowiadają regionom
w obrębie jednego obiektu Fullmaga. 16-bitowe pole w `SurfExchangeCUDA.cu` opisuje
cel sprzężenia; nie dowodzi globalnego limitu 65 535 siatek ani braku innych limitów.
Usuwamy też twierdzenie o porównywalnej szybkości Boris/amumax bez benchmarku.

W `ExchangeCUDA.cu::ExchangeCUDA_FM_UpdateField` kernel ścieżki 0 K używa lokalnych
A i Ms oraz laplasjanu **M**; ścieżka temperaturowa jest inna. Nie przejmujemy tego
jako operatora heterogenicznego Fullmaga: dla zmiennych A/Ms nie jest to ogólnie
dyskretyzacja energii z noty 0104, opartej na gradiencie **m**. To wniosek
matematyczny dotyczący porównywanych modeli, nie ocena całej fizyki Borisa.

### amumax / model mumax3

`external_solvers/amumax/src/engine/regions.go::NREGION` oraz bajtowa mapa regionów
potwierdzają limit reprezentacji 256. `engine/exchange.go::exchParam` i
`exchAverage` pokazują symetryczne pary oraz harmoniczną średnią dodatnich A.
Przejmujemy ideę symetrycznego współczynnika, nie stałą tablicę wszystkich par.
Fullmag zachowuje własne tryby `HarmonicScale`, `Explicit`, `Disabled`.

Niezależnym odniesieniem jest
[OOMMF: Oxs_Exchange6Ngbr i Oxs_ExchangePtwise](https://math.nist.gov/oommf/doc/userguide21a3/userguide-xml/sec_oxsEnergies.html):
wymiana przez symetryczne współczynniki sąsiednich komórek i realizacja zmiennego A.
Źródła te wspierają wybór dyskretyzacji, ale nie kwalifikują kodu Fullmaga.

## 3. Wspólny model: region, materiał i indeks wykonawczy

Rozdzielamy cztery pojęcia:

1. **Tożsamość autora:** trwałe `object_id`, tekstowe `region_id`, materiał,
   selektor, priorytet, przypisania i reguła przejścia materiałowego.
2. **Zrealizowane członkostwo:** komórki/elementy i legenda wiążąca je z obiektami
   oraz regionami. Zmiana numeracji nie zmienia problemu fizycznego.
3. **Współczynniki:** skalar, tabela materiałów albo pole przestrzenne; jeden
   region może mieć zmienny parametr, wiele regionów może dzielić jeden materiał.
4. **Indeksy solvera:** zwarte `u32` dla FDM; zwarte dodatnie atrybuty dla FEM,
   z jawną mapą odwrotną do kanonicznych markerów i regionów.

`u16` może być opcjonalną kompresją wewnętrzną, nigdy limitem wspólnego modelu.
Nie alokujemy `max(region_id)+1` ani `region_count²`. Mapy i legendy mają
sprawdzane zakresy, deterministyczną kolejność i stabilny fingerprint.

**Zero nie oznacza automatycznie próżni.** FDM może używać `region_mask=0` dla
aktywnej części obiektu bez nazwanego regionu. O magnetyczności decydują
członkostwo obiektu i `active_mask`; FEM ma osobne znaczenie markera air=0.
Istniejące traktowanie `u32::MAX` w walidatorze FDM wymaga jawnej normalizacji
importu albo błędu, nie indeksowania nim bufora. W nowej reprezentacji wartość
zarezerwowana nie jest zwykłym regionem.

W tym projekcie nowe reguły autora nadal wskazują **nazwane regiony**; runtime 0
nie staje się publicznym endpointem sprzężenia. Parent↔child domyślnie korzysta
z harmonicznej; jawny override wymaga nazwania obu podobszarów. Obserwable mogą
nadal rozliczać aktywny obszar bazowy 0. Adapter starej LUT zachowuje poprawne
współczynniki jej wiersza/kolumny 0 jako dane wykonawcze; nie tworzy na tej
podstawie nowego regionu autora. Rozszerzenie API o endpoint bazowego podobszaru
nie jest częścią tego refaktoru.

Przypisania i pola zachowują istniejące reguły priority/overlap oraz przejścia
`mesh_relative`, `metric`, `sharp`. Nowy builder korzysta z **już zrealizowanych**
A/Ms, nie z samej nominalnej tabeli materiałów. Usunięcie limitu nie może zmienić
domyślnego wygładzenia przejść ani wymusić ostrej granicy.

Walidacja par sprawdza ownera, istniejące regiony, różne endpointy, skończone
wartości i nieujemność A/scale; normalizuje kolejność endpointów i odrzuca
sprzeczne duplikaty. Nadmiarowa para bez rzeczywistego kontaktu ma deterministyczną
diagnostykę. Odczyt zapisanych planów przechodzi te same kontrole co nowy plan.

## 4. FDM: reprezentacje i przygotowanie operatora

### Niezależny wybór dla parametrów i operatorów

Nie wybieramy jednego globalnego „tieru materiału”. Niejednorodne Ms lub alpha
nie musi wymuszać tablic ścian A; jednorodne A nie oznacza jednorodnego RHS.

| Składnik | Kandydat bazowy | Rozszerzenie do porównania |
|---|---|---|
| Ms, alpha i pozostałe współczynniki lokalne | `Uniform` albo rezydentne `Dense` | tabela unikalnych materiałów z osobnym indeksem materiału |
| Wymiana jednorodna | istniejący szybki stencil, lokalne Ms niezależnie | specjalizacje tylko po pomiarze |
| Wymiana heterogeniczna | H-faces: do trzech tablic A na dodatnich ścianach | H-cellA: A per komórka + symetryczna reguła par; wariant z rzadkimi poprawkami interfejsów |
| Regiony | legenda, członkostwo, obserwable i preprocessing | brak obowiązkowego odczytu region ID w każdym RHS |

Warunek szybkiej wymiany: wszystkie **rzeczywiste połączenia magnetyczne** mają
jednakowy współczynnik i zgodną politykę geometrii. Sama obecność wielu regionów
nie wyłącza tej ścieżki. `ExchangeFaces=None` nie może znaczyć jednocześnie
„jednorodne”, „wymiana wyłączona” i „jeszcze nie przygotowano”; tryb jest jawny.
Identyczne wartości można zwinąć do skalaru; tolerancja nie może usuwać zamierzonej
małej niejednorodności.

### Builder i cykl życia

Wspólny kontrakt reguły pary oraz referencyjny builder są poza runnerem.
Bieżący CPU pozostaje `CpuReference` w `fullmag-engine`; natywny CUDA pozostaje
w `backends/fdm`. Nie tworzymy przy okazji nowego produkcyjnego solvera CPU.

Wejścia buildera: grid/PBC, aktywność, właściciel komórki, członkostwo regionów,
zrealizowane A, znormalizowane rzadkie reguły sprzężeń. Wyjście: jawny tryb
wymiany i bufory operatora. Reguły są rozwiązywane na rzeczywistych sąsiedztwach,
bez tablicy wszystkich par. Dla hash map koszt oczekiwany to O(N + P); dla
uporządkowanej mapy należy jawnie uwzględnić log P. N to liczba komórek, P —
liczba jawnych reguł. To koszt buildera, nie całego przygotowania geometrii.

Domyślne odsprzęganie **różnych obiektów** wynika z ownerów, zamiast generowania
O(R²) par disabled. Regiony jednego obiektu zachowują ciągłą wymianę domyślną.
Jawne sprzężenia respektują własne capability; parametr powierzchniowy J nie
jest bezpośrednio wkładany do A [J/m].

Kompilacja współczynników i upload następują raz dla danej rewizji. Zmiany
materiałów, reguł, geometrii, maski, PBC lub realizacji precyzji unieważniają
odpowiednie bufory, cache pola/RHS i FSAL. Sama zmiana m nie przebudowuje A.
Zmiana nazwy regionu aktualizuje legendę/provenance, bez zbędnego uploadu fizyki.
Nie ma alokacji, dekodowania regionów ani przebudowy par w gorącej pętli.

Rasteryzacja wymaga oddzielnego pomiaru dla tysięcy regionów. Należy wykorzystać
ograniczenia przestrzenne selektorów/indeks kandydatów, gdy obecna pętla N×R
przestaje skalować; przyspieszenie nie zmienia rozstrzygania nakładania regionów.

## 5. Kontrakt fizyczny FDM

Właścicielem fizyki pozostaje nota 0104. Poniżej wymagania do jej uzupełnienia,
nie zastępcza publikacja naukowa. W pierwszej realizacji rozważamy regularną
siatkę kartezjańską z binarną aktywnością, statycznymi parametrami i A ≥ 0.

Dla istniejącego połączenia aktywnych komórek jednego obiektu:

```{math}
:label: design-unbounded-regions-pair
A_f = \begin{cases}
0 & \text{disabled},\\
A^{\mathrm{explicit}}_{r_i r_j} & \text{explicit},\\
s_{r_i r_j}\,H(A_i,A_j) & \text{harmonic-scale},\\
H(A_i,A_j) & \text{brak override},
\end{cases}
\qquad
H(a,b)=\begin{cases}
0 & a=0\ \text{lub}\ b=0,\\
a & a=b>0,\\
2ab/(a+b) & a,b>0.
\end{cases}
```

Najpierw rozstrzygamy geometrię i właścicieli: brak sąsiada lub nieaktywna komórka
nie tworzy połączenia; różne obiekty domyślnie nie mają wymiany. Jawna dodatnia
wartość pary zastępuje harmoniczną również przy lokalnym A=0, jeżeli taki zakres
jest dopuszczony przez kontrakt. Dla nieobecnej wymiany nie ma operatora.
Implementacja średniej musi unikać zbędnego overflow produktu ab; wszystkie
wyniki i konwersje precyzji podlegają walidacji.

```{math}
:label: design-unbounded-regions-energy-field
E_{\mathrm{ex}}=\sum_{f\in F_+} A_f\,\frac{S_f}{d_f}
 |\mathbf m_j-\mathbf m_i|^2,
\qquad
\mathbf H_{\mathrm{ex},i}=\frac{2}{\mu_0 M_{s,i}V_i}
 \sum_{f\in\partial i}A_f\,\frac{S_f}{d_f}(\mathbf m_j-\mathbf m_i).
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $A_i,A_f,A^{\mathrm{explicit}}$ | sztywność lokalna i współczynnik połączenia | $\mathrm{J/m}$ |
| $s$ | skala pary | $1$ |
| $\mathbf m$ | magnetyzacja zredukowana | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A/m}$ |
| $\mu_0$ | przenikalność próżni | $\mathrm{N/A^2}$ |
| $V_i,S_f,d_f$ | objętość, pole ściany, odległość centrów | $\mathrm{m^3},\mathrm{m^2},\mathrm m$ |
| $E_{\mathrm{ex}},\mathbf H_{\mathrm{ex}}$ | energia i pole wymiany | $\mathrm J,\mathrm{A/m}$ |
| $F_+,\partial i$ | dodatnie połączenia siatki, połączenia incydentne do komórki | $1$ |

Każde połączenie w $F_+$ liczymy raz; obie komórki używają **tego samego** A_f.
Wtedy pole jest ujemną pochodną energii podzieloną przez $\mu_0 M_{s,i}V_i$.
Na regularnej siatce $S_f/d_f=V_i/h_f^2$. Podana harmoniczna zakłada równe
odległości półkomórek; nie jest gotową regułą dla dowolnej siatki nieregularnej.

Kontrakt indeksowania `x_plus/y_plus/z_plus` musi określać odczyt ujemnej ściany
z sąsiada, wrap PBC, osie długości 1 i 2 oraz nieaktywne komórki. Przy PBC i dwóch
komórkach dwa połączenia okresowe mogą mieć te same endpointy; nie wolno scalać
ich tylko po nieuporządkowanej parze indeksów. Osie długości 1 nie wnoszą wymiany
z samym sobą. Energia regionalna dostaje połowę energii połączenia na każdą stronę;
suma po rozłącznym podziale, łącznie z aktywnym parent-region 0, odtwarza całość.
Inne obserwable regionalne nadal są redukcjami komórek/elementów, nie ścian.

`Ms > 0` na aktywnej domenie jest **istniejącym wymaganiem** noty 0104 §2.3,
nie nową decyzją do zatwierdzenia. Wymagamy też skończoności Ms/A/alpha, A ≥ 0,
alpha ≥ 0 oraz poprawnych długości buforów; nieaktywnych komórek nie dzielimy przez Ms.

### T0/T1 i DMI

Trzy tablice A_f nie definiują kompletnego operatora korekty brzegowej. Obecne
`exchange_field_t0_fp64_kernel` używa face fractions i φ, a
`exchange_field_t1_fp64_kernel` także kierunkowych odległości δ. Dla nich trzeba
osobno wykazać zgodność **całego ważonego operatora** i energii; samo symetryczne A
nie daje takiego dowodu. Początkowe nowe kombinacje heterogeniczne mogą być jawnie
zablokowane. Migracja już wspieranych regionów/T0/T1 musi zachować geometrię,
walidacje i dotychczasowe zachowanie; dopóki >256 nie przejdzie osobnej bramki,
nie deklarujemy pełnego usunięcia limitu dla tej kombinacji.

DMI przy niejednorodnym A wymaga również lokalnego A w naturalnym warunku
brzegowym; podmiana samego prefaktora 1/Ms nie wystarcza. `a_field` nie wolno
usunąć z potrzeb runtime tylko dlatego, że wymiana ma A_f. Każdy konsument
lokalnego A musi być przeniesiony albo objęty jawną bramką.

## 6. FEM: obowiązkowa część wspólnej architektury

FEM nie przyjmuje FDM-owych tablic ścian. Zachowuje ciągłą magnetyzację w obrębie
obiektu, współczynniki materiałowe i słabą postać z noty 0104:
`M_Ms H_ex = -(2/mu0) K_A m`. Gęste mapowanie markerów dotyczy reprezentacji
siatki, nie dodawania nowych stopni swobody ani nowego modelu interfejsu.

**Rekomendacja:** kanoniczny marker `u32` → zwarty dodatni atrybut natywny
→ mapa odwrotna, osobno dla domen i granic. Liczba atrybutów musi mieścić się
w typie natywnym i budżecie pamięci. Mapa obejmuje air=0 bez kolizji, wszystkie
odwołania współczynników, selektory, interfejsy, eksport i fingerprint.
`verify_marker_map` musi porównywać przez tę mapę, zamiast wymagać równości
numerycznej markera i atrybutu. To korekta konkretnego ryzyka `attributes.Max()`,
nie pełny refaktor backendu FEM.

| Realizacja | Zachowanie objęte projektem | Granice, których nie zdejmujemy automatycznie |
|---|---|---|
| FDM CPU | >256 regionów; nowa obsługa par po kwalifikacji operatora | obecny `CpuReference`, bez fikcyjnego native CPU |
| FDM CUDA | >256; heterogeniczne Ms/A/alpha w zakwalifikowanych kombinacjach | jawne bramki per interakcja, integrator, precyzja i geometria |
| FEM CPU native | >256 markerów, poprawne mapy i materiały; regression istniejących ścieżek | ostre przejścia wymagają właściwej realizacji; DG0 ma odrębne ograniczenia |
| FEM GPU native | zgodność wspólnego kontraktu i >256 dla obsługiwanych współczynników | nie oznacza automatycznego wsparcia DG0 ani wszystkich sprzężeń |

Stan źródeł FEM: `FemRegionMaterialIR` wiąże ownera/materiał/marker; dostępne są
współczynniki skalarne i nodalne Ms/A/alpha, a pola elementowe Ms/A mają węższe
capability. Brak analogicznego `alpha_element_field`; obsługa DG0, consistent mass,
relaksacji i GPU jest ograniczona. Zachowujemy strict/extended i istniejące
odmowy zamiast ogłaszać pełny parytet na podstawie obecności buforów.

FEM `DiffusionIntegrator(a_coeff)` nie realizuje FDM-owych par
`explicit/disabled/harmonic-scale`. Tych par nie odblokowujemy dla FEM w tym
projekcie. Niezależne rozcięcie ciągłego H1 albo sprzężenie powierzchniowe wymaga
osobnej definicji energii, przestrzeni i operatora interfejsu.

Źródła: `crates/fullmag-ir/src/plan.rs::FemRegionMaterialIR`,
`crates/fullmag-plan/src/fem.rs` (materializacja pól),
`backends/fem/cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem`,
`backends/fem/src/mesh_space_preparation.cpp::verify_marker_map`,
`backends/fem/core/fem_material_fields.hpp` (pola materiałowe),
`backends/fem/core/fem_material_runtime.cpp`,
`backends/fem/gpu/cuda/demag_poisson/operators.cpp` (odmowa elementwise Ms).

## 7. IR, ABI, wszystkie konsumujące operatory i zapis wyników

### Plan i migracja

Nowa reprezentacja par powinna być jednym typowanym zbiorem reguł
`HarmonicScale(scale) | Explicit(A) | Disabled`, a nie dwiema konkurującymi listami
z nieokreślonym pierwszeństwem. Wspólny `ProblemIR` przechowuje intencję;
plan wykonawczy — rozstrzygniętą topologię i reprezentację współczynników.

Stare `inter_region_exchange` zawiera już wartości jawne. Adapter może zachować
je jako `Explicit`, lecz nie odzyska z liczby utraconego zamiaru scale. Jeśli
trzeba odzyskać zamiar, plan przebudowuje się z zapisanego kanonicznego IR.
`serde(default)` zapewnia odczyt składniowy, nie dowodzi zgodności semantycznej.
Wersjonujemy realizację, format/cache key i reguły migracji; starych wyników nie
przeliczamy automatycznie ani nie przedstawiamy jako wyników nowego operatora.

### ABI

Rekomendowane jest rozszerzenie chronione `abi_version/struct_size` z jawnym
trybem operatora i descriptorami buforów. Aktualizacje obejmują C header,
Rust FFI, definicję layoutu, ingestion, native validation, preflight i teardown.
Sprawdzamy kompletność pól, pointer/length, finite values, overflow rozmiarów,
czas życia/ownership danych i atomowe przyjęcie nowej konfiguracji.

Tryb nowego descriptora rozstrzyga admission przed dawną walidacją 255 i alokacją
LUT; obecność samego `region_mask` nie może uruchamiać starej ścieżki domyślnej.
Preflight oraz certyfikat planu liczą rzeczywisty koszt wybranej reprezentacji
przed dużymi alokacjami host/device, bez cichej zmiany precyzji przy braku pamięci.

Stary descriptor jest adaptowany **przy konstrukcji** do nowego operatora;
nie wymaga utrzymywania drugiej starej gorącej pętli. Stare LUT/pairs/default
zachowują swoją udokumentowaną semantykę, w tym historyczne `UNSPECIFIED`.
Jednoczesne podanie nowej reprezentacji i starych danych par jest błędem.
Alternatywą jest jawnie wersjonowane niezgodne ABI i migracja wszystkich klientów;
nie nazywamy odrzucania starych pól zgodnością append-only. Usunięcie nazwanej
stałej z publicznego headera też wymaga uwzględnienia zgodności źródłowej klientów.

Zgodność obejmuje fizycznie dopuszczalne stare payloady. Surowy upload w
`backends/fdm/gpu/cuda/runtime/context.cu::context_upload_exchange_lut` nie
sprawdza symetrii ani wartości wpisów. Nowy adapter wymaga skończonej,
nieujemnej, symetrycznej LUT; asymetrii nie wolno po cichu uśrednić do A_f.
Niedopuszczalny stary payload otrzymuje jawny błąd migracji. To udokumentowane
zaostrzenie walidacji, a nie obietnica zachowania każdej dawnej ścieżki ABI.

### CUDA: audyt konsumentów zamiast ogólnego odblokowania

Każdy z poniższych konsumentów otrzymuje lokalne parametry albo konkretną odmowę:

- pole i energia wymiany, gęstości energii i redukcje;
- demag: źródło M = Ms·m, energia i korekty brzegowe;
- Zeeman, anizotropia i magnetoelastyka: pola, energie i prefaktory;
- DMI, także naturalne warunki brzegowe zależne od A;
- LLG i relaksacja: alpha, gamma/(1+alpha²), wszystkie stage/RHS integratorów;
- termika: amplituda szumu, objętość, krok, alpha/Ms, RNG i rejected-step semantics;
- STT/SOT, spin/charge transport i ich sprzężone aktualizacje;
- diagnostyka: moment Ms·m·V, torque, normy błędów i obserwable regionalne.

Wersja podstawowa kwalifikuje deterministyczne exchange/demag/Zeeman/LLG.
Pozostałe kombinacje są odblokowywane osobno po audycie i dowodach; istniejące
jednorodne przypadki pozostają obsługiwane. Nie wystarczy zablokować zmiennego Ms,
jeśli problemem dla danej interakcji jest zmienne A albo alpha. Forced GPU nie
przechodzi po cichu na CPU.

### Artefakty, cache, UI

`workspace_dependency_identity.cpp::context_build_workspace_dependency_identity_v1`
musi objąć rzeczywistą reprezentację, współczynniki, geometrię/PBC, politykę
precyzji i wersję operatora; legenda ma własną tożsamość. Zmiana Ms unieważnia
źródło demag/pola, lecz nie musi przebudowywać geometrycznego kernela FFT.
Checkpoint/resume sprawdza zgodność współczynników i map, także przy niezmienionych
rozmiarach tablic. `A_cell` oraz `A_face` są rozróżnione w metadanych i jednostkach.

Audyt obejmuje membership codec, eksport/import, palety/selekcję UI, zapis wyników,
redukcje i Python round-trip. Bufory liczbowe nie są ograniczane do `u8`; ewentualne
powtarzanie kolorów nie może utożsamiać regionów. Redukcje mają O(N+R), bez maski
N-komórkowej materializowanej osobno dla każdego z R regionów w każdym kroku.

## 8. Wydajność: decyzja na podstawie pomiarów

Porównujemy: uniform, obecną LUT tam, gdzie wejście mieści się w limicie,
H-faces, H-cellA z równoważną obsługą par oraz ograniczony prototyp
piecewise-constant z osobnym indeksem materiału. Ostatni wariant jest szczególnie
istotny dla tysięcy regionów dzielących kilka materiałów. Nie zakładamy, że cała
tabela zmieści się w shared memory ani że region ID jest material ID.

H-faces jest prostą realizacją referencyjną nowego operatora; wybór produkcyjny
pozostaje otwarty do pomiaru. Wszystkie warianty muszą liczyć ten sam problem.
Nie porównujemy szybkiego H-cellA bez override'ów z H-faces realizującym inną fizykę.

Przy d aktywnych osiach i N komórkach gęste ściany zajmują d·N·sizeof(storage).
W 3D fp64 to 24 B/komórkę; Ms i alpha dodają do 16 B, a nadal potrzebne A kolejne
8 B. Do peak memory dochodzą kopie host/device, pola m/H, scratch i FFT.
Fp32 storage zmniejsza część kosztu, ale polityka redukcji i ABI może pozostawać
fp64. Szacunek pamięci rezydentnej nie jest pomiarem ruchu DRAM ani czasu kroku.

Macierz pomiarów obejmuje:

- 2D/3D, working set mieszczący się i niemieszczący w cache, fp64 oraz fp32;
- 1/255/256/257/1000 regionów i większy przypadek w ustalonym budżecie;
- stałą liczbę komórek z różną liczbą regionów, osobno liczbę unikalnych materiałów;
- materiały skupione przestrzennie i przemieszane, mało i dużo rzeczywistych interfejsów;
- exchange-only i pełny krok z demag, oraz koszt planowania, uploadu i peak VRAM/RAM;
- czas osiągnięcia tej samej dokładności, nie tylko czas pojedynczego kernela.

Stałe: GPU/CPU, sterownik, kompilator, precision realization, scena, integrator,
liczba RHS, wyłączony podgląd i zbędne I/O. Rejestrujemy warm-up, powtórzenia,
medianę/rozrzut i receipt dokładnego commita. CUDA events mierzą pracę GPU;
pełny czas przygotowania i wykonania mierzymy osobno.

**Proponowany budżet do uzgodnienia przed optymalizacją:** brak mierzalnej regresji
uniform ponad szum; orientacyjnie ≤3% mediany całego kroku i ≤5% kernela wymiany
na ustalonych przypadkach. Nie ukrywamy regresji wymiany dominacją FFT. Wybór
bardziej złożonej ścieżki uzasadnia istotny, powtarzalny zysk czasu lub pamięci na
docelowych obciążeniach. Próg „>10% pełnego kroku” nie jest jedynym kryterium:
mógłby odrzucić wariant, który umożliwia zmieszczenie symulacji w VRAM.

## 9. Weryfikacja i kryteria odbioru

### Kontrakty i skalowanie

- 255, 256, 257, 1000 regionów; wysokie/rzadkie ID; wiele regionów jednego materiału
  i pole ciągłe w jednym regionie. Oddzielić liczbę etykiet od ich wartości.
- Brak aliasingu, wraparound, alokacji R²/max-ID; poprawne 0/sentinel, konflikty,
  duplikaty par, nieznani ownerzy, malformed payload i brak pamięci.
- Niezmienność fizyki po permutacji region ID i podziale jednorodnego obiektu
  na dodatkowe etykiety. Brak sztucznego odsprzęgania takich etykiet.
- Round-trip Python → IR → plan → artefakt → restore/UI, zgodność legend i rewizji.
- Stary/nowy descriptor i zapisany plan, zmiana współczynników bez zmiany rozmiaru,
  invalidation i ponowna konstrukcja; single-grid adapter wielu ciał.

### Fizyka niezależnie od współdzielonego buildera

Parzystość CPU/GPU nie wystarczy: oba mogą użyć tych samych błędnych A_f.
Potrzebny jest niezależny mały oracle analityczny/dense, który nie wywołuje buildera.

- Dwie komórki: harmoniczna, explicit, scale=0/0.5/1, disabled, A=0;
  skok Ms przy stałym A i stałym m musi dawać zerową wymianę.
- Pochodna energii vs pole, także dla perturbacji stycznych do m, symetria
  operatora z wagą Ms·V, E_ex ≥ 0 dla dopuszczonych nieujemnych współczynników.
- PBC, osie długości 1/2, 2D/3D, dziury, różne obiekty i parent-region 0.
- Skok i gładki profil A: poprawny strumień oraz zbieżność przy zagęszczaniu siatki;
  per-region energia sumuje się do globalnej.
- Różne Ms/alpha: pole, RHS, moment, energie demag/Zeeman, tłumienie i normy;
  statyczny przypadek relaksacji bez wymuszeń powinien spełniać kryteria spadku energii.
- T0/T1, DMI, termika i torque: osobne bramki albo oczekiwane jawne odrzucenie.

### Runtime i FEM

Headless przez publiczne wejście w zarządzanej grupie Docker danego checkoutu:
dwa materiały z parami, 1000 ziaren, przypadek jednorodny z etykietami i bez.
W przypadkach ziarna/material assignment należy jawnie ustawić rodzaj przejścia,
żeby „ziarna” nie oznaczały przypadkowo innego wygładzenia niż w oracle.

FDM CPU/CUDA double: H_ex, H_eff, RHS, energie składników, moment i przebieg do
zadanej dokładności. Tolerancje bezwzględne/względne i normalizację dla wielkości
bliskich zeru przypinamy przed pomiarami do istniejących bramek/precyzji.
Fp32 wymaga własnej kwalifikacji; wynik fp64 nie promuje go automatycznie.
Bitową zgodność można wymagać tylko dla **niezmienionej** ścieżki uniform,
identycznego toolchaina/urządzenia i warunków; zgodność współczynnika H(A,A)=A
sama nie gwarantuje identycznej kolejności działań ani hashy końcowej trajektorii.

FEM: >256 konformalnych markerów, wiele regionów z dwoma materiałami, air,
wysokie rzadkie markery i poprawne remapowanie. Sprawdzamy import/assembly,
H_ex/E_ex i pochodną energii w słabej postaci na CPU oraz obsługiwanej GPU/double;
nieobsługiwane DG0/sprzężenia mają dawać dotychczasowe jawne odmowy.
Porównanie FDM–FEM dotyczy wspólnego problemu i zbieżności, nie bitowej równości.

Obowiązuje aktualny zakaz lokalnego budowania testów jednostkowych z AGENTS.md.
Nie obchodzimy go. Testy kontraktowe należy przygotować do właściwej dopuszczonej
bramki CI, a managed runtime/science wykonać istniejącymi receptami. Kontrole
źródłowe i diff dokumentu nie zastępują tych dowodów. Brak dowodu = `NOT VERIFIED`.

## 10. Kolejność realizacji i punkty do dyskusji

1. **Kontrakt i baseline:** aktualizacja noty 0104, jej source-map oraz specyfikacji
   i macierzy czterech realizacji; przypięcie bazowego commita, przypadków,
   tolerancji i budżetów. Wykonać wymagane kontrole scientific-documentation-contract.
   Nie tworzyć drugiego właściciela tej samej fizyki w nowej nocie 0402; osobny
   dokument realizacji jest uzasadniony tylko przy potrzebie i z linkiem do 0104.
2. **Indeksy, migracja i oracle:** typowane reguły par, mapy owner/region/material,
   kompatybilny adapter, niezależne przypadki analityczne; przygotowanie remapu FEM.
3. **FDM CPU i kandydaci CUDA:** operator pola/energii i H-faces jako referencja;
   ograniczone prototypy wydajnościowe. Dopiero dowody zdejmują bramkę CPU dla par.
4. **Pełna ścieżka CUDA:** wszystkie konsumujące parametry, pamięć i invalidation,
   dopuszczone integratory/interakcje, usunięcie LUT z hot loop i migracja klientów.
   Walidacji 255 nie usuwa się wcześniej, pozostawiając stare indeksowanie.
5. **FEM i produkt:** remap, regression materiałów, artefakty/UI/restore oraz
   adapter wielu ciał; sprawdzenie kosztów przygotowania dużej liczby regionów.
6. **Kwalifikacja:** fizyka, CPU/GPU, wydajność, jawna lista pozostałych ograniczeń.
   Dopiero potem normalny cykl review/PR/integracji dla osobno zleconej implementacji.

Do uzgodnienia pozostają rzeczywiste kompromisy:

- Czy pierwsza kwalifikowana wersja obejmuje heterogeniczne T0/T1, DMI i termikę,
  czy zostają jawnie gated? Rekomendacja: deterministyczny rdzeń najpierw, pełna
  migracja już wspieranych klientów bez regresji.
- Jaki docelowy rozmiar siatki/liczba regionów i budżet VRAM mają rozstrzygać
  benchmark? Rekomendacja: uwzględnić wiele regionów dzielących mało materiałów
  oraz przynajmniej jeden przypadek, dla którego koszt ścian jest istotny.
- Czy pomiary uzasadniają material-table lub rzadką realizację interfejsów?
  Rekomendacja: sprawdzić ograniczony prototyp przed trwałym wyborem storage,
  bez zobowiązania do utrzymywania wszystkich wariantów.

Nie wymagają nowego głosowania: Ms>0, brak cichego fallbacku, zachowanie ownerów,
spójność energii/pola, naprawa niewspieranego CPU przed jego odblokowaniem ani
czytelna migracja ABI. To istniejące kontrakty poprawności.

Nie przypisujemy z góry nowej ścieżki worktree ani historycznej nazwy brancha.
Przed przyszłą implementacją trzeba ponownie ustalić bazę, właściciela i dostępną
izolację. Niniejsza korekta nie uruchamia implementacji, buildu, commita ani PR.
