# Bimeron i prawoskrętne bazy tekstur — plan implementacji

> Dla agentów: plan należy wykonywać zadanie po zadaniu, z testem RED/GREEN po każdym kroku. Praca jest wykonywana bezpośrednio na master; nie twórz commita bez osobnej prośby użytkownika.

**Cel:** Dodać preset "bimeron" do wspólnego pipeline'u Fullmaga oraz naprawić orientację lokalnej bazy "xz" we wszystkich evaluatorach i powierzchniach, które ją opisują.

**Architektura:** Zachowujemy istniejący ogólny InitialMagnetizationIR::PresetTexture (preset_kind: String, preset_params: BTreeMap<String, Value>). Wspólny kontrakt lokalnej bazy jest prawoskrętny: xy=(x,y,+z), xz=(x,z,-y), yz=(y,z,+x). Bimeron jest osobnym evaluatorem radialnym, a nie aliasem pojedynczego profilu skyrmionu. Python, planner i Control Room serializują identyczne nazwy parametrów.

**Stos technologiczny:** Rust + Cargo (fullmag-plan), Python DSL + pytest, TypeScript/React + Vitest, dokumentacja MyST/MathJax i source map.

## Ograniczenia globalne

- Nie zmieniać istniejących lokalnych zmian w checkoutcie.
- Nie zmieniać enumu InitialMagnetizationIR ani nie dodawać nowego endpointu/OpenAPI.
- Zachować wyniki presetów xy i yz; korygować tylko wspólną orientację xz.
- Parametry fizyczne radius i wall_width są w metrach; helicity_rad jest w radianach.
- radius > 0, wall_width > 0, vorticity ∈ {-1,+1}, background_sign ∈ {-1,+1}.
- Raporty, plany i noty pisać po polsku; nazwy kodowe i komentarze w kodzie pozostają po angielsku.
- apps/legacy_web pozostaje reference-only; zmiany legacy są wyłącznie synchronizacją katalogu i semantyki serializowanego presetu.

---

### Zadanie 1: Nota fizyczna i mapa źródeł

**Pliki:**
- Zmień: docs/physics/0530-magnetic-preset-textures.md
- Utwórz: docs/physics/0530-magnetic-preset-textures.source-map.json
- Istnieje design: docs/superpowers/specs/2026-08-19-bimeron-textures-design.md

**Interfejsy:**
- Nota definiuje równanie bimeronu, lokalne bazy, jednostki, parametry, lane'y FEM/FDM CPU/GPU i dowody.
- Source map wskazuje stabilne symbole: eval_bimeron, bimeron_theta, plane_coords, plane_vec_to_world, texture.bimeron, _bimeron, evaluate_preset_texture oraz testy.

- [ ] **Krok 1: Dopisać sekcje fizyczne przed kodem**

Uzupełnić istniejącą notę o etykiety (problem-statement), (governing-equations), (symbols-and-si-units), (assumptions-and-validity), (python-api), (problem-ir), (round-trip-and-failure-semantics), (discrete-realization), (implementation-mapping), (validation), (limitations), (scientific-bibliography), (source-code-index). Użyć pełnych równań MathJax i tabeli parametrów z walidacją.

- [ ] **Krok 2: Dodać mapę źródeł**

W mapie umieścić macierz czterech lane'ów: FDM CPU, FDM GPU, FEM CPU, FEM GPU — status documented na poziomie wspólnego samplingu, bez twierdzenia o kwalifikacji GPU. Każde równanie i parametr musi mieć źródło path + symbol.

- [ ] **Krok 3: Zweryfikować strukturę noty**

Uruchomić:

~~~bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0530-magnetic-preset-textures.source-map.json --repo-root .
~~~

Oczekiwany wynik: validator nie zgłasza brakujących etykiet, symboli, źródeł ani mapowania parametrów. Jeżeli validator wymaga dokładnej nazwy symbolu, poprawić dokumentację przed przejściem do kodu.

---

### Zadanie 2: Rust planner — RED/GREEN dla bimeronu i xz

