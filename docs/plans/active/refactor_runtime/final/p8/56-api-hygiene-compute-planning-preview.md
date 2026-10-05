# P8-56 — higiena kanonicznego podglądu planu compute

Data: 05.10.2026. Stan: źródłowa bramka zaliczona; bez nowej kwalifikacji runtime.

Pełna higiena API odmówiła w próbie `86bb8a4742d54280803310030b8ae014`
wyłącznie definicji `/v2/platform/compute/preview` w centralnym `apiPaths.ts`.
[Spec, §13.5](../../../../../specs/compute-resource-execution-v1.md) opisuje ten
endpoint jako stateless podgląd planu wykonania, bez lease ani spawnu solvera.
Nie jest to legacy preview opublikowanego pola lub ilości.

Checker pozwala wyłącznie na dokładną definicję
`PLATFORM_COMPUTE_PREVIEW_PATH = openApiV2Path("/v2/platform/compute/preview")`
w `src/kernel/api/apiPaths.ts`. Normalizuje Windows separators; nie pozwala
na inne stałe, ścieżki, trailing code ani użycie tego literału w komponencie.
Zakazy direct fetch, ręcznych endpointów poza API/generated i legacy state
pozostają. Mieszany wynik wyszukiwania nie ukrywa sąsiedniego legacy match.
Nieznany kod wyszukiwania lub status 0 bez output pozostaje odmową.

Interpretowane regresje są uruchamiane przez sam checker: 3/3 PASS.
Zarządzane `just check-control-room-api-hygiene`: PASS, exit 0, receipt
`8e5c115cbf644d4e9c7580475efcd3c0`, identyczny digest źródeł przed/po
`1f6c60fbbc72dbafc210f761ea8c25a82a8c223b9561c6a7aae0b61715201699`.
Lint trzech zmienionych skryptów: exit 0, zero warnings.

Nie zmieniono endpointu, OpenAPI, transportu ani backendu compute. Bramka
nie dowodzi placement, rezerwacji, wykonania CPU/GPU, restartu ani odtworzenia UI.
