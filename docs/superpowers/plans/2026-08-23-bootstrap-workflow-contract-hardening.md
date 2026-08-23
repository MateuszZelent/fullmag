# Plan implementacji wzmocnienia kontraktu workflow bootstrap

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` (zalecane) albo `executing-plans`, aby realizować ten plan zadanie po zadaniu. Kroki używają pól wyboru (`- [ ]`) do śledzenia postępu.

**Cel:** Sprawić, by kontrakt bootstrap z PR #56 odrzucał nieaktualne wersje akcji niezależnie od nazw kroków oraz odrzucał śledzone gitlinki bez kompletnych metadanych klonowania.

**Architektura:** Kontrakt pozostaje bez dodatkowych zależności w `scripts/test_bootstrap_workflow_contract.py`. Parser odczytuje wyłącznie zakotwiczone klucze `uses:` workflow, `.gitmodules` jest parsowany przez `configparser`, a oba niezmienniki są wyrażone przez małe czyste helpery objęte negatywnymi testami regresji przed zastosowaniem do plików repozytorium.

**Stos technologiczny:** biblioteka standardowa Python 3 (`configparser`, `pathlib`, `subprocess`, `unittest`), indeks Git, tekst YAML GitHub Actions.

## Ograniczenia globalne

- Nie dodawać zależności Python ani workflow.
- Zachować zgodność z Windows i Linux.
- Zachować `.github/workflows/bootstrap.yml` jako źródło prawdy workflow.
- Nie zmieniać zachowania workflow, wersji akcji, członkostwa submodułów, kodu produktu, OpenAPI, semantyki runtime ani architektury frontendu.
- Objąć kontraktem dokładnie `actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-python@v7`, `actions/upload-artifact@v7` oraz `pnpm/action-setup@v6`.
- Każdy śledzony gitlink musi mieć dokładnie jedną pasującą ścieżkę `.gitmodules` i niepusty URL.

---

## Mapa plików

- Modyfikacja `scripts/test_bootstrap_workflow_contract.py`: helpery parsowania, negatywne testy regresji i asercje kontraktu repozytorium.
- Zachowanie `docs/superpowers/specs/2026-08-23-bootstrap-workflow-contract-hardening-design.md`: zatwierdzony właściciel projektu; nie są oczekiwane zmiany merytoryczne.

### Zadanie 1: Walidacja rzeczywistych odwołań do akcji workflow

**Pliki:**
- Modyfikacja: `scripts/test_bootstrap_workflow_contract.py:1-35`
- Test: `scripts/test_bootstrap_workflow_contract.py`

**Interfejsy:**
- Dostarcza: `_workflow_uses(workflow: str) -> list[str]`.
- Dostarcza: `_assert_required_action_version(workflow: str, action: str, expected_reference: str) -> None`.
- Zużywa: surowy tekst `.github/workflows/bootstrap.yml`.

- [ ] **Krok 1: Dodać nieprzechodzący test regresji dla zmienionej nazwy kroku i starej wersji**

Dodać metodę testową wywołującą nieistniejący jeszcze helper:

```python
def test_action_version_contract_reads_uses_instead_of_step_names(self) -> None:
    workflow = """
jobs:
  test:
    steps:
      - name: Clone sources
        uses: actions/checkout@v6
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"actions/checkout.*actions/checkout@v7",
    ):
        _assert_required_action_version(
            workflow,
            "actions/checkout",
            "actions/checkout@v7",
        )
```

- [ ] **Krok 2: Uruchomić test ukierunkowany i potwierdzić RED**

Polecenie:

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/test_bootstrap_workflow_contract.py BootstrapWorkflowContractTests.test_action_version_contract_reads_uses_instead_of_step_names -v
```

Oczekiwany wynik: `ERROR` z `NameError: name '_assert_required_action_version' is not defined`.

- [ ] **Krok 3: Zaimplementować minimalny parser wierszy i helper asercji**

Dodać nad klasą testową:

```python
def _workflow_uses(workflow: str) -> list[str]:
    references: list[str] = []
    for line in workflow.splitlines():
        stripped = line.strip()
        if not stripped.startswith("uses:"):
            continue
        reference = stripped.removeprefix("uses:").strip().strip("'\"")
        if reference:
            references.append(reference)
    return references


def _assert_required_action_version(
    workflow: str,
    action: str,
    expected_reference: str,
) -> None:
    references = [
        reference
        for reference in _workflow_uses(workflow)
        if reference.partition("@")[0] == action
    ]
    if not references:
        raise AssertionError(f"workflow does not use required action {action}")
    stale = [reference for reference in references if reference != expected_reference]
    if stale:
        raise AssertionError(
            f"{action} must use {expected_reference}; found {stale}"
        )
```

- [ ] **Krok 4: Zastąpić asercje liczb nazw kroków kontrolą rodzin akcji**

Po odczytaniu workflow użyć:

```python
required = {
    "actions/checkout": "actions/checkout@v7",
    "actions/setup-node": "actions/setup-node@v7",
    "actions/setup-python": "actions/setup-python@v7",
    "actions/upload-artifact": "actions/upload-artifact@v7",
    "pnpm/action-setup": "pnpm/action-setup@v6",
}
for action, expected_reference in required.items():
    with self.subTest(action=action):
        _assert_required_action_version(workflow, action, expected_reference)
```

- [ ] **Krok 5: Uruchomić cały kontrakt bootstrap i potwierdzić GREEN**

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/test_bootstrap_workflow_contract.py -v
```

Oczekiwany wynik: wszystkie testy przechodzą, w tym regresja zmienionej nazwy oraz kontrakt rzeczywistego workflow.

- [ ] **Krok 6: Zacommitować wzmocnienie odwołań do akcji**

Najpierw osobno sprawdzić staging:

```powershell
git add -- scripts/test_bootstrap_workflow_contract.py
git diff --cached --name-only
git diff --cached --check
```

Po potwierdzeniu, że staging zawiera wyłącznie test kontraktu:

```powershell
git commit -m "test(ci): validate workflow action references"
```

### Zadanie 2: Wymaganie kompletnych metadanych każdego śledzonego gitlinku

**Pliki:**
- Modyfikacja: `scripts/test_bootstrap_workflow_contract.py:1-100`
- Test: `scripts/test_bootstrap_workflow_contract.py`

**Interfejsy:**
- Dostarcza: `_submodule_urls_by_path(gitmodules: str) -> dict[str, str]`.
- Zużywa: tekst `.gitmodules` i ścieżki zwrócone przez `git ls-files --stage`.

- [ ] **Krok 1: Dodać nieprzechodzące testy pustego URL i zduplikowanej ścieżki**

Dodać `import configparser` oraz:

```python
def test_submodule_metadata_requires_nonempty_url(self) -> None:
    gitmodules = """
