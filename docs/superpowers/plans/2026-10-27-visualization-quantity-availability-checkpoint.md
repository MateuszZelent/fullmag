# Dostępność Quantity source — checkpoint 27.10.2026

Status: izolowany fragment wspólnego Inspectora, nie odbiór pełnego Universe.

`ObjectVisualizationPanelModel.ts::visualizationQuantitySelectionState` rozróżnia
wybór, brak wyboru, pusty katalog, ładowanie, niedostępne pole, błąd oraz brak
wybranego wykonania. `ObjectVisualizationTargetSection.tsx::VisualizationQuantitySection`
i `ObjectVisualizationPanel.tsx::ObjectVisualizationPanelView` stosują wspólny
resolver zamiast pustego dropdownu albo retained m w overview. Wykorzystują
istniejące katalogi i wspólny Select; nie tworzą field IDs ani nowych requestów.
Wybór nadal używa istniejącego quantitySourcePatch i transakcji właściwego pola.
Nie auto-wybiera wykonania/źródła i nie uruchamia Solve.

Fragment nie zmienia ownera, routingu, nośnika Global, capabilities, renderera,
ribbon ani współdzielonego staged ArtifactInspectionSource.tsx. Istniejący
artifactInspectionOwner określa tylko informację executionSelected, a istniejący
catalogOwnerReady pozostaje twardą bramką zgodności historycznego katalogu.

## Zachowanie last-good

Resource hooks kluczują field/quantity catalogs przez sessionScopedResourceKey
(session/epoch/request-scope), a historyczne pola dodatkowo przez stage/run.
useResource odczytuje snapshot pod dokładnym kluczem; disabled nie zwraca danych.
refreshError jest osobnym ostrzeżeniem przy zachowanych danych. Dlatego matching
last-good pozostaje dostępny z widocznym ostrzeżeniem, bez globalnego disable.
Fatal error, brak danych i obcy immutable owner nadal są twardą odmową.
Źródłowe anchors i lineage kandydata zapisano w control/granice.md.

## Weryfikacja

Izolowany HEAD f9e00ede9df6d338b2dd27473ddf1debcc33fd55 plus dokładne cztery
pliki kandydata; reszta WIP zastąpiona HEAD w pamięci, AM niedostępny.
RED: overview dla pustego Universe zwracał m zamiast jawnego braku ilości.
Drugi RED: refreshError antenna_store_busy wyłączał poprawny zachowany katalog.
Finalnie 18 kontroli selektora/SSR/handlera oraz dwie bezpośrednie kontrole
wyrażenia overview i klasyfikacji zasobów PASS; izolowany TypeScript PASS,
lint czterech plików zero błędów/ostrzeżeń. Testów jednostkowych nie kompilowano.
W WT zastosowano wyłącznie dwa dodatkowe hunki refresh i własny skrypt regresji;
pozostały owner/routing WIP i cudzy indeks zachowano.

Dowody w wolumenie kontrolnym:
verification/quantity-availability-commit-20261027/{candidate.json,candidate.patch,
results-final.json,red-green.json,wt-refresh-fix.patch,wt-refresh-fix-scope.json}.
Patch refresh SHA256 80a3c1e56de58bb16ae993cb8fe6e270c32d898abcab24a83b4f4fcdc128bd95.
Browser, stabilność DOM/focus/scroll i WebGL pozostają NOT VERIFIED.
To poprawka dostępności kontrolek, nie dowód opublikowania H ani globalnego
zakończenia naprawy katalogu quantities w E5/E7/E12. Aktualna pełna próba
zakończyła się surface RT0 wall-time exhausted, bez V/J/H i bez ponowienia.
