# Diagnoza różnic GSG i publikacji — 7.11.2026

## Wniosek i zakres

Potwierdzono przyczynę małej zmiany estymatora η: lokalna siatka50nm/bulk75nm zachowuje prawie ten sam rozmiar elementów w połączeniach końcowych co wcześniejsza globalna50nm. Właśnie tam znajduje się99,89957% energii korekty RT0–H1. Nie jest to brak zastosowania pola zagęszczenia.

Nie potwierdzono nowego błędu znaku pola. Na20zachowanych targetach H różnica względem niezależnego modelu prostych pasków jest mała; znaczną część jej asymetrii wyjaśnia rzeczywisty podział prądów powrotnych. Nadal nie rozstrzygnięto różnicy częstotliwości/kształtu Fig.3 i nie potwierdzono odtworzenia publikacji.

To wewnętrzny audyt zachowanych danych, bez zmiany fizyki, tolerancji, progów, runtime lub publicznego API. Zastosowano systematic-debugging i scientific-documentation-contract. Kanoniczne kontrakty pozostają w notach0950i0951; ten raport nie zastępuje ich ani nie deklaruje gotowości publikacyjnej nowej metody.

## Wejścia i weryfikacja

- Najnowszy run:run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e; task902544fb…; attemptb7eaad04…, epoch1.
- Request SHA256:50b1accd824a7e1fec5e64bea44ad347de5b088f282a2f7c542a21c9cfb051eb.
- Starszy run global50nm:run-bc05bbf73072ea18dd6726455fe6f23f44fd7d3f3c2f624ec4630e5117a38e7e.
- Starszy request:/opt/fullmag/control/verification/gsg-50nm-approved-20261104/50nm-new/request.json, SHA256c3ccdd46467845564a048396e041d734e0bb5895465725f4e331d0fa3adaed1a.
- HEAD podczas diagnozy:37687bf0a37b13c18769a8d1748b5b0b3d5f0b7b.
- Źródła, dane i dowody numeryczne przypięto w diagnostic-provenance.json.

V/J/H i geometrię analizowano z wcześniej publicznie odczytanych payloadów, ponownie kontrolując SHA. Podział material_parts z kanonicznego ProblemIR pokrywa34243komórki dokładnie raz. Nie zgadywano przyporządkowania materiałów z położenia. Analiza zachowuje lokalne ślady RT0, bez wygładzania J między komórkami.

## 1. Dlaczego η prawie się nie zmieniła

| Część | Energia korekty całego źródła | Lokalne η |
|---|---:|---:|
| Inlet |50,43889% |0,08604676 |
| Outlet |49,46068% |0,08520126 |
| Signal |0,06693% |0,00120035 |
| Ground left |0,01773% |0,00123559 |
| Ground right |0,01577% |0,00116511 |

Globalne η=0,03464604656814306. Podział istniejącym partitioned_weighted_rt0_h1_correction trwał27,615s, Decimal120. Sumy licznika i mianownika zgadzają się z globalnym wynikiem; lokalnych η nie uśredniano.

| Rozmiar faktyczny | Poprzednia globalna50nm | Nowa lokalna50/bulk75nm |
|---|---:|---:|
| Inlet, liczba komórek |6730 |6571 |
| Outlet, liczba komórek |6596 |6546 |
| Inlet, mediana krawędzi regularnego Tet o tej samej objętości |51,674nm |51,669nm |
| Outlet, ta sama mediana |51,662nm |51,696nm |
| Inlet, mediana największej krawędzi Tet |70,466nm |71,821nm |
| Outlet, ta sama mediana |71,813nm |71,487nm |
| Proste paski, mediana największej krawędzi |około72nm |108,773nm |

Nowy mesh ma mniej komórek głównie w prostych paskach. Nie jest kolejnym drobniejszym poziomem w krytycznych połączeniach. Target50nm nie gwarantuje każdej krawędzi Tet≤50nm. Spadek η ookoło0,90% względem wcześniejszej globalnej50nm nie dowodzi kontrakcji po rzeczywistym zagęszczeniu naroży.

