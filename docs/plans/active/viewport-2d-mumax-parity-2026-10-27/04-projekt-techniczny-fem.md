# Projekt techniczny: widok 2D dla FEM (i wspólny operator próbkowania FDM/FEM)

- Data: 2026-10-27
- Status: **PROPOSED**. Zmiany numeryczne wymagają wcześniejszej aktualizacji [noty 0970](../../../physics/0970-planar-monitor-sampling-and-projection.md) przez `scientific-documentation-contract` (reguła „physics before implementation”)
- Rola dokumentu: projekt wejściowy, nie strona terminalna w rozumieniu `scientific-documentation-contract`. Kanonicznym właścicielem równań, symboli i macierzy legalności torów pozostaje nota 0970; bramki walidatora tego skilla (LaTeX, tabela symboli, source map, bibliografia) obowiązują przy jej aktualizacji w zadaniu F0.5, nie dla tego pliku
- Wiążące: decyzja 10 z 31.08 (dokładny sampling na mieszanym carrierze; zakaz ukrytej konwersji do tetów, nearest-FDM i pomijania elementów), decyzje 14–19 (tożsamość próbki, atomowa klatka, binarny data plane, klucz cache, `vector_budget`, profile jakości), ADR 0020 (jeden sampler `PlanarSamplingEngine`), ADR 0021 i nota 0106 (mieszana topologia P1)

## 1. Dlaczego FEM jest trudny

| Aspekt | FDM (mumax3) | FEM (Fullmag) |
|---|---|---|
| Gdzie są dane | środki komórek regularnej siatki | węzły P1 nieregularnej siatki Tet4/Prism6/Pyramid5/Hex8 |
| Co to jest „warstwa” | wycinek tablicy `k` | brak; płaszczyzna przecina elementy w dowolnych miejscach |
| Wartość w pikselu | `q[i,j,k]` po indeksie | lokalizacja elementu + odwrotne odwzorowanie + funkcje kształtu |
| Koszt nowej klatki pola | O(piksele), bez geometrii | dziś O(Σ bbox pikseli elementów + P_puste·E) przy każdym żądaniu (`planar_sampling/fem.rs:251-416`) |
| Granice obiektów | krawędzie komórek | przecięcia ścian elementów z płaszczyzną |
| Airbox | zwykle brak | elementy powietrza, w SP4 z Pyramid5 w powłoce przejściowej |

Obecny sampler FEM jest poprawny dla Tet4 i Prism6, ale przy każdym żądaniu zasobu wykonuje od nowa rozwiązanie targetu, rozwinięcie wartości i pełną pętlę po elementach (N-04 w audycie). Nie ma indeksu przestrzennego (P1-09), a jeden Pyramid5 w siatce odrzuca każde żądanie (P0-03). To uniemożliwia zachowanie „jak mumax”: płynny krok warstwy i natychmiastowe odświeżenie przy nowym kroku solvera.

## 2. Kluczowa obserwacja

Wszystkie legalne operatory liniowe w nocie 0970 (plane sample, slab average, depth projection w trybie `mean`/`integral`) są **liniowe względem wartości węzłowych**. Dla ustalonej geometrii (siatka, target, scope, rama, operator, rozdzielczość) wynik dla piksela p ma postać:

```math
\bar q_p = \frac{\sum_{a} W_{pa}\, q_a}{M_p},
\qquad
W_{pa} =
\begin{cases}
N_a\bigl(\boldsymbol\xi_e(\mathbf x_p)\bigr) & \text{plane sample, } \mathbf x_p \in e,\\[2pt]
\displaystyle\int_{e \cap \Pi_p} N_a\,\mathrm dV & \text{slab/depth},
\end{cases}
\qquad
M_p =
\begin{cases}
1 & \text{plane},\\
|\,\Omega_{\mathrm{sel}} \cap \Pi_p\,| & \text{slab/depth},
\end{cases}
```

gdzie Π_p to pryzmat piksela, a ξ_e to współrzędne referencyjne elementu e. Całka ∫ N_a dV po obszarze e ∩ Π_p musi być liczona dla **własnej bazy elementu**: dla Tet4 wystarcza dekompozycja na tetraedry z wartościami liniowymi (baza jest afiniczna), ale dla Prism6, Hex8 i Pyramid5 wymagana jest kwadratura elementowa na obszarze przyciętym, mapowanym do przestrzeni referencyjnej. Obecna ścieżka używa liniowego przycinania także dla Prism6, co jest dokładne tylko dla pól afinicznych (N-09 w audycie 01). Liniowość względem wartości węzłowych, a więc cała architektura operatora, pozostaje niezmieniona. Macierz W jest rzadka: plane sample ma ≤ 8 niezerowych wpisów na piksel (Hex8), slab/depth ma tyle, ile węzłów elementów przeciętych przez pryzmat piksela.

