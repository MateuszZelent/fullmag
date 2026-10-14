# P8-53CE — bieżące bramki integracji

Data: 14.10.2026. Weryfikowany SHA:
`868a224baad5bdc5faebccec824b1443b06036c9`, draft PR #165.

## Wyniki rzeczywiście odebrane

| Bramka | Job | Wynik i zakres |
|---|---|---|
| modal-observables | 115766886457 | SUCCESS; 48 plików / 1039 testów, pełny frontend typecheck, module architecture, scoped React Doctor, final managed status |
| fullmag-session w physical-field-source-contracts | 115766857474 | 315 PASS / 0 FAIL / 0 ignored; dalsza kompilacja testów API FAILED |
| fullmag-session w rust-contracts | 115766888084 | 315 PASS / 0 FAIL; dalsza kompilacja testów API FAILED |
| Control Room | 115766888557 | 821 plików PASS / 8 FAIL / 1 skipped; 8525 testów PASS / 16 FAIL / 13 skipped; 9 unhandled errors |

Nie traktować zielonej serii sesji albo częściowego workflow jako green CI
całego PR. Wyniki nie dowodzą pełnego pakietu, browser/WebGL, nauki ani
restartów A→B→C. Publiczny restart pozostaje poza odebraną kwalifikacją.

## Cztery blokady kompilacji testów API

1. `handlers/simulation/runtime.rs`, fixture hysteresis: brak `completed_step`.
   Dodano `None`, zgodnie z pozostałymi niewykonanymi krokami fixture.
2. `router_v2/tests.rs`, test fizycznego FDM field z retained FEM mesh:
   brak kind i solver_progress. Dodano `PhysicalObservation` i `None`.
3. `script.rs`, regresja Rust overrides/Python export: wywołanie starego helpera.
   Test korzysta z bieżącego helpera z jawną polityką `Bounded` dla workspace.
4. `tests/project_documents.rs`, batch replay/pagination/conflict:
   Router przeniesiony do second_page przed kolejnym żądaniem; dodano clone.

Wyłącznie testowe fixtures/use sites. Produkcyjne API, helper policy,
walidatory i asercje pozostają bez zmian. Review diffu, read-only Rust parser
czterech plików i diff check: PASS. Wykonanie CI tych napraw: NOT VERIFIED.
Nie kompilowano testów jednostkowych lokalnie.

## Pozostałe błędy frontendowe — nie zamknięte

| Plik/grupa | Zaobserwowany problem |
|---|---|
| openapiV2GeneratedContract.test.ts | generated path niepromowany przez handwritten API path boundary |
| MeshBuildDialog.test.tsx | oczekiwany explicit FEM lane, otrzymany unknown |
| buildModelTree.test.ts | brak oczekiwanego Debug pod Visualization |
| AntennaObjectPanel.dom.test.tsx | 8 failures: niepełny mock KernelContext |
| ComputeEnvironmentWidget.test.tsx | brak oczekiwanego statusu inventory; 9 unhandled computeNodes errors w serii |
| useViewport3DSceneModel.test.ts | source assertion o renderingState niezgodna z kodem |
| FdmCuboidLayer.test.ts | source assertion o material ref niezgodna z kodem |
| ReferenceImportSection.dom.test.tsx | wpisy FAIL w logu workerów; wymaga dalszej diagnozy, nie traktować samej sumy 16 jako kompletnego opisu wszystkich wyjątków |

Nie zmieniać asercji tylko w celu zazielenienia CI: każdy przypadek wymaga
sprawdzenia bieżącego publicznego zachowania, fixture i istotnych konsumentów.

## Przestrzeń następnego native buildu

Resolver profilu `windows-native-fdm-cpu-dev` nadal wskazuje kanoniczny storage
projektu. Odczyt woluminów: C około 15 GB free, R około 75 GB free.
Host doctor wykrył aktywny buildkit; nie zatrzymywano go. Klient wspólnego
runnera `list` zwrócił HTTP 500, dlatego nie uzyskano scoped retention preview.
Read-only rekursywne mierzenie profilu przerwano bez końcowych rozmiarów;
nie jest dowodem oszczędności ani zbędności żadnego katalogu. Niczego nie
usunięto ani nie przeniesiono. Następny pełny build wymaga wiarygodnej oceny
szczytowego miejsca i konkretnych celów retencji albo zatwierdzonej trasy.

**P8 i cały plan pozostają IN PROGRESS; procentów nie podniesiono.**
