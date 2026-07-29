# Architektura profesjonalnej dokumentacji FullMag

> **Status dokumentu:** docelowa architektura i plan wdrożenia portalu dokumentacji.  
> **Zakres:** dokumentacja użytkownika, fizyki, numerics, API, deweloperska, GUI i proces publikacji.  
> **Charakter:** plan normatywny; opisy narzędzi i etapów wdrożenia nie oznaczają, że dana integracja już istnieje w repozytorium.

## Jak czytać ten dokument

Ten dokument definiuje, jak FullMag ma zarządzać dokumentacją jako częścią produktu. Nie zastępuje
specyfikacji fizycznych, ADR-ów ani kontraktów API. Rozstrzyganie konfliktów odbywa się według
następującej hierarchii:

1. `docs/physics/` — prawda naukowa: równania, jednostki, założenia i zakres ważności.
2. `docs/specs/` oraz `docs/adr/` — prawda architektoniczna, kontrakty i decyzje długoterminowe.
3. `AGENTS.md` — zasady pracy w repozytorium i wymagania operacyjne.
4. Kod źródłowy i testy — aktualny stan implementacji.
5. Ten dokument — sposób budowania, organizowania i publikowania portalu.

Jeżeli dokumentacja publiczna opisuje zachowanie, którego nie potwierdza kod, test lub jawny kontrakt,
strona musi oznaczyć je jako `planned`, `experimental` albo `not qualified`. Nie wolno przedstawiać
planowanej funkcji jako dostępnej.

## Stan obecny a stan docelowy

Stan docelowy zakłada jeden portal Sphinx/MyST, ale repozytorium jest monorepo z istniejącymi
specyfikacjami, physics notes, ADR-ami, planami, audytami, pakietem Python, crate'ami Rust,
backendami `backends/fdm` i `backends/fem` oraz aplikacją `apps/control-room`. Migracja musi więc
być inkrementalna:

| Obszar | Źródło prawdy dziś | Docelowa powierzchnia | Status w portalu |
|---|---|---|---|
| Fizyka | `docs/physics/` | `docs/source/physics/` | przenoszenie z zachowaniem autorstwa i cytowań |
| Architektura | `docs/specs/`, `docs/adr/`, `docs/architecture/` | `docs/source/developer/` | indeksowane, bez kopiowania treści |
| Python DSL | `packages/fullmag-py/` i `crates/fullmag-py-core/` | `docs/source/api/python/` | generowane z kodu |
| REST/API v2 | OpenAPI oraz kontrakty sesji/resource-first | `docs/source/api/rest/` | generowane i lintowane |
| Backend FDM/FEM | `backends/fdm/`, `backends/fem/` | `docs/source/numerics/` + referencja deweloperska | dokumentacja z kwalifikacją runtime |
| Control Room | `apps/control-room/` | `docs/source/user-guide/` + `developer/` | scenariusze Cypress i referencja wybranych interfejsów |
| Plany i audyty | `docs/plans/`, `docs/audits/`, `docs/diagnostics/`, `docs/reports/` | `docs/internal/` | poza publiczną nawigacją |

W okresie przejściowym portal może linkować do istniejących plików repozytorium. Nie wolno tworzyć
drugiej, ręcznie utrzymywanej kopii tej samej specyfikacji bez wskazania właściciela i reguły
aktualizacji.

## Rekomendacja

Dla **FullMag** rekomendowanym rozwiązaniem jest następujący stos:

> **Sphinx + MyST Parser + PyData Sphinx Theme** jako główny portal dokumentacji, uzupełniony przez **Sphinx-Gallery**, natywne generatory API dla poszczególnych języków, **Cypress** do dokumentowania interfejsu oraz **GitHub Pages + GitHub Actions** jako pierwszy kanał publikacji. Read the Docs pozostaje opcjonalnym kanałem dla stabilnych wersji i PDF.

Nie należy szukać jednego generatora, który sam udokumentuje Python, Rust, TypeScript, C++/CUDA, REST API, fizykę, przykłady i GUI. Lepszym rozwiązaniem jest **jeden spójny portal**, do którego poszczególne warstwy dostarczają treść ze swoich właściwych źródeł.

FullMag jest wielojęzykowym projektem z pakietem Pythona, warstwą Rust, aplikacją TypeScript/React, kodem natywnym i rozbudowaną dokumentacją naukową. Obecny katalog `docs/` powinien zostać uporządkowany tak, aby oddzielić dokumentację publiczną od planów, audytów, raportów i materiałów wewnętrznych.

Sphinx jest właściwym rdzeniem, ponieważ jego model dokumentacji opiera się na semantycznych odwołaniach do funkcji, klas, równań, tabel, sekcji, terminów i obiektów zewnętrznych. Pozwala również generować HTML, PDF i inne formaty. MyST Parser umożliwia pisanie dokumentacji w Markdown zamiast w reStructuredText.

---

# Proponowany stos technologiczny

| Warstwa | Narzędzie | Rola w FullMag |
|---|---|---|
| Główny generator | **Sphinx** | Nawigacja, indeksy, odwołania, wersje, HTML i PDF |
| Format źródłowy | **MyST Parser** | Markdown z równaniami, dyrektywami i referencjami |
| Wygląd | **PyData Sphinx Theme** | Nowoczesny, responsywny portal naukowo-techniczny |
| Komponenty UI dokumentacji | **Sphinx Design** | Karty, zakładki, gridy, statusy i callouty |
| Przykłady Pythona | **Sphinx-Gallery** | Wykonywanie skryptów, galerie, wyniki, wykresy i pliki `.ipynb` |
| Linki przykład → API | **Sphinx-Gallery backreferences** i opcjonalnie `sphinx-codeautolink` | Klikalne symbole i lista przykładów używających danej funkcji |
| Dokumentacja fizyki | **MathJax + sphinxcontrib-bibtex** | Równania, numeracja, BibTeX, cytowania i bibliografia |
| Publiczne API Pythona | **autodoc + autosummary + Napoleon + linkcode** | Sygnatury, docstringi, indeks API i linki do GitHuba |
| C++/CUDA | **Doxygen + Breathe** | Włączenie wybranej dokumentacji natywnej do Sphinx |
| TypeScript | **Sphinx-JS wykorzystujący TypeDoc** | Dokumentacja stabilnych interfejsów TypeScript w tym samym portalu |
| Rust | **rustdoc** | Pełna referencja deweloperska dla crate'ów |
| REST API | **OpenAPI + Redocly CLI** | Automatyczna dokumentacja endpointów i modeli danych |
| GUI i instrukcje | **Cypress** | Powtarzalne scenariusze oraz automatyczne zrzuty ekranu |
| Publikacja | **GitHub Pages** | Pierwszy publiczny portal, deployment z GitHub Actions i preview pull requestów |
| Wersje naukowe | **Read the Docs** | Opcjonalne aliasy stable/latest, wersje tagowane i redagowane PDF |
| Kontrola jakości | **GitHub Actions** | Budowanie, wykonywanie przykładów, testy linków i walidacja dokumentacji |

Sphinx-Gallery jest szczególnie dobrze dopasowany do FullMag: wykonuje skrypty `.py`, przechwytuje tekst, błędy, wykresy i inne wyniki, generuje stronę galerii oraz pliki skryptu i notebooka do pobrania. Potrafi także tworzyć odwrotne odwołania z API do przykładów używających konkretnego obiektu.

Dla TypeScript można użyć Sphinx-JS, który wykorzystuje TypeDoc. Dzięki temu wybrane publiczne interfejsy TypeScript mogą mieć ten sam wygląd i nawigację co pozostała dokumentacja. Dla C++ i CUDA naturalnym mostem jest Doxygen z Breathe. Pełną dokumentację Rust najlepiej pozostawić w rustdoc, ponieważ najlepiej obsługuje semantykę języka, linki między symbolami i doctesty.

