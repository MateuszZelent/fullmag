# Plan wdrożenia: widok 2D z parytetem mumax3 dla FDM i FEM

- Data: 2026-10-27
- Status: **PROPOSED**; start implementacji po akceptacji decyzji D2D-01…D2D-13 (README)
- Kolejność zgodna z rekomendacją audytu 31.08 §25: najpierw czerwone bramki i dokumentacja, potem poprawność, potem funkcje

## 0. Reguły wykonania (dla każdego etapu)

- Każdy etap w osobnym worktree `worktrees/viewport-2d-<etap>-<data>`, branch `codex/viewport-2d-<etap>-<data>`, pełny cykl z AGENTS.md (testy → commit → PR → merge → fast-forward → sprzątanie grupy Compose → `git worktree remove` → wpis w rejestrze).
- Build tylko w grupie Docker Compose worktree (`just docker-dev-toolchain`, `just docker-dev`); żadnego hostowego `cargo`/`pnpm build`.
- **Zakaz kompilacji testów jednostkowych** obowiązuje do odwołania. Do tego czasu bramki „testy Rust/vitest” są `NOT VERIFIED`, a dowodem są: `just check-api-source`, `just lint-control-room-source`, `just check-control-room-production-source`, testy kontraktowe Python/Node bez kompilacji, walidatory `scripts/test_validate_*`, oraz smoke przeglądarkowy w grupie DEV. Testy jednostkowe są pisane razem z kodem, ale uruchamiane dopiero po zdjęciu zakazu.
- Zmiana viewportu wymaga dowodu z przeglądarki: widoczny canvas, brak utraty kontekstu WebGL 3D po powrocie, niezerowy bufor (reguły frontendu).
- Zmiana fizyki/numeryki wymaga aktualizacji noty 0970 przez `scientific-documentation-contract` **przed** kodem.
- Zmiana kontraktu JSON: OpenAPI + `just docker-dev-codegen`; frontend tylko przez typowany klient i resource hooks.
- Każdy etap kończy się wpisem w `docs/status/2d-slice-capabilities.md` z rewizją i linkiem do receiptu; checkbox bez dowodu jest zabroniony.

## F0 — Bramki i dokumentacja (fundament, bez nowych funkcji)

| # | Zadanie | Pliki | Weryfikacja |
|---|---|---|---|
| F0.1 | Uzgodnić id przypadku `raster` vs `shaded` w smoke bez osłabiania wymogu warstwy (P0-02) | `apps/control-room/scripts/smoke-viewport-2d*.mjs` i test | `node --test apps/control-room/scripts/smoke-viewport-2d.test.mjs` → 11/11 |
| F0.2 | Zdiagnozować 16 porażek preflightu FDM (fail-open `PreflightError not raised`) i naprawić przyczynę, nie asercje (N-08) | `scripts/analysis/validate_viewport_2d_fdm_preflight.py`, test | `PYTHONPATH=. python3 -B scripts/test_validate_viewport_2d_fdm_preflight.py -v` → OK; test startuje także bez ręcznego `PYTHONPATH` albo recepta dokumentuje wymóg |
| F0.3 | Jeden ledger statusu; masterplan 07-18 i plany 08-12 oznaczone `superseded`/historyczne z linkiem do tego pakietu (P0-04) | `docs/status/2d-slice-capabilities.md`, `docs/plans/active/viewport-2d-*` | przegląd linków; brak „done” bez receiptu |
| F0.4 | Aktualizacja spec 15 o pasek kontrolek, składową `direction`, stany klatki, skróty, kontrakt warstwy (z 03) | `docs/specs/frontend-v2/15-viewport-2d-module.md` | review; zgodność z ADR 0020 |
| F0.5 | Aktualizacja noty 0970: tryby warstw (cell/named/continuous/node-plane), operator S=(W,M) i cache, statusy sondy, tolerancje względne, rozdział `occupied_range`/`rendered_range`, provenance toru źródła | `docs/physics/0970-…md` + `source-map.json` | walidator dokumentacji naukowej z `scientific-documentation-contract` |
| F0.6 | Usunąć lub ukryć martwe komendy (N-01) do czasu ich implementacji w F1 | `modules/field-map/fieldMapCommands.ts`, `modules/explorer/builders/modelRootNodes.ts` | lint/typecheck source; komenda bez implementacji nie jest widoczna |

