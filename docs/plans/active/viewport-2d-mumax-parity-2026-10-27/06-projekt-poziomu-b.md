# Projekt etapu F6 — funkcje poziomu B widoku 2D

- Data: 2026-10-27
- Status: **PROPOSED** — projekty do akceptacji przed implementacją; każda funkcja wymaga własnej noty numerycznej, jeśli dotyka próbkowania
- Wejście: decyzje 1–23 audytu 2026-08-31 (§26.2), zwłaszcza 14–16 i 22 (tożsamość klatki, zasoby pochodne, binarny data plane), oraz stan po F1–F4 w [01-audyt](01-audyt-stanu-2026-10-27.md) i [status](../../../status/2d-slice-capabilities.md)

Wspólna zasada: każda funkcja jest **zasobem pochodnym tej samej klatki** (`sample_token`/`frame_id`), a nie drugim modelem wyników. Dane idą binarnym data plane z ETag, a JSON niesie tylko meta. Frontend nie rekonstruuje pól FDM/FEM.

## B1. Profil liniowy

| Aspekt | Projekt |
|---|---|
| Interakcja | Shift + przeciągnięcie na mapie rysuje odcinek w (u,v); uchwyty końców edytowalne; `Esc` usuwa |
| Zasób | `GET …/planar-{default|monitors/:id}/profile?u0_m&v0_m&u1_m&v1_m&samples&component&sample_token` → FMVP: `s_m[]`, `value[]` (lub 3 składowe), `occupancy[]` |
| Numeryka | FDM: wartość komórki zawierającej punkt; FEM: ewaluacja punktowa bazą elementu w punktach przecięć odcinka ze ścianami elementów + `samples` punktów równomiernych; żadnego wygładzania |
| Nota | nowa sekcja w 0970 „Line profile sampling” (równanie, tożsamość, bramki: liniowe pole odtworzone dokładnie, punkty przecięć ze ścianami) |
| UI | wykres ECharts pod mapą w tej samej powierzchni; oś X w jednostkach długości, serie składowych, wspólny kursor z sondą; eksport CSV |
| Koszt | FEM wymaga lokalizacji punktów — wykorzystać operator płaszczyzny (piksele na odcinku) albo indeks przestrzenny z B6 |

## B2. Multislice

| Aspekt | Projekt |
|---|---|
| Forma | siatka 2×2 lub 1×N paneli 2D; wspólna wielkość, składowa, zakres i paleta; każdy panel ma własne `sample_token` |
| Stan | `planar.multislice: { plane, stops: number[] (fractions), shared_range: true }` w `visualization/state.planar` (migracja v11 → v12) |
| Zasoby | istniejące zasoby `planar-default` z parametrem `slice_fraction` per panel (bez nowego samplera); operator FEM z cache F2 obsługuje każdy panel osobno |
| Zakres | wspólny: min/max po wszystkich panelach z zajętych pikseli (`occupied_range` z F2) |
| Sonda | ten sam (u,v) we wszystkich panelach |
| 3D | podgląd zestawu płaszczyzn w widoku 3D jako druga forma nad tym samym stanem (później) |

## B3. Streamlines

| Aspekt | Projekt |
|---|---|
| Numeryka | całkowanie RK4 w płaszczyźnie (składowe u,v) z krokiem ≤ ½ piksela, interpolacja dwuliniowa rastra wektorowego, zatrzymanie na masce i przy |v∥| < ε; seeding jednorodny z odrzucaniem kolizji (Jobard–Lefer) |
| Gdzie | worker frontendu na rastrze wektorowym klatki (dane już są w przeglądarce); deterministyczne ziarno |
| Nota | sekcja w 0970 „In-plane streamlines (presentation)” — jasno oznaczona jako prezentacja rzutu, nie trajektoria 3D |
| Budżet | limit linii i punktów; anulowanie przy nowej klatce |
| Legenda | kolor linii = |v∥| z osobną legendą albo monochromatyczny |

## B4. Nawigator czasu i etapu

| Aspekt | Projekt |
|---|---|
| UI | pasek pod mapą: etap, migawka, czas symulacji; strzałki ‹ › między migawkami; tryb „na żywo” |
| Dane | istniejące `snapshot_id`/`stage_id` w zapytaniu planarnym; nowe: lista migawek etapu z zasobu wyników |
| Ograniczenie | migawki publikują obecnie tylko `m` (`snapshot_quantity_unsupported`) — rozszerzenie wymaga zmiany runtime/zapisu wyników |
| Animacja | odtwarzanie sekwencji z prefetchem N klatek, bez trzymania wszystkich buforów |

## B5. Gizmo płaszczyzny w 3D

| Aspekt | Projekt |
|---|---|
| Interakcja | uchwyt przesunięcia wzdłuż normalnej i dwa pierścienie obrotu w widoku 3D; pick-from-face ustawia płaszczyznę na ścianie obiektu |
| Stan | zapisuje draft monitora tą samą transakcją co Inspector; brak drugiego stanu |
| Klawiatura | `Shift+[`/`Shift+]` krok obrotu, liczby w Inspectorze |
| Dowód | smoke przeglądarkowy z kontekstem WebGL i porównaniem ramki z meta próbki |

## B6. Indeks przestrzenny i gather na GPU

- BVH po AABB elementów (budowane raz na `topology_fingerprint`) dla płaszczyzn skośnych, sondy i profili; obecnie płaszczyzna rasteryzuje element po elemencie, a sonda skanuje elementy liniowo.
- Gather operatora (rzadkie mnożenie) na urządzeniu dla FEM GPU, aby nie kopiować całego pola przy każdym kroku; wymaga noty i kwalifikacji parytetu z CPU.

## Kolejność proponowana

1. B1 profil liniowy (największa wartość analityczna, mały koszt).
2. B4 nawigator czasu (wymaga zmian runtime dla wielkości innych niż `m`).
3. B2 multislice.
4. B6 indeks przestrzenny (warunek wydajności B1 dla FEM na dużych siatkach).
5. B3 streamlines, B5 gizmo.