## Ważne rozróżnienie rodzajów API

Nie wszystkie API powinny mieć równą widoczność.

### API publiczne

- Python DSL,
- format konfiguracji,
- REST API,
- interfejs uruchamiania symulacji,
- formaty wejścia i wyjścia,
- publiczne klasy i modele danych.

### API rozszerzeń

- interfejsy do dodawania solverów,
- interfejsy do implementowania nowych składników energii,
- geometrie,
- backendy obliczeniowe,
- eksportery i analizatory wyników.

### API wewnętrzne

- crate'y Rust,
- komponenty React,
- implementacje CUDA,
- kod infrastrukturalny,
- mechanizmy cache,
- wewnętrzne warstwy komunikacji.

Publiczny użytkownik nie powinien widzieć w głównej nawigacji tysięcy wewnętrznych funkcji Rust czy komponentów React. Pełne referencje mogą istnieć, ale powinny być umieszczone w sekcji **Developer Reference**.

---

# Docelowa architektura informacji

Proponowana struktura katalogu dokumentacji:

```text
docs/
├── source/
│   ├── index.md
│   │
│   ├── getting-started/
│   │   ├── installation.md
│   │   ├── first-simulation.md
│   │   └── concepts.md
│   │
│   ├── user-guide/
│   │   ├── geometry.md
│   │   ├── materials.md
│   │   ├── initial-states.md
│   │   ├── studies.md
│   │   ├── visualization.md
│   │   └── exporting-results.md
│   │
│   ├── workflows/
│   │   ├── relaxation.md
│   │   ├── time-domain.md
│   │   ├── frequency-domain.md
│   │   ├── eigenmodes.md
│   │   └── parameter-sweeps.md
│   │
│   ├── examples/
│   │   ├── basic/
│   │   ├── advanced/
│   │   └── benchmarks/
│   │
│   ├── physics/
│   │   ├── conventions-and-units.md
│   │   ├── llg.md
│   │   ├── exchange.md
│   │   ├── demagnetization.md
│   │   ├── anisotropy.md
│   │   ├── dmi.md
│   │   ├── spin-torques.md
│   │   └── magnetoelasticity.md
│   │
│   ├── numerics/
│   │   ├── fdm/
│   │   ├── fem/
│   │   ├── time-integrators/
│   │   ├── eigensolvers/
│   │   └── frequency-domain/
│   │
│   ├── validation/
│   │   ├── analytical-tests.md
│   │   ├── standard-problems.md
│   │   ├── convergence.md
│   │   └── backend-parity.md
│   │
│   ├── api/
│   │   ├── python/
│   │   ├── rest/
│   │   ├── configuration-schema/
│   │   └── command-line/
│   │
│   ├── developer/
│   │   ├── architecture.md
│   │   ├── repository-map.md
│   │   ├── extending-fullmag.md
│   │   ├── rust-reference.md
│   │   ├── native-reference.md
│   │   ├── typescript-reference.md
│   │   └── adr/
│   │
│   ├── release-notes/
│   ├── glossary.md
│   ├── bibliography.md
│   └── _static/
│
├── extensions/
│   ├── fullmag_source.py
│   ├── fullmag_physics.py
│   └── fullmag_capabilities.py
│
├── bibliography/
│   └── fullmag.bib
│
├── internal/
│   ├── plans/
│   ├── audits/
│   ├── diagnostics/
│   └── reports/
│
└── generated/                  # gitignored
```

Poza katalogiem `docs/`:

```text
examples/
├── gallery/
│   ├── basic/
│   ├── dynamics/
│   ├── frequency_domain/
│   └── validation/
├── gpu/
└── long_running/

tests/
├── validation/
└── e2e/
    └── docs/
```

Najważniejsza zasada:

> **Nie kopiować kodu przykładów do dokumentacji.**

Skrypt znajdujący się w `examples/gallery/` powinien pozostawać źródłem prawdy, a Sphinx-Gallery powinien generować z niego stronę dokumentacji.

---

# Najważniejsza funkcja dokumentacji: równanie → implementacja → test → przykład

Najbardziej wartościową częścią dokumentacji FullMag nie będzie samo API, lecz **pełna identyfikowalność implementacji naukowej**:

```text
model fizyczny
    ↓
równanie ciągłe
    ↓
postać dyskretna FDM/FEM
    ↓
implementacja w kodzie
    ↓
test walidacyjny
    ↓
przykład i wynik referencyjny
```

Każda strona opisująca składnik fizyczny powinna mieć ten sam schemat:

1. Zakres i założenia modelu.
2. Notacja, jednostki i konwencje znaków.
3. Energia lub równanie pola efektywnego.
4. Warunki brzegowe.
5. Postać dyskretna FDM.
6. Postać słaba FEM.
7. Obsługiwane backendy.
8. Odwołania do implementacji.
9. Testy walidacyjne.
10. Znane ograniczenia.
11. Literatura.

Przykładowo strona dotycząca DMI powinna pokazywać nie tylko równanie, lecz również:

- implementację pola DMI w FDM CPU,
- kernel CUDA,
- składnik formy słabej FEM,
- test ściany domenowej,
- test warunków brzegowych,
- przykład skryptu Pythona,
- publikacje będące podstawą implementacji.

Bibliografia powinna być przechowywana w jednym pliku BibTeX, a cytowania rozwiązywane globalnie przez `sphinxcontrib-bibtex`.

---

# Linkowanie do konkretnych fragmentów kodu

## 1. Kod powinien być włączany bezpośrednio z repozytorium

Sphinx `literalinclude` potrafi pobierać fragment rzeczywistego pliku, wybierać zakres między markerami, dodawać numery linii i podświetlać wskazane linie. Dzięki temu zmiana kodu natychmiast wpływa na dokumentację.

Przykład:

````markdown
```{literalinclude} ../../../crates/fullmag-engine/src/physics/dmi.rs
:language: rust
:start-after: // docs-region: interfacial-dmi-field:start
:end-before: // docs-region: interfacial-dmi-field:end
:linenos:
:caption: Implementacja pola efektywnego interfejsowego DMI
```
````

W kodzie:

```rust
// docs-region: interfacial-dmi-field:start
fn interfacial_dmi_field(/* ... */) {
    // ...
}
// docs-region: interfacial-dmi-field:end
```

Markery są stabilniejsze niż ręczne linki `#L125-L181`, ponieważ numery linii zmieniają się przy każdej refaktoryzacji.

## 2. Własne rozszerzenie `fullmag_source`

Dla FullMag warto napisać niewielkie rozszerzenie Sphinx:

```text
docs/extensions/fullmag_source.py
```

Dyrektywa mogłaby wyglądać tak:

````markdown
```{fullmag-source} interfacial_dmi_field
:path: crates/fullmag-engine/src/physics/dmi.rs
:region: interfacial-dmi-field
:language: rust
:tests:
  - tests/validation/test_dmi_domain_wall.py
```
````

Rozszerzenie powinno:

- włączyć wskazany fragment kodu,
- wygenerować link do GitHuba,
- przypiąć link do dokładnego taga albo SHA,
- dodać linki do testów,
- zgłosić błąd kompilacji, gdy plik lub region nie istnieje,
- sprawdzić unikalność nazw regionów,
- pokazać wersję kodu odpowiadającą wersji dokumentacji.

Dla obiektów Pythona należy dodatkowo użyć `sphinx.ext.linkcode`, które generuje linki z dokumentacji obiektu bezpośrednio do zewnętrznego repozytorium.

## 3. Wersjonowana dokumentacja nie może linkować do `main`

Dla dokumentacji `v0.5.0` link powinien wskazywać:

```text
github/.../blob/v0.5.0/...
```

albo na commit użyty do zbudowania tej wersji:

```text
github/.../blob/8f37c9a.../...
```

Nie powinien wskazywać na:

```text
github/.../blob/main/...
```

W przeciwnym razie stara dokumentacja będzie po kilku miesiącach pokazywać nowy, niezgodny kod.

---

# Przykłady wykonywalne

## Skrypty `.py` jako źródło prawdy

Dla FullMag podstawowym formatem przykładów powinny być skrypty:

```text
examples/gallery/basic/first_relaxation.py
examples/gallery/dynamics/vortex_gyration.py
examples/gallery/frequency_domain/driven_response.py
```

Sphinx-Gallery powinien:

- wykonać skrypt,
- zapisać standardowe wyjście,
- przechwycić wykresy i obrazy,
- wygenerować estetyczną stronę,
- utworzyć miniaturę,
- udostępnić skrypt `.py`,
- wygenerować notebook `.ipynb`,
- zbudować listę funkcji użytych w przykładzie.

Dodatkowo `sphinx-codeautolink` może uczynić wywołania funkcji w przykładach bezpośrednio klikalnymi i prowadzącymi do odpowiedniej strony API.

## Klasy wykonywania przykładów

Przykłady powinny mieć metadane:

```yaml
execution:
  class: fast
  backend: fdm-cpu
  deterministic: true
  requires_gpu: false
```

Proponowane klasy:

| Klasa | Wykonywanie |
|---|---|
| `fast` | Każdy pull request |
| `native-cpu` | Główny branch i wydania |
| `gpu` | Runner GPU |
| `long-running` | Build nocny lub wydanie |
| `reference-output` | Wynik wygenerowany przez kontrolowane środowisko |

Każda strona przykładu powinna pokazywać:

- wersję FullMag,
- Git SHA,
- backend,
- precyzję,
- rozmiar siatki,
- urządzenie,
- tolerancje solvera,
- seed generatora,
- datę wygenerowania wyniku.

Nie należy wykonywać ciężkich przykładów CUDA/FEM bezpośrednio na Read the Docs. Powinny być wykonywane przez własny runner GPU, a zweryfikowane wyniki przekazywane do dokumentacji jako artefakty.

## Notebooki

Podstawowa dokumentacja nie powinna opierać się na notebookach. Skrypty `.py` są:

- łatwiejsze do review,
- łatwiejsze do testowania,
- czytelniejsze w diffach,
- prostsze do uruchomienia poza Jupyterem.

Sphinx-Gallery i tak może wygenerować notebooki dla użytkowników.

Prawdziwe pliki `.ipynb` można obsłużyć opcjonalnie przez `nbsphinx`, ale nie powinny stanowić podstawowego formatu dokumentacji.

---

# Instrukcje ze zrzutami ekranu

Cypress powinien stać się również **generatorem dokumentacji interfejsu**.

Przykładowa struktura:

```text
tests/e2e/docs/
├── create-project.cy.ts
├── geometry-editor.cy.ts
├── material-editor.cy.ts
├── measurement-tree.cy.ts
└── results-inspector.cy.ts
```

Przykładowy scenariusz dokumentacyjny:

```typescript
describe("Documentation: create a frequency-domain study", () => {
  it("captures stable documentation states", () => {
    cy.seedDocumentationProject();
    cy.visit("/projects/documentation-example");

    cy.getByTestId("add-study").click();
    cy.screenshot("frequency-domain/01-add-study");

    cy.getByTestId("study-type-frequency").click();
    cy.screenshot("frequency-domain/02-select-study-type");

    cy.getByTestId("frequency-start").type("1e9");
    cy.getByTestId("frequency-stop").type("20e9");
    cy.screenshot("frequency-domain/03-configured-study");
  });
});
```

Dla stabilnych zrzutów trzeba:

- ustawić stały viewport,
- używać deterministycznych danych,
- zamrozić czas,
- wyłączyć animacje,
- ukryć losowe identyfikatory,
- ustalić stały zoom i skalę,
- używać jednej wersji przeglądarki,
- nie wykonywać screenshotu przed zakończeniem renderowania.

Obrazy powinny trafiać do:

```text
docs/source/_static/screenshots/generated/
```

Strona dokumentacji powinna odwoływać się zarówno do obrazu, jak i do testu Cypress, który go wygenerował.

---

# Dokumentacja API

## Python

Dla publicznego DSL Pythona:

```python
def frequency_sweep(
    start: float,
    stop: float,
    points: int,
    *,
    scale: Literal["linear", "log"] = "linear",
) -> FrequencySweep:
    """Create a frequency sweep.

    Parameters
    ----------
    start
        Start frequency in hertz.
    stop
        Stop frequency in hertz.
    points
        Number of frequency points.
    scale
        Frequency spacing.

    Returns
    -------
    FrequencySweep
        Validated sweep definition.

    Raises
    ------
    ValueError
        If ``stop <= start`` or ``points < 2``.

    Examples
    --------
    ...
    """
```

Zalecany styl docstringów: **NumPy**, ponieważ naturalnie pasuje do oprogramowania naukowego.

API powinno być generowane przez:

- `autodoc`,
- `autosummary`,
- `napoleon`,
- `linkcode`,
- `intersphinx`.

`intersphinx` pozwoli odwoływać się bezpośrednio do klas i funkcji NumPy, SciPy, Python i innych bibliotek bez ręcznego wpisywania adresów.

## Rust

Pełną dokumentację wewnętrznych crate'ów należy budować przez:

```bash
cargo doc --workspace --no-deps
cargo test --workspace --doc
```

Do głównego portalu Sphinx warto wprowadzić tylko:

- architekturę modułów,
- stabilne interfejsy rozszerzeń,
- mapy przepływu danych,
- kluczowe trait'y,
- opis integracji Python–Rust–native.

Można przetestować `sphinxcontrib-rust`, ale nie należy uzależniać od niego całej dokumentacji. Natywny rustdoc powinien pozostać źródłem pełnej referencji Rust.

## TypeScript

Sphinx-JS może wykorzystać TypeDoc i osadzić wybrane interfejsy TypeScript w Sphinx.

Dokumentować należy przede wszystkim:

- modele danych współdzielone z backendem,
- publiczne klienty API,
- system rozszerzeń UI,
- stabilne komponenty biblioteczne.

Nie należy generować publicznych stron dla wszystkich wewnętrznych hooków i komponentów React.

## OpenAPI

Specyfikacja powinna być generowana z backendu, a nie ręcznie przepisywana:

```text
backend source
    ↓
openapi.json
    ↓
Redocly lint
    ↓
Redocly build-docs
    ↓
docs/api/rest/
```

Redocly CLI może walidować, scalać i renderować specyfikacje OpenAPI jako statyczną dokumentację.

---

# GitHub Actions i kontrola jakości

Minimalny workflow dokumentacji powinien mieć kilka odrębnych zadań.

## Pull request

```text
docs-lint
├── walidacja Markdown/MyST
├── sprawdzanie formatowania
└── walidacja metadanych stron

docs-api
├── Python autodoc
├── OpenAPI lint
├── TypeScript API
├── Doxygen/Breathe
└── rustdoc

docs-fast-examples
├── przykłady CPU
└── doctesty

docs-ui
├── uruchomienie aplikacji
├── Cypress @docs
└── kontrola screenshotów

docs-build
├── strict Sphinx build
├── brak nierozwiązanych referencji
└── artefakt HTML
```

Podstawowe polecenia:

```bash
sphinx-build \
  -b html \
  -W \
  --keep-going \
  -n \
  docs/source \
  docs/_build/html

sphinx-build \
  -b linkcheck \
  docs/source \
  docs/_build/linkcheck

sphinx-build \
  -b doctest \
  docs/source \
  docs/_build/doctest

cargo test --workspace --doc
```

Tryb `nitpicky` i opcja `-W` powinny powodować niepowodzenie buildu przy brakujących referencjach, nieznanych symbolach i ostrzeżeniach.

