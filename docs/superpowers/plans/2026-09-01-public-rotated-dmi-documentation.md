# Public Rotated Interfacial DMI Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opublikować `Rotated interfacial DMI` jako trzeci równorzędny wariant DMI i dołączyć reprodukowalną figurę walidacyjną Göbel 2019.

**Architecture:** Nowa terminalna strona jest jedynym właścicielem równań, API, ProblemIR i macierzy backendów. Indeks DMI zapewnia kolejność `interfacial`, `bulk`, `rotated-interfacial`, a strona walidacji zawiera wyłącznie skrócony wynik i odsyłacz. Figura jest deterministycznie renderowana z istniejącego artefaktu i raportu weryfikacji przez osobny skrypt.

**Tech Stack:** MyST/Sphinx 8, `sphinx-design`, JSON source maps, Python 3.12, NumPy, Matplotlib, pytest/unittest.

## Global Constraints

- Publiczne treści trafiają wyłącznie do `public_docs/site/`.
- Równania używają `$...$` i etykietowanych bloków `{math}`.
- Każda linia FDM CPU, FDM GPU, FEM CPU i FEM GPU ma osobny status implementacji i kwalifikacji.
- Tylko FDM CUDA FP64 może otrzymać status wykonanej reprodukcji Göbel 2019.
- Przykład Python jest stage-first i nie używa `fm.Problem(...)`.
- Obraz nie zastępuje raportu Berg–Lüschera ani receipt runtime.

---

### Task 1: Trzeci właściciel fizyki DMI

**Files:**
- Create: `public_docs/site/physics/interactions/dmi/rotated-interfacial.md`
- Create: `public_docs/site/physics/interactions/dmi/rotated-interfacial.source-map.json`
- Modify: `public_docs/site/physics/interactions/dmi/index.md`
- Modify: `public_docs/site/physics/interactions/dmi/validation.md`
- Modify: `public_docs/site/physics/interactions/dmi/validation.source-map.json`

**Interfaces:**
- Consumes: `fullmag.RotatedInterfacialDMI(D: float)`, `kind=rotated_interfacial_dmi`, scenariusz `tests/standard_problems/bimeron/goebel_2019/scenario_fdm.py`.
- Produces: etykietę `public-docs-physics-interactions-dmi-rotated-interfacial` i terminalną publiczną stronę scientific-docs.

- [ ] **Step 1: Dodać stronę do toctree jako trzeci wariant**

W `dmi/index.md` ustawić kolejność:

```text
interfacial
bulk
rotated-interfacial
boundary-conditions
validation
```

- [ ] **Step 2: Napisać stronę właścicielską**

Użyć wszystkich obowiązkowych etykiet kontraktu strony. Pokazać dokładne równania energii, pola i warunku brzegowego, tabelę symboli, `RotatedInterfacialDMI(D=3.0e-3)`, kompletny scenariusz `fm.study(...).stages`, JSON IR, cztery realizacje backendowe, obserwable, wynik Göbel 2019, ograniczenia i bibliografię.

- [ ] **Step 3: Utworzyć kompletny source map**

Powiązać równania i twierdzenia co najmniej z symbolami `class RotatedInterfacialDMI`, `rotated_interfacial_dmi_field`, `rotated_interfacial_dmi_energy_from_vectors`, `plan_fdm`, `plan_fem`, `dmi_accumulate_rotated_interfacial_residual`, kernelami CUDA i `verify.py`.

- [ ] **Step 4: Dodać skrócony wpis do strony walidacji**

Wpis ma podać urządzenie, FP64, 15/15, wartości $Q$ i zakres `FDM CUDA only`, po czym odsyłać do strony właścicielskiej bez kopiowania równań.

- [ ] **Step 5: Uruchomić walidację źródłową**

Run:

```powershell
python .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py public_docs/site/physics/interactions/dmi/rotated-interfacial.source-map.json --repo-root .
```

Expected: exit 0.

### Task 2: Reprodukowalna figura Göbel 2019