**Pliki:**
- Zmień: crates/fullmag-plan/src/magnetization_textures.rs
- Test: crates/fullmag-plan/src/magnetization_textures.rs (mod tests)

**Interfejsy:**
- fn bimeron_theta(radius: f64, r: f64, wall_width: f64) -> f64
- fn eval_bimeron(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], String>
- Dispatcher eval_preset("bimeron", params, point).
- Wspólna baza: plane_coords([x,y,z], "xz") == [x,z,-y]; plane_vec_to_world(mu,mv,mn,"xz") == [mu,-mn,mv].

- [ ] **Krok 1: Napisać failing testy Rust**

Dodać testy, które wołają sample_preset_texture:

~~~rust
#[test]
fn bimeron_has_in_plane_background_and_opposite_meron_cores() {
    let values = sample_preset_texture("bimeron", &params, &mapping, &transform, &points)?;
    assert!(values[0][0] < -0.999);
    assert!(values[1][0] > 0.999);
    assert!(values[2][2] < -0.99);
    assert!(values[3][2] > 0.99);
    assert!(values.iter().all(|value| (norm(*value) - 1.0).abs() < 1e-12));
}

#[test]
fn bimeron_rejects_non_positive_dimensions_and_invalid_signs() {
    for (key, value) in [("radius", 0.0), ("wall_width", 0.0), ("vorticity", 0.0), ("background_sign", 2.0)] {
        let mut invalid = params.clone();
        invalid.insert(key.to_string(), Value::from(value));
        assert!(sample_preset_texture("bimeron", &invalid, &mapping, &transform, &points).is_err());
    }
}

#[test]
fn xz_plane_uses_right_handed_normal_for_plane_aware_textures() {
    let value = sample_preset_texture("bloch_skyrmion", &xz_params, &mapping, &transform, &points)?[0];
    assert!(value[1] < -0.99);
}
~~~

Test centrum ma wymagać m_x < -0.999, dalekiego pola m_x > 0.999, rdzeni m_z < -0.99 i m_z > 0.99; test xz ma weryfikować normalną -y, a nie tylko normę.

- [ ] **Krok 2: Uruchomić RED**

Uruchomić:

~~~bash
cargo test -p fullmag-plan bimeron -- --nocapture
~~~

Oczekiwany wynik: test nie przechodzi, bo dispatcher nie zna bimeron, a obecny helper xz zwraca normalną +y. Błąd kompilacji testu oznacza błąd testu i należy go naprawić przed implementacją.

- [ ] **Krok 3: Wprowadzić minimalną implementację GREEN**

Zastąpić tylko mapowanie xz, dodać stabilny profil:

~~~rust
((r - radius) / width).tanh().asin()
    + ((r + radius) / width).tanh().asin()
~~~

W eval_bimeron parsować plane, radius, wall_width, vorticity, helicity_rad i background_sign; odrzucać niepoprawne wartości, obliczyć komponenty lokalne oraz zwrócić normalize(plane_vec_to_world(mu, mv, mn, plane)). Dodać "bimeron" => eval_bimeron(params, point).

- [ ] **Krok 4: Uruchomić GREEN i regresję Rust**

Uruchomić:

~~~bash
cargo fmt --all -- --check
cargo test -p fullmag-plan magnetization_textures -- --nocapture
~~~

Oczekiwany wynik: wszystkie testy modułu przechodzą, a testy istniejących vortexów/skyrmionów w xy zachowują dotychczasowe kierunki.

---

### Zadanie 3: Publiczny Python DSL i evaluator referencyjny

**Pliki:**
- Zmień: packages/fullmag-py/src/fullmag/init/textures.py
- Zmień: packages/fullmag-py/src/fullmag/init/preset_eval.py
- Zmień: packages/fullmag-py/src/fullmag/runtime/initial_state.py
- Test: packages/fullmag-py/tests/test_preset_texture_roundtrip.py