`linkcheck` powinien sprawdzać linki do:

- publikacji,
- DOI,
- dokumentacji zależności,
- zasobów zewnętrznych.

## Build nocny

Build nocny powinien dodatkowo:

- wykonywać przykłady GPU,
- uruchamiać ciężkie przypadki FEM,
- sprawdzać zgodność backendów CPU/GPU,
- wykonywać walidacje numeryczne,
- aktualizować raport pokrycia dokumentacją,
- kontrolować odnośniki z dokumentacji do regionów kodu.

## Wydanie

Dla taga `vX.Y.Z`:

1. wykonywane są wszystkie testy dokumentacji,
2. powstaje wersjonowany portal,
3. wszystkie linki są przypinane do taga lub SHA,
4. generowany jest PDF „FullMag Physics and Numerics Reference”,
5. generowany jest PDF „FullMag User Guide”,
6. publikowane są zweryfikowane przykłady i wyniki.

Nie należy generować jednego ogromnego PDF zawierającego całe API. Lepsze są dwa redagowane podręczniki, podczas gdy pełna referencja API pozostaje w HTML.

---

# Publikacja

## Główna rekomendacja: GitHub Pages

GitHub Pages jest pierwszym kanałem, ponieważ repozytorium już jest hostowane na GitHubie, a
użytkownik ma otrzymać działający publiczny adres przed zakończeniem całej migracji treści.
Publikacja odbywa się wyłącznie przez GitHub Actions z przypiętego artefaktu, a nie przez ręczne
kopiowanie plików do gałęzi.

GitHub Pages musi obejmować rustdoc, TypeDoc, Redocly, wyszukiwarkę i nawigację portalu, status
wersji i kwalifikacji, preview pull requestów, manifest SHA i artefaktów oraz przekierowania dla
nieopublikowanych sekcji.

Pierwszy adres projektowy to:

https://mateuszelent.github.io/fullmag/

Dokładny URL musi zostać potwierdzony po włączeniu Pages w ustawieniach repozytorium. Dokumentacja
nie może zakładać własnej domeny, dopóki DNS i certyfikat nie zostaną zweryfikowane.

## Read the Docs jako drugi kanał

Read the Docs można dodać po ustabilizowaniu portalu, gdy potrzebne będą:

- aliasy latest i stable,
- wersje odpowiadające tagom,
- przełącznik wersji,
- redagowane wydania PDF,
- osobny hosting cięższych artefaktów dokumentacyjnych.

Nie może on stać się drugim źródłem treści. GitHub Actions buduje jeden artefakt źródłowy, a każdy
kanał publikacji musi wskazywać ten sam commit i manifest.

---

# Dlaczego nie MkDocs Material, Zensical lub Jupyter Book

## Material for MkDocs

Material for MkDocs jest estetyczny i prostszy w konfiguracji, ale projekt przeszedł w tryb utrzymaniowy, a dalszy rozwój przenoszony jest do Zensical.

## Zensical

Zensical jest potencjalnie interesującym następcą, ale nadal jest rozwiązaniem młodym i dynamicznie rozwijanym. Dla wieloletniej dokumentacji naukowo-programistycznej FullMag nie powinien obecnie stanowić podstawowego fundamentu.

## Jupyter Book 2 / samodzielny MyST Engine

To dobry wybór dla:

- książki naukowej,
- kursu,
- publikacji,
- zestawu notebooków.

Nie jest jednak najlepszym rdzeniem pełnej dokumentacji software'owej, ponieważ dokumentacja API, semantyczne odwołania do symboli i integracja z wieloma generatorami językowymi są dojrzalsze w Sphinx.

## Docusaurus lub Quarto

Mogłyby zostać użyte, ale wymagałyby większej liczby własnych integracji do:

- dokumentowania API wielu języków,
- semantycznego linkowania symboli,
- testowania odwołań,
- osadzania fragmentów kodu,
- generowania PDF,
- integracji z Doxygen,
- budowania relacji równanie–kod–test.

Quarto może być przydatne jako osobny generator raportów naukowych lub publikacji, ale nie jako główny portal FullMag.

---

# Zasady jakości dokumentacji FullMag

Dokumentacja powinna być traktowana jak część produktu i przechodzić review tak samo jak kod.

## Każdy publiczny obiekt API

Musi mieć:

- opis celu, nie tylko mechanizmu,
- typy i jednostki,
- wartości domyślne,
- ograniczenia,
- wyjątki,
- minimalny przykład,
- link do przykładu pełnego,
- link do źródła.

## Każdy model fizyczny

Musi mieć:

- konwencję znaków,
- układ jednostek,
- założenia,
- równanie ciągłe,
- dyskretyzację,
- obsługiwane warunki brzegowe,
- obsługiwane backendy,
- walidację,
- literaturę,
- link do implementacji,
- jawnie opisane ograniczenia.

## Każdy tutorial

Musi:

- być wykonywalny,
- działać w czystym środowisku,
- wskazywać oczekiwany wynik,
- być powiązany z konkretną wersją FullMag,
- używać publicznego API,
- nie opierać się na ukrytych plikach lokalnych.

## Każdy screenshot

Musi:

- być wygenerowany z testu,
- mieć deterministyczny stan aplikacji,
- wskazywać test będący jego źródłem,
- być automatycznie sprawdzany po zmianie UI.

---

# Kolejność wdrożenia

Poprzedni podział na sześć etapów był zbyt zgrubny: nie określał kolejności zależności, nie
rozróżniał publikacji od migracji treści i nie mówił, kiedy konkretny dział fizyki jest gotowy.
Poniższy plan jest planem wykonawczym. Każdy etap ma rezultat, wejścia, właściciela, artefakt
dowodowy i bramkę przejścia. Nie przechodzimy dalej na podstawie samego istnienia plików.

## Zasada bramkowania

Etap może przejść do statusu qualified dopiero, gdy:

1. jego źródła są wskazane i wersjonowane;
2. treść została zbudowana w portalu;
3. linki lokalne i odwołania do symboli rozwiązują się;
4. przypisane przykłady lub testy zostały uruchomione;
5. status implementacji nie wykracza poza dowód runtime i walidację;
6. przegląd merytoryczny zatwierdził zakres, jednostki i ograniczenia.

planned oznacza zaplanowany dział bez publicznej obietnicy. draft oznacza stronę w trakcie
opracowania. qualified oznacza dział z dowodem. stable oznacza dodatkowo stabilny kontrakt
publiczny i co najmniej jedną wersję wydaną bez regresji.

## Faza 0 — decyzja o kanale i inwentaryzacja

**Cel:** ustalić, co jest publikowane, gdzie i z jakiego repozytorium.

**Czynności:**

1. Potwierdzić właściciela repozytorium MateuszZelent/fullmag i projektowy adres GitHub Pages:
   https://mateuszelent.github.io/fullmag/.
2. Rozdzielić publiczny portal od materiałów wewnętrznych, planów, audytów i raportów.
3. Zarejestrować ten plan w wersjonowanym katalogu dokumentacji; obecna reguła *.md w .gitignore
   nie może powodować, że jedyny plan pozostaje niewidoczny dla Git.
4. Sporządzić manifest źródeł: docs/physics/, docs/specs/, docs/adr/, docs/architecture/,
   packages/fullmag-py/, crates/, backends/, apps/control-room/ i tests/.

**Rezultat:** zakres publiczny, właściciel strony, URL, manifest źródeł i lista materiałów
wyłączonych z publikacji.

**Dowód:** manifest, decyzja ADR lub README portalu oraz przegląd sekretów i danych lokalnych.

**Bramka:** nie budować publicznej strony, dopóki źródła wewnętrzne nie są odseparowane od
publicznej nawigacji.

## Faza 1 — dedykowana strona GitHub Pages

**Cel:** uruchomić pierwszy publiczny adres przed migracją całej treści.

**Czynności:**

