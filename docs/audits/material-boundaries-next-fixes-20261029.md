# Kolejny etap napraw materiałów i granic — 29.10.2026

Kontynuacja po PR #337. Baza etapu: `dcfc351c86a75e04b5df4e52a65325fbb4dfec07`.
Worktree: `/home/kkingstoun/.codex/worktrees/material-boundaries-p1-20261029/fullmag`;
branch: `codex/material-boundaries-next-20261029`; właściciel:
`01a18732-767d-7431-b30e-337c3f4310a8`.
Przed PR włączono upstream `abc6f92cebb0e2f80c8e31fe3049757d5f38fbb4`
przez merge `6dbdf37defc85c7ee037cec29314923ad8919519`.
Zmiana upstream dotyczy nazw obiektów UI; źródła objęte poniższymi testami
Rust/Python pozostały identyczne. Głównego checkoutu nie modyfikowano.

## Naprawy i przyczyny

| Priorytet | Błąd i odtworzenie | Naprawa oraz granica dowodu |
|---|---|---|
| P1 | Pole Aex z `unit="pJ/m"` przechodziło Python, scenę oraz IR V03/V04, chociaż evaluator nie przelicza liczb z SI. | Wspólny walidator Rust i zgodny walidator Python sprawdzają jednostkę wybranego parametru. Analityczne missing/null nadal oznacza SI; `dimensionless` pozostaje aliasem `1`. Złe prefiksy/wymiary są odrzucane. Publiczny eksport Python ponawia kontrolę po mutacji payloadu. Bez zmiany schematu ani automatycznej konwersji liczb. |
| P1 | FDM single-grid i multilayer gubiły skalarne DMI zapisane w materiale, gdy nie było jawnego termu energii. | Single-grid zachowuje iDMI/BulkDMI; jawny term, także zero, ma pierwszeństwo. Multilayer dopuszcza jeden wspólny efektywny skalar; różne D ciał są jawnie odrzucane. Istniejący guard BulkDMI multilayer i granice CUDA pozostają. Testy sprawdzają plany CPU/CUDA, nie nowe wykonanie GPU. |
| P1 | FEM z jednym obiektem podzielonym markerami konformalnymi liczył absorber względem podregionu; odwrócenie markerów zmieniało alpha. Dodatkowo helper po geometry/owner wybierał pierwszą mesh part i pomijał węzły innych segmentów również przy Ms/Aex. | Członkostwo węzłów pochodzi z connectivity elementów każdego segmentu. Węzły są deduplikowane i łączone per owner, a parametry rozwiązywane raz na całym obiekcie. Object-frame i automatyczny fallback universe używają pełnych bounds ownera. Odrębne obiekty pozostają odrębne. Regresje sprawdzają alpha, Ms i Aex w każdym węźle i obie kolejności markerów. |

Źródła: `crates/fullmag-ir/src/model.rs::validate_unit`, oba walidatory IR,
`crates/fullmag-authoring/src/validation.rs::validate_material_parameter_field`,
`packages/fullmag-py/src/fullmag/model/structure.py::_validate_material_parameter_field`,
`crates/fullmag-plan/src/fdm.rs::resolve_multilayer_material_dmi_scalar`,
`crates/fullmag-plan/src/fem.rs::build_region_material_fields` oraz
`segment_element_node_indices`.

## Commity etapów

- `9cf1927865c9007770c0f4d81357df2be28affb1`: jednostki, Python/scena/IR, regresje, nota 0104.
- `b65deffbc0b5a176219f965b3f5a40eecd343a90`: materiałowy DMI FDM, regresje, kontrakt lowering.
- `f703cf3c1141140ccb08f708f711a7ad47b9f2ea`: kompletne węzły ownera i absorber FEM, regresje, nota absorbera.
- `9fdf77d64ed0626462cb96674cbb1092d072a2c6`: wyłącznie dwie stare fixture authoringu; normalizacja sampled magnetization i rozróżnienie blokady mesh/solver.

## Weryfikacja lokalna

