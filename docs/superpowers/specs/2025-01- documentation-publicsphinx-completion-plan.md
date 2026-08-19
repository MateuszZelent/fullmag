# Specyfikacja: Kompletacja dokumentacji publicznej Sphinx

> **Status**: w trakcie przeglądu
> **Nadrzędny cel**: Pelna, precyzyjna, oparta na kodzie dokumentacja publiczna Fullmag zgodna z kontraktem dokumentacyjnym

## 1. Cel i zakres

Systematyczne przegladanie i poprawianie dokumentacji publicznej Sphinx (`public_docs/site/`) z naciskiem na:
- Precyzję fizyczną i numeryczną
- Pelne referencje do kodu (brak zgadywania)
- Wyczerpującą dokumentację wszystkich parametrów (tabele, jednostki SI, zakresy)
- Wykonywalne przykłady Python w formacie `# %%` (Jupyter)
- Pełne sekcje mandatory kontraktu dokumentacyjnego (13 sekcji)
- Mapowanie każdego twierdzenia do konkretnego pliku/funkcji w kodzie

## 2. Aktualny stan dokumentacji

```
public_docs/site/
├── 133 stron terminalnych (non-index.md)
├── 74 source-map.json (43% pokrycia)
├── 59 stron bez source-map
├── 8 source-map z błędami walidacji (brak # %% przykładów)
├── 166 status:partial | 2 status:implemented | 1 draft | 1 planned
```

### Struktura działowa

| Dział | Stron terminalnych | Priorytet |
|---|---|---|
| physics/interactions/ | 12 root + 9 subpages | 🔴 Wysoki |
| python-api/interactions/ | 14 | 🔴 Wysoki |
| physics/foundations/ | 7 | 🟡 Średni |
| numerical-methods/ | 22 | 🟡 Średni |
| python-api/studies/ | 5 | 🟡 Średni |
| python-api/problem/ | 4 | 🟡 Średni |
| python-api/runtime/ | 5 | 🟢 Niski |
| python-api/geometry/ | 6 | 🟢 Niski |
| python-api/materials/ | 4 | 🟢 Niski |
| python-api/outputs/ | 6 | 🟢 Niski |
| python-api/dynamics/ | 5 | 🟢 Niski |
| python-api/discretization/ | 7 | 🟢 Niski |
| python-api/boundary-conditions/ | 3 | 🟢 Niski |
| python-api/current-and-excitations/ | 6 | 🟢 Niski |
| python-api/magnets-and-textures/ | 4 | 🟢 Niski |
| architecture/ | 6 | 🟢 Niski |
| validation/ | 5 | 🟡 Średni |
| getting-started/ | 5 | 🟡 Średni |
| physics/geometry-and-materials.md | 1 | 🟡 Średni |

## 3. Kontrakt dokumentacyjny — przypomnienie

Każda **strona terminalna** musi zawierać **13 mandatorych sekcji**:

1. `(section-name)=` — unikalny anchor
2. `# Tytuł` — nagłówek
3. **Problem statement** — co to jest, dlaczego istnieje
4. **Governing equations** — równania w LaTeX z MathJax
5. **Symbols and SI units** — tabela symbol → opis → jednostka
6. **Assumptions and validity limits** — kiedy stosować, granice stosowalności
7. **Python API** — pełna tabela parametrów + przykład `fm.study()`
8. **ProblemIR** — obniżenie do IR (dla interakcji)
9. **Round-trip and failure semantics** — co sie psuje i jak
10. **Discrete realization** — FDM/FEM, CPU/GPU z macierzą statusów
11. **Implementation mapping** — `source-map.json` z referencjami do kodu
12. **Validation** — dowody poprawności, testy, tolerancje
13. **Scientific bibliography** — referencje do literatury
14. **Source code index** — id/path/symbol/responsibility w source-map.json

