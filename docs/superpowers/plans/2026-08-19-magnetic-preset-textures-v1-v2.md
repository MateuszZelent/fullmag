# Wersjonowany kontrakt tekstur magnetycznych v1/v2 — plan implementacji

> **For agentic workers:** Wykonuj kroki kolejno, zachowując niezapisane zmiany użytkownika i stosując test-first dla każdej zmiany zachowania.

**Goal:** Naprawić problemy matematyczne, walidacyjne i reprodukowalności tekstur magnetycznych bez zmiany wyników historycznych scen.

**Architecture:** InitialMagnetizationIR::PresetTexture dostaje wersję z domyślnym
1. Istniejący evaluator pozostaje ścieżką v1; nowy evaluator v2 korzysta z
centralnego parsera/validacji, prawoskrętnego frame i pełnej transformacji
wektorowej. Rust jest kanoniczną ścieżką planera, a Python utrzymuje identyczny
kontrakt przez parity tests i nie wykonuje alternatywnego modelu w runtime.

**Tech Stack:** Rust/Serde/Cargo, Python/pytest, TypeScript/React/Vitest,
ProblemIR, SceneDocument, dokumentacja MyST/MathJax i source-map.

## Stan wykonania — 2026-08-19

- [x] Kontrakt preset_version v1/v2, walidacja v2, ramy/projekcje i transformacje.
- [x] Materializacja Rust planera, lowering IR/API, Python DSL/runtime oraz UI/legacy.
- [x] Testy Rust, parity Rust/Python na 1000 punktów na preset, testy Python, UI i typecheck.
- [x] Walidacja source map oraz końcowy rustfmt --check i git diff --check dla zakresu naprawy.
- [ ] Kwalifikacja managed runtime/GPU i pełny browser smoke — lokalny dev-server nie odpowiedział w limicie.

---

## Zadanie 1: Nota fizyczna i kontrakt źródłowy

**Files:**
- Create: docs/physics/0531-versioned-magnetic-preset-textures.md
- Create: docs/physics/0531-versioned-magnetic-preset-textures.source-map.json
- Create: docs/superpowers/specs/2026-08-19-magnetic-preset-textures-v1-v2-design.md
- Create: docs/superpowers/plans/2026-08-19-magnetic-preset-textures-v1-v2.md

- [ ] **Step 1: Opisać fizykę i kontrakt przed kodem**

Nota zawiera labels problem-statement, governing-equations, symbols-and-si-units,
assumptions-and-validity, python-api, problem-ir, round-trip-and-failure-semantics,
discrete-realization, implementation-mapping, validation, limitations,
scientific-bibliography, source-code-index. W tabeli support matrix są osobne
wiersze FEM CPU, FEM GPU, FDM CPU i FDM GPU, a brak kwalifikacji runtime jest
oznaczony jako brak dowodu, nie jako sukces.

- [ ] **Step 2: Zweryfikować source map**

Uruchomić:
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0531-versioned-magnetic-preset-textures.source-map.json --repo-root .
Wynik przed dodaniem nowych symboli może wskazać brak przyszłych anchorów; po Zadaniu
2-6 musi zakończyć się kodem 0.

## Zadanie 2: Wersjonowanie IR i migracja lowering

**Files:**
- Modify: crates/fullmag-ir/src/model.rs:511-531
- Modify: crates/fullmag-authoring/src/scene.rs:1060-1080
- Modify: crates/fullmag-authoring/src/adapters.rs:1907-1920
- Modify: crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs:1009-1085
- Modify: crates/fullmag-plan/src/mesh.rs
- Modify: crates/fullmag-plan/src/fdm.rs
- Test: crates/fullmag-ir/tests/ir_tests.rs
- Test: crates/fullmag-plan/src/tests.rs

- [ ] **Step 1: Napisać failing test deserializacji**

Dodać test, który deserializuje historyczny PresetTexture bez pola
preset_version, asercją otrzymuje 1, oraz testuje JSON z wersją 2.
Dodać test, że autorowanie sceny i lowering API zachowują wersję.

- [ ] **Step 2: Uruchomić RED**

cargo test -p fullmag-ir --test preset_texture_version -- --nocapture oraz
cargo test -p fullmag-plan --test magnetization_textures_v2_contract -- --nocapture.
RED ma wynikać z braku pola lub niedopasowanego konstruktora, nie z błędu fixture.

- [ ] **Step 3: Wprowadzić minimalne IR**

Dodać preset_version: u32 z serde default default_preset_version i funkcję
zwracającą 1. Dodać pole do SceneInitialMagnetization::PresetTexture,
adaptera i initial_magnetization_for_object. Wszystkie match arms przekazują
wersję; historyczne konstruktory zapisują 1.

- [ ] **Step 4: Uruchomić GREEN i regresję**

Uruchomić wskazane testy IR/plannera oraz cargo test -p fullmag-ir.
Każdy dotychczasowy konstruktor bez pola ma jawnie preset_version: 1 albo
używa .., a wynik serializacji nie może zgubić wersji.