[submodule "external_solvers/example"]
    path = external_solvers/example
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"external_solvers/example.*nonempty url",
    ):
        _submodule_urls_by_path(gitmodules)


def test_submodule_metadata_rejects_duplicate_paths(self) -> None:
    gitmodules = """
[submodule "first"]
    path = external_solvers/example
    url = https://example.test/first
[submodule "second"]
    path = external_solvers/example
    url = https://example.test/second
"""

    with self.assertRaisesRegex(
        AssertionError,
        r"duplicate submodule path external_solvers/example",
    ):
        _submodule_urls_by_path(gitmodules)
```

- [ ] **Krok 2: Uruchomić oba testy ukierunkowane i potwierdzić RED**

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/test_bootstrap_workflow_contract.py BootstrapWorkflowContractTests.test_submodule_metadata_requires_nonempty_url BootstrapWorkflowContractTests.test_submodule_metadata_rejects_duplicate_paths -v
```

Oczekiwany wynik: oba testy kończą się `NameError: name '_submodule_urls_by_path' is not defined`.

- [ ] **Krok 3: Zaimplementować ścisłe parsowanie `.gitmodules`**

Dodać nad klasą testową:

```python
def _submodule_urls_by_path(gitmodules: str) -> dict[str, str]:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(gitmodules)
    records: dict[str, str] = {}
    for section in parser.sections():
        if not section.startswith('submodule "'):
            continue
        path = parser.get(section, "path", fallback="").strip()
        if not path:
            raise AssertionError(f"{section} must define a nonempty path")
        url = parser.get(section, "url", fallback="").strip()
        if not url:
            raise AssertionError(f"{path} must define a nonempty url")
        if path in records:
            raise AssertionError(f"duplicate submodule path {path}")
        records[path] = url
    return records
```

