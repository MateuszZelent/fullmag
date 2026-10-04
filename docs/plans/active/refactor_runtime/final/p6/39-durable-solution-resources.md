# Przyrost 39 — trwałe zasoby wyników historycznych

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i specyfikacja: `a634c0cb6ae6c36413c00e8c72e8614f8c4d856b`, opublikowany na remote master.

## Zakres i wynik

Historyczny właściciel wyników jest teraz dostępny przez trzy GET-y pod
`/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}`:
korzeń rewizji, stronicowani members i stronicowane artefakty konkretnego membera.
Odczyt używa trwałego katalogu SolutionSet, bez aktywnej sesji, inicjalizacji
store ani przejmowania lease. Weryfikuje właściciela projektu/run, fingerprint
RunSpec oraz provenance manifestu. Nieistniejący wynik nie staje się pustym sukcesem.

Cały odczyt, walidacja i przygotowanie odpowiedzi pracują poza executorem async.
Wejściowy manifest ma limit 16 MiB również podczas publikacji; odpowiedź ma
limit 1 MiB. Strony domyślnie zawierają 50 pozycji, maksymalnie 100, z jawnym
`after_id`. Limity nie dowodzą szczytowego RAM po parsowaniu.

Rewizja, epoch, accepted step i liczniki u64 są przesyłane jako ciągi dziesiętne,
aby zachować wartości powyżej bezpiecznego zakresu JavaScript. Digest oznacza
kanoniczny manifest, nie weryfikację bajtów CAS. Integralność artefaktu pozostaje
`not_verified`; wykonanie, naukowa ocena i stan manifestu są oddzielnymi polami.

OpenAPI zawiera trzy nowe operacje i 17 schematów. Istniejące operacje i schematy
pozostały strukturalnie niezmienione. Klient został wygenerowany rzeczywistą
trasą codegen. Facade i trzy hooki zawierają project/run/solution/revision,
member oraz stronę w tożsamości zasobu; zmiana źródła anuluje poprzedni request.
Hooki nie zależą od aktywnej sesji. Consumer UI i discovery kolejnych rewizji
pozostają otwarte.

## Weryfikacja

Receipts znajdują się pod
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/`:

| Bramka | Wynik | Receipt względem tego katalogu |
|---|---|---|
| API + OpenAPI codegen | PASS, exit 0, źródła stabilne | `windows-api-source-check/api-openapi-codegen/39979b3947a048b49ace0029de57e23a/receipt.json` |
| Generated client | PASS, exit 0 | `windows-control-room-source-check/generate-client/e2aef7df59594976998cd615ce211e81/receipt.json` |
| Produkcyjny TypeScript | PASS, exit 0, źródła stabilne | `windows-control-room-source-check/production-source/1bc22d642e5e42a3b7099797e1c290b4/receipt.json` |
| Higiena API | PASS, exit 0, źródła stabilne | `windows-control-room-source-check/api-hygiene/a6de81ac73674209b1ca26fb5a797494/receipt.json` |
| Lint całego frontendu | FAILED: 19 błędów, 2 ostrzeżenia poza nowymi hookami | `windows-control-room-source-check/lint/9774a343d1184fec85b19696b1b3fc71/receipt.json` |

Niezależny ograniczony review backendu oraz poprawionej granicy lekkich
kontroli: PASS. Staged diff i kontrola istniejących schematów: PASS.
Źródła kontrolowano we współdzielonym dirty checkoutcie; nie jest to dowód
kwalifikacji czystego pakietu ani managed runtime.

Lint wykazuje wcześniejsze problemy w FieldMapModule, InspectorEditSession,
ObjectMeshPolicyPanel i FdmCuboidLayer. Dwie uwagi nowych hooków zostały
naprawione. Bramka pozostaje FAILED. Pre-commit React Doctor zgłosił dwa
ostrzeżenia o istniejących sekwencyjnych pętlach odczytu topology chunks
w ControlRoomApi; przyrost ich nie zmienia. Sekwencyjność ogranicza równoległą
pamięć i odczyty zakresów, dlatego nie zastąpiono jej automatycznie Promise.all.

Nowe regresje zostały napisane, lecz są **NOT COMPILED / NOT RUN** zgodnie
z obowiązującym zakazem kompilacji testów jednostkowych. Produkcyjny tsc
wyklucza pliki testowe i nie uruchamia Next typegen. Runtime, browser/WebGL,
CAS integrity, RAM oraz kwalifikacja wydania pozostają **NOT VERIFIED**.

## Stałe lekkie trasy

Dodano `generate-control-room-client`, `check-control-room-production-source`,
`check-control-room-api-hygiene` oraz `lint-control-room-source`. Helper ma
zamkniętą listę operacji, resolver, lock i terminalny receipt. Hashuje konfiguracje,
źródła, deklaracje i używane `.next/types`; codegen wyklucza tylko własne outputs.
Shell nie wykonuje tekstu recepty, lecz wywołuje zaufany helper bieżącego checkoutu.
Nie jest to obejście managed kolejki ciężkich buildów.

Istniejące node_modules tego dokładnego checkoutu są używane tylko do odczytu;
nie instalowano ani nie przenoszono zależności. Nowe logi, config kontrolny i
receipts trafiają do zarządzanego storage. Generated client pozostaje wersjonowanym
artefaktem źródłowym. Poprzedni receipt codegen powstał przed rozszerzeniem
fingerprintu; późniejszy produkcyjny tsc sprawdził finalne wygenerowane źródła.

## Pozostałe kroki

1. Trwały Dataset/materializer i porównanie dwóch przypiętych źródeł wraz
   z jednostkami, zgodnością przestrzeni oraz receipt jawnej projekcji.
2. Integracja PlotDefinition, export recipes, discovery i Explorer.
3. Naprawa istniejących błędów lintu z adekwatnymi dowodami zachowania UI.
4. Managed wykonanie, import/recovery, pomiary pamięci i bramki wszystkich lane'ów.

Buildy wcześniejszych przyrostów były ostatnio queued z powodu storage poniżej
bramki 8 GiB; tego stanu nie użyto jako zaliczenia bieżącego przyrostu. Nie zlecano
kolejnego ciężkiego buildu, nie usuwano danych ani nie obniżano guard.
