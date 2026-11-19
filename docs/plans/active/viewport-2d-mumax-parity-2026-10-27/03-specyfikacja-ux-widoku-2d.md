# Specyfikacja UX widoku 2D (docelowe zachowanie produkcyjne)

- Data: 2026-10-27
- Status: **PROPOSED**; po akceptacji treść przechodzi do [spec 15](../../../specs/frontend-v2/15-viewport-2d-module.md) przed implementacją F1
- Makiety: [mockups/viewport-2d-mockups.html](mockups/viewport-2d-mockups.html) (interaktywne; przełącz scenariusz FDM / FEM swept / FEM Tet4 / FEM mieszana i stan klatki)
- Wiążące: ADR 0020 (Canvas 2D + worker, bez WebGL; jeden Inspector; tylko aktywna powierzchnia zamontowana), decyzje 1–23 z audytu 31.08 §26.2

## 1. Zasady

1. **Jak mumax3 na wierzchu, jak Fullmag pod spodem.** Rzeczy zmieniane co minutę są jednym kliknięciem lub klawiszem nad mapą. Tożsamość klatki, provenance i diagnostyka są zawsze dostępne, ale nie zasłaniają danych.
2. **Jeden stan.** Pasek i Inspector czytają i zapisują ten sam `visualization/state.planar` przez istniejące komendy i `queuePatch`. Nie ma lokalnego stanu widoku poza efemerycznym pan/zoom w trakcie gestu.
3. **Ten sam UI dla FDM i FEM.** Różnice wynikają z capability i metadanych źródła (np. czy są dyskretne przystanki warstwy), nie z osobnych drzew komponentów.
4. **Żądane i rozwiązane zawsze widoczne** (decyzja 8). Snap nigdy nie jest ukryty.
5. **Ostatnia dobra klatka nigdy nie znika** podczas przejścia; stan komunikuje odznaka i pasek statusu, bez przyciemniania i animacji krycia.
6. **Żadnych atrapowych kontrolek.** Komenda lub opcja bez implementacji jest ukryta albo wyłączona z powodem.

## 2. Układ (D2D-01, wariant C)

```text
┌ Explorer ┐┌─────────────────────── 2D ─────────────────────────────┐┌ Inspector ───────────┐
│ Model    ││ Wielkość [m ▾] Składowa [wektor|x|y|z||·|] Płaszczyzna  ││ Źródło  [Domyślne ▾] │
│ Monitory ││ [XY|XZ|YZ]  Warstwa ‹ ━━━●━━━ › k 3/7 · z = 26.25 nm    ││ Tryb    [Komórka|…]  │
│ Wyniki   ││ [Strzałki] [Siatka]                                      ││ Operator[próbka ▾]   │
│          │├──────────────────────────────────────────────┬──────────┤│ Żądane  indeks 3     │
│          ││ y [nm]                          [Analiza]     │  ◐ ẑ>0  ││ Rozwiąz. z=26.25 nm  │
│          ││  250 ┤▓▓▓▓▓▓ mapa + strzałki ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ◑ ẑ<0  ││ Zakres  [auto|sym|…] │
│          ││    0 ┼────────────────────────────── x [nm]   │ legenda ││ Strzałki, nakładki   │
│          │├──────────────────────────────────────────────┴──────────┤│ Tożsamość klatki     │
│          ││ FDM CPU · 64×32×8 · Δ=8×8×7.5 nm · t=1.250 ns · krok 4210 ││ frame_id, token,     │
└──────────┘└───────────────────────────────────────────────────────────┘│ sampler              │
                                                                          └──────────────────────┘
```

| Strefa | Zawartość | Właściciel stanu |
|---|---|---|
| Pasek nad mapą | wielkość, składowa, płaszczyzna (XY/XZ/YZ; „Dowolna” tylko dla monitora autorskiego), warstwa z krokowaniem i odczytem, strzałki, siatka | `visualization/state.planar` |
| Mapa | raster, nakładki, osie w jednostkach fizycznych, odznaka jakości/stanu, sonda | renderer (lokalnie tylko gest) |
| Legenda | koło barw (składowa `direction`) albo pasek kolorów z jednostką, zakresem i trybem zakresu | pochodna klatki |
| Pasek statusu | tor wykonania (requested/resolved), dyskretyzacja, czas, krok, etap, źródło, operator | meta klatki |
| Inspector | źródło (Default/monitor), tryb warstwy, operator, slab, rozdzielczość, zakres ręczny, paleta, gęstość i skala strzałek, nakładki, tożsamość klatki | `visualization/state.planar` |

