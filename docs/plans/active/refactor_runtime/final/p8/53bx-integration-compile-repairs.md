# P8-53BX — wąskie naprawy kompilacji integracji

Data: 14.10.2026. Baza `6fb53c463b4da8ee23d67bccb4a1c869ce2b8347`.
Status: **IN PROGRESS**; źródła przygotowane do autoryzowanego CI, nowy build
produkcyjny i runtime pozostają NOT VERIFIED.

## Dowody błędów i zakres naprawy

| Błąd | Dowód | Wąska zmiana |
|---|---|---|
| E0004, pominięty wariant `AntennaExternalLeadInspection` w adaptive match | Hosted CI c876 (`38518281744`, `38518281842`) oraz terminalny native build `native-build-1c8373aae883439b8a2f06e7ed0ddee2.log` | Jawny Err dla unsupported adaptive; Serial bez zmiany, bez cichego fallbacku. |
| Dwie deklaracje `monitorId` i `newName` w tych samych scope | Hosted CI `38518281731`, parse error Field Map | Usunięte tylko redundant deklaracje; wcześniejsze guardy i narrowing zachowane. |
| Fixture nie deserializuje się z powodu brakującego `entrypoint_kind` | Hosted CI `38518281735`, test `flat_antenna_stage_declares_only_its_inspection_artifact` | Dodane `flat_antenna_field_solve` i `flat_relax` dla obu etapów; produkcyjny kontrakt i asercje bez osłabienia. |

Staged diff źródeł to trzy pliki, siedem insertions i cztery deletions. Adaptive
arm wybrano do indexu przez `git apply --cached` z wersji HEAD plus dokładnie
pięć linii; working tree pozostało nietknięte. Jest to niezależna autoryzowana
naprawa, a nie wykonanie odrzuconego cofnięcia 69 plików formattera.
Pobocznego formatowania nie wolno dołączać do tego przyrostu; pozostaje
oczekujące pytanie o dokładną autoryzację jego usunięcia.

## Granice odbioru

Scoped diff/check i read-only parser obu staged plików Rust PASS;
formatter używał `--emit stdout --config skip_children=true` bez zapisu.
Bounded review jest osobną
bramką przed commitem. Pierwsze review wykryło brak wymaganego entrypoint
także w etapie antenowym fixture; uzupełniono go zgodnie z SceneStudyStage,
eksporterem Python i komendą authoring UI. Pozostałe dwa fixy: brak P0/P1/P2.
Nie kompilowano unit targets lokalnie. PASS224 z
[53BW](53bw-antenna-scene-handoff.md) dotyczy interpretowanego handoff Python,
nie dowodzi kompilacji ani zachowania tych trzech zmian. Wymagane są wyniki
CI dla nowego commita oraz nowy managed produkcyjny build i runtime proof.

Ponowny REST readback potwierdził zdalne scalenie PR #162; zdalny master
wskazuje `c87661353420085013956f1b39d78d87c6b97312`. Naprawy 53BW i tego
przyrostu nie są jeszcze objęte nowym wynikiem CI ani remote master.