## Zadanie 3: Rust evaluator v1/v2, walidacja i frame

**Files:**
- Modify: crates/fullmag-plan/src/magnetization_textures.rs
- Test: crates/fullmag-plan/tests/magnetization_textures_v1_v2.rs
- Modify: crates/fullmag-plan/src/lib.rs tylko dla eksportu publicznych typów, jeśli potrzebne

- [ ] **Step 1: Napisać failing testy matematyczne**

Testy muszą osobno sprawdzić: normalize_checked odrzuca zero/NaN;
xz ma determinant +1; v1 zachowuje aktualne wyniki fixture; v2 vortex
ma m_n(0)=polarity; v2 antivortex ma winding -1; v2 skyrmion ma
zerową składową in-plane w centrum; domain wall ma profil tanh/sech;
helical ma okres 2π/|q|; conical zachowuje normę i iloczyn z osią;
nieortogonalne e1/e2 i zerowy q są błędem; rigid rotation obraca wynik.

- [ ] **Step 2: Uruchomić RED**

cargo test -p fullmag-plan --test magnetization_textures_v1_v2 -- --nocapture
musi zakończyć się oczekiwanymi asercjami brakujących zachowań.

- [ ] **Step 3: Dodać typowany parser i wspólne operacje**

Zastąpić publiczne fallbacki przez TextureError, parse_plane, parse_axis,
parse_sign, parse_positive_finite, normalize_checked, walidację
quaternionu/skali oraz OrientedPlaneFrame. Zachować osobne prywatne helpery v1,
aby nie zmienić starych wyników.

- [ ] **Step 4: Dodać dispatch wersji**

sample_preset_texture bez wersji wywołuje v1 dla kompatybilności.
Wewnętrzna funkcja przyjmuje preset_version i wybiera v1/v2; nieznana
wersja zwraca TextureError::UnsupportedVersion.

- [ ] **Step 5: Zaimplementować minimalne v2**

Wprowadzić regularny vortex/antivortex, skyrmion, domain wall, two-domain,
helical i conical zgodnie z notą 0531. wavevector nie jest normalizowany;
baza spinowa musi być ortonormalna; transformacja rigid obraca wektor po
ewaluacji. Nie dodawać nowych fallbacków ani automatycznej zmiany parametrów.

- [ ] **Step 6: Uruchomić GREEN i regresję**

Uruchomić test pliku, istniejące testy crates/fullmag-plan dotyczące tekstur
i cargo fmt --check tylko dla zmienionych plików. Każdy błąd z testu v1
oznacza powrót do separacji v1/v2, nie osłabienie asercji.

## Zadanie 4: Random i materializacja FDM/FEM

**Files:**
- Modify: crates/fullmag-plan/src/magnetization_textures.rs
- Modify: crates/fullmag-plan/src/mesh.rs
- Modify: crates/fullmag-plan/src/fdm.rs
- Locate/modify: generator generate_random_unit_vectors znaleziony przez rg
- Test: crates/fullmag-plan/tests/magnetization_random_contract.rs

- [ ] **Step 1: Napisać failing tests**

Testy seedów 0, 1, 2^53+1 i punktów identycznych sprawdzają
deterministyczność, różność oraz izotropowy sampler sferyczny. Testy materializacji
sprawdzają, że wersja presetu trafia do obu ścieżek FDM i FEM.

- [ ] **Step 2: Uruchomić RED**

cargo test -p fullmag-plan --test magnetization_random_contract -- --nocapture.
RED musi reprodukować degenerację seed=0 albo brak przekazania wersji.

- [ ] **Step 3: Zaimplementować wspólny integer sampler**

Użyć jawnych operacji u64, wrapping arithmetic i określonego mapowania do
f64; z z∈[-1,1] i φ∈[0,2π) tworzyć jednostkowy wektor. Nie konwertować
seeda do f64 i nie używać cichego seeda 1 po błędzie.

- [ ] **Step 4: Uruchomić GREEN**

Uruchomić test random, testy planera materializujące FDM/FEM oraz diff-check.
Wynik musi być skończony i deterministyczny dla seed=0.

## Zadanie 5: Python DSL, runtime i parity

**Files:**
- Modify: packages/fullmag-py/src/fullmag/init/textures.py
- Modify: packages/fullmag-py/src/fullmag/init/preset_eval.py
- Modify: packages/fullmag-py/src/fullmag/init/magnetization.py
- Modify: packages/fullmag-py/src/fullmag/model/problem.py
- Modify: packages/fullmag-py/src/fullmag/runtime/initial_state.py
- Modify: packages/fullmag-py/src/fullmag/runtime/scene_document.py
- Modify: packages/fullmag-py/src/fullmag/runtime/script_builder.py
- Test: packages/fullmag-py/tests/test_preset_texture_contract_v1_v2.py
- Test: packages/fullmag-py/tests/test_preset_texture_roundtrip.py

- [ ] **Step 1: Napisać failing tests**