Kryterium ukończenia F0: obie bramki kontraktowe zielone, dokumentacja bez sprzeczności z ADR 0020, żadna komenda 2D nie zwraca sukcesu bez efektu.

## F1 — Parytet mumax3 dla FDM (głównie frontend + mała zmiana kontraktu)

| # | Zadanie | Pliki (główne) | Weryfikacja |
|---|---|---|---|
| F1.1 | Kontrakt: `layer_mode`, `layer_index`, `named_layer_id`, `requested_coordinate_m` w `DefaultPlanarSliceState`; meta: `requested/resolved_coordinate_m`, `resolved_layer_index`, `layer_stops`; migracja v10 → v11 | `crates/fullmag-api/src/schemas/visualization_state.rs`, `schemas/planar_fields.rs`, `planar_sampling/source.rs`, `session_persistence.rs`, OpenAPI | `just check-api-source`; codegen; test migracji (uruchomienie po zdjęciu zakazu) |
| F1.2 | Pasek kontrolek nad mapą (wariant C): wielkość, składowa, płaszczyzna, warstwa z ‹ ›, odczyt żądane/rozwiązane, strzałki, siatka; prymitywy shadcn; tokeny `--fm-*` | `modules/field-map/components/` (nowy `FieldMapToolbar`), `FieldMapModule.tsx`, `src/design/styles/field-map.css` | lint/production source; smoke: zmiana warstwy z paska aktualizuje Inspector i odwrotnie |
| F1.3 | Retencja niezależna od pozycji (N-02) + RAF/settle dla gestów (P2-01, podłączyć `createPlanarFrameScheduler` albo usunąć) + profil `interactive` przy przeciąganiu | `hooks/useRetainedPlanarFrame.ts`, `model/planarFrameRetention.ts`, `renderer/PlanarSurface.tsx`, `VisualizationRegistrySyncController.ts` | smoke: 50 kroków suwaka bez placeholdera i bez nowego workera; licznik żądań i renderów w budżecie z 03 §10 |
| F1.4 | Składowa `direction` (koło barw mumax3, układ świata) w workerze przez **wspólną** funkcję z 3D (`magnetizationHslRgb` przeniesione do `shared/visualization`) + legenda dwóch półkul + ta sama formuła w backendowym `render.png` | `modules/viewport-3d/orientation/magnetizationColor.ts` → `shared/visualization/`, `renderer/colorRaster.ts`, `renderer/planarColorizer.ts`, `components/PlanarColorLegend.tsx`, backend render PNG | test modelu koloru (formuła z 02 §4.1, v ≈ 0 → szary 0,6); ten sam wektor ma ten sam kolor w 2D i 3D; zrzut porównawczy z mumax3 na tym samym polu |
| F1.5 | Strzałki wg 03 §6: siatka 2D, groty, min px, ⊙/⊗, usunięcie atrapy `magnitude` lub implementacja z legendą | `renderer/vectorGlyphs.ts`, `renderer/planarRenderer.ts`, `presentationSemantics.ts` | zrzut regresyjny; brak pasów; glify nie zmieniają się przy zoomie |
| F1.6 | Komendy `fit`, `reset-view`, `toggle-*`, skróty z 03 §11 | `fieldMapCommands.ts`, rejestr skrótów | test komend; smoke klawiatury |
| F1.7 | Inspector „Live” przez `resolvePlanarEvidenceStatus` (P1-08); odczyt żądane/rozwiązane w Inspectorze (P1-01) | `PlanarVisualizationSection.tsx`, `DefaultPlanarSourceSection.tsx` | regresja Inspectora wg reguł frontendu (stabilny root, brak nieistotnych disabled/opacity) |
| F1.8 | Dostępność wg 03 §12 (P2-02) i formatowanie przypiętej sondy (P2-03) | `PlanarAxes.tsx`, `PlanarSurface.tsx`, `PlanarColorLegend.tsx`, `PlanarPinnedProbe.tsx` | axe smoke |