Grupa Compose: `fullmag-worktree-fullmag-033f6660666cdc47`.
Zarządzany start: attempt `03a69234ade14ad48b47dd96a85a1470`, config SHA
`b6aacca0425a4abbec9788773bf0b148c14c18f4918055b9f3bde74b66c0eb1f`.
Kompilacja testów odbyła się w jej stałym backendzie; target i logi pozostały
w named volume `/build`. Zgoda użytkownika na testy tego zadania obowiązuje.

| Kontrola | Wynik |
|---|---|
| `fullmag-plan --lib` | **621 PASS**, w tym 9 nowych regresji DMI i 3 FEM |
| `fullmag-ir --lib --test ir_tests --test material_field_units` | **258 + 241 + 3 PASS** |
| `fullmag-authoring --lib` | **181 PASS** |
| Python `test_material_parameter_units.py` | **8 PASS**, macierze parametrów, typów pola i ownerów; obejście przez mutację miało 8 failing subcases przed poprawką |
| Python API regionów i eksportu sceny | **6 PASS** po finalnej zmianie eksportu |
| Kontrole naukowe | Walidatory obu zmienionych not i source-map; **41 PASS** testów kontraktu dokumentacji |
| Publiczne przykłady Python | **PASS** repozytoryjnego guarda |
| Kontrakty aplikacji | `scripts/ci/contract_guard.sh --strict`: **PASS** |

RED jednostek potwierdzono niezależnie w V03/V04 i scenie. RED DMI: 7 FAIL,
6 PASS przed poprawką. RED FEM po poprawieniu fixture i stabilnego dt:
1 FAIL (kolejność segmentów), 1 PASS (odrębni ownerzy). Pierwsza agregacja
ownerów nie wystarczała: diagnostyka pokazała brak jednego węzła po wybraniu
pierwszej mesh part. Dopiero przejście na connectivity usunęło przyczynę.

Dwa stare błędy authoringu odtworzono na bazie w osobnym
`/build/material-next-baseline-target`: **178 PASS / 2 FAIL**.
Porównano hashe źródeł bazowego cienia `/build/workspace` z bazą Git.
Wcześniejszy eksperyment ze wspólnym target między dwoma rootami wykorzystał
nieodpowiednią binarkę i został odrzucony jako dowód bazy. Testy źródeł zadania
korzystają z `/opt/fullmag/source` i `/build/material-audit-target`.

Logi: `/build/material-next-{ir-red,ir-suite,authoring-red,authoring-baseline-isolated,authoring-final,fdm-red,fem-red,fem-green,plan-final}.log`.
Start DEV zbudował pakiet bazowy przed finalnymi zmianami. Nie jest dowodem
wykonania finalnego solvera. Nowa kwalifikacja dynamiki, energii, parytetu
FEM/FDM CPU/GPU i urządzenia: **NOT VERIFIED**. Nie zmieniano UI ani OpenAPI.

## Pozostałe ustalenia

- P2: sharp conformal Aex DG0 nadal wymaga poprawy `MaterialFieldPlan` —
  `gather_fem_material_field_plans` deklaruje Node mimo `a_element_field`.
  `artifacts.rs::fem_material_field_values` wybiera dane według tej lokalizacji.
- P2: odczyt dziedziczonego Ku1 w panelu regionu wymaga uwzględnienia
  physics_stack właściciela zamiast tylko właściwości materiału.
- Osobnego testu wymaga konsument `segment_node_indices_from_parts` dla masek
  spin-torque; ta partia usuwa zależność resolvera materiałów od tego helpera.
- Różne DMI per ciało w multilayer, regionalne Ku/DMI i fizyczny kontakt
  różnych ciał FEM pozostają ograniczeniami capability; usunięcie guardu
  bez operatora i kwalifikacji nie byłoby naprawą.

Stan CI/PR i końcowej retencji zostaje przypięty w PR oraz operacyjnym rejestrze
worktree. Zdalny merge nie oznacza aktualizacji cudzej, rozbieżnej gałęzi lokalnej.