Na wąskim ekranie Inspector przechodzi pod mapę, pasek zawija się w wiersze; legenda przechodzi pod mapę w poziomie.

Warianty odrzucone (makieta §2): A „tylko Inspector” (stan obecny, najdalej od mumax3) i B „pływający panel w mapie” (zasłania dane, tworzy drugie źródło stanu).

## 3. Kontrolka „Warstwa”

Jedna kontrolka, której semantyka zależy od trybu i źródła. Odczyt jest zawsze w formacie: *co żądano* → *co rozwiązano* (+ indeks, jeśli istnieje).

| Tor / tryb | Wartość suwaka | Przystanki | Odczyt | Zachowanie ‹ › i `[` `]` |
|---|---|---|---|---|
| FDM `cell-layer` (domyślny) | indeks k | `0 … Nz−1` | `k 3/7 · z = 26.25 nm` | ±1 komórka |
| FDM `continuous-plane` | z [m] | brak | `żąd. 24.00 → rozw. 26.25 nm (k 3)` | skok do środka sąsiedniej komórki |
| FDM `named-layer` | warstwa | `FdmLayerPlanIR.layer_id` | `free · k 0–3 · slab` | następna warstwa nazwana |
| FEM swept (certyfikat) | indeks płaszczyzny węzłów | `magnetic_plane_coordinates_m` | `płaszczyzna 2/4 · z = 10.00 nm` | ±1 płaszczyzna |
| FEM nazwana | obiekt/region | zakresy obiektów wzdłuż normalnej | `free_layer · z ∈ [0, 5] nm · slab` | następny obiekt |
| FEM ciągła (Tet4, mieszana) | z [m] | brak warstw danych; znaczniki nawigacyjne co h⊥ | `z = 12.40 nm · 1 932 el. przecięte` | ±h⊥ (mediana wysokości elementu wzdłuż normalnej) |

Dla płaszczyzn XZ/YZ suwak indeksuje odpowiednio j albo i (FDM) lub współrzędną y/x (FEM). Przy zmianie płaszczyzny pozycja wraca do środka domeny (zgodnie z obecnym `position_fraction = 0.5`).

Tryby `cell-layer` i `named-layer` są niedostępne (wyłączone z powodem), gdy źródło nie publikuje przystanków. Znaczniki nawigacyjne FEM są oznaczone w tooltipie jako „pomoc nawigacyjna, nie warstwa danych”.

## 4. Wielkość i składowa

- Składowe wektora: `wektor` (= `direction`, D2D-02), `x`, `y`, `z`, `|·|`; dodatkowo w Inspectorze `u`, `v`, `normal`, `in_plane_magnitude` (istniejące).
- `orientation` (skalar `atan2(v,u)/2π`) zostaje zastąpione przez `direction` w pasku; w Inspectorze pozostaje tylko z paletą cykliczną albo jest usuwane (decyzja przy F1).
- Domyślnie: `m` → `wektor`; pola H → `z` z zakresem symetrycznym; skalary (energie, ładunek topologiczny) → `wartość` z paletą sekwencyjną.
- Koło barw: formuła mumax3 (02 §4.1) w **układzie świata**: barwa = atan2(v̂y, v̂x), jasność = 0,5·v̂z + 0,5, nasycenie 1, szary 0,6 dla wektora bez kierunku. Jest to dokładnie funkcja `magnetizationHslRgb` używana już w widoku 3D (`modules/viewport-3d/orientation/magnetizationColor.ts`); 2D musi korzystać z tej samej funkcji, żeby ten sam wektor miał ten sam kolor w 2D i 3D oraz na płaszczyznach XY, XZ i YZ. Wariant w układzie monitora (barwa z kąta w (u,v), jasność z v̂ₙ) może być późniejszą jawną opcją; legenda zawsze nazywa układ. Legenda pokazuje dwie półkule (ẑ > 0 i ẑ < 0) i tekst „barwa = kąt w płaszczyźnie XY świata, jasność = składowa z”. Dla pól innych niż `m` legenda dodaje „tylko kierunek; moduł w składowej |·|”.
- Składowa `direction` jest prezentacyjna: frontend koloruje ją z zasobu wektorów (FMVP, 3 składowe), bez nowej próbki. Eksport `render.png` wymaga tej samej mapy kolorów w backendzie (zadanie F1).

## 5. Raster i powiększenie (D2D-03)