Kryterium ukończenia F1: na realnej sesji FDM CPU w grupie DEV użytkownik zmienia warstwę klawiszami `[` `]` z odczytem `k i z`, widzi koło barw i strzałki z grotami, bez migotania; smoke browser zielony; budżety FDM z 03 §10 zmierzone i zapisane.

## F2 — Fundament FEM: operator próbkowania i indeks przestrzenny

| # | Zadanie | Pliki (główne) | Weryfikacja |
|---|---|---|---|
| F2.1 | `PlanarSamplingOperator` (CSR W, M, zajętość, source_entity, overlay) i etap polowy (gather) dla FDM i FEM Tet4/Prism6; ścieżki nieliniowe bez zmian | `crates/fullmag-api/src/planar_sampling/` (nowy moduł `operator.rs`), `fem.rs`, `fdm.rs` | walidator `test_validate_planar_monitor_sampling.py` zielony; test „cache vs bezpośrednio” z tolerancją względną ≤ 1e-13 (inna kolejność sumowania) oraz determinizm „ta sama ścieżka dwa razy = identyczne bajty” (po zdjęciu zakazu) |
| F2.2 | BVH + listy przedziałów, element-driven rasteryzacja, reguła top-left, `overlap_count` | `planar_sampling/` (nowy `spatial_index.rs`) | benchmark 10k/200k/2M elementów; brak regresji dokładności |
| F2.3 | Cache operatorów LRU per sesja, single-flight, `spawn_blocking`, fence epoki przed insertem (N-04, P1-14) | `quantity_data_plane.rs`, `router_v2/handlers/data/planar_fields.rs` | test równoległych żądań → 1 budowa; test sesja A → B |
| F2.4 | Tolerancje względne (P1-10), błędy membership bez `.ok()` (P1-11), zakres zajętości (P1-12), sonda punktowa ze statusami (P1-05), `vector_budget` w tożsamości (P1-13) | `planar_sampling/*.rs`, `router_v2/handlers/data/resolved_spatial_field.rs`, `planar_fields.rs` | testy skali nm/µm/mm; testy sondy na krawędzi i poza ramą |
| F2.5 | Kontrola typów elementów w obrębie targetu (D2D-07) | `planar_sampling/target.rs:742-778` | fixture SP4: `m` w magnesie działa, `H_demag` w airboxie zwraca 422 z liczbą Pyramid5 |
| F2.6 | Provenance toru źródła w meta (backend, urządzenie, precyzja) | `schemas/planar_fields.rs` | meta FEM GPU pokazuje źródło GPU i `sampling_execution=cpu` |

Kryterium ukończenia F2: FEM Tet4/Prism6 spełnia budżety FEM z 03 §10 przy ciepłym cache; nowa klatka pola nie przebudowuje operatora (licznik); wyniki zgodne ze ścieżką bezpośrednią w tolerancji względnej, a powtórne budowy operatora bajtowo identyczne.

## F3 — Pyramid5 i Hex8 (P0-03)

| # | Zadanie | Weryfikacja |
|---|---|---|
| F3.1 | Potwierdzenie bazy Pyramid5 względem MFEM i zapis w 0970 (D2D-08) | nota z równaniami, odwołaniem do źródła MFEM i testem zgodności wartości |
| F3.2 | Odwrotne odwzorowania Hex8/Pyramid5; slab/depth z kwadraturą elementową na obszarze przyciętym dla Prism6, Hex8 i Pyramid5 (naprawa N-09); klasyfikacja granic FMCS v4 | pola wytwarzane liniowe (≤ 1e-12) i kwadratowe (rząd 2); skośne płaszczyzny |
| F3.3 | Fixture SP4 Prism6 + Pyramid5 + Tet4; `H_demag` w airboxie | science report FEM CPU i FEM GPU (źródło) |
| F3.4 | Aktualizacja capability matrix i statusu | wpis z receiptem |

