# Audyt scenariusza UI: universe → dwie sfery → parametry siatki → build → jakość

Data: 28.10.2026. Branch: `codex/ui-mesh-build-scenario-20261028`.

## Scenariusz i środowisko

Użytkownik uruchamia Fullmag bez skryptu, tworzy pustą symulację FEM, definiuje
universe, dodaje dwie sfery (r = 50 nm, środki x = ±60 nm), ustawia w Inspektorze
parametry siatki, buduje siatkę i ocenia jej jakość. Potem zmienia geometrię albo
parametry i przebudowuje siatkę.

**Stan wyjściowy.** Odtworzenie w przeglądarce na grupie `fullmag-master` (backend
`0.1.0-dev.20261028.g44dccd0dc40d`, tryb Docker API-only) pokazało, że scenariusz nie
przechodzi. Siatkę udało się zbudować dopiero po siedmiu obejściach przez API i tylko
dla prostopadłościanów. Po pierwszym buildzie nie dało się już zmienić ani geometrii,
ani parametrów siatki.

**Stan po poprawkach.** Cały scenariusz przechodzi z UI na grupie Docker kopii
weryfikacyjnej worktree (`ui-mesh-build-verify-20261028`, port 3310). Szczegóły
w sekcji Weryfikacja.

## Ustalenia

Waga: **B** – blokuje scenariusz, **W** – daje błędny wynik lub wprowadza w błąd,
**N** – utrudnia pracę.

