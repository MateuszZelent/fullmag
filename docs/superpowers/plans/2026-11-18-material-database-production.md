# Wspólna baza materiałów — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trwała baza materiałów między projektami, chronione oryginały, warianty
z porównaniem zmian oraz wybór i ręczna edycja materiału w Model Builderze.

**Architecture:** Backend publikuje katalog v2 i zapisuje własne wpisy w osobnym
SQLite w trwałym katalogu użytkownika. Materiał sceny zachowuje samodzielne
wartości oraz opcjonalny snapshot źródła. Jeden modal i centralna warstwa API
obsługują zarządzanie katalogiem oraz wybór w Inspectorze.

**Tech Stack:** Rust/Axum/utoipa/rusqlite, Python DSL, Next.js 16/React,
istniejące prymitywy shadcn/Radix, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-18-material-database-production-design.md`

## Global Constraints

- Osobny `material-library.sqlite3` obok trwałego `workspace.db`, poza danymi buildu.
- Grupy nadal mają niezależne dane zgodnie z ADR 0067.
- Model zapisuje wartości i ich pochodzenie; brak automatycznej propagacji zmian z bazy.
- Create i update są odrębnymi operacjami; kolizja nie przechodzi w update.
- OpenAPI jest źródłem typów; transport wyłącznie w centralnym kliencie i hooks.
- Nie zmieniamy ProblemIR, algorytmów FDM/FEM ani wyboru CPU/GPU.
- Wszystkie buildy i ich cache pozostają we właściwej grupie Docker Compose.
- Użytkownik zatwierdził projekt i zlecił wdrożenie; wykonanie ciągłe w tej sesji,
  bez kolejnego pytania o rozpoczęcie. Jedno niezależne review przed integracją.

## Review Focus

- Nowy materiał z nazwą/ID istniejącego: bez ukrytego patch ani utraty wartości (zadania 1, 4).
- Katalog zmieniony/usunięty po użyciu w modelu: model i porównanie pozostają samodzielne (1, 2, 5).
- Sesja zmieniona podczas żądania: stary ACK nie modyfikuje nowego Inspectora (3, 4, 5).
- Dwie karty edytują tę samą wersję: konflikt zachowuje draft i nie nadpisuje zmian (1, 3, 4).
- Materiał współdzielony przez obiekty: widoczne użycia i niezależna kopia na żądanie (2, 4, 5).

## Task 1: Trwały katalog i pochodzenie materiału

**Files:**
- Create: `crates/fullmag-api/src/material_library.rs`,
  `crates/fullmag-api/src/material_library/tests.rs`.
- Modify: `crates/fullmag-api/Cargo.toml`, `crates/fullmag-api/src/main.rs`,
  `crates/fullmag-authoring/src/scene.rs`, `crates/fullmag-authoring/src/adapters.rs`,
  istniejące konstruktory `SceneMaterialAsset` w testach.

**Interfaces:**
- Produces: `SceneMaterialSource` z tożsamością, wersją, nazwą, rodzajem źródła,
  właściwościami i referencjami; opcjonalne `SceneMaterialAsset.source`.
- Produces: `MaterialLibraryStore::open(path)`, `list()`, `create(input)`,
  `update(id, input, expected_revision)`, `delete(id, expected_revision)`.
- Katalog zwraca wersjonowane wpisy; pięć istniejących presetów ma stabilne
  ID, niezmienne wartości i wersję. Wpisy własne mają osobną tożsamość i snapshot
  rodzica. Typy domeny nie zależą od UI ani wyboru solvera.

- [ ] Napisać testy: `persists_custom_entries_after_reopen`,
  `builtins_cannot_be_changed_or_deleted`, `create_collision_is_not_update`,
  `stale_update_is_conflict`, `source_snapshot_survives_parent_removal`,
  `validates_finite_values_and_required_alpha`, `preserves_all_references`.
- [ ] Uruchomić testy w backendzie grupy zadania; Expected: RED dla brakujących
  interfejsów, a nie z powodu nieskonfigurowanego runtime.
- [ ] Zaimplementować SQLite, transakcje rewizji i domenowe błędy; brak
  nadpisywania bazy po błędzie odczytu. Zachować wszystkie istniejące presety,
  oznaczając je jako wartości wyjściowe wymagające weryfikacji dla próbki.
- [ ] Uruchomić te same testy; Expected: GREEN. Sprawdzić serializację starej
  sceny bez `source` i nowej ze snapshotem.
- [ ] Przejrzeć i commitować spójny etap po osobnym sprawdzeniu staged files.

## Task 2: Kontrakt API i round-trip modelu

**Files:**
- Create: `crates/fullmag-api/src/schemas/material_library.rs`,
  `crates/fullmag-api/src/router_v2/handlers/material_library.rs`,
  `crates/fullmag-api/src/router_v2/tests/material_library.rs`.
- Modify: `crates/fullmag-api/src/schemas/mod.rs`, `schemas/authoring.rs`,
  `router_v2/mod.rs`, `router_v2/handlers/mod.rs`, `router_v2/tests/mod.rs`,
  `openapi_v2.rs`, `router_v2/handlers/model/authoring.rs`.
- Modify: `crates/fullmag-authoring/src/builder.rs`, `adapters.rs`,
  `packages/fullmag-py/src/fullmag/runtime/scene_document.py`,
  `packages/fullmag-py/src/fullmag/runtime/script_builder.py` i odpowiednie testy.
- Create: `docs/specs/material-library-v1.md` i właściwy ADR dla nowego kontraktu.

**Interfaces:**
- Consumes: store i `SceneMaterialSource` z zadania 1.
- Produces: `GET/POST /v2/workspace/material-library`,
  `PUT/DELETE /v2/workspace/material-library/{material_id}`; rewizje przy mutacjach.
- Produces: `MaterialLibraryResource`, `MaterialLibraryEntryResource`,
  `MaterialLibraryWriteRequest`, `MaterialSourceResource` oraz opcjonalny `source`
  w create/patch/resource materiału sceny.
- Pochodzenie nigdy nie zastępuje efektywnych parametrów. Aktualizacja katalogu
  nie jest mutacją authoringu. Import do modelu zachowuje transakcje i undo.

- [ ] Napisać testy HTTP trwałości, błędów 400/404/409, ochrony builtins,
  null/pustych wartości i rewizji; test create/patch scene z pełnym source.
- [ ] Napisać test Python scene→builder→script→scene ze zmodyfikowanym Ms i
  oryginalnym snapshotem; odczyt działa bez katalogu. Expected: RED.
- [ ] Zaimplementować DTO, router, `spawn_blocking`, mapowanie błędów, origin
  i jawne metadane round-trip zgodne z istniejącym `fm.runtime_metadata`.
- [ ] Regenerować OpenAPI, transport, TS i modele Python przez
  `just docker-dev-codegen <source-root>`; nie edytować generated ręcznie.
- [ ] Uruchomić odpowiednie testy Rust/Python i walidację kontraktu. Expected: GREEN.
- [ ] Przejrzeć i commitować etap z kontraktem i generated.

## Task 3: Centralny klient, zasoby i model formularza

**Files:**
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`, `ControlRoomApi.ts`,
  `ControlRoomApi.test.ts`, właściwe stałe ścieżek w `kernel/api`.