## F4 — Warstwy FEM (D2D-06)

| # | Zadanie | Weryfikacja |
|---|---|---|
| F4.1 | `layer_stops` z certyfikatu swept dla płaszczyzny równoległej do sweepu; tryb `fem_node_plane` | raster na płaszczyźnie węzłów = interpolacja liniowa wartości węzłowych |
| F4.2 | Warstwy nazwane z obiektów/regionów (slab po grubości obiektu); `scope_kind=region` (P1-03) | dwa regiony o różnych polach dają różne mapy |
| F4.3 | `navigation_step_m` dla siatek niestrukturalnych | odczyt i krok w UI zgodny z medianą rozciągłości |
| F4.4 | Jedno źródło capability airboxu (P1-04) | UI nie pokazuje wsparcia przed rozwiązaniem źródła |

Kryterium ukończenia F4: ta sama kontrolka „Warstwa” działa na FDM, FEM swept i FEM Tet4 z poprawnymi odczytami; smoke dla trzech fixture.

## F5 — Kwalifikacja (P0-01)

- Jedna tożsamość źródeł; tory FDM CPU, FEM CPU, FEM GPU; FDM GPU osobno po istnieniu zarządzanego launchera.
- Science + browser + zrzuty + wydajność (budżety 03 §10) + 100 przełączeń 2D↔3D (pamięć, worker, listener, kontekst WebGL).
- Zrzuty porównawcze z mumax3 dla tego samego stanu wiru w FDM (koło barw, strzałki) jako dowód parytetu ergonomii, nie poprawności fizycznej.
- Status w ledgerze zmienia się na `production-qualified` wyłącznie z linkiem do receiptu.

## F6 — Poziom B (osobne designy po F5)

Profil liniowy, multislice (siatka paneli), nawigator czasu/etapu w powierzchni 2D, gizmo płaszczyzny w 3D, streamlines (D2D-13), gather na GPU. Każda funkcja jako zasób pochodny tej samej klatki (decyzja 22) z własną notą, jeśli dotyka numeryki.

## Zależności i równoległość

```text
F0 ──► F1 (FDM, frontend) ─────────────┐
  └──► F2 (FEM operator) ──► F3 ──► F4 ─┴──► F5 ──► F6
```

F1 i F2 mogą iść równolegle w osobnych worktree po F0: F1 dotyka głównie `apps/control-room` i małej części schematów, F2 głównie `planar_sampling`. Wspólny punkt styku to kontrakt meta z F1.1 — F2 musi go przejąć, nie duplikować.

## Szacunek skali (orientacyjny)

| Etap | Backend | Frontend | Dokumentacja/testy |
|---|---|---|---|
| F0 | mały | mały | średni |
| F1 | mały–średni | duży | średni |
| F2 | duży | mały | średni |
| F3 | średni–duży | brak | duży (nota) |
| F4 | średni | mały | średni |
| F5 | — | — | duży (runtime, przeglądarka) |

## Stan realizacji (2026-10-28, branch `codex/viewport-2d-production-20261027`)