FDM ma tę samą postać: plane sample to W z jednym wpisem 1 na piksel (wartość komórki), slab/depth to wagi objętości przecięcia komórki z pryzmatem (`eq-planar-fdm-discrete` w 0970).

Wniosek: **jeden operator próbkowania S = (W, M)** dla FDM i FEM. Kosztowna część (lokalizacja, odwrotne odwzorowanie, przycinanie wielościanów) zależy tylko od geometrii i jest liczona raz. Nowa klatka pola to rzadkie mnożenie macierz–wektor O(nnz(W)), czyli zachowanie analogiczne do wycinka tablicy w mumax3.

Operatory nieliniowe (`rms`, `min`, `max` w slab/depth, surface projection z polityką widoczności) pozostają na obecnej ścieżce bez cache operatora i są oznaczone w meta jako `operator_cache: none`.

## 3. Architektura dwuetapowa (D2D-05)

```text
                  ┌─────────────────── etap geometryczny (cache) ───────────────────┐
mesh topology ──► │ indeks przestrzenny → kandydaci → przekroje elementów → W, M,   │
target/scope  ──► │ maska zajętości, overlay przekroju (FMCS), przystanki warstw,    │──► PlanarSamplingOperator
rama/operator ──► │ id elementu/komórki na piksel, diagnostyka nakładania            │     (klucz: geometry_token)
rozdzielczość ──► └──────────────────────────────────────────────────────────────────┘
                                                   │
                  ┌───────── etap polowy (przy każdej rewizji pola) ─────────┐
pole węzłowe ───► │ q̄ = (W·q) / M per składowa; zakres zajętości; checksum  │──► scalar / vectors / direction
(rewizja)         └───────────────────────────────────────────────────────────┘     (klucz: geometry_token + field_revision)
```

### 3.1. `PlanarSamplingOperator`

| Pole | Typ | Uwagi |
|---|---|---|
| `geometry_token` | SHA-256 | z `topology_fingerprint` (lub tożsamości siatki FDM), targetu, scope, ramy, operatora, rozdzielczości, wersji samplera |
| `row_ptr`, `col_idx`, `weights` | CSR: `u32`, `u32`, `f64` | indeksy węzłów (FEM) lub komórek (FDM) carriera |
| `measure` | `f64` na piksel | M_p; 0 oznacza piksel niezajęty |
| `occupancy` | `u8` na piksel | zajęty / pusty / nakładanie (diagnostyka N-05) |
| `source_entity` | `u32` na piksel | id elementu lub komórki — dla sondy i overlay |
| `section_overlay` | FMCS v4 / FMFG v1 | istniejące kodeki, budowane raz (naprawa podwójnej budowy, N-04) |
| `layer_stops`, `navigation_step_m` | meta | §5 |

Pamięć: dla rastra 512² i średnio 6 wpisów na piksel ≈ 2,6·10⁵ · 6 · 12 B ≈ 19 MB. Dla 2048² plane sample ≈ 300 MB — dlatego profil `publication` liczy W kafelkami i nie trzyma go w cache, tylko strumieniuje gather.

### 3.2. Cache i współbieżność

- LRU operatorów per sesja z limitem bajtów (propozycja 512 MB) niezależny od obecnego cache próbek (8 wpisów / 128 MiB, `quantity_data_plane.rs:38,42`).
- **Single-flight** po `geometry_token` i po `(geometry_token, field_revision)`: równoległe żądania meta/scalar/vectors/mask tej samej klatki czekają na jedno obliczenie (naprawa N-04).
- Obliczenia w `spawn_blocking` (albo dedykowanej puli), nie w wątku async handlera.
- Epoka sesji w kluczu i fence **przed** wstawieniem do cache (naprawa P1-14).
- Invalidacja: zmiana siatki, targetu lub ramy unieważnia operator; nowa rewizja pola unieważnia tylko wynik etapu polowego. Realtime publikuje oba rodzaje zdarzeń osobno, a frontend refetchuje tylko zasoby zależne od pola (decyzja 20).

### 3.3. Etap polowy