- Create: `apps/control-room/src/kernel/resources/materialLibraryResources.ts`
  i jego testy.
- Modify: `apps/control-room/src/shared/domain/material/materialLibrary.ts`,
  `materialLibrary.test.ts`.

**Interfaces:**
- Consumes: generated DTO z zadania 2.
- Produces: `api.workspace.materialLibrary`, `createLibraryMaterial`,
  `updateLibraryMaterial`, `deleteLibraryMaterial`; `useMaterialLibraryResource`.
- Produces: wspólny model draftu i walidacji; funkcja porównania source do
  parametrów/referencji; stabilne etykiety built-in/custom/modified.

- [ ] Napisać testy właściwego resource key, invalidacji po ACK, konfliktu,
  załadowania oryginałów z API i porównania 8e5 == 800000. Expected: RED.
- [ ] Zaimplementować facade/hooks i wspólne funkcje domenowe; usunąć drugą
  frontendową kopię katalogu presetów.
- [ ] Uruchomić focused Vitest i API hygiene w frontendzie grupy zadania.
  Expected: GREEN; brak endpointów lub fetch w komponentach.
- [ ] Przejrzeć i commitować etap.

## Task 4: Modal i Model Builder

**Files:**
- Modify: `apps/control-room/src/kernel/layout/MaterialLibraryDialog.tsx`,
  `src/design/styles/material-library.css`, `kernel/layout/AppMenuBar.tsx`.