- **FDM:** domyślnie 1 piksel rastra = 1 komórka w płaszczyźnie, bez resamplingu; renderer powiększa nearest-neighbour z zachowaniem proporcji fizycznych. Powyżej limitu (propozycja 2048 komórek na oś w profilu `analysis`) podgląd może użyć uśredniania blokowego jak mumax3, ale odznaka mówi wtedy „Podgląd · średnia 4×4 komórki” i sonda zwraca wartość komórki, nie bloku.
- **FEM:** rozdzielczość z polityki w 04 §7 (piksel ≈ h_med/2 w `analysis`, limit 2048², `interactive` 256², `publication` do 4096²).
- Zoom i pan nie zmieniają próbki; zmiana profilu jakości tak.

## 6. Strzałki (D2D-04, rozstrzyga §26.3.5)

| Atrybut | Kontrakt |
|---|---|
| Rozmieszczenie | regularna siatka 2D w przestrzeni ekranu, odstęp `s` px (domyślnie 26 px, suwak 14–44 px); stabilna przy zoomie (glify nie „pływają” względem danych, siatka zakotwiczona w układzie u,v) |
| Wartość | ewaluacja punktowa pola w środku komórki siatki glifów (FDM: wartość komórki; FEM: funkcje kształtu), z zasobu wektorów o budżecie = liczbie glifów, nie 1D stride po rastrze |
| Długość | `0,82·s·|v_∥|/|v|_max` jak rzut w mumax3; minimum 7 px; brak skalowania z kamerą |
| Grot | wypełniony trójkąt, długość max(4 px; 0,38·L), szerokość 0,55 długości grotu |
| Składowa normalna | gdy `|v_∥|/|v| < 0,25`: okrąg ⊙ (v̂ₙ > 0) albo ⊗ (v̂ₙ < 0) zamiast strzałki |
| Kolor | domyślnie ciemny z jasną obwódką na kole barw; tryby: monochromatyczny (token), `|·|` z osobną legendą wektorów; opcja `magnitude` bez implementacji jest usuwana (P1-06) |
| Maska | brak glifu poza zajętością; glify nie przekraczają granicy targetu |

## 7. Stany klatki (D2D-11, rozstrzyga §26.3.7)

| Stan | Warunek | Widok | Kod |
|---|---|---|---|
| Podgląd | gest suwaka/parametru w toku | raster profilu `interactive`; odznaka „Podgląd” | `quality=interactive` |
| Analiza | meta + scalar + raster mają wspólne `frame_id` (decyzja 15) | pełna rozdzielczość; odznaka „Analiza” | `quality=analysis` |
| Nieaktualna | solver opublikował nowszą rewizję, nowa klatka w drodze | ostatnia dobra klatka + odznaka „f-412 (solver f-415)” | `frame_stale` |
| Brak próbki | płaszczyzna poza domeną albo pusty target | komunikat z zakresem domeny; suwak pokazuje dozwolony przedział | `plane_outside_domain`, `empty_target` |
| Nieobsługiwana | typ elementu/operator bez wsparcia w torze | komunikat z liczbą elementów danego typu i linkiem do macierzy capability | `unsupported_element_order` i in. |
| Błąd | błąd transportu/serwera | ostatnia dobra klatka + odznaka błędu z kodem; ponowienie automatyczne z backoff | kod API |

Przejścia: zmiana suwaka → Podgląd (natychmiast, retencja ostatniej klatki) → Analiza po puszczeniu suwaka lub 250 ms bezruchu. Retencja nie może zależeć od `default_slice` (naprawa N-02): klucz retencji obejmuje źródło, wielkość, składową i płaszczyznę, ale nie pozycję.

Decyzja 8 obowiązuje także w oknie retencji: dopóki widoczna jest zachowana klatka, odczyt i odznaka opisują **tę klatkę** (jej rozwiązaną współrzędną i indeks), a nowe żądanie jest pokazane osobno, np. `pokazano k 3 · z = 26.25 nm · ładuję k 4`. Odczyt nie może sugerować, że obraz przedstawia warstwę, której jeszcze nie pobrano. Sonda w tym oknie zwraca wartości zachowanej klatki z jej `frame_id`.

## 8. Płaszczyzna dowolna i manipulator (D2D-10, rozstrzyga §26.3.3)

- Etap F1–F4: XY/XZ/YZ w pasku; płaszczyzna dowolna wyłącznie przez monitor autorski w Inspectorze (edycja liczbowa punktu i normalnej, przyciski „wyrównaj do osi”, „przez zaznaczony obiekt”).
- Etap F6: gizmo w widoku 3D (przesunięcie wzdłuż normalnej, obrót), pick-from-face, klawisze: `Shift+[`/`]` dla kroku obrotu. Gizmo nie tworzy drugiego stanu: zapisuje draft monitora tą samą transakcją co Inspector.