| # | Waga | Objaw w UI | Przyczyna | Status |
|---|---|---|---|---|
| 1 | B | Apply polityki shared-domain kończy się błędem 400 `invalid type: boolean true, expected a string` | `SharedDomainMeshPolicySection` wysyłała `h_max`/`h_min` jako liczby i `optimize` jako bool. Backend (`ScriptBuilderMeshState`) oczekuje `hmax`/`hmin`/`growth_rate` jako tekstu, a `optimize` jako nazwy optymalizatora. Odczyt używał złych kluczy | naprawione, zweryfikowane w UI |
| 2 | B | Build sfery: „Sphere is preview-only for fem” | `geometry.rs` oznaczał `Sphere`/`Ellipsoid` jako preview, choć IR i mesher je obsługują | naprawione dla FEM, zweryfikowane w UI |
| 3 | B | Build bez materiału: „Object references a missing material” | Walidacja geometrii blokowała `build_mesh` bez materiału i magnetyzacji | naprawione (blokują tylko Compute), zweryfikowane |
| 4 | B | Build bez interakcji: `IncompletePhysicsError` | Build renderował pełny skrypt `Problem` | naprawione (ADR 0074), zweryfikowane |
| 5 | B | Build bez etapu study: 422 „no authored source for the StudyPlan” | `mesh_build` tworzył pełny, zaakceptowany StudyPlan | naprawione (ADR 0074), zweryfikowane |
| 6 | B | Universe Auto: „FEM demag requires a conformal shared-domain mesh …” | Planowanie study przed buildem wymagało istniejącej siatki z powietrzem | build nie planuje study; Auto bez paddingu daje czytelny błąd (pytest) |
| 7 | B | Apply Airbox: 409 „changed since revision 0 (current 7)” | Zasób polityki nie był unieważniany przy zmianie sceny, a brudny draft trzymał starą rewizję | naprawione, zweryfikowane w UI |
| 8 | B | Po pierwszym buildzie każda zmiana geometrii lub polityki siatki kończy się 409 `accepted_execution_input_locked`, a Stop jest nieaktywny | Build tworzył run czekający na Compute, który zamrażał wejścia | naprawione (ADR 0074), zweryfikowane w UI |
| 9 | W | Elementy w obiektach ~20–24 nm przy h_max = 10 nm | (a) ścieżka Docker nie przekazywała polityki do top-level `mesh_options`; (b) mesher nie zaciskał ciała bez receptury, gdy `airbox_hmax` > `hmax` | naprawione; (b) pytest, (a) UI: ~2270 tetraedrów na sferę zamiast 88–176 |
| 10 | W | Brak jakości w UI: pusty `/quality`, Latest Success = 0, brak provenance | Ścieżka Docker nie publikowała `mesh_quality_summary` ani historii | naprawione: SICN/gamma w `/quality`, historia, `source_scene_revision` |
| 11 | W | Readiness po buildzie: „Build a current shared-domain mesh” | Skutek pkt 10 | naprawione, zweryfikowane |
| 12 | N | Build: „mesh_revision precondition failed: expected 3, got 4” | Status sesji nie odświeżał się po zmianie siatki | naprawione (status przy zdarzeniu Mesh), zweryfikowane |
| 13 | N | Manifest z `object_id` równym nazwie | Segmenty kluczowane nazwą geometrii | naprawione w ścieżce ADR 0074 (`object_id` z dokumentu sceny) |
| 14 | N | „Mesh editor capabilities 0/8 – fem is not advertised” | Żaden producent nie publikował kluczy pasa (`fem`, `cpu`, `double` …) w zasobie capabilities meshingu | naprawione: API publikuje pas sesji (dyskretyzację zawsze, urządzenie i precyzję po rozwiązaniu); inne pasy pozostają informacyjne |
| 15 | N | „Configure now” w oknie New simulation nie otwiera Inspektora Universe | Powłoka przełącza poddrzewa przy tworzeniu sesji, co przemontowuje dialog i gubi intencję zapisaną w jego stanie | naprawione: intencja zapisana przy ACK poza dialogiem, stosowana w konektorach sesji po potwierdzeniu tożsamości |
| 16 | N | Readiness uznaje interakcje na podstawie `physics_stack`, a renderer skryptu używa `study.exchange_enabled`/`demag_enabled` | Dwa źródła prawdy | otwarte |
| 17 | W | „Element growth rate” = 1,3 kończy build błędem `adjacent_size_growth_exceeded` | `growth_rate` to wskazówka Gmsh, a `_mesh_result_payload` traktował ją jako twardą bramkę (tolerancja 0). Pomiar: max ρ ≈ 2,2–2,6 dla g = 1,3, 1,8 i 3,0, więc każda wartość < ~2,6 odrzucała build | naprawione: raport publikowany jako diagnostyka (`enforced: false`); twarda bramka tylko na żądanie kwalifikacji `enforce_growth_gate`; nota 0105 |
| 18 | B | Build z sekcji Inspektora: „Choose FEM or FDM in Study settings” | Kontekst polecenia w Inspektorze nie miał statusu sesji | naprawione (Shared-Domain i Airbox), zweryfikowane |
| 19 | N | Dialog buildu: „scene_revision precondition failed: expected 4, got 5” | Zasób sceny w dialogu podawał rewizję z cache | naprawione (nowsza z rewizji: zasób sceny albo status), zweryfikowane |
| 20 | B | Druga edycja Airbox blokuje Compute: `scene_document_universe_conflict` | Trasa polityki universe aktualizowała `scene.universe` tylko przy pierwszym zapisie | naprawione, zweryfikowane |
| 21 | B | Compute FEM po buildzie tylko z geometrii: „simulation preparation unavailable” | Frontend wymagał przygotowania, które dawniej powstawało przy buildzie | naprawione: przy braku przygotowania przygotowuje serwer; Compute zakończony |
| 22 | N | Po udanym Apply Inspektory Universe i geometrii nadal zgłaszają niezapisane zmiany | Airbox: draft nie był przebazowany na kanoniczną odpowiedź serwera (np. `authoredConfigPresent`). Geometria: publikacja zatwierdzonej sceny bywa pomijana bez odświeżenia zasobu | naprawione: Airbox przyjmuje odpowiedź jako czystą bazę (zachowując edycje w locie); panel obiektu zawsze unieważnia zasób sceny |
| 23 | N | Polecenie `close` w trybie Docker zostaje w kolejce (`queued`) | Kolejkę opróżnia tylko host CLI, którego tryb API-only nie ma | naprawione: `close` jest jawnie odrzucany (`accepted_control_unsupported`), readiness podaje ten sam powód; UI nie wysyła `close` |
| 24 | N | Dwie sfery z wstążki dostają tę samą nazwę „New sphere”, a build kończy się błędem „Region name 'New sphere' is used by both …” | Nowe obiekty nie dostają unikalnych nazw, a regiony są kluczowane nazwą | otwarte – obejście: zmiana nazwy w Inspektorze |
| 25 | B | Po zapisie polityki siatki edycja obiektu kończy się 409 `scene revision mismatch` (aż do Revert), a build błędem `mesh_revision precondition failed` | Zapis polityki podbija rewizje sceny i siatki bez zdarzenia realtime; brudny draft obiektu nigdy nie był przebazowywany | naprawione: po zapisie polityki odświeżane są scena i status sesji; brudny draft przechodzi na nową rewizję, gdy sam obiekt się nie zmienił |
| 26 | N | `curvature_factor` i `narrow_region_resolution` wpisane w JSON polityki Airbox znikają po zapisie | `ScriptBuilderUniverseState` nie ma tych pól i ich nie odrzuca | otwarte – formularz Airbox ich nie pokazuje |

## Commity

- `664902d6e`, `ccc864c53` – raport audytu.
- `7a8701987` – zacisk rozmiaru ciała w mesherze, nota 0102, test pytest.
- `3da221619` – moduł `fullmag.meshing.geometry_mesh_build` i ADR 0074.
- `49b9caf51` – API: build siatki tylko z geometrii (bez RunIntent), bramki
  authoringu, sfera i elipsoida FEM, pakowanie w planerze, payload w runnerze.