- [ ] **Krok 4: Porównać kompletne ścieżki metadanych z indeksem Git**

Po obliczeniu `gitlinks` zastąpić dotychczasową pętlę:

```python
self.assertTrue(gitlinks)
metadata = _submodule_urls_by_path(gitmodules)
self.assertEqual(
    set(metadata),
    set(gitlinks),
    "tracked gitlinks and complete .gitmodules records must match exactly",
)
```

- [ ] **Krok 5: Uruchomić cały kontrakt i potwierdzić GREEN**

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/test_bootstrap_workflow_contract.py -v
```

Oczekiwany wynik: wszystkie testy przechodzą, a każdy śledzony gitlink solvera zewnętrznego ma niepusty URL.

- [ ] **Krok 6: Zacommitować wzmocnienie metadanych gitlinków**

```powershell
git add -- scripts/test_bootstrap_workflow_contract.py
git diff --cached --name-only
git diff --cached --check
```

Po osobnym potwierdzeniu stagingu:

```powershell
git commit -m "test(ci): require complete gitlink metadata"
```

### Zadanie 3: Weryfikacja i publikacja PR #56

**Pliki weryfikowane:**
- `scripts/test_bootstrap_workflow_contract.py`
- `packages/fullmag-py/tests/test_api.py`
- `apps/control-room/src/shared/ui/Resizable.tsx`
- `apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts`
- `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx`
- `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- `crates/fullmag-runner/src/dispatch.rs`

**Interfejsy:**
- Zużywa: commity z zadań 1 i 2 oraz istniejące poprawki PR #56.
- Dostarcza: opublikowany head PR z lokalnymi dowodami i świeżymi dowodami GitHub Actions.

- [ ] **Krok 1: Uruchomić kontrakty Python**

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/test_bootstrap_workflow_contract.py -v
$env:PYTHONPATH = 'packages/fullmag-py/src'
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest discover -s packages/fullmag-py/tests -p test_api.py -k random_initializer_serializes_to_ir -v
```

Oczekiwany wynik: oba polecenia przechodzą.

- [ ] **Krok 2: Uruchomić typecheck, lint i testy regresji frontendu**

```powershell
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\admin\Documents\Fullmag\node_modules\typescript\bin\tsc' --noEmit --project apps/control-room/tsconfig.typecheck.json
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\admin\Documents\Fullmag\node_modules\eslint\bin\eslint.js' apps/control-room/src/shared/ui/Resizable.tsx apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx apps/control-room/src/modules/ribbon/ribbonCommands.ts
& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\admin\Documents\Fullmag\node_modules\vitest\vitest.mjs' run apps/control-room/src/shared/ui/Resizable.test.ts apps/control-room/src/kernel/visualization/visualizationCommandContributions.test.ts apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.test.tsx apps/control-room/src/modules/ribbon/ribbonStructure.test.ts
```

Oczekiwany wynik: typecheck i lint kończą się kodem zero; przechodzą cztery pliki i 128 testów.

- [ ] **Krok 3: Sprawdzić higienę repozytorium i graf commitów**

```powershell
git diff --check origin/master...HEAD
git status --short
git log --oneline origin/codex/fix-pr-ci-gates-20260823..HEAD
```

Oczekiwany wynik: brak błędów whitespace, czysty worktree i wyłącznie przejrzane commity PR #56 przed zdalną gałęzią.

- [ ] **Krok 4: Wypchnąć zatwierdzoną aktualizację gałęzi**

```powershell
git push origin HEAD:codex/fix-pr-ci-gates-20260823
```

Oczekiwany wynik: zdalna gałąź przechodzi fast-forward na bieżący lokalny head.

- [ ] **Krok 5: Zweryfikować świeże GitHub Actions i stan review**

Pobrać workflow runs dla nowego headu, przeczytać pełny log każdego nieudanego joba i wymagać sukcesu wszystkich obowiązkowych jobów. Ponownie pobrać wątki review i rozwiązać wyłącznie te, których dokładny niezmiennik jest dowiedziony przez nowy kod i testy.

- [ ] **Krok 6: Scalić dopiero po kompletnych dowodach**

Wymagać mergeable PR, zielonych obowiązkowych checks, braku nierozwiązanych uwag wymagających działania i dokładnego oczekiwanego SHA headu. Scalić PR #56 bez omijania branch protection.