## 2. Lokalizacja w narożach

Geometria zawiera osiem wklęsłych pionowych krawędzi: x=−0,35;−0,10;+0,10;+0,35µm, y=±11,8µm, z=30…120nm. Inlet crossbar zajmuje y=−12…−11,8µm, outlet11,8…12µm. Źródło przy y=−11µm leży w centralnym necku i nie jest narożem geometrycznym.

Ponownie użyto istniejącego estymatora dla13117komórek połączeń. Dla każdej policzono odległość środka Tet od najbliższej wskazanej pionowej krawędzi. To jawna diagnostyka po obejrzeniu wyniku, nie nowe progi kwalifikacji.

| Odległość środka komórki | Liczba Tet | Udział energii korekty samych połączeń |
|---|---:|---:|
|≤25nm |101 |29,2261% |
|≤50nm |339 |64,4321% |
|≤100nm |993 |83,1239% |
|≤200nm |2987 |98,4372% |
|≤400nm |4553 |99,9858% |

Najsilniejsze1%komórek połączeń odpowiada za51,6752%ich energii korekty. Suma analizy komórkowej zgadza się z sumą inlet/outlet względnie poniżej1e-100; czas9,958s. Lokalizacja wspiera hipotezę trudnej aproksymacji koncentracji prądu przy ostrych narożach. Sama korekta RT0–H1 nie jest certyfikowanym błędem rozwiązania ciągłego ani pola H.

## 3. Co rzeczywiście różni pole H

Istniejąca referencja rectangular_prism_field całkuje dokładnie kierunek długości i Simpsonem przekrój. gsg_field opisuje trzy proste paski o grubości90nm, z30…120nm i długości24µm; nie zawiera poprzecznych połączeń zamkniętego obwodu. Nie zastosowano starej bramki compare_samples do nowej geometrii.

Porównano wszystkie20targetów po normalizacji prądem źródła17,544214575µA, bez dopasowania amplitudy lub znaku.

- Największa różnica normy wektora:0,000397726A/m.
- Największa względna różnica:0,116654%, przy słabym polu na x=±2µm.
- Pod paskami maksymalna względna różnica około0,00316%.
- Zmiana kwadratury referencji64→128: maksymalnie2,155e-7A/m; to kontrola tego kwadraturowania, nie dowód jego błędu a priori.

Rzeczywiste prądy powrotne odpowiadają udziałom0,4999846263959267i0,5000153736040733. Po użyciu ich w tej samej referencji, bez fitu, maksymalna różnica maleje do0,000077364A/m. Na osi źródła małe niezerowe Hz jest w znacznej części odtworzone przez ten podział prądów. Nie rozstrzygnięto oddzielnie reszty wkładu połączeń, zmian J wzdłuż przewodnika i dyskretyzacji.

To mocny wynik diagnostyczny w20punktach, ale nie pełna kwalifikacja objętości. Duże globalne η przy zdalnych narożach nie przekłada się automatycznie na ten sam procent błędu centralnego H. Niewielkie odchylenia nie potwierdzają błędu odwrócenia fazy.

## 4. Dlaczego to jeszcze nie rozwiązuje Fig.3