**Interfejsy:**
- texture.bimeron(radius, wall_width, vorticity=1, helicity_rad=0.0, background_sign=1, plane="xy") -> PresetTexture.
- _bimeron(point, params) -> Vec3 i dispatch w evaluate_preset_texture.
- _plane_coords/_plane_vec_to_world mają identyczną bazę jak Rust.

- [ ] **Krok 1: Napisać failing testy Python**

Dodać test serializacji i test próbkowania:

~~~python
def test_bimeron_factory_roundtrip():
    preset = texture.bimeron(5e-9, 2e-9, -1, 0.25, -1, "xz")
    ir = preset.to_ir()
    assert ir["preset_kind"] == "bimeron"
    assert ir["preset_params"] == {
        "plane": "xz",
        "radius": 5e-9,
        "wall_width": 2e-9,
        "vorticity": -1,
        "helicity_rad": 0.25,
        "background_sign": -1,
    }

def test_bimeron_profile_and_xz_basis_are_stable():
    values = evaluate_preset_texture("bimeron", params, points)
    assert values[0][0] < -0.999
    assert values[1][0] > 0.999
    assert values[2][2] < -0.99
    assert values[3][2] > 0.99
    assert all(abs(sum(component * component for component in value) - 1.0) < 1e-12 for value in values)
~~~

Testy mają również odrzucać radius=0, wall_width<=0, vorticity=0 i background_sign=2, oraz próbkować wall_width=1e-300 bez OverflowError/nan.

- [ ] **Krok 2: Uruchomić RED**

Uruchomić:

~~~bash
pytest -q packages/fullmag-py/tests/test_preset_texture_roundtrip.py -k bimeron
~~~

Oczekiwany wynik: fail z powodu braku fabryki i dispatchera oraz różnicy bazy xz.

- [ ] **Krok 3: Wprowadzić minimalny kod Python**

Dodać factory z nazwami parametrów zgodnymi z Rustem, stabilny _bimeron, dispatcher oraz bimeron do _METRIC_ANALYTIC_PRESETS. Nie zmieniać publicznego eksportu texture, bo namespace jest już eksportowany.

- [ ] **Krok 4: Uruchomić GREEN i round-trip**

Uruchomić:

~~~bash
pytest -q packages/fullmag-py/tests/test_preset_texture_roundtrip.py
~~~

Oczekiwany wynik: cały istniejący kontrakt round-trip i nowe testy przechodzą.

---

### Zadanie 4: Control Room v2 — katalog, draft, panel i komenda

**Pliki:**
- Zmień: apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts
- Zmień: apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts
- Zmień: apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx
- Zmień: apps/control-room/src/kernel/authoring/magnetization-texture/commands.ts
- Test: apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts
- Test: apps/control-room/src/shared/domain/magnetization-texture/draftModel.test.ts lub test katalogu, jeśli istniejący wzorzec tego wymaga

**Interfejsy:**
- MagnetizationTexturePresetId zawiera "bimeron".
- Draft zawiera vorticity, helicity_rad, background_sign jako stringi kontrolki.
- presetParamsFromDraft("bimeron", draft) zwraca dokładnie { plane, radius, wall_width, vorticity, helicity_rad, background_sign }.
- Command registry ma magnetization-texture.assign-bimeron z domyślnymi parametrami.

- [ ] **Krok 1: Napisać failing testy TypeScript**

Dodać test sprawdzający zmianę presetu oraz asset:

~~~typescript
it("builds a bimeron asset with metric and handedness parameters", () => {
  const patch = objectMagneticTexturePresetChangePatch(model, draft, "bimeron");
  const next = { ...draft, ...patch, presetKind: "bimeron" as const };
  expect(buildObjectMagneticTextureAssetDraft(model, next).preset_params).toEqual({
    plane: "xy",
    radius: 10e-9,
    wall_width: 2e-9,
    vorticity: 1,
    helicity_rad: 0,
    background_sign: 1,
  });
});
~~~

Test katalogu/command registry ma sprawdzać obecność bimeron i domyślne parametry.

- [ ] **Krok 2: Uruchomić RED**

Uruchomić:

~~~bash
pnpm --dir apps/control-room test -- ObjectMagneticTexturePanelModel
~~~

Oczekiwany wynik: fail typów lub brakującego wariantu bimeron.

- [ ] **Krok 3: Wprowadzić minimalne zmiany draftu i UI**

Dodać pola draftu, domyślne wartości, serializację, label, katalog Bimeron, sekcję parametrów panelu oraz komendę assign. Użyć istniejących DraftNumberField, PlaneSelect i kontrolek wyboru; nie tworzyć nowego transportu ani własnego widgetu.

- [ ] **Krok 4: Uruchomić GREEN i typecheck**

Uruchomić:

~~~bash
pnpm --dir apps/control-room test -- ObjectMagneticTexturePanelModel
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany wynik: test panelu i typecheck przechodzą, bez ręcznie budowanych endpointów i bez importu z modułów sąsiednich.

---

### Zadanie 5: Legacy metadata i metryczne dopasowanie

**Pliki:**
- Zmień: apps/legacy_web/lib/magnetizationPresetCatalog.ts
- Zmień: apps/legacy_web/lib/textureTransform.ts
- Zmień: apps/legacy_web/features/interaction/model/magnetization.ts tylko jeśli kompilator wykaże osobną kopię unii
- Test: apps/legacy_web/features/viewport-fem/model/__tests__/textureTransform.test.ts

**Interfejsy:**
- MagneticPresetKind i METRIC_ANALYTIC_PRESETS zawierają bimeron.
- textureScaleSemantics("bimeron") === "identity_metric".
- fitPresetParamsToBounds("bimeron", ...) ustawia radius i wall_width na metryczne proporcje geometrii, pozostawiając skalę transformacji równą jeden.

- [ ] **Krok 1: Napisać failing test legacy semantyki**

Dodać asercję identity_metric i dopasowania radius/wall_width dla bimeronu.

- [ ] **Krok 2: Uruchomić RED**

Uruchomić istniejący test transformacji legacy. Oczekiwany wynik: bimeron jest rozpoznawany jako size_multiplier albo nie ma dopasowania parametrów.

- [ ] **Krok 3: Wprowadzić tylko metadata compatibility**

Dodać descriptor bimeronu do katalogu oraz przypadek w fitPresetParamsToBounds; nie dodawać nowej legacy-only ścieżki menu ani endpointu.

- [ ] **Krok 4: Uruchomić GREEN**

Uruchomić test transformacji oraz dostępny typecheck legacy. Oczekiwany wynik: nowe i istniejące testy przechodzą.

---

### Zadanie 6: Weryfikacja dokumentacji, kontraktów i całego diffu

**Pliki:**
- Testy dokumentacji: validator scientific docs i testy validatora
- Diff: wszystkie pliki z zadań 1–5

- [ ] **Krok 1: Uruchomić walidację dokumentacji**

~~~bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0530-magnetic-preset-textures.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
~~~

- [ ] **Krok 2: Uruchomić testy skupione wszystkich warstw**

~~~bash
cargo fmt --all -- --check
cargo test -p fullmag-plan magnetization_textures
pytest -q packages/fullmag-py/tests/test_preset_texture_roundtrip.py
pnpm --dir apps/control-room typecheck
~~~

- [ ] **Krok 3: Sprawdzić kontrakty architektoniczne**

Wykonać wyszukiwania:

~~~bash
rg "from ['\"]\\.\\./" apps/control-room/src/modules
rg "fetch\\(" apps/control-room/src
rg "apps/web|ControlRoomContext|normalizeSession|mergeSession" apps/control-room/src
~~~

Ocena: zmiana nie dodaje importów między modułami, transport pozostaje w fasadzie/resource layer, a apps/legacy_web pozostaje tylko referencją.

- [ ] **Krok 4: Obejrzeć diff i status**

~~~bash
git diff --check
git diff --stat
git status --short
~~~

Zweryfikować, że zmienione są tylko pliki celu i nowe dokumenty, a wcześniejsze lokalne modyfikacje nadal mają ten sam status. Nie tworzyć commita.