- Gather: dla każdej składowej `q̄_p = Σ W_pa q_a / M_p`; puste piksele mają NaN w payloadzie i 0 w masce, a nie 0.0 w wartościach (naprawa P1-12).
- Zakres zajętości liczony tylko po pikselach zajętych; meta rozdziela `occupied_range` i `rendered_range`.
- Redukcja wektorowa przed wyprowadzeniem składowych (wymóg 0970 „vector reduction precedes component derivation”) jest zachowana, bo gather działa na składowych świata, a składowe u/v/normal/`direction` liczy się po nim.
- Koszt: 512² · 6 · 3 składowe ≈ 4,7·10⁶ FMA ≈ kilka ms na jednym rdzeniu.

## 4. Etap geometryczny

### 4.1. Indeks przestrzenny (P1-09)

- Budowany raz na `topology_fingerprint`: BVH po AABB elementów (SAH albo median split), z dodatkowymi posortowanymi listami przedziałów [min, max] wzdłuż osi x, y, z dla płaszczyzn osiowych.
- Zapytanie płaszczyzny: dla XY/XZ/YZ wyszukanie przedziałów zawierających współrzędną (O(log E + k)); dla ramy dowolnej przejście BVH z testem płaszczyzna–AABB. Slab: test przecięcia z warstwą |s| ≤ t/2.
- Element-driven rasteryzacja zamiast lokalizacji per piksel: dla każdego kandydata liczony jest wielokąt przekroju w (u,v), a potem tylko piksele, których środki leżą w wielokącie, dostają odwrotne odwzorowanie i wagi. Koszt O(k + liczba pikseli zajętych), bez skanu `interpolate_at` po wszystkich elementach (`fem.rs:518-534`).
- Własność pikseli na wspólnych ścianach: deterministyczna reguła top-left na krawędziach wielokąta przekroju; piksel trafiony przez dwa elementy z różną wartością (siatka niekonformna) zwiększa licznik `overlap_count` i jest raportowany w diagnostyce (naprawa N-05).
- Legacy `fem_spatial_index_cache` z `/samples/slice` może zostać źródłem kodu BVH, ale nie źródłem semantyki (decyzja 23).

### 4.2. Odwrotne odwzorowanie i tolerancje (P1-10)

| Element | Odwzorowanie | Odwrotność | Uwagi |
|---|---|---|---|
| Tet4 | afiniczne | zamknięta postać (barycentryczne) | istniejące |
| Prism6 | trójkąt-P1 × odcinek-P1 | Newton (istniejący, `fem.rs:564-601`); zamknięta postać, gdy ściany warstw są równoległe do płaszczyzny | §5.1: przekrój XY siatki swept jest dokładnie kawałkami liniowy |
| Hex8 | trójliniowe | Newton z kontrolą jakobianu | nowe (F3) |
| Pyramid5 | baza pierwszego rzędu z wymiernym odwzorowaniem referencyjnym (nota 0106, tabela przy linii 251) | Newton na odwzorowaniu wymiernym | nowe (F3); **baza musi być identyczna z bazą MFEM używaną przez solver** — do potwierdzenia w nocie 0970 przed implementacją (D2D-08) |

Wszystkie tolerancje względne: `ε_x = c · diam(e)`, `ε_ξ` bezwymiarowe w przestrzeni referencyjnej, próg jakobianu względem `diam(e)³`. Usunąć absolutne `1e-12 m`, `1e-13`, `1e-24`, `== 0.0` (lista w audycie 01 §2, P1-10). Test skali: ta sama siatka w nm, µm i mm daje identyczne W.

### 4.3. Kontrola typów elementów tylko w targetcie (D2D-07)

Dziś dispatch odrzuca całą siatkę, jeśli gdziekolwiek jest Pyramid5/Hex8 (`planar_sampling/target.rs:742-778`). Propozycja: kontrolować typy elementów należących do targetu i scope **po** selekcji. Elementy poza targetem nie są próbkowane z definicji targetu, więc nie jest to „pomijanie elementów” zakazane decyzją 10. Jeżeli płaszczyzna przecina wybrany element nieobsługiwanego typu, żądanie nadal kończy się 422 z liczbą takich elementów. Efekt: `m` w magnesie z Prism6 działa na siatce SP4 przed F3; pola pełnej domeny w airboxie z Pyramid5 nadal uczciwie odmawiają.

## 5. Co znaczy „warstwa” w FEM (D2D-06)

### 5.1. Siatki swept (certyfikat mixed-layer)

Certyfikat `MixedLayerTopologyCertificateV1IR` publikuje `resolved_sweep_direction`, `realized_layer_count` i `magnetic_plane_coordinates_m` z tolerancją `plane_tolerance_m` (`crates/fullmag-ir/src/mesh_assets.rs:1468-1477`). Gdy normalna płaszczyzny pokrywa się z kierunkiem sweepu:

