# Otwieranie zapisanych wyników — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Otworzyć folder zakończonej symulacji i przewijać zapisane pole m w Inspectorze oraz wspólnym viewporcie 3D, bez Solve.

**Architecture:** Zarejestrowany folder workspace jest źródłem tylko do odczytu. Deskryptor playback.json identyfikuje geometrię regularnej siatki FDM, etapy, czasy i tablice Zarr. Cienki manifest API i binarna pojedyncza klatka są czytane przez facade/resource hooks; kontroler kernela przechowuje wyłącznie wybór źródła, czasu i prezentacji.

**Tech Stack:** Rust/Axum/utoipa, React/TypeScript, istniejący R3F/Three Viewport3DCanvas, Zarr v2 bez kompresji float64.

**Spec:** docs/specs/saved-results-playback.md

## Stan wykonania

Zaimplementowano Tasks 1–4. Przeszły testy czytnika i HTTP, 68 regresji helperów, 8899 testów frontendu, typecheck, lint oraz końcowy managed browser QA na YIG po integracji mastera. Dowody i granice: [raport weryfikacji](../../specs/saved-results-playback-verification-20261027.md). Integracja CI i cleanup są rejestrowane w PR #297 i checkpointcie operacyjnym.

## Global Constraints

- Źródła i wyniki pozostają niezmienne; bez uruchamiania skryptu ani solvera, bez przejmowania runtime.
- Oddzielne źródło historyczne: folder, rewizja, etap, klatka. Zmiana klatki nie przebudowuje geometrii.
- Jeden viewport i Inspector; bez tablic w kontrolerze UI, bez transportu w komponentach.
- Build i zależności tylko w grupie Docker Compose worktree. Nie kompilować natywnych testów jednostkowych, zgodnie z bieżącym zakazem.
- Pierwszy obsługiwany zapis: regularna siatka FDM, pole m AoS xyz, Zarr v2 little-endian f64, chunks [1,3*N]. Inne formaty otrzymują czytelny komunikat.

## Review Focus

- Złośliwy lub uszkodzony folder: brak symlinków/path traversal, granice rozmiaru, skończoność danych, brak wykonywania kodu.
- Niekompletny i zmieniony zapis: wymagane complete, przypięta rewizja, błąd zamiast zera lub obcej klatki.
- Szybkie przewijanie/zmiana folderu: anulowanie starego odczytu, brak starego pola pod nowym czasem.
- Brak aktywnej sesji: historyczny workspace działa samodzielnie, po zamknięciu wraca poprzedni ekran.
- Długi zapis: tylko jedna klatka i ograniczony cache, cisza przy bezczynności, stabilny Inspector i kamera.

### Task 1: Czytnik i kontrakt API (worker backend)

Pliki: crates/fullmag-workspace-inspect/src/playback.rs i eksport/rozpoznanie; crates/fullmag-api/src/schemas/workspace_items.rs, router/handler/OpenAPI.

Interfejsy: GET /v2/workspace/items/{id}/playback; GET /v2/workspace/items/{id}/playback/frames/{frame_index}?stage_id&revision. Manifest SavedPlaybackResource: schema, revision, name, grid_cells_xyz, cell_size_m, origin_m, stages[{stage_id,frame_count,times_s,quantity_ids}]. Klatka: binarne f64 xyz.

- [x] Testy czytnika: poprawne dwa etapy, końcowa klatka, brak chunku, obce ścieżki i symlinki, uszkodzony/za duży zapis, nieaktualna rewizja.
- [x] Implementacja czytnika i cienkich handlerów z blokującym I/O poza async executorem.
- [x] Eksport OpenAPI z managed buildu i regeneracja klientów; kontrola zgodności.
- [x] Commit spójnego backendu po dozwolonej weryfikacji.

### Task 2: Zasoby i wybór źródła (parent)

Pliki: kernel/saved-results/{SavedResultsPlaybackController.ts,useSavedResultsPlayback.ts}, kernel/resources/savedResultsPlaybackResources.ts, kernel/api/ControlRoomApi.ts, apiPaths.ts, KernelProvider.tsx, types.ts.

- [x] Testy izolacji kontrolera i dekodera (zły rozmiar/NaN/ostatnia klatka).
- [x] Typowany facade, cache rewizji i anulowanie odczytu starszej klatki; brak ciężkich danych w stanie UI.
- [x] Weryfikacja testami frontendowymi w wolumenie grupy i commit.

### Task 3: Otwieranie i Inspector (worker UI)

Pliki: modules/start/inspector/ResultInspector.tsx, StartScreen.tsx; kernel/layout/WorkspaceShellClient.tsx, WorkspaceDockLayout.tsx; modules/inspector/InspectorModule.tsx i panels/SavedResultsPlaybackInspector.tsx.

- [x] Folder z dowolnym źródłem (również skrypt) otwiera odtwarzanie; nie wymaga sesji.
- [x] Inspector: etap, czas z jednostką ns, suwak, poprzednia/następna/ostatnia klatka, składowa x/y/z, zakres koloru i zamknięcie.
- [x] Testy otwarcia bez source projektu i stabilnego przewijania; commit po weryfikacji.

### Task 4: Adapter źródła w istniejącym viewporcie i realne dane (parent)

Pliki: modules/viewport-3d/SavedResultsPlaybackViewport.tsx, model/savedResultsPlaybackModel.ts, Viewport3DModule.tsx; docs/specs/saved-results-playback.md; pomocniczy deskryptor w odzyskanym bundle YIG.

- [x] Adapter regularnej geometrii i mapowania m_x/m_y/m_z na kolory; geometria nie zależy od klatki.
- [x] Istniejący Canvas, orbit/zoom, render na żądanie; zwalnianie geometrii/materiałów przy zamknięciu.
- [x] Uruchomienie grupy na wolnym porcie, wczytanie folderu YIG i dowód zmiany klatek, widocznego canvas, niezagubionego kontekstu i niezerowego bufora.
- [x] Typecheck/lint/tests i właściwe architecture/API hygiene gates. Niezależne review zmian.
- [ ] Commit/push/PR/master/integracja i bezpieczny cleanup w granicach aktualnych uprawnień; blokady zapisać jawnie.