| Etap | Stan | Uwagi |
|---|---|---|
| F0 | zrobione | smoke contract 11/11, preflight FDM zielony, martwe komendy zastąpione, plany oznaczone `superseded`, spec 15/UI/ledger zsynchronizowane, nota 0970 rozszerzona |
| F1 | zrobione z odstępstwem, smoke przeglądarkowy FDM CPU | pasek kontrolek, koło barw `hsl_direction` (2D/3D/PNG), strzałki z grotami, retencja, skróty, `meta.section`, Inspector `Live` (selektor tylko statusu), dostępność canvasa (`tabIndex=0`, streszczenie `aria-describedby`); **odstępstwo**: budżety z 03 §10 nie zostały zmierzone (tylko czasy z smoke: otwarcie 0,3 s, krok warstwy ~20 ms) |
| F2 | zrobione z odstępstwami (kompilacja, runtime FDM) | cache operatora FEM, single-flight, `spawn_blocking`, fence epoki, sonda punktowa, ekstrema zajętości, tolerancje względne FEM, dokładny błąd loadera membership (P1-11); `vector_budget` zdefiniowany jako parametr wyłącznie prezentacyjny (gęstość glifów), poza tożsamością próbki (P1-13); **odstępstwa**: BVH (F2.2) odłożony do B6 — zostaje rasteryzacja per element; tolerancja de-duplikacji w `geometry.rs` nadal absolutna |
| F3 | zrobione (kompilacja) | Hex8, Pyramid5 (zgodny z MFEM), kwadratura slab/depth dla elementów nieafinicznych |
| F4 | zrobione | F4.1 przystanki płaszczyzn węzłów z certyfikatu swept (odczyt „between node planes”); F4.2 zakres `region` (`scope_kind=region`, `scope_id` = obiekt, `scope_region_id`) dla FDM i FEM oraz warstwy nazwane z obiektów (slab o grubości obiektu z realizacji geometrii, bez snapu środka; PM-N24); F4.3 krok h⊥ = mediana rozciągłości przeciętych elementów (PM-N23); F4.4 capability Airboxu z meta backendu. Dowody i ograniczenia w ledgerze statusu |
| F5 | częściowo | FDM CPU i FEM CPU: smoke sesyjne PASS; smoke repozytorium `smoke-viewport-2d.mjs` (tryb `default`, FDM CPU): przypadki slice'a domyślnego, slab i monitor autorski PASS; PM-N24 runtime (zakres regionu: +1 na 320 komórkach, −1 na 280, cel 600); FDM GPU: runtime + przeglądarka PASS (`resolved_device=gpu`); budżety D2D-12 po poprawkach: krok warstwy ciepły P50 0,35 s pod SwiftShader, przełączenie składowej 0 żądań planarnych i 1 wiadomość do workera, sterta ~0,24 MiB/cykl 2D↔3D (było 0,86), pan/zoom 0 żądań; zrzuty porównawcze z mumax3 (koło barw, strzałki) w `docs/diagnostics/viewport-2d-mumax3-parity-2026-10-28/` — stan początkowy wiru oraz stan po etapie relaksacji FDM CPU (200 kroków; możliwe po poprawce nieograniczonego horyzontu relaksacji w runnerze, 2026-10-29); FEM GPU **BLOCKED** (`MPI_ABORT` na `cudaFree` „driver shutting down”, zajęty ledger); zarządzana kwalifikacja wydania **nie wykonana**: recepty release/qualification są w `justfile` oznaczone jako „Legacy/frozen”, odrębne od Docker DEV, a tor FEM GPU jest zablokowany — status pozostaje bez `production-qualified` |
| F6 | częściowo | B1 profil liniowy zrobiony (nota 0970 `eq-planar-line-profile`, PM-N25; zasób `…/profile`; Shift+przeciągnięcie, wykres ECharts, eksport CSV/TSV/PNG; runtime FEM: 890 punktów, w tym 378 przecięć ze ścianami elementów); B2 multislice zrobione (nota 0970 § Multislice panels, PM-N27 w runtime: panele XY/XZ bitowo równe pojedynczemu przekrojowi, różne tokeny; przeglądarka 2–4 panele); B3 streamlines zrobione (nota 0970 `eq-planar-streamlines`, PM-N26; worker, przeglądarka FDM: 7 linii wiru, 0 błędów); B4 nawigator migawek zaimplementowany, runtime zablokowany przez master (etap histerezy niewykonywalny); B5 gizmo płaszczyzny w 3D (przesunięcie, pierścienie obrotu, Shift+[ / ], pick-from-face — przeglądarka); B6 BVH dla lokalizacji punktów (PM-N28: profil = sonda bitowo) i dla operatora płaszczyzny (PM-N17: poprawność na 10k/164k/2,26M potwierdzona; przyspieszenie niewykazane — przy 164k brak, przy 2M brak pomiaru bez indeksu), gather GPU zablokowany — szczegóły w 06 |