1. Włączyć GitHub Pages dla MateuszZelent/fullmag z publikacją przez GitHub Actions.
2. Utworzyć środowisko github-pages z ochroną deploymentu i historią wdrożeń.
3. Dodać workflow budujący wyłącznie katalog źródłowy dokumentacji, a nie przypadkowy Markdown
   z całego repozytorium.
4. Ustawić https://mateuszelent.github.io/fullmag/; własna domena może zostać dodana później.
5. Utworzyć stronę startową z nazwą FullMag, statusem projektu, wersją, linkami do Getting
   Started, architektury, fizyki, API i statusu kwalifikacji.
6. Dodać jawny komunikat dla nieopublikowanych działów zamiast pustych linków.
7. Włączyć preview pull requestów jako artefakt lub tymczasowy deployment; latest nie może
   wskazywać na przypadkową gałąź.

**Rezultat:** działająca strona publiczna z ekranem startowym, nawigacją i identyfikacją wersji.

**Dowód:** URL odpowiada konkretnemu SHA, deployment ma status success, strona nie zawiera
lokalnych ścieżek, a niegotowe działy pokazują swój status.

**Bramka:** GitHub Pages jest pierwszym kanałem publicznym; Read the Docs i PDF są późniejsze.

## Faza 2 — repozytoryjny fundament dokumentacji

**Cel:** zbudować portal uruchamialny lokalnie i w CI.

**Czynności:** utworzyć docs/source/index.md, konfigurację Sphinx, katalogi _static i _templates;
włączyć Sphinx, MyST Parser, PyData Sphinx Theme, Sphinx Design, MathJax i intersphinx; ustalić
metadane status, audience, owner, source_of_truth, last_verified i version; zdefiniować toctree
Getting Started, User Guide, Workflows, Physics, Numerics, Validation, API, Developer Reference,
Release Notes i Glossary; odłączyć materiały wewnętrzne od publicznej nawigacji.

**Rezultat:** minimalny portal renderujący stronę główną i stronę testową.

**Dowód i bramka:** lokalny i CI build HTML w trybie strict, z -W, -n i linkcheck, bez ostrzeżeń.

## Faza 3 — standard redakcyjny, bibliografia i słownik

**Cel:** ustalić język dokumentacji przed masową migracją.

**Czynności:** zatwierdzić główny język narracji; utworzyć glossary obejmujący problem fizyczny,
domenę, region, mesh, field, observable, stage, run, artifact, backend, runtime i capability;
przenieść cytowania do jednego BibTeX; ustalić tabele SI, konwencje znaków, statusy, ostrzeżenia
i szablony physics note, API page, tutorial, validation report, backend capability page i GUI
procedure.

**Rezultat:** kontrakt redakcyjny, glossary, bibliography i szablony.

**Dowód i bramka:** po jednej stronie każdego typu przechodzi review i build; kolejne strony
muszą używać tych samych terminów.

## Faza 4 — architektura produktu FullMag

**Cel:** opisać produkt od powierzchni użytkownika do artefaktów, zanim dokumentujemy równania.

**Źródła:** docs/specs/fullmag-application-architecture-v2.md,
docs/architecture/backend-golden-masterplan.md, odpowiednie ADR-y i aktualne źródła.

**Pakiety i bramki:**

1. **Tożsamość produktu:** Python DSL, launcher fullmag, browser control room i natywne backendy;
   diagram i tutorial muszą prowadzić przez jedną ścieżkę semantyczną.
2. **Warstwy kanoniczne:** Python/UI → ProblemIR → validation/normalization →
   planner/capabilities → session/run/stage → backend → fields/artifacts/provenance; nie wolno
   definiować drugiego modelu fizycznego wyłącznie w UI lub runnerze.
3. **Dystrybucja i runtime:** Rust-hosted launcher, Python helper, managed runtime, CPU/GPU,
   requested versus resolved execution i fail-closed dla jawnie wymuszonego GPU; provenance
   musi ujawnić przyczynę wyboru i źródło dowodu.
4. **Własność backendów:** backends/fdm i backends/fem są właścicielami produkcyjnych operatorów;
   crate’y Rust są orkiestracją, ABI lub referencją; mapa repozytorium musi wskazać właściciela
   każdego solvera, operatora i artefaktu.
5. **Frontend v2 i API resource-first:** jeden shell, moduły, typed client, resource hooks,
   command registry, workspace, unified viewport, revisions, control plane i data plane;
   legacy frontend pozostaje tylko referencją migracyjną.

**Rezultat:** rozdział architektury produktu z diagramami, mapą repozytorium i linkami do ADR/spec.

**Bramka:** każdy dalszy dział musi wskazać, do której warstwy należy i czego nie implementuje.

## Faza 5 — ProblemIR, API, sesje i artefakty

**Cel:** utrwalić semantyczny kontrakt przed opisem terminów fizycznych.

**Pakiety:** Python DSL i canonical script export; ProblemIR, normalizacja i kompatybilność;
planner, capabilities i legality; runtime session/run/stage; mesh/field/scalar/observable/
artifact/provenance/revision; API v2 resource-first; Explorer, Inspector, ribbon, viewport,
charts i invalidation.

**Rezultat:** rozdziały architektury i API z odnośnikami do OpenAPI, ADR i kodu.

**Dowód i bramka:** przykład przechodzi od skryptu do IR, planu, sesji i artefaktu; różnice są
opisane jako jawna normalizacja, a nie ukryty fallback. Żadna strona fizyczna nie wprowadza
własnych nazw ani jednostek poza IR i katalogiem wielkości.

## Faza 6 — wykonywalne przykłady i traceability

**Cel:** zbudować mechanizm dowodu przed szeroką migracją.

**Czynności:** wprowadzić Sphinx-Gallery dla examples/gallery/ i klasy fast, native-cpu, gpu,
long-running, reference-output; zapisać SHA, backend, precision, mesh size, seed, tolerances i
device; dodać regiony kodu i dyrektywę fullmag-source wskazującą kod, test i wersję; raportować
example → API → implementation → test → physics note; rozróżniać syntetyczny dowód, CPU
reference, native runtime i executed-device proof.

**Rezultat i bramka:** jeden kompletny przykład z pełną ścieżką dowodową; każdy nowy dział fizyki
musi dostarczyć przykład albo uzasadnić inną formę walidacji.

# Kolejność dokumentowania architektury FullMag

Poniższe pakiety wykonuje się po fazach 0–6. Pakiet jest zamknięty po stronie narracyjnej,
diagramie, linkach do kodu, wpływie na API/IR, przykładzie i dowodzie testowym.

## A1 — repozytorium i granice odpowiedzialności

Opisać top-level directories, właścicielstwo backends/fdm, backends/fem, crate’ów Rust, Python
DSL, API, Control Room, testów i artefaktów. Dołączyć reguły, czego nie kopiować do publicznej
referencji.

**Akceptacja:** nowy deweloper potrafi wskazać miejsce zmiany dla DSL, IR, planner, runtime,
operatora FDM, operatora FEM, API i UI.

## A2 — kanoniczny model fizyczny i round-trip

Opisać publiczny model problemu, Study, canonicalization, serializację i eksport Python.
Pokazać Python → IR → Python/UI → IR oraz dopuszczalne różnice.

**Akceptacja:** test round-trip wskazuje te same wielkości, jednostki i intent.

## A3 — planner, capabilities i provenance

Opisać legality, capability vocabulary, backend selection, explicit CPU/GPU/auto, fallback,
qualification i runtime identity.

**Akceptacja:** każda capability ma status i dowód; explicit GPU nie znika w CPU.

## A4 — runtime sesji, etapów i artefaktów

Opisać session → run → stage, snapshots, fields, tables, autosave, cancellation, failure,
resume, artifact naming i revision-driven refresh.

**Akceptacja:** diagram stanów odpowiada kodowi i testom sesji.