- Create: `kernel/layout/MaterialLibraryDialog.dom.test.tsx`, ewentualne
  komponenty edytora/listy obok modalu według podziału odpowiedzialności.
- Modify: `modules/inspector/panels/ObjectMaterialPanel.tsx`,
  `ObjectMaterialPanelModel.ts` i ich istniejące testy.

**Interfaces:**
- Consumes: katalog i model draftu z zadania 3, source z zadania 2.
- Produces: jeden modal trybu manage/pick, `onSelect(entry)` dla Inspectora.
- Inspector importuje snapshot przez istniejący create-and-assign, kontroluje
  scope sesji/obiektu, pokazuje source i użycia oraz udostępnia niezależną kopię.

- [ ] Napisać testy DOM: wyszukiwanie, filtr, Built-in tylko odczyt,
  fork→Modified, New→Custom, dirty navigation/close, konflikt zachowuje draft,
  wszystkie referencje i Dbulk w J/m². Expected: RED.
- [ ] Dodać testy Inspectora: wybór→import→assign, ręczna edycja→modified,
  zapis własnego wariantu, copy-for-object, kolizja, podwójny submit,
  późny ACK po zmianie scope, zachowane edycje rozpoczęte podczas ACK.
- [ ] Zaimplementować UI według istniejących tokenów i prymitywów.
  Oryginał nie jest formularzem zapisywanym in-place; wyraźna akcja wariantu.
- [ ] Zweryfikować dostępność, etykiety, fokus, Esc i stany błędów zgodnie
  z odczytanym Modern Web Guidance; zachować wspólny Dialog repozytorium.
- [ ] Uruchomić focused testy oraz wymagane typecheck/lint/test/API hygiene.
  Expected: GREEN; inspektory nie migają i nie blokują niezwiązanych pól.
- [ ] Przejrzeć i commitować etap.

## Task 5: Dowód runtime, przegląd i integracja

**Files:**
- Create: `apps/control-room/scripts/smoke-material-library.mjs` według
  istniejących smoke testów i zarządzanej trasy browser QA.
- Modify: plan/spec o stan dowodów, bez przedstawiania kontraktu jako runtime.

- [ ] Przeprowadzić scenariusz na osobnej sesji grupy zadania: built-in→wariant,
  zapis, nowy projekt→ponowne użycie, wybór dla obiektu, ręczna zmiana, zapis
  i ponowny odczyt projektu oraz eksport/odczyt Python; model nadal działa po
  zmianie/usunięciu wpisu katalogu. Nie mutować sesji użytkownika na 3197.
- [ ] Przeprowadzić Object/Airbox stability regression: ten sam root,
  fokus/scroll, zero obcych disabled/opacity i aktywnych opacity animations,
  ograniczone żądania/render. Potwierdzić canvas, gdy scenariusz obejmuje viewport.
- [ ] Uruchomić niezależne review całego diffu i naprawić istotne ustalenia
  z regression check; required gates muszą dotyczyć aktualnych źródeł.
- [ ] Commit/push, PR do master, wymagane kontrole i akceptacje, merge;
  sprawdzić wynikowy pełny commit i lokalny fast-forward.
- [ ] Drain i zatrzymanie wyłącznie grupy zadania, qualified retention przez
  worktree-finish, niezależny inventory i cleanup dokładnie tego worktree.
- [ ] Raport końcowy zawiera faktyczne dowody oraz pozostałe blokady.

## Rejestr wykonania

- 2026-11-18: diagnoza i zatwierdzony projekt; kod produktu niezmieniony.
- Pre-flight: 1→2 source/store; 2→3 generated DTO; 3→4 facade/hooks; 2→4
  snapshot przy create/assign; 4→5 browser UI. Brak konfliktu interfejsów.
- Izolacja: natywne tworzenie worktree pozostaje w toku; brak implementacji
  w głównym checkoutcie. Docelowy katalog zgodnie z resolverem:
  `D:/git/worktrees/material-database-production-20261118`.