Dodać testy konstrukcji preset_version, walidacji każdego publicznego
parametru, historycznego round-trip bez wersji, export/import ze wersją,
runtime błędu oraz parity na co najmniej 1000 deterministycznych punktach dla
każdego presetu i obu wersji tam, gdzie istnieją.

- [ ] **Step 2: Uruchomić RED**

python3 -m pytest packages/fullmag-py/tests/test_preset_texture_contract_v1_v2.py -q
oraz testy round-trip. RED ma potwierdzić brak wersji/kontraktu, nie błąd importu.

- [ ] **Step 3: Dodać wersję i walidację DSL**

PresetTexture.to_ir() zapisuje preset_version; factory methods przyjmują
wersję i nie ukrywają błędnych typów, zerowych osi, nieortogonalnych baz ani
ujemnych długości. Eksport skryptu zachowuje wersję i parametry.

- [ ] **Step 4: Zsynchronizować evaluator i runtime**

Python odwzorowuje te same równania, frame, random hash i błędy co Rust.
prepare_initial_magnetization nie omija wersji ani nie stosuje innej listy
presetów metrycznych. Wszystkie nowe/zmienione pola przechodzą przez
SceneDocument i ProblemIR.

- [ ] **Step 5: Uruchomić GREEN**

python3 -m pytest packages/fullmag-py/tests/test_preset_texture_contract_v1_v2.py packages/fullmag-py/tests/test_preset_texture_roundtrip.py packages/fullmag-py/tests/test_bimeron_textures.py -q
oraz pełny pakiet testów Python, jeśli izolowany przebieg jest zielony.

## Zadanie 6: Control Room, legacy i resource/API hygiene

**Files:**
- Modify: apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts
- Modify: apps/control-room/src/kernel/authoring/magnetization-texture/commands.ts
- Modify: apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts
- Modify: apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx
- Locate/update: all preset_version asset builders under apps/control-room
- Modify: apps/legacy_web/lib/magnetizationPresetCatalog.ts
- Modify: apps/legacy_web/lib/textureTransform.ts
- Test: existing texture catalog/panel/command tests plus new focused version test

- [ ] **Step 1: Napisać failing tests**

Sprawdzić, że nowa komenda tworzy v2, istniejący asset bez/with v1 zachowuje
wersję, panel serializuje preset_version, wszystkie preset IDs mają descriptor
i żaden moduł UI nie buduje endpointu ani bezpośredniego transportu.

- [ ] **Step 2: Uruchomić RED**

pnpm --dir apps/control-room test -- test_preset_texture_contract oraz
pnpm --dir apps/control-room typecheck na testach wersji. W razie braku
skryptu użyć istniejącego runnera ustalonego w package.json, bez zgadywania.

- [ ] **Step 3: Wprowadzić propagację UI**

Nowe assety zapisują v2; odczyt zachowuje wersję; katalogi pokazują poprawne
jednostki i zakresy; błędy walidacji są widoczne jako odrzucenie komendy.
Nie dodawać endpointu, fetch ani drugiej ścieżki synchronizacji.

- [ ] **Step 4: Uruchomić GREEN**

Uruchomić focused tests, pnpm --dir apps/control-room typecheck,
targeted ESLint i istniejące testy legacy dla katalogu/transformacji. Przy
zmianie React wykonać także browser smoke zgodnie z lokalnym skryptem, jeśli
panel jest objęty istniejącą macierzą smoke.

## Zadanie 7: Dokumentacja, parity i kwalifikacja końcowa

**Files:**
- Modify: docs/physics/0531-versioned-magnetic-preset-textures.md
- Modify: docs/physics/0531-versioned-magnetic-preset-textures.source-map.json
- Modify: docs/superpowers/plans/2026-08-19-magnetic-preset-textures-v1-v2.md

- [ ] **Step 1: Przejść walidację dokumentacji**

Uruchomić validator source-map, testy validatorów, public example guard i
Sphinx/rendered HTML tylko dla zmienionej noty, zapisując pełne wyniki.

- [ ] **Step 2: Wykonać cross-layer parity**

Uruchomić Rust tests, Python parity/round-trip, Control Room tests/typecheck,
legacy tests oraz search guard sprawdzający brak starych fallbacków:
normalize([0,0,0]) -> +z, k = normalize(wavevector), ciche defaulty
dla nieznanych osi i brak propagacji preset_version.

- [ ] **Step 3: Sprawdzić diff i stan użytkownika**

Osobno uruchomić git diff --cached --name-only, git status --short,
git diff --check i git diff --stat. Nie stage'ować, nie commitować ani
nie usuwać żadnych zastanych plików.

- [ ] **Step 4: Raportować tylko dowody**

Raport końcowy rozdziela: kod, testy, runtime, browser i GPU. Brak managed
runtime evidence pozostaje jawnie niezakwalifikowany; nie wolno na podstawie
testów źródłowych twierdzić produkcyjnej kwalifikacji solvera.