## A5 — API i Control Room

Opisać resource-first API v2, typed client, hooks, workspace modules, Inspector, Explorer,
unified viewport, charts, commands i lifecycle WebGL.

**Akceptacja:** każda strona UI ma endpoint/resource, test UI lub browser smoke i opis ograniczeń.

# Kolejność dokumentowania fizyki — pierwszy pełny zakres

Każdy pakiet fizyczny ma kontrakt: problem, równania, symbole i SI, założenia, FDM, FEM,
backendy CPU/GPU, ProblemIR/API, observables, implementację, testy, przykład, ograniczenia i
literaturę. Brak implementacji lub dowodu oznacza status planned albo experimental.

## P0 — standard fizyczny i konwencje

**Zakres:** SI, m, H, B, H_eff, M_s, energia, znaki, osie, normalizacja magnetyzacji, czas,
częstotliwość, damping i konwencje LLG.

**Źródła:** docs/physics/0000-physics-documentation-standard.md,
docs/physics/llg_conventions.md i powiązane physics notes.

**Dowód:** tabela symboli, test jednostek i minimalny przykład bez nazw backend-specific.

## P1 — geometria, regiony, materiały i mesh

**Zakres:** geometria, region membership, material fields, interfejsy, FDM grid, FEM mesh,
airbox, grading, periodicity, remesh i invalidation.

**Źródła:** physics notes 0100–0161 oraz specs meshing/geometry.

**Dowód:** prostokąt, cienka warstwa i shared domain z certyfikatem mesh.

## P2 — stan magnetyzacji i inicjalizacja

**Zakres:** pole magnetyzacji, normalization, region-aware initialization, preset textures,
bootstrap, state transfer FDM↔FEM i maska.

**Źródła:** physics notes 0150, 0160, 0530 i specs magnetization-init.

**Dowód:** deterministyczny snapshot t=0, test normy i provenance inicjalizacji.

## P3 — energia, pole efektywne i observables

**Zakres:** dekompozycja energii, H_eff, energy density, active terms, canonical quantities,
availability, sampling, tables i field store.

**Źródła:** physics notes 0870, 0880, 0890 oraz ADR canonical quantities.

**Dowód:** ten sam katalog wielkości w DSL, IR, runtime, API i UI; brak one-off field IDs.

## P4 — exchange

**Zakres:** energia wymiany, pole efektywne, A, interfejsy, exchange BC, FDM stencil, FEM weak
form i granice regionów.

**Źródła:** physics note 0200, fem_exchange.md i exchange-bc-policy-v0.md.

**Dowód:** uniform state, nonuniform state, interface test i parity CPU reference/native.

## P5 — demagnetyzacja FDM

**Zakres:** dipolar field, convolution/kernel, open boundary, multilayer, periodic images,
precision i cache.

**Źródła:** physics notes 0400, 0420, 0421, 0550 i aktualne FDM plans.

**Dowód:** test analityczny lub standard problem, backend parity, limit pamięci i jawny status GPU.

## P6 — demagnetyzacja FEM

**Zakres:** shared-domain Poisson/BEM/multi-model policy, airbox, Robin, mixed topology,
MFEM/hypre/libCEED, CPU/GPU, residual i solver telemetry.

**Źródła:** physics notes 0410, 0430, 0520, 0540, 0560 i native-fem-backend-architecture-v1.md.

**Dowód:** managed/container runtime, mesh certificate, residual/convergence evidence oraz
odrębny status CPU i GPU. Oracle, dense GPU i UI smoke nie są dowodem produkcyjnego FEM.

## P7 — Zeeman i pola zadane

**Zakres:** pole jednorodne, regionalne, czasowe, prescribed mask, microstrip/antenna basis,
Oersted source i stage-time semantics.

**Źródła:** fem_zeeman.md, physics notes 0920–0950 i ADR regional field drive.

**Dowód:** pole statyczne, impuls/sinc, regional mask i parametry drive w artefakcie.

## P8 — anizotropia

**Zakres:** uniaxial, cubic, osie, energy/field, SI, region/material parameters i walidacja osi.

**Źródła:** fem_anisotropy_uniaxial.md, fem_anisotropy_cubic.md i physics note 0570.

**Dowód:** test jednoosiowy, sześcienny i test błędnego axis.

## P9 — DMI

**Zakres:** interfacial i bulk DMI, znaki, boundary conditions, FDM, FEM weak residual,
CPU/GPU qualification i domain-wall validation.

**Źródła:** physics notes 0440–0470, fem_dmi.md i native-fem-dmi-weak-residual.

**Dowód:** domain wall/chiral state, weak residual, equation→region code→test i parity.

## P10 — LLG i dynamika czasowa

**Zakres:** LLG/LL equation, damping, effective field, integrators, adaptive time, stage time,
sampling, stability i performance gates dla każdego wspieranego RK.

**Źródła:** physics notes 0480–0490, 0960 i plany integratorów.

**Dowód:** precession/damping, time-step convergence, all-integrator gate i autosave t=0,
accepted-step oraz terminal.

## P11 — relaksacja i minimalizacja

**Zakres:** equilibrium contract, stop criteria, projected-gradient BB, Armijo, direct minimizers,
exchange/demag ownership, convergence, provenance i failure modes.

**Źródła:** physics notes 0500–0533, 0580–0582 i ADR algorithm-specific relaxation.

**Dowód:** CPU/native runtime, energy decrease, residual/torque criterion, no false convergence i
managed proof dla FEM/GPU, jeśli jest deklarowany.

## P12 — warunki okresowe i Floquet

**Zakres:** periodic boundary conditions, face pairs, phase, k-vector/Floquet, open demag,
mesh certificates, FDM image budget i FEM topology.

**Źródła:** physics notes 0600-periodic, 0710-periodic, 0800–0810 oraz PBC specs/plans.

**Dowód:** pair certificate, phase test, edge/corner closure, FDM/FEM matrix i reproducibility.

## P13 — temperatura i szum Browna

**Zakres:** thermal field, temperature units, stochastic integrator, seed, statistical
reproducibility, damping/noise relation i qualification boundaries.

**Źródła:** fem_thermal.md, fem_thermal_brown.md oraz canonical physics note, jeśli zakres ma
być publicznie wspierany.

**Dowód:** fixed-seed replay, distributional test i jawne oznaczenie kwalifikacji GPU/native.

## P14 — spin transport i torque

**Zakres:** STT, SOT, SHE, spin polarization, current density, signs, Oersted coupling,
STNO workflow i observables.

**Źródła:** physics notes 0800, 0820, 0830, 0840–0860 i stt_sign_conventions.md.

**Dowód:** test znaku, fixture z prądem, current/field provenance i osobny status FDM/FEM.
Tapered/constricted antenna wymaga pełnego 3D current solve.

## P15 — magnetoelasticity

**Zakres:** strain/stress, coupling energy, small-strain assumptions, mechanical BC, FDM/FEM
interpretation, frequency-domain coupling i solver ownership.

**Źródła:** 0700-shared-magnetoelastic-semantics.md, 0710, 0720 i
problem-ir-magnetoelastic-v1.md.

**Dowód:** ProblemIR round-trip, coupled fixture, boundary-condition test i osobny status GPU.

## P16 — eigenmodes i frequency domain

**Zakres:** linearized LLG, eigenproblem, complex amplitudes, drive/response, Kittel validation,
Poisson-airbox modal route, Floquet, Krylov i artifacts.

**Źródła:** physics notes 0600, 0700, 0828, 0830, 0831, eigenmode-artifacts-v1.md i masterplan.

**Dowód:** Kittel/self-check, residual/convergence, mode normalization, response artifact oraz
odrębne CPU/GPU/managed qualification. Plan lub oracle nie jest produkcyjnym proof.

## P17 — observables, analiza i eksport