**Files:**
- Create: `scripts/render_goebel_2019_bimeron_figure.py`
- Create: `scripts/test_render_goebel_2019_bimeron_figure.py`
- Create: `public_docs/site/_static/images/validation/goebel-2019-rotated-dmi-bimeron.png`
- Modify: `public_docs/site/physics/interactions/dmi/rotated-interfacial.md`

**Interfaces:**
- Consumes: `scenario_fdm.zarr`, runtime verification JSON, `render_figure(bundle: Path, verification: Path, output: Path) -> None`.
- Produces: PNG z trzema stanami i jednym powiększeniem, osadzony przez MyST `{figure}`.

- [ ] **Step 1: Napisać test wejść i wymiaru obrazu**

Test tworzy minimalne trzy stany JSON, raport metryk, wywołuje `render_figure`, sprawdza PNG, rozmiar co najmniej `2400x1400` i błąd dla brakującego stanu.

- [ ] **Step 2: Potwierdzić RED**

Run:

```powershell
python -m unittest scripts/test_render_goebel_2019_bimeron_figure.py -v
```

Expected: FAIL, brak modułu/funkcji renderującej.

- [ ] **Step 3: Zaimplementować renderer**

Renderer odczytuje `stage_00_flat_relax/m_initial.json`, `stage_00_flat_relax/m_final.json` i `stage_02_flat_run/m_final.json`, waliduje `1000x80x1`, używa jednej skali `m_z`, dodaje wektory końcowego $(m_x,m_y)$ oraz metryki z raportu.

- [ ] **Step 4: Potwierdzić GREEN i wyrenderować artefakt publiczny**

Run:

```powershell
python -m unittest scripts/test_render_goebel_2019_bimeron_figure.py -v
python scripts/render_goebel_2019_bimeron_figure.py --bundle tests/standard_problems/bimeron/goebel_2019/scenario_fdm.zarr --verification C:/fullmag-build/rotated-dmi-native/qualification/goebel-2019-fdm-gpu-final-verification.json --output public_docs/site/_static/images/validation/goebel-2019-rotated-dmi-bimeron.png
```

Expected: test PASS i zapisany PNG.

- [ ] **Step 5: Obejrzeć figurę**

Sprawdzić czytelność trzech etapów, wspólną skalę, podpisy, brak nachodzących strzałek i zgodność metryk z JSON.

### Task 3: Publiczny gate dokumentacji

**Files:**
- Test: `.agents/skills/scientific-documentation-contract/scripts/test_*.py`
- Test: `scripts/test_public_docs_information_architecture.py`
- Test: `scripts/test_check_public_doc_examples.py`
- Build output: `D:/fullmag-build/rotated-dmi-public-docs-html`

**Interfaces:**
- Consumes: wszystkie pliki z Task 1–2.
- Produces: ostrzeżeniowo czysty HTML i zweryfikowany render strony.

- [ ] **Step 1: Uruchomić walidatory kontraktowe**

Run validator unit tests, information architecture check, public example guard oraz `validate_changed_scientific_docs.py --base e46c18b1f3415b8c38a2d8c8bf4afa1a439cbdcf --head HEAD --repo-root .`.

Expected: wszystkie procesy exit 0.

- [ ] **Step 2: Zbudować Sphinx poza repozytorium**

Run:

```powershell
sphinx-build -b html -W -n --keep-going public_docs/site D:/fullmag-build/rotated-dmi-public-docs-html
```

Expected: build succeeded, no warnings.

- [ ] **Step 3: Zweryfikować HTML strony terminalnej**

Run `validate_scientific_docs.py` z `--rendered-html D:/fullmag-build/rotated-dmi-public-docs-html/physics/interactions/dmi/rotated-interfacial.html`.

Expected: exit 0, równania jako MathJax i bloki kodu z kontrolką kopiowania.

- [ ] **Step 4: Sprawdzić diff i stan gałęzi**

Run `git diff --check`, `git diff --cached --name-only`, `git status --short` i przegląd zmienionych plików. Nie stage'ować plików spoza zakresu.

- [ ] **Step 5: Zacommitować publiczną dokumentację**

Commit message:

```text
docs: publish rotated interfacial DMI validation
```
