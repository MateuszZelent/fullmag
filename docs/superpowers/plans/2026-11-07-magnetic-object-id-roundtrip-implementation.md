# Zachowanie object_id magnetyka — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Zachować istniejące immutable object_id przez typowany builder Rust, scenę i nadpisania eksportera.
**Architecture:** Naprawiamy utratę już istniejącego pola publicznego Python/Scene, bez nowego modelu fizyki, ProblemIR lub endpointu. Rust odczytuje opcjonalny klucz object_id, przekazuje ID sceny w obie strony. Istniejący końcowy rewrite override już zachowuje ID i pozostaje bez zmiany. Brak/null w starym builderze zachowuje fallback do name.
**Tech Stack:** Rust serde, fullmag-authoring, istniejące testy API i workflow bootstrap.
**Spec:** [ADR 0024](../../adr/0024-compositional-physics-object-model.md), rozdział Implementation obligations oraz Migration and rollback; istniejący Python runtime/scene_document.py i model/structure.py::Ferromagnet.
**Status:** DO ZATWIERDZENIA; patch wyłącznie przygotowany, nie zastosowany.

## Global Constraints

- Właściwy worktree anten i chronione 63 wpisy indeksu pozostają bez zmian.
- Brak nowego Solve, przygotowania siatki, native buildu, restartu lub zmiany rezerwacji.
- Lokalnie nie kompilować testów Rust. Dozwolona ścieżka kompilacji i testów to wymagane GitHub CI.
- Nie zmieniać źródeł, markerów, receiptów lub wyników GSG. Ten patch nie wdraża nowego shared_domain_mesh_source.
- Nie przełączać writera ProblemIR 0.3 na 0.4 ani dodawać semantyki marker_bindings do publicznego IR.
- Kod, komentarze i commity po angielsku; raport po polsku. Nowy wspólny pakiet pozostaje osobną bramką managed.

## Review Focus

1. Jawne ID różne od nazwy musi przeżyć JSON, oba adaptery i rewrite overrides.
2. Rename przy stałym ID nie może stworzyć nowej tożsamości obiektu.
3. Brak/null legacy zachowuje name fallback; jawnie pusty tekst nie uruchamia fallbacku.
4. Dwa obiekty o różnych nazwach i tym samym ID nadal są odrzucane przez istniejącą walidację sceny.
5. Podregiony zachowują owner_object i region_id; nie przepisujemy referencji po nazwach.

## Potwierdzony problem i granice zgodności

Python SceneObject.id oraz builder dict geometry.object_id już istnieją.
Rust ScriptBuilderGeometryEntry pomija ten klucz; scene_object_from_geometry
odtwarza id z geometry.name. Publiczne rewrite overrides już dopisuje ID
ze sceny po wywołaniu geometry_override_value; nie naprawiamy działającej ścieżki.
To potwierdzenie na podstawie źródeł, nie wykonany jeszcze test Rust.

Pole Rust: object_id: Option<String>, serde default, pomijane przy None.
String oznacza dokładne ID, jednostka 1; nie trimować go i nie naprawiać do
name. Walidacja pustego/niepoprawnego/zdublowanego ID pozostaje u właściciela
sceny. Some(id) wybiera id, None wybiera dotychczasowe name.
Scene→builder zapisuje Some(scene_object.id), także gdy ID jest równe nazwie.
Po takim eksporcie identyfikator jest jawny; nie obiecujemy zachowania
nieobecności klucza, tylko zachowanie tożsamości legacy.
Publiczne rewrite overrides zachowuje dotychczasowe bezwarunkowe dopisanie ID sceny.

Stary Rust ignoruje nieznane object_id w builderze — nie deklarujemy jego
bezpiecznej forward compatibility. Odbiór produkcyjny wymaga spójnego
authoring/API/Python; starego pakietu nie kwalifikuje ten patch. Sama
SceneDocument ma ID już przed poprawką; nie zmieniamy sceny.v2 ani root IR.
FDM CPU/GPU i FEM CPU/GPU używają tego samego adaptera; testy authoringu nie
kwalifikują żadnego solvera. Nie ma nowych parametrów SI lub równań.

## Pliki i dokładny patch

Patch kandydacki: [dokładny diff](2026-11-07-magnetic-object-id-roundtrip.patch).
SHA256: 9cc76ed39ca056413a467eb680bc974cb35a7ba591ea9bcbf68a53d2e64fcef2.
Baza: 4de2e92954ea105f05b55cf2d897ff09d01d234f wraz z niezmienionym WIP.
git apply --check przeszedł. Testów nie skompilowano i patcha nie zastosowano.
Manifest przypina hashe przed/po dla pięciu plików; przed zastosowaniem
trzeba ponownie sprawdzić te hashe. Nie ma zgody na dopasowanie zmienionej bazy
przez automatyczne rozszerzanie zakresu.