**Zakres:** scalar histories, energy density, topological charge, planar monitors, sampling,
selection scope, tables, field snapshots, binary codecs i export.

**Źródła:** physics notes 0870, 0890, 0910, 0940, 0970, 0910-table oraz specs visualization/data.

**Dowód:** quantity catalog parity, bounded chart data, unit-aware labels, checksum i round-trip
eksportu.

## P18 — walidacja przekrojowa i macierz backendów

**Zakres:** analytical tests, standard problems, convergence, CPU/native parity, FDM/FEM parity,
precision, runtime identity, managed container proof, performance i known limitations.

**Źródła:** tests/standard_problems/, tests/validation/, physics note 0980, backend golden
masterplan i runtime verification recipes.

**Dowód:** macierz capability/status/evidence z datą i SHA; host diagnostic nie może być opisany
jako executed-device proof.

## P19 — wydanie pierwszego pakietu Physics Reference

**Cel:** opublikować spójną wersję fizyki, a nie zbiór pojedynczych stron.

**Warunki:** P0–P4 są stable lub mają jawnie ograniczony status; P5–P18 mają strony i statusy,
lecz tylko zakresy z dowodem są qualified; równania mają jednostki i konwencję znaków; każdy
backend-specific claim ma implementację, test i runtime evidence; portal ma bibliografię,
glossary, changelog i manifest; GitHub Pages publikuje SHA.

**Rezultat:** tag dokumentacji v0.1.0-docs i raport kompletności fizyki.

## Przepis pracy dla każdego kolejnego działu

Dla każdego pakietu A lub P wykonywać zawsze tę sekwencję:

1. zidentyfikować najwyższy dokument źródłowy i aktualny status implementacji;
2. napisać lub zaktualizować physics/spec note przed narracją użytkową;
3. opisać ProblemIR, planner, runtime, API i UI impact;
4. dodać mapowanie równanie → kod → test → przykład;
5. uruchomić testy jednostkowe i właściwy runtime gate;
6. opublikować stronę z planned, experimental, qualified lub stable;
7. po review włączyć ją do publicznego toctree;
8. zaktualizować macierz kompletności i changelog.

## Minimalny ciąg przyrostów wdrożeniowych

Duże fazy nie powinny być jednym nieprzeglądalnym pull requestem. Zalecany ciąg przyrostów jest
następujący:

| Przyrost | Zakres | Zależność | Wynik |
|---|---|---|---|
| PR-00 | włączenie trackowania planu i manifestu źródeł | brak | plan jest widoczny i wersjonowany |
| PR-01 | GitHub Pages, workflow i ekran startowy | PR-00 | pierwszy publiczny URL |
| PR-02 | Sphinx/MyST, theme, strict build i linkcheck | PR-01 | portal techniczny |
| PR-03 | metadane, glossary, bibliography i szablony | PR-02 | jednolity standard treści |
| PR-04 | mapa produktu i repozytorium | PR-03 | rozdział architektury |
| PR-05 | ProblemIR, planner, runtime i provenance | PR-04 | kontrakt semantyczny |
| PR-06 | API v2, OpenAPI, typed client i Control Room | PR-05 | referencja integracyjna |
| PR-07 | Sphinx-Gallery, metadata runów i traceability | PR-05 | wykonywalny przykład referencyjny |
| PR-08 | A1–A2 oraz P0–P2 | PR-06, PR-07 | fundament modelu i fizyki |
| PR-09 | P3–P4 | PR-08 | energia, observables i exchange |
| PR-10 | P5–P7 | PR-09 | demag FDM/FEM i pola zadane |
| PR-11 | P8–P9 | PR-10 | anizotropia i DMI |
| PR-12 | P10–P11 | PR-11 | dynamika i relaksacja |
| PR-13 | P12–P15 | PR-12 | PBC, thermal, torque i magnetoelastic |
| PR-14 | P16–P18 | PR-13 | frequency domain, analiza i macierz walidacji |
| PR-15 | P19, release notes i tag dokumentacji | PR-14 | pierwszy Physics Reference release |

PR-00–PR-07 są sekwencyjne. Pakiety A1–A5 mogą być dzielone między właścicieli po zamknięciu F6,
ale P0 musi zostać zamknięty przed P4, P5, P6, P7, P8, P9 i P10. P10–P16 nie mogą być
publikowane jako stabilne bez P3, ponieważ dynamika i observables zależą od kanonicznego katalogu
energii i pól.

## Definition of Done dla pojedynczej strony

Strona jest gotowa do publikacji, gdy posiada:

1. tytuł, odbiorcę, właściciela, status, źródło prawdy i datę weryfikacji;
2. jednoznaczny zakres oraz listę rzeczy nieobsługiwanych;
3. jednostki SI, symbole i konwencję znaków, jeśli dotyczy fizyki;
4. link do ProblemIR/API oraz rozróżnienie intent versus resolved execution;
5. link do implementacji przypięty do taga lub SHA;
6. test, przykład albo kontrolowany artefakt referencyjny;
7. informację, czy dowód jest CPU, native runtime, managed runtime czy executed-device;
8. wpis w macierzy kompletności i changelog;
9. przejście strict build, linkcheck i właściwego gate runtime;
10. review osoby odpowiedzialnej za fizykę lub kontrakt techniczny.

---

# Ostateczny wybór

Dla FullMag zalecana jest następująca architektura:

```text
                    GitHub monorepo
                          │
          ┌───────────────┼────────────────┐
          │               │                │
     kod i docstringi   przykłady       testy Cypress
          │               │                │
    API generators   Sphinx-Gallery     screenshots
          │               │                │
          └───────────────┼────────────────┘
                          │
                 Sphinx + MyST
                          │
             PyData Sphinx Theme
                          │
          GitHub Pages / PDF / Read the Docs
```

Podsumowanie:

- **Rdzeń:** Sphinx + MyST Parser.
- **Wygląd:** PyData Sphinx Theme + własny styl FullMag.
- **Przykłady:** Sphinx-Gallery.
- **Fizyka:** MathJax + BibTeX + własne dyrektywy traceability.
- **API:** autodoc, rustdoc, Doxygen/Breathe, Sphinx-JS/TypeDoc, Redocly.
- **GUI:** Cypress jako generator testów i screenshotów.
- **Pierwsza publikacja:** GitHub Pages pod adresem projektowym repozytorium.
- **Wersje naukowe i PDF:** Read the Docs może zostać dodany po ustabilizowaniu portalu.
- **Kontrola jakości:** GitHub Actions z buildem traktującym ostrzeżenia jako błędy.

Takie rozwiązanie zapewni dokumentację:

- estetyczną,
- naukowo rygorystyczną,
- wersjonowaną,
- wykonywalną,
- bezpośrednio powiązaną z rzeczywistym kodem,
- gotową do rozwoju razem z projektem,
- odpowiednią zarówno dla użytkowników, jak i deweloperów.

---

# Materiały referencyjne