- przystankami suwaka są płaszczyzny węzłów; na nich wartość P1 jest wyznaczona dokładnie przez wartości węzłowe (bez interpolacji wzdłuż normalnej), co jest najbliższym odpowiednikiem komórki mumax3;
- między płaszczyznami węzłów, przy czystym sweepie (trójkąt górny jest przesunięciem dolnego wzdłuż normalnej), Prism6 ma na płaszczyźnie stałe ζ, więc przekrój jest kawałkowo liniowy na trójkątach podstawy i renderowanie jest dokładne; certyfikat musi tę własność potwierdzać, inaczej obowiązuje ogólny Newton;
- odczyt: `płaszczyzna 2/4 · z = 10.00 nm`; meta publikuje `layer_stops` z certyfikatu, nie z heurystyki.

Gdy normalna nie jest równoległa do sweepu (XZ/YZ dla cienkiej warstwy), tryb przechodzi na ciągły.

### 5.2. Warstwy nazwane

Obiekty magnetyczne (i regiony, po naprawie P1-03) z zakresem wzdłuż normalnej tworzą przystanki nazwane. Wybór warstwy nazwanej = slab average po grubości obiektu (operator liniowy, więc korzysta z cache operatora). Odczyt: `free_layer · z ∈ [0, 5] nm · slab`. To ten sam mechanizm co FDM `named-layer` z `FdmLayerPlanIR.layer_id`.

### 5.3. Siatki niestrukturalne (Tet4, mieszane bez certyfikatu)

Brak warstw danych. Suwak jest ciągły; krok ‹ › i `[` `]` to `navigation_step_m` = mediana rozciągłości kandydatów wzdłuż normalnej w bieżącej płaszczyźnie. Tooltip: „pomoc nawigacyjna, nie warstwa danych”. Odczyt zawiera liczbę przeciętych elementów, żeby użytkownik widział, że płaszczyzna jest „prawdziwa”, a nie wycinek tablicy.

## 6. Pyramid5 i Hex8 (P0-03, D2D-08)

Kolejność:

1. Nota 0970: dodać bazy Pyramid5 i Hex8, odwrotne odwzorowania, przycinanie wypukłych komórek dla slab/depth (Hex8 i Pyramid5 z niepłaskimi ścianami czworokątnymi wymagają podziału ścian lub kwadratury — rozstrzygnąć w nocie), klasyfikację granic w FMCS v4 i tabelę legalności torów.
2. Potwierdzić, że baza Pyramid5 w samplerze jest identyczna z bazą MFEM solvera (nota 0106 wymaga „geometry-specific MFEM basis”). Jeżeli MFEM używa innej bazy pierwszego rzędu niż zakłada nota, sampler musi przyjąć bazę MFEM; różnica bazy oznacza błąd próbkowania pola rozwiązanego.
3. Implementacja w `planar_sampling/fem.rs` (dispatch w `target.rs:742-778`, enum w `contract.rs:218-228`).
4. Fixture SP4: Prism6 w magnesie + Pyramid5 w powłoce + Tet4 w powietrzu; pola wytwarzane (stałe, liniowe, kwadratowe); płaszczyzny osiowe i skośne; slab/depth.

Podział Hex8 na tetraedry jest **niedozwolony** jako realizacja (pole trójliniowe nie jest kawałkami liniowe), zgodnie z decyzją 10.

## 7. Polityka rozdzielczości rastra FEM

| Profil | Rozdzielczość | Cel |
|---|---|---|
| `interactive` | najdłuższa oś 256 px | podgląd przy przeciąganiu suwaka; zawsze z cache operatora, jeśli istnieje |
| `analysis` (domyślny) | piksel ≈ h_med/2 przeciętych elementów, oś 256–2048 px | klatka naukowa; sonda i eksport danych |
| `publication` | do 4096 px na oś, liczone kafelkami | eksport PNG/danych |

h_med pochodzi z kandydatów etapu geometrycznego. Rozdzielczość jest częścią `geometry_token`, więc zmiana profilu jest jawną nową próbką.

## 8. Wektory (P1-13, D2D-04)

- Zasób wektorów przyjmuje siatkę glifów: `vector_budget` (liczba glifów) i kotwicę siatki w (u,v). Wchodzi do tożsamości i linku kanonicznego.
- Wartość glifu: ewaluacja punktowa w środku komórki siatki glifów przez ten sam lokalizator (FEM) lub komórkę (FDM). Nie 1D stride po rastrze.
- Składowa `direction` (koło barw) używa pełnego rastra 3-składowego z etapu polowego. Transport: f64 w `analysis`, f32 w `interactive` (precyzja jawnie w nagłówku FMVP).