- `cf8bfb283` – synchronizacja `universe` z `study.universe_mesh`.
- `117efbdf4` – format polityki shared-domain i kontekst polecenia w Inspektorze.
- `d7397891f` – aktualne rewizje buildu, rebase Airbox, Compute bez przygotowania.
- `a9fdaad40` – `growth_rate` jako diagnostyka (pkt 17), nota 0105.
- `7e4542361` – punkty 14, 15, 22, 23 i 25.
- kolejny commit – cofnięcie bezwarunkowej inwalidacji sceny w `ObjectGeneralPanel`.
  Dodatkowe pobranie sceny po publikacji potwierdzonej sceny łamało w CI
  `browser-fixture-smoke`: gest przesunięcia w trakcie oczekującego Apply zmieniał
  podgląd. Bisekcja w CI potwierdziła przyczynę. Rebase szkicu z punktu 25 sam
  usuwa konflikt rewizji.

## Weryfikacja

- **pytest** (Python hosta: miniconda, gmsh 4.15.2; nie interpreter zarządzany przez
  repo): `test_shared_domain_body_hmax.py` i `test_geometry_mesh_build.py` przechodzą.
  W `test_meshing.py`, `test_meshing_fallbacks.py`,
  `test_conformal_occ_degenerate_retry_regression.py` i `test_mixed_element_meshing.py`
  przechodzi 602 testów. 9 pada identycznie z poprawką i bez niej (środowisko hosta).
- **Kompilacja Rust:** backend grupy weryfikacyjnej zbudował się z całą zmianą
  (`development: succeeded`, potem restart `iteration: succeeded` po zmianie `mesh.rs`).
  Testów jednostkowych Rust nie kompilowano (obowiązujący zakaz).
- **Frontend:** `tsc --noEmit` na kodzie produkcyjnym (bez plików testów) i ESLint
  `--max-warnings=0` na zmienionych plikach przechodzą w kontenerze `frontend` grupy.
  Testów vitest nie uruchamiano.
- **Przeglądarka (port 3310), krok po kroku:**
  1. Nowa symulacja FEM.
  2. Universe Manual 400×240×240 nm, `airbox_hmax` 30 nm (Apply z Inspektora).
  3. Dwie sfery z wstążki, bez materiałów.
  4. Polityka shared-domain h_max 10 nm, h_min 3 nm, Netgen (zapis i odczyt).
  5. Build z sekcji Inspektora: 12 325 tetraedrów, ~2270 na sferę, SICN p5 0,62,
     segmenty z `object_id`, readiness bez blokady siatki.
  6. Zmiana promienia prawej sfery na 40 nm (bez 409) i rebuild: 1215 elementów.
  7. Zmiana h_max na 20 nm i `airbox_hmax` na 40 nm (200) i rebuild: 336/198 elementów.
  8. Fizyka, etap relax i Compute: `solve` zakończony, 8 kroków.

  Canvas WebGL jest widoczny, kontekst nie jest utracony, bufor rysowania ma 684×449,
  a dialog potwierdził renderowanie nowej rewizji siatki.
- **Druga runda (pkt 14, 15, 17, 22, 23, 25), ta sama grupa po przebudowie backendu:**
  - pytest `scripts/test_fem_quality_typed_dispatch.py`: 29 testów przechodzi; dwie
    sfery z `growth_rate` 1,3, 1,8 i 3,0 budują się i publikują raport wzrostu.
  - `tsc --noEmit` na całym projekcie (z testami) i ESLint na zmienionych plikach
    przechodzą; vitest i testy Rust sprawdza CI.
  - Przeglądarka: nowa symulacja FEM z „Configure now” otwiera Inspektor Universe.
    Apply Airbox, utworzenie dwóch sfer i zmiana promienia kończą się stanem
    „No unapplied changes”. Inspektor siatki pokazuje „3/8 available”. Po zapisie
    polityki zmiana nazwy obiektu przechodzi bez 409, a build z `growth_rate` 1,3
    kończy się stanem `published` (12 461 elementów, SICN p5 0,39, min 0,005).
    `close` zwraca `accepted_control_unsupported`.
- **Środowisko:** grupy pierwotnego worktree nie dało się uruchomić. Najpierw zabrakło
  pul adresów sieci Docker; za zgodą użytkownika usunięto 8 pustych sieci. Potem
  launcher zostawił znacznik aktywnej operacji bez usług. Do weryfikacji użyto
  odłączonej kopii worktree na tym samym commicie z tymi samymi zmianami. Bramkę
  wolnego miejsca launchera (32 GiB) na polecenie użytkownika obniżono lokalnie do
  24 GiB tylko na czas weryfikacji; zmiana nie weszła do commitów.