- [Sphinx](https://www.sphinx-doc.org/)
- [MyST Parser](https://myst-parser.readthedocs.io/)
- [PyData Sphinx Theme](https://pydata-sphinx-theme.readthedocs.io/)
- [Sphinx Design](https://sphinx-design.readthedocs.io/)
- [Sphinx-Gallery](https://sphinx-gallery.github.io/)
- [sphinxcontrib-bibtex](https://sphinxcontrib-bibtex.readthedocs.io/)
- [Sphinx autodoc](https://www.sphinx-doc.org/en/master/usage/extensions/autodoc.html)
- [Sphinx linkcode](https://www.sphinx-doc.org/en/master/usage/extensions/linkcode.html)
- [Sphinx intersphinx](https://www.sphinx-doc.org/en/master/usage/extensions/intersphinx.html)
- [Breathe](https://breathe.readthedocs.io/)
- [Doxygen](https://www.doxygen.nl/)
- [Sphinx-JS](https://github.com/pyodide/sphinx-js)
- [TypeDoc](https://typedoc.org/)
- [rustdoc](https://doc.rust-lang.org/rustdoc/)
- [Redocly CLI](https://redocly.com/docs/cli/)
- [Cypress screenshots](https://docs.cypress.io/api/commands/screenshot)
- [Read the Docs](https://docs.readthedocs.com/)

---

# Kontrakty operacyjne portalu

## Właścicielstwo treści

Każda strona publiczna musi mieć metadane: tytuł, status, odbiorcę, źródło prawdy, właściciela
i datę ostatniej weryfikacji. Minimalny status to jeden z: draft, experimental, stable albo
deprecated. source_of_truth wskazuje plik lub kontrakt, który rozstrzyga poprawność treści.
last_verified oznacza ostatnią datę weryfikacji z kodem i testami, a nie datę ostatniej edycji tekstu.
Strona bez właściciela, statusu i źródła prawdy nie może wejść do stable.

## Wersjonowanie i reprodukowalność

Każdy build portalu zapisuje w stopce i w artefakcie maszynowym:

- wersję FullMag i commit SHA,
- wersję generatora dokumentacji,
- wersję Pythona, Rust toolchainu i Node.js,
- system operacyjny oraz architekturę,
- wynik walidacji przykładów,
- informację o dostępności GPU, jeśli przykład jej wymaga.

Link do kodu musi używać tego samego taga albo SHA. Build z niezatwierdzonego drzewa może być
preview, ale nie może być publikowany jako stable.

## Statusy kwalifikacji

| Status | Znaczenie | Dozwolone twierdzenia |
|---|---|---|
| planned | opis kierunku, brak gwarancji implementacji | tylko opis celu i planu |
| experimental | implementacja istnieje, ale ma ograniczony zakres dowodu | zakres, ograniczenia i dowody muszą być jawne |
| qualified | przeszły wymagane testy kodu i runtime | można opisywać jako obsługiwane w podanym zakresie |
| stable | kwalifikacja oraz stabilny publiczny kontrakt | można używać w tutorialach bez ostrzeżenia |
| deprecated | nadal dostępne, ale wycofywane | musi zawierać zamiennik i termin polityki |
| not qualified | obecność kodu nie jest dowodem gotowości | nie wolno przedstawiać jako funkcji produkcyjnej |

Samo przejście testu jednostkowego, analiza statyczna albo obecność kernela nie daje statusu
qualified. Dla backendów native wymagane są również dowody kompilacji, uruchomienia w odpowiednim
runtime oraz walidacji fizycznej.

## Bezpieczeństwo i prywatność

Portal nie może ujawniać sekretów, tokenów, ścieżek użytkowników, danych z produkcyjnych sesji,
nieprzefiltrowanych logów ani artefaktów GPU bez jawnej polityki publikacji. Przykłady muszą używać
danych syntetycznych, a screenshoty muszą być deterministyczne i wolne od identyfikatorów
środowiska. Każdy nowy generator lub zewnętrzna usługa wymaga przeglądu zależności, licencji i
sposobu przechowywania artefaktów.

## Dostępność i jakość UX

Publiczny portal musi działać z klawiaturą, zachowywać logiczną hierarchię nagłówków, mieć tekst
alternatywny dla obrazów i opis tabel, nie przekazywać informacji wyłącznie kolorem, obsługiwać
powiększenie tekstu bez utraty treści oraz zapewniać wersję tekstową dla wykresów i animacji
niosących istotną informację. Screenshot nie zastępuje instrukcji tekstowej ani testu interakcji.

# Macierz wdrożenia i kryteria odbioru

## Kolejność prac z właścicielem i dowodem

| Etap | Dostarczany rezultat | Właściciel | Dowód odbioru |
|---|---|---|---|
| F0 | decyzja o kanale, URL i inwentaryzacja | core/docs/release | manifest źródeł, zakres publiczny i przegląd sekretów |
| F1 | dedykowana strona GitHub Pages | release/docs | deployment z SHA, ekran startowy i działające linki |
| F2 | portal Sphinx/MyST i ścisły CI | docs/CI | HTML z -W -n, linkcheck i artefakt preview |
| F3 | standard redakcyjny, glossary i bibliografia | docs/physics/core | szablony, słownik i przykładowe strony |
| F4 | architektura produktu FullMag | core/backend/frontend | diagramy, mapa repozytorium i odnośniki do ADR/spec |
| F5 | ProblemIR, API, runtime i artefakty | API/runtime | round-trip, OpenAPI i przykładowa sesja |
| F6 | przykłady i traceability | validation/backend | raport example → API → code → test → physics |
| A1–A5 | działy architektury FullMag | core/API/runtime/frontend | strony, diagramy, testy i status kwalifikacji |
| P0–P4 | fundament fizyczny i interakcje lokalne | physics/FDM/FEM | konwencje, mesh, state, observables, exchange |
| P5–P9 | demag, Zeeman, anizotropia i DMI | FDM/FEM physics | walidacja operatorów i macierz CPU/GPU |
| P10–P15 | dynamika, relaksacja, PBC, thermal, torque, magnetoelastic | solver/physics owners | testy fizyczne, runtime evidence i ograniczenia |
| P16–P18 | frequency domain, analiza i walidacja przekrojowa | frequency/validation | residuals, artifacts, parity i capability matrix |
| P19 | pierwszy pakiet Physics Reference | release/docs/physics | tag v0.1.0-docs, manifest i raport kompletności |

## Kryteria odbioru całego systemu

Wdrożenie można uznać za ukończone dopiero wtedy, gdy:

1. nowa osoba może zainstalować FullMag i uruchomić pierwszy przykład;
2. każdy publiczny przykład ma jedno źródło prawdy poza wygenerowanym HTML;
3. build strict nie zawiera ostrzeżeń ani nierozwiązanych referencji;
4. publiczne API Python i REST jest generowane z aktualnego kodu lub kontraktu;
5. każda strona fizyczna wskazuje jednostki, założenia, implementację i test walidacyjny;
6. strony backendów rozróżniają CPU, GPU, runtime zarządzany i poziom kwalifikacji;
7. instrukcje GUI mają test Cypress albo jawne uzasadnienie wyjątku;
8. linki do kodu są przypięte do wersji dokumentacji;
9. materiały wewnętrzne nie są przypadkowo publikowane w głównej nawigacji;
10. publikacja stable jest możliwa z czystego taga i ma reprodukowalny manifest builda.

## Minimalny manifest builda

Każdy opublikowany build generuje plik docs/_build/manifest.json zawierający produkt, wersję
dokumentacji, commit SHA, stan drzewa źródłowego, wersje narzędzi, wyniki przykładów, linkcheck
oraz czas wygenerowania w UTC. Generator powinien wstawić rzeczywiste wartości albo zakończyć
build błędem. Manifest umożliwia odróżnienie aktualnej dokumentacji od starego artefaktu na hostingu.

# Polityka utrzymania

Zmiana kodu wpływająca na publiczne zachowanie musi w tym samym pull requeście wskazać stronę
dokumentacji i jej źródło prawdy, zaktualizować przykład, równanie lub ograniczenia, jeśli zmieniła
się fizyka, zaktualizować OpenAPI i typy frontendowe przy zmianie kontraktu v2, dodać dowód
walidacyjny dla nowego zakresu oraz uruchomić właściwy poziom kontroli jakości.

Review dokumentacji sprawdza cztery niezależne pytania:

- Czy treść jest prawdziwa dla wskazanej wersji?
- Czy użytkownik wie, jak wykonać opisaną czynność?
- Czy twierdzenia naukowe mają źródło i test?
- Czy dokument nie obiecuje więcej niż kwalifikowany runtime?

Gdy odpowiedź brzmi „nie”, zmiana nie jest gotowa do publikacji jako stable.