## 9. Sonda (P1-05, decyzja 12)

- Ewaluacja punktowa w dokładnej współrzędnej świata przez lokalizator BVH, nie wartość piksela.
- Status: `occupied` (wartość + element/komórka + współrzędne referencyjne), `outside` (poza ramą lub domeną, bez wartości), `empty` (w ramie, poza targetem), `stale` (rewizja pola nowsza niż klatka).
- `world_m` i wartość dotyczą tego samego punktu (dziś nie: `planar_fields.rs:922-941`).

## 10. Airbox

- Wielkości pełnej domeny (`H_demag`, `H_eff`, `H_ext`, `H_ant`) próbkują elementy powietrza; wielkości `magnetic_only` nie (istniejąca reguła).
- Na siatkach SP4 airbox zawiera Pyramid5 w powłoce przejściowej, więc pełne `H_demag` w airboxie wymaga F3. Do tego czasu UI pokazuje stan „Nieobsługiwana” z liczbą Pyramid5 przeciętych przez płaszczyznę.
- Capability airboxu pochodzi z jednego źródła w backendzie (meta źródła), a frontend nie wnioskuje go z typu dyskretyzacji (P1-04).

## 11. CPU, GPU i provenance

- Sampler pozostaje postprocesorem CPU dla wszystkich torów. Meta musi publikować `sampling_execution` (dziś zakodowane `"cpu"`, `planar_fields.rs:1282`) **oraz** tor źródła pola: backend, urządzenie i precyzję (brak, 0970 „Limitations”).
- Odroczone: gather na GPU (SpMV na polu rezydującym na urządzeniu) dla FEM GPU, żeby nie kopiować całego pola na host przy każdym kroku. Wymaga osobnej noty i kwalifikacji; nie może zmienić wyniku poza udokumentowaną tolerancją.

## 12. Walidacja

| Test | Kryterium |
|---|---|
| Pole liniowe, każdy typ elementu, płaszczyzny osiowe i skośne | błąd względny ≤ 1e-12 (reprodukcja liniowych) |
| Pole kwadratowe, rafinacja ×2 | zbieżność rzędu 2 w normie L2 rastra |
| Swept Prism6, płaszczyzna węzłów | wartości rastra = interpolacja liniowa wartości węzłowych na trójkątach podstawy |
| Slab/depth, rafinacja lokalna | niezmienniczość średniej (istniejący test 0970) dla nowych typów |
| Cache operatora vs ścieżka bezpośrednia | zgodność w tolerancji względnej ≤ 1e-13 (względem zakresu zajętości) dla plane/slab/depth `mean`; bajtowa identyczność nie jest wymagana, bo kolejność sumowania jest inna. Docelowo operator staje się kanoniczną ścieżką dla operatorów liniowych, a ścieżka bezpośrednia zostaje tylko jako wyrocznia testowa |
| Determinizm | dwie budowy operatora tą samą ścieżką → identyczny `geometry_token`, wagi i bajty wyniku |
| Prism6/Hex8/Pyramid5 slab | pole równe własnemu interpolantowi elementu (np. q = r·ζ) całkowane dokładnie do tolerancji kwadratury (N-09) |
| Skala | nm / µm / mm → identyczne W po przeskalowaniu |
| Single-flight | N równoległych żądań → 1 budowa operatora (licznik) |
| Wydajność | budżety z 03 §10 na siatkach 10k / 200k / 2M elementów |
| FDM jako szczególny przypadek | operator FDM plane = indeks komórki; wynik identyczny z obecną ścieżką `fdm.rs:259-304` |

## 13. Ryzyka

| Ryzyko | Skutek | Mitygacja |
|---|---|---|
| Baza Pyramid5 samplera ≠ baza MFEM | systematyczny błąd pola w powłoce airboxu | krok 2 w §6; test pola wytwarzanego eksportowanego z MFEM |
| Pamięć operatora przy 2048²+ | presja RAM API | limit LRU, kafelki dla `publication`, f32 indeksy |
| Zmiana kontraktu meta/stanu | regres klientów | migracja v10 → v11 jednorazowa, bez dual-write; OpenAPI + codegen |
| Nakładanie na siatkach niekonformnych | niejednoznaczne piksele | `overlap_count` + diagnostyka, nie cichy wybór |
| Rozjazd ścieżek nieliniowych (rms/min/max) | różna wydajność | jawne `operator_cache: none` w meta; te same testy poprawności |