Dodatkowo dla stron **python-api/**:
- Przykład w formacie `# %%` (Jupyter cells) na początku
- Tabela wszystkich parametrów konstruktora z typami, jednostkami, wartościami domyślnymi
- Sekcja ProblemIR pokazująca obniżenie

## 4. Źródło prawdy i relacja do docs/physics

- `docs/physics/` = wewnętrzna dokumentacja naukowa Fullmag (źródło prawdy)
- `public_docs/site/` = dokumentacja publiczna (musi być zgodna z docs/physics)
- Relacja: `public_docs/site/` używa `source_of_truth: docs/physics/...` we frontmatter
- Jeśli `docs/physics/` strona istnieje i jest kompletna → publiczna strona powinna być kompletna
- Jeśli `docs/physics/` strona nie istnieje → to jest blokator dla kompletacji publicznej

## 5. Macierz backend dla realizacji fizycznych

Każda interakcja/fizyka musi mieć w source-map.json:

```json
{
  "backend_matrix": {
    "fdm_cpu": { "status": "reference|implemented|unsupported|planned|not-qualified", "evidence": "..." },
    "fdm_gpu": { "status": "...", "evidence": "..." },
    "fem_cpu": { "status": "...", "evidence": "..." },
    "fem_gpu": { "status": "...", "evidence": "..." }
  }
}
```

## 6. Błędy walidacji do naprawienia (priorytet natychmiastowy)

8 source-map.json z błędami `page requires a copyable Python example organized with # %% cells`:

1. `python-api/interactions/spin-transfer-torque.source-map.json`
2. `python-api/interactions/magnetoelastic.source-map.json`
3. `python-api/interactions/drift-diffusion-spin-torque.source-map.json`
4. `python-api/interactions/cubic-anisotropy.source-map.json`
5. `python-api/interactions/bulk-dmi.source-map.json`
6. `python-api/interactions/spin-orbit-torque.source-map.json`
7. `python-api/interactions/oersted-field.source-map.json`
8. `python-api/interactions/interfacial-dmi.source-map.json`

Dla każdego: dodać `fm.study(...)` z `# %%` komórkami na początku pliku .md.

## 7. Plan implementacji — priorytetyzacja

### Faza 1: Physyka interakcji — kompletacja (5 dni)

**Cel**: doprowadzić wszystkie 12 root `physics/interactions/X/index.md` do statusu `implemented`

Strony do zrobienia (już mają source-map, trzeba sprawdzić kompletność 13 sekcji):
- ✅ `exchange/index.md` — już kompletny (quality template)
- ⚠️ `zeeman/index.md` — już kompletny
- ⚠️ `demagnetization/index.md` — struktura OK, sprawdzić sekcje
- ⬜ `anisotropy/index.md`, `dmi/index.md`, `thermal-noise/index.md`, `magnetoelastic/index.md`, `oersted-field/index.md`, `spin-transfer-torque/index.md`, `spin-orbit-torque/index.md`, `drift-diffusion-spin-torque/index.md`, `inter-region-couplings/index.md`

Dla każdej strony:
1. Przeczytać obecną treść
2. Sprawdzić które z 13 sekcji mandatorych są obecne
3. Uzupełnić brakujące sekcje
4. Zweryfikować/dodać source-map.json
5. Dodać FDM/FEM/CPU/GPU matrix realization
6. Dodać przykład ProblemIR
7. Zmienić status: partial → implemented
8. Walidować: `python3 validate_scientific_docs.py <source-map.json> --repo-root .`

### Faza 2: Python API interactions — naprawa błędów i kompletacja (3 dni)

**Cel**: naprawić 8 błędów walidacji + uzupełnić brakujące source-mapy + podnieść status

14 plików python-api/interactions/ do zrobienia:
- Te z source-map (10): dodać # %% przykład, uzupełnić sekcje
- Te bez source-map (4): stworzyć source-map, dodać wszystkie sekcje

### Faza 3: physics/foundations + numerical-methods (3 dni)

**Cel**: doprowadzić kluczowe strony do implemented

Priorytety w physics/foundations:
1. `llg-equation.md` — fundamental
2. `effective-field.md` — fundamental
3. `micromagnetic-energy.md` — fundamental
4. `conventions-and-units.md` — fundamental

Priorytety w numerical-methods:
1. `demag-solvers/fdm-convolution.md`
2. `demag-solvers/fem-poisson-airbox.md`
3. `relaxation/llg-relaxation.md`
4. `time-integration/explicit-runge-kutta.md`
5. `meshing/fem-shared-domain.md`

### Faza 4: python-api/studies + python-api/problem + validation (2 dni)

### Faza 5: pozostałe działy (2 dni)

geometry, materials, outputs, dynamics, boundary-conditions, current-and-excitations, magnets-and-textures, architecture, getting-started, runtime

## 8. Kryteria sukcesu (definition of done per strona)

Dla każdej strony terminalnej:

- [ ] Status frontmatter: `status: implemented`
- [ ] Wszystkie 13 sekcji mandatorych są obecne i kompletne
- [ ] Source-map.json istnieje i przechodzi walidację (`python3 validate_scientific_docs.py`)
- [ ] Wszystkie 4 backend lanes (FDM CPU/GPU, FEM CPU/GPU) są udokumentowane z statusem i evidence
- [ ] Tabela parametrów Python ma wszystkie parametry z typami, jednostkami, wartościami domyślnymi
- [ ] Przykład Python na początku strony jest w formacie `# %%` (dla python-api i interakcji)
- [ ] ProblemIR lowering jest pokazany (dla interakcji fizycznych)
- [ ] Scientific bibliography istnieje z prawdziwymi referencjami
- [ ] Żadnych TODO/TBD/FIXME w treści

## 9. Narzędzia i walidacja

### Walidacja pojedynczej strony
```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  public_docs/site/physics/interactions/exchange.source-map.json \
  --repo-root .
```

### Walidacja wszystkich source-map
```bash
for f in $(find public_docs/site -name "*.source-map.json"); do
  python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
    "$f" --repo-root . 2>&1
done
```

### Sprawdzanie statusów
```bash
grep -r "^status: implemented" --include="*.md" public_docs/site/ | wc -l
grep -r "^status: partial" --include="*.md" public_docs/site/ | wc -l
```

## 10. Struktura dokumentacji a źródła kodu

Dla każdej interakcji, kod źródłowy żyje w:

| Interakcja | Kod Rust (crates/) | Kod Python (packages/fullmag-py/) |
|---|---|---|
| Exchange | `fullmag-engine/src/exchange.rs` | `fullmag/_exchange.py` |
| Zeeman | `fullmag-engine/src/zeeman.rs` | `fullmag/_zeeman.py` |
| Demagnetization | `fullmag-fdm-demag/`, `backends/fem/` | `fullmag/_demag.py` |
| Anisotropy | `fullmag-engine/src/anisotropy.rs` | `fullmag/_anisotropy.py` |
| DMI | `fullmag-engine/src/dmi.rs` | `fullmag/_dmi.py` |

ProblemIR definitions: `crates/fullmag-ir/src/`

## 11. Czas szacowany

| Faza | Czas | Stron |
|---|---|---|
| Faza 1: Interakcje fizyczne | 5 dni | 12 root + 9 subpages |
| Faza 2: Python API interactions | 3 dni | 14 |
| Faza 3: Foundations + numerical | 3 dni | ~15 |
| Faza 4: Studies + problem + validation | 2 dni | ~10 |
| Faza 5: Pozostałe | 2 dni | ~30 |
| **Total** | **~15 dni** | **~133** |

## 12. Dependencje i blockery

- **Blocker**: brak `docs/physics/` dla niektórych interakcji (np. spin-orbit-torque, drift-diffusion-spin-torque) — najpierw stworzyć wewnętrzną dokumentację fizyczną, potem publiczną
- **Blocker**: brak implementacji w kodzie dla niektórych interakcji → status `planned` lub `not-qualified` w backend matrix
- **Zależność**: walidator wymaga `source-map.json` → najpierw stworzyć strukturę source-map

## 13. Wytyczne dla agenta (reguły pracy)

1. Nigdy nie zgaduj — jeśli nie ma kodu, napisz `source_of_truth: not yet implemented`
2. Nie używaj `\(` jako delimiterów LaTeX — tylko `$$...$$` lub `\['\[' ` (MyST block math)
3. Wszystkie parametry muszą mieć tabelę: nazwa | typ | domyślna | jednostka SI | opis
4. Przykłady Python muszą być wykonywalne: `fm.study(...).stages.add_*`
5. Nigdy nie używaj `fm.Problem(...)` w publicznych przykładach
6. Dla każdej zmiany: uruchom walidator po zakończeniu
7. Zmieniaj status: partial → implemented dopiero gdy wszystkie 13 sekcji jest kompletnych i walidator przechodzi
8. Jeśli docs/physics/ nie istnieje dla jakiejś interakcji, najpierw stwórz notatkę fizyczną w docs/physics/