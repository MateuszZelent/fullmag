# P6-D — pinned observation source w viewport 3D

Data: 29.09.2026
Status: **TYPECHECK/LINT/API HYGIENE/WEBGL PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

Przypięta immutable observation frame zasila teraz istniejący render-model
viewportu 3D jako historyczne pole `m`. Integracja nie tworzy drugiego
renderera ani gałęzi FDM/FEM. Używa centralnej fasady API, wspólnego
128 MiB cache buforów pola oraz osobnego klucza zawierającego dokładny
`frame_id`.

Adopcja payloadu jest fail-closed. Dekoder musi zwrócić
`source_kind=observation_frame`, dokładny `source_id` przypiętej ramki oraz
quantity `m`. Istniejące sprawdzenia generation/carrier/scope nadal chronią
zgodność bufora z topologią. Zmiana live → historyczna ramka albo ramka → ramka
czyści last-good retention między różnymi resource keys, więc viewport nie może
pokazać starego pola pod nową tożsamością źródła.

Historyczny source wyłącza live field refresh i live field-meta requests.
Jawny analysis overlay zachowuje pierwszeństwo, a odpięcie ramki wraca do
bieżącego field resource bez przebudowy topologii.

## Dowody

- `pnpm --dir apps/control-room typecheck`: **PASS**,
- scoped ESLint dla zmienionych plików: **PASS**,
- `scripts/ci-resource-first-gates.sh`: **PASS**,
- browser/WebGL gate: canvas widoczny, `contextLost=false`, drawing buffer
  `617×478`: **PASS**,
- `git diff --check`: **PASS**.

Regresje exact observation source oraz zakazu retention pomiędzy live i
historycznym resource są zapisane, ale pozostają **NOT RUN** z powodu aktywnego
zakazu kompilacji testów jednostkowych.

## Granica

Otwarte pozostają porównania wielu ramek, SolutionSet/DatasetDefinition,
pozostałe quantities i evaluatory, bounded partial I/O, plot/export recipes
oraz produkcyjna kwalifikacja historycznego renderingu na wszystkich lane'ach.

P6 rośnie z **4% do 6%**. Cały plan pozostaje około **49%**.
