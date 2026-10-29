# Widok 2D, poziom B: B4–B6 — dowody 2026-10-28

## B4 — nawigator migawek
- Implementacja: `PlanarSnapshotNavigator` nad mapą 2D. Kroki ‹ › po migawkach `m` wybranego etapu
  histerezy, odtwarzanie klatka po klatce (krok dopiero po narysowaniu bieżącej klatki), „Live”.
  Używa tego samego zaznaczenia, które publikuje wykres histerezy.
- Runtime **BLOCKED na masterze**: aktywacja fixture histerezy (`examples/fdm_hysteresis_snapshot_smoke.py`,
  także `viewport_2d_planar_monitor_fdm_smoke.py`) jest odrzucana komunikatem
  `study pipeline primitive stage 'hysteresis' is not yet executable by the runtime; materialize it
  into explicit stages first`. Bez runu nie ma migawek, więc nawigator nie ma czego pokazać.
  Weryfikacja: `tsc --noEmit`, eslint, vitest `planarSnapshotNavigation` (napisany).

## B5 — uchwyt płaszczyzny w 3D
Grupa DEV `viewport-2d-snapshot-navigator-20261028` (checkout B5), fixture
`examples/viewport_2d_planar_monitor_fdm_multi_object_smoke.py` (scena wczytana, start symulacji
odrzucony przez master jak wyżej), Chromium headless (SwiftShader):
- wybór monitora „XY plane”, zmiana `Origin Z` na 5 nm w Inspectorze → szkic → podgląd ramki i
  uchwyt wzdłuż normalnej (`b5-handle-before-drag.png`);
- przeciągnięcie uchwytu o 60 px w górę → `Origin Z` w Inspectorze = 32,88 nm, ramka przesunięta,
  kamera bez obrotu (`b5-handle-after-drag.png`); 0 błędów strony.
- Smoke wykrył dwie wady, naprawione: zbyt cienki cel trafienia; menedżer zdarzeń 3D odkładał
  `pointerdown` do kliknięcia (sonda tylko dla `move-axis`), więc przeciąganie obracało kamerę.

### B5 — pierścienie obrotu, skróty, pick-from-face (ta sama grupa, ponownie uruchomiona launcherem)
Fixture `viewport_2d_planar_monitor_fdm_multi_object_smoke.py` (scena aktywna, `awaiting_command`), monitor
„Multi-object XY plane”, szkic z `Origin Z` = 5 nm:
- `Shift+]`: normalna (0, −0,0872, 0,9962) = obrót o 5° wokół u; v = (0, 0,9962, 0,0872); u bez zmian;
- przeciągnięcie czerwonego pierścienia (wokół u): normalna (0, −0,582, 0,813), u = (1, 0, 0) (`b5-rings-start.png`, `b5-rings-drag.png`);
- „Pick face in 3D” + kliknięcie górnej ściany obiektu: początek ramki (58,0; 0,50; 10,0) nm, normalna (0, 0, 1), tryb rozbrojony po kliknięciu (`b5-pick-face.png`);
- 0 błędów strony; ramki ortonormalne i prawoskrętne (walidacja Inspectora 1e-12).

## B6 — indeks przestrzenny
Grupa DEV `viewport-2d-element-index-20261028`, fixture `examples/viewport_2d_fem_mixed_smoke.py`
(FEM CPU, Prism6 + Pyramid5 + Tet4), stan początkowy `m`:
- profil po przekątnej ramki: 327 punktów (256 równomiernych) w 28 ms, 2121 punktów (2048) w 42 ms;
  73 przecięcia ze ścianami elementów;
- 61 punktów profilu (lokalizacja przez BVH) porównanych z sondą w tych samych (u, v) (skan
  bezpośredni): wartość i zajętość identyczne bitowo, 0 rozbieżności.

### PM-N17 — operator płaszczyzny z indeksem (A/B)
Ta sama grupa i fixture FEM, dwa buildy backendu: A = `e9f0799bc` (pełne przejście po elementach),
B = `074446535` (kandydaci z BVH cache'owanego po fingerprincie topologii). 12 przekrojów
(XY, XZ, YZ × φ = 0,2 / 0,37 / 0,5 / 0,81, 384×384, `pm_n17_ab.py`): skróty rastra skalarnego i maski
oraz współrzędne **identyczne** we wszystkich 12 (`pm_n17_A.json`, `pm_n17_B.json`). Czasy meta
porównywalne (25–98 ms) — siatka fixture jest mała; pomiary 200k/2M elementów pozostają otwarte.

### PM-N17 — skala 164k elementów
Fixture `examples/viewport_2d_fem_large_mesh_smoke.py` (film 80×60×40 nm, h ≈ 2,2 nm, powietrze 8 nm;
164 425–164 444 Tet4, 26,5k węzłów). Mesher nie jest deterministyczny między startami grupy, więc
skróty A/B na tej siatce nie są porównywalne. Zamiast tego, w jednym procesie z buildem z indeksem
(`pm_n17_probe_check.py`): 4 przekroje (XY ×2, XZ, YZ; 2865–5758 przeciętych elementów),
300 losowych pikseli 256² porównanych z sondą w środku piksela (sonda = skan bezpośredni):
168/168 zajętych pikseli z wartością bitowo równą, 0 pikseli pustych w rastrze przy zajętej sondzie
(indeks nie gubi elementów), 1 piksel zajęty w rastrze przy pustej sondzie — różnica tolerancji
brzegowej rasteryzacja/sonda istniejąca wcześniej (indeks może tylko usuwać kandydatów).
Czas meta dla świeżej płaszczyzny 512²: mediana 380 ms (bez indeksu) i 419 ms (z indeksem; pierwsza
płaszczyzna 523 ms z budową BVH) — przy 164k elementów indeks nie daje mierzalnego przyspieszenia
end-to-end (dominują inne etapy żądania). Punkt 2M elementów nie został uruchomiony (generowanie
siatki tej skali w grupie DEV), więc korzyść wydajnościowa PM-N17 pozostaje niewykazana.