## 9. Multislice i profil (D2D-09, rozstrzyga §26.3.2 i §26.3.6)

- Multislice: siatka 2×2 lub 1×N paneli 2D nad jednym datasetem; wspólna wielkość, składowa, zakres i paleta; każdy panel ma własne `frame_id`; sonda pokazuje ten sam punkt (u,v) we wszystkich panelach. Podgląd zestawu płaszczyzn w 3D jako późniejsza forma nad tym samym zbiorem.
- Profil liniowy: rysowany na mapie (Shift + przeciągnięcie); zasób pochodny tej samej klatki (decyzja 22); wykres pod mapą w tej samej powierzchni, oś X w jednostkach długości, serie składowych; synchronizacja kursora z sondą. FEM: próbki w przecięciach linii z krawędziami elementów, łączone liniowo tylko dla elementów liniowych; dla Prism6/Hex8 dodatkowe punkty wewnątrz elementu.

## 10. Budżety wydajności (D2D-12, rozstrzyga §26.3.8; do potwierdzenia pomiarem)

| Operacja | FDM P50 / P95 | FEM P50 / P95 | Warunek pomiaru |
|---|---|---|---|
| Krok warstwy (cache etapu geometrycznego ciepły) | 30 / 80 ms | 60 / 150 ms | 256×256 FDM; FEM 200k elementów, raster 512² |
| Krok warstwy (zimny) | 30 / 80 ms | 400 / 1200 ms | jw.; FEM obejmuje lokalizację i wagi |
| Nowa klatka pola przy niezmienionej płaszczyźnie | 20 / 60 ms | 30 / 90 ms | od zdarzenia invalidacji do pikseli |
| Przełączenie składowej `wektor`→`x` | 0 żądań, < 16 ms | 0 żądań, < 16 ms | dane już w pamięci (doktryna field-store) |
| Pan/zoom | 0 żądań, 60 fps | 0 żądań, 60 fps | brak rekoloryzacji (naprawa P2-01) |
| Pamięć sterty po 100 przełączeniach 2D↔3D | < 30 MB wzrostu | < 30 MB wzrostu | istniejący test lifecycle |

## 11. Skróty klawiszowe

| Klawisz | Akcja |
|---|---|
| `2` | otwórz 2D (istniejące) |
| `[` / `]` | poprzednia / następna warstwa (przystanek albo h⊥) |
| `Shift+[` / `Shift+]` | skok o 10 warstw |
| `v` `x` `y` `z` `m` | składowa: wektor / x / y / z / moduł |
| `a` | strzałki wł./wył. |
| `g` | siatka wł./wył. |
| `0`, dwuklik | dopasuj widok (istniejące, ale komenda `field-map.fit` do podłączenia — N-01) |
| `p` | przypnij sondę w punkcie kursora |

Skróty działają, gdy fokus jest w powierzchni 2D, i są rejestrowane w jednym rejestrze komend (spec 12).

## 12. Dostępność

- Canvas `role="img"` z `aria-describedby` wskazującym streszczenie: wielkość, składowa, płaszczyzna, warstwa, zakres z jednostką.
- Ticki osi i legenda dostępne jako tekst (nie `aria-hidden`).
- Canvas zawsze osiągalny klawiaturą (`tabIndex=0`), także przy wyłączonej sondzie.
- `aria-live` tylko dla odczytu warstwy i przypiętej sondy, nie dla sondy hover.

## 13. Zmiany kontraktu wynikające z UX (do OpenAPI v2)

| Zasób / stan | Zmiana | Uwagi |
|---|---|---|
| `DefaultPlanarSliceState` | `layer_mode: continuous \| cell_layer \| named_layer \| fem_node_plane`; `layer_index`; `named_layer_id`; `requested_coordinate_m` | migracja schematu stanu (v10 → v11), bez dual-write |
| meta próbki | `requested_coordinate_m`, `resolved_coordinate_m`, `resolved_layer_index`, `layer_stops: [{index, coordinate_m, label}]`, `navigation_step_m` | stops tylko gdy istnieją; FEM ciągła publikuje `navigation_step_m` |
| meta próbki | `occupied_range` oddzielony od `rendered_range` | P1-12 |
| sonda | `status: occupied \| outside \| empty \| stale`, ewaluacja punktowa, `cell_index [i,j,k]` albo `element_id` + typ | P1-05, P2-03 |
| wektory | `vector_budget` w tożsamości i linku; payload = punkty siatki glifów | P1-13 |
| `render.png` | obsługa `direction` | D2D-02 |