Fig.3 przedstawia rzeczywistą część zespolonej odpowiedzi transmisyjnej pary anten z podatnością magnetyczną i propagacją, a nie statyczne H jednej anteny. Model teoretyczny przyjmuje cienkie nieskończone paski i parametry TableI; nasz zamknięty3D GSG nawiązuje do nominalnego przekroju eksperymentalnego. Nie wolno utożsamiać tych modeli. [Sushruth iin., częśćII–IV](https://arxiv.org/html/2001.11483v1).

Nie znaleziono nowej rozbieżności w implementacji gamma, ω=2πf, n(k), tłumienia lub center-to-center distance względem literalnych równań. Wcześniejsze diagnostyki A8, obserwabli napięcie/indukcyjność i spójnej normalizacji GS nie zostały ponownie uruchomione ani uznane za rozwiązanie problemu.

Nowa kontrola dwóch zachowanych oryginalnych rastrów potwierdza różne położenia szarych znaczników opisanych jako FMR:

| Obraz | Panel S | Panel GSG |
|---|---:|---:|
| APS |7,19457–7,22172GHz |7,13494–7,16386GHz |
| arXiv |7,18777–7,22191GHz |7,13172–7,16503GHz |

Zakres obejmuje grubość kreski w pikselach, nie pełną niepewność digitizacji. Kalibrację6…9GHz sprawdzono na podpisach osi; detekcja używa pokrycia czarnych ramek i szarych kolumn w zadanym paśmie wierszy. Wynik występuje w obu obrazach, więc nie wynika wyłącznie z resamplingu wydawniczego PDF. Nie znamy recepty generatora figur i nie przypisujemy autorom błędu fizycznego.

Literalne0,25T i30GHz/T dają nadal f0=7,5GHz, zgodnie z istniejącym wzorcem i wcześniejszymi kontrolami k=0. Nie wolno dopasować Heff/gamma do jednego szarego znacznika i nazwać tego reprodukcją. Zmiana samej grubości zmienia dyspersję przy niezerowym k, ale nie ten limit k=0.

Źródła obrazów: APS92aeb043aa5329cd73fc77fecc6eb110af760fe8b86a0f9b072cca2c83a7bf27; arXivdc7a08ec34e42eeefc854437b64d9a3c071a2d59c68d3a012a23d470011329ba. Dokładne ścieżki, wymiary, kolumny i przeliczenie zapisano w figure3-marker-raster-check.json. [Wersja wydawnicza](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.2.043203).

## 5. Przekrój zbieżności na trzech zachowanych siatkach

Nowy odczytowy audyt obejmuje wszystkie komórki wcześniejszych globalnych siatek 100/75/50 nm, a nie tylko najnowszą lokalną siatkę 50/bulk75 nm. Przed wykonaniem zapisano sześć rozłącznych pasów odległości centroidu Tet od tych samych ośmiu pionowych krawędzi: 0–25, 25–50, 50–100, 100–200, 200–400 i powyżej 400 nm. To przypisanie całych komórek według środka, nie dokładne całkowanie po przyciętym obszarze.

Ponownie sprawdzono SHA czterech payloadów każdego źródła: cells, conductivity, stable_vertex_ids, v_raw; ich descriptor pochodzi z wcześniej zweryfikowanego publicznego odczytu. Każda komórka należy dokładnie do jednego pasa; suma licznika i mianownika estymatora zgadza się z zachowaną analizą całego źródła względnie poniżej 1e-100. Użyto bez zmian scripts/antenna_gsg_current_correction.py::partitioned_weighted_rt0_h1_correction, Decimal120.

| Siatka nominalna | Tet4 | Globalne η | Udział energii korekty do 50 nm | Do 200 nm | Powyżej 400 nm |
|---|---:|---:|---:|---:|---:|
| 100 nm | 14 299 | 0,04909710 | 56,1829% | 98,0098% | 0,2303% |
| 75 nm | 25 516 | 0,03828854 | 65,8466% | 98,2219% | 0,1399% |
| 50 nm | 72 911 | 0,03496045 | 64,9954% | 98,3628% | 0,1167% |

Przejście 75→50 nm zwiększa licznik korekty w pasie 0–25 nm o 14,8768%; po normalizacji kwadratem rzeczywistego prądu wzrost wynosi 14,8478%. Lokalne η tego pasa zmienia się z 0,481587 do 0,491022. W pasie powyżej 400 nm licznik po tej samej normalizacji maleje do 0,694948 poprzedniej wartości; jego udział w całym liczniku jest mały. W innych pasach zmiany nie są jednolite: stosunek licznika po normalizacji wynosi 0,692803 dla 25–50 nm i 0,917145 dla 50–100 nm.

Wynik wspiera lokalizację problemu aproksymacji przy narożach. Nie dowodzi zbieżności do rozwiązania ciągłego, ścisłego błędu H ani zgodności z publikacją. Zmienna liczba komórek i centroidowe granice pasów ograniczają interpretację lokalnych ilorazów; nie ustanowiono nowego progu zaliczenia. Dotychczasowe kryterium globalnej kontrakcji nadal nie jest spełnione. Propozycja nowego meshowania naroży pozostaje niewykonana.

Dowody w control volume: verification/gsg-corner-convergence-localization-20261107/. Czas 83,673 s, szczyt RSS 148 612 KiB, limit przestrzeni adresowej 2 GiB, bez nowego meshowania i Solve.

| Artefakt | SHA256 |
|---|---|
| analyze.py | 3fea4d896533ce1e84cfef1bb01ccc1a62b19803c79fe0e265aad7b47b0cac4e |
| prospective-analysis.json | 62d565d2675dfae725c1f15077d4d18046bbbc5f475c143f66edab55f2a4ff88 |
| result.json | 07dae7747d11f878203733c418b5ba01efda0e00d97cd18fdee5b2e0338286d4 |

## Mapa kodu i granice wykonania

| Źródło + symbol | Odpowiedzialność / dowód |
|---|---|
| scripts/antenna_gsg_current_correction.py::partitioned_weighted_rt0_h1_correction |Istniejący estymator i pełny podział energii na części |
| scripts/antenna_gsg_current_correction.py::weighted_rt0_h1_correction |Analiza komórkowa i zgodność sum |
| scripts/reference_sushruth_2020_gsg_current.py::gsg_field |Niezależne proste paski o grubości90nm |
| scripts/antenna_current_source_oracle.py::rectangular_prism_field |Całka referencyjna pola; kontrola64/128 |
| packages/fullmag-py/src/fullmag/model/geometry.py::CPWAntennaLayout.connection_solids |Położenie poprzeczek, necków i naroży |
| packages/fullmag-py/src/fullmag/runtime/antenna_coincident_materialization.py::_material_binding |Stabilne globalne ordynały i pełne pokrycie materiałów |
| packages/fullmag-py/src/fullmag/meshing/_antenna_coincident_cut.py::split_coincident_sourcecut |Zachowanie kolejności i współrzędnych komórek po cięciu |
| scripts/reference_sushruth_2020_response.py::film_susceptibility / inductive_response |Istniejący literalny wzorzec odpowiedzi publikacji; bez nowego wykonania |

Lane: rzeczywisty zachowany wynik FEM CPU/double/strict. Analizy Python są diagnostyką CPU istniejących danych, nie nowym backendem. FEM GPU oraz FDM CPU/GPU nie były w tej diagnozie wykonywane lub kwalifikowane.

## Wnioski do dalszej pracy

1. Kolejny test siatki musi rzeczywiście zmniejszyć elementy przy ośmiu narożach, a nie powtórzyć lokalne50nm. Najpierw trzeba ocenić budżet i zachować kryteria; nowej próby nie uruchomiono.
2. Należy osobno kwalifikować H na docelowej siatce próbki. Nie przeliczać η całego obwodu na deklarowany błąd pola w próbce.
3. Dla Fig.3 trzeba równocześnie porównywać parametry materiałowe, FMR, okresy i obwiednię zespolonej transmisji. Nie wystarczy fit jednego maksimum ani nowa statyczna mapa H.
4. Przed kolejnym uruchomieniem pozostaje operacyjne domknięcie kwarantanny rezerwacji poprzedniej próby. W tej diagnozie nie ingerowano w scheduler.

## Dowody

W istniejącym control volume grupy3203: verification/gsg-discrepancy-diagnosis-20261107/. Pliki: diagnostic-provenance.json, actual-mesh-resolution-comparison.json, junction-correction-partition.json, correction-corner-localization.json, uniform-strip-vs-accepted-field.json, return-current-asymmetry-isolation.json, figure3-marker-raster-check.json.

Cała diagnoza: bez nowego meshowania, natywnego V/J/H, H-only, LLG, buildu, restartu, zmiany limitów, fitu parametrów, zmiany progów i kasowania danych.
