# Korekta dokumentacji FDM multilayer convolution — plan implementacji

> **Dla agentów:** plan jest wykonywany inline z kontrolą walidatorów dokumentacji. Wszystkie raporty i dokumenty są po polsku; nazwy symboli, ścieżki i kod pozostają w oryginalnym zapisie.

**Cel:** Uzgodnić kanoniczną notę fizyczną, stronę publiczną i mapy źródeł z aktualnym `master`, pokazując rzeczywiste przykłady `two_d_stack`, `three_d`, `identity`, `push_pull`, supercell i testy z ich zakresem dowodowym.

**Architektura:** Nie zmieniamy solvera ani kontraktu API. Rozdzielamy w dokumentacji teorię Lepadatu/BORIS, obliczeniową supercell FFT, warstwowe siatki native/scratch oraz status dowodu CPU/GPU. Każdy przykład jest przypięty do istniejącego testu lub scenariusza, a brak niezależnego dowodu pozostaje jawnie oznaczony.

**Technologie:** Markdown/MyST, JSON source map, Python scenariusze Fullmag, Rust testy Cargo, walidator `scientific-documentation-contract`.

## Ograniczenia globalne

- Nie zmieniać kodu Rust/CUDA/Python ani semantyki runtime.
- Nie promować żadnego lane'u GPU do `runtime-verified`, `physically-validated` ani `production-qualified` bez zarządzanego dowodu urządzenia.
- Supercell FFT opisywać jako layout obliczeniowy, nigdy jako fizyczny mesh materiałowy.
- Dla nierównych `h_z` odróżnić dowód pair-kernel od braku continuum/native-cell dowodu złożonego `push_pull`.
- Każdy nowy claim w nocie ma mieć `path + symbol` oraz test/evidence w source mapie.

### Zadanie 1: Ustalenie aktualnych dowodów

**Pliki:**
- Odczyt: `crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs`
- Odczyt: `crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs`
- Odczyt: `crates/fullmag-fdm-demag/tests/descriptors.rs`
- Odczyt: `crates/fullmag-engine/src/multilayer.rs`
- Odczyt: `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/`

- [x] Uruchomić testy kernela, deskryptorów, planera i scenariuszy Python.
- [x] Zapisać nazwy testów, wynik oraz zakres dowodu; nie dopisywać liczb, których test nie emituje.

### Zadanie 2: Aktualizacja kanonicznej noty fizycznej

**Pliki:**
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- Modyfikuj: `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`

- [x] Dodać sekcję „Jak czytać supercell” z równaniem liniowego extentu, insertion offset, lag-zero, crop i rozróżnieniem native/scratch.
- [x] Dodać kopiowalne przykłady testowe: pair Newell unequal-Z, kontrola `+z/-z`, 3-D reciprocity, odrzucenie unequal-XY oraz scenariusz `three_d` z `push_pull`.
- [x] Przy każdym przykładzie opisać: co sprawdza, tolerancję/warunek, czego nie dowodzi i jaki lane pozostaje otwarty.
- [x] Skorygować macierz CPU/GPU oraz mapowanie do aktualnego `HEAD` i stabilnych symboli testowych.

### Zadanie 3: Aktualizacja strony publicznej

**Pliki:**
- Modyfikuj: `public_docs/site/physics/interactions/demagnetization/multilayer-convolution.md`
- Modyfikuj: `public_docs/site/physics/interactions/demagnetization/multilayer-convolution.source-map.json`

- [x] Zachować stage-first Python workflow i dodać osobne przykłady: równy `two_d_stack`, pełny `three_d`, nierówne gridy z `push_pull` oraz celowe odrzucenia.
- [x] Opisać supercell na małym przykładzie `[3,2,1]`/`[5,4,1]` z `linear_extent=[7,5,1]`, crop i `physical_mesh=false`.
- [x] Dodać tabelę „test → obserwacja → interpretacja → granica” oraz aktualny status CUDA-assisted/D-07/H2D-D2H.
- [x] Zaktualizować source mapę bez ręcznych linii jako jedynego identyfikatora; bieżące claims wskazują pełny SHA aktualnego `HEAD`, a historyczne źródła zachowują pełny SHA commitów wprowadzających symbole.

### Zadanie 4: Walidacja publikacji

- [x] Uruchomić `validate_scientific_docs.py` dla obu stron i map.
- [x] Uruchomić `validate_changed_scientific_docs.py` względem rodzica `HEAD`.
- [x] Uruchomić public-example guard, testy walidatora i Sphinx strict/rendered HTML, jeśli środowisko udostępnia build.
- [x] Sprawdzić `git diff --check`, status zmian oraz zachowanie istniejącego `external_solvers/3`.