| Plik + symbol | Zmiana |
|---|---|
| crates/fullmag-authoring/src/builder.rs::ScriptBuilderGeometryEntry | odczyt istniejącego optional object_id |
| crates/fullmag-authoring/src/adapters.rs::scene_document_to_script_builder | Some(object.id) |
| crates/fullmag-authoring/src/adapters.rs::scene_object_from_geometry | ID z object_id, fallback tylko przy None |
| crates/fullmag-authoring/src/adapters.rs::tests | siedem regresji i uzupełniony sample_builder |
| crates/fullmag-api/src/types.rs::tests::sample_builder | pełny inicjalizator object_id=None |
| crates/fullmag-api/src/router_v2/tests.rs::sample_builder | pełny inicjalizator object_id=None |
| .github/workflows/bootstrap.yml | wykonanie prefiksu magnetic_object_id_ w istniejącym jobie Rust |

## Task 1: Regresja i naprawa utraty ID

**Files:** dokładnie pięć powyższych plików; dokumenty statusu tego etapu.
**Interfaces:** brak zmiany sygnatur adapterów. Nowe pole Rust odzwierciedla
istniejący klucz Python; JSON overrides nadal pochodzi od jednego właściciela.

- [ ] Odtworzyć RED przez CI dla testów z kandydata bez poprawki produkcyjnej; pierwszy test musi wskazać utratę immutable-A na rzecz flower, a nie awarię setupu.
- [ ] Zastosować przypięty patch po ponownym check/hash, zachowując istniejący WIP.
- [ ] Test magnetic_object_id_survives_builder_json_and_both_adapters: JSON object_id=immutable-A, name=flower; ID we wszystkich trzech przejściach identyczne.
- [ ] Test magnetic_object_id_survives_scene_rename: nazwa Renamed sample zmieniona, ID immutable-A stałe także w overrides.
- [ ] Test magnetic_object_id_legacy_absence_and_null_keep_name_fallback: oba wejścia dają dawne ID flower i poprawną scenę.
- [ ] Test magnetic_object_id_does_not_fallback_for_explicit_empty_id: komunikat zawiera scene object ids must not be empty.
- [ ] Test magnetic_object_id_duplicate_is_rejected_despite_different_names: komunikat zawiera duplicate scene object id.
- [ ] Test magnetic_object_id_preserves_existing_owned_region_identity: owner_object i region_id przechodzą bez zmiany.
- [ ] Test magnetic_object_id_preserves_fdm_grid_through_rename: istniejąca mapa per_magnet po name przechodzi na per_object_grid po immutable ID i wraca pod zmienioną nazwą z tym samym cell, bez starego klucza.
- [ ] Uruchomić istniejące CI rust-contracts, w tym nowy prefiks, testy API i regresje execution_intent. Przeczytać cały istotny błąd; nie osłabiać asercji dla zielonego wyniku.
- [ ] Review zakresu i kompatybilności; selektywny commit/push na branch zadania po sprawdzeniu indeksu w osobnym poleceniu. Zachować dokładne 63 wcześniejsze wpisy.
- [ ] Raport: pełne SHA kodu/CI, RED→GREEN, ograniczenia i niewykonany odbiór managed.

Ta naprawa usuwa jeden warunek konieczny dla trwałych powiązań siatki.
Nie dowodzi zachowania domeny GSG przez scenę ani rename-safe interpretacji
markerów w planerze. Te wymagania pozostają w pełnym celu E0–E12.

Pierwszy review usunął zbędny hunk geometry_override_value: jego publiczny caller już dopisuje object_id. Test payloadu pozostaje regresją obecnego poprawnego zachowania, nie potwierdzeniem dawnego błędu w tej ścieżce.

Review v2 wykrył błąd składania pliku patcha (fragmenty kolejnych plików w hunku adapters.rs). V2 nie został zastosowany. V3 usuwa te linie i dodaje konkretne asercje błędów oraz regresję mapowania FDM. Kontrola składni i końcowy review przeszły; CI pozostaje niewykonane.


## Weryfikacja kandydata v3 — bez zastosowania

- git apply --check: PASS na aktualnych źródłach.
- Dokładnie cztery zmienione pliki Rust przeszły parser rustfmt, bez
  kompilacji testów. Kopie diagnostyczne i logi są wyłącznie w prywatnym
  control volume: verification/magnetic-object-id-roundtrip-20261107/proposal-v3/.
- router_v2/tests.rs początkowo odmówił z powodu brakujących child modules w
  izolowanej kopii. Rozważono pełne declared-module dependencies, stdin,
  nightly skip_children i pełne drzewo źródeł. Wybrano jednoplikowy parser
  stdin; zachowano nieudane logi i router-parser-stdin.json. Nie użyto
  maskowania błędów parsera ani zmiany toolchaina. [Rust: moduły i path](https://doc.rust-lang.org/reference/items/modules.html),
  [rustfmt: osobna operacja stdin](https://doc.rust-lang.org/stable/nightly-rustc/rustfmt/enum.Operation.html).
- Końcowy niezależny review v3: brak dalszych wymaganych poprawek.
- Siedem testów Rust: NOT RUN, bez lokalnej kompilacji. Parser i review
  nie są deklaracją GREEN.
- Produkcyjne źródła pięciu plików nadal mają hashe before_sha256 z
  manifest-v3.json. Stare 63 wpisy indeksu pozostają zachowane.

Plan prosi o decyzję wyłącznie o tej poprawce oraz lekkich testach i CI.
Nie obejmuje nowej interpretacji markerów, migracji V04, zarządzanego
buildu/restartu, recovery, zwolnienia rezerwacji lub nowego Solve.
