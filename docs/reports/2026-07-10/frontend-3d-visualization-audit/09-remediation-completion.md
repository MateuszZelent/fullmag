# 09. Zakończenie remediacji audytu 3D

**Stan:** zamknięte w gałęzi `codex/frontend-3d-visualization-remediation`.

Ten dokument jest końcową macierzą dowodową dla audytu z 10 lipca 2026.
Każdy punkt zachowuje osobny opis i plan naprawy w plikach `01`–`08`; poniżej
zapisano implementację oraz najmocniejszy dostępny dowód regresyjny.

| Finding | Stan i implementacja | Dowód |
|---|---|---|
| F3D-001 | Provenance sceny/manifestu jest jawnie porównywana. | `71e9f01e`, testy freshness. |
| F3D-002 | Stara topologia nie jest nośnikiem pól ani passów. | `1c9de680`, `62bdb3a4`. |
| F3D-003 | Domain generation uczestniczy w kompatybilności pola i mesh quality. | `cd15ba4b`, `6bfc8332`. |
| F3D-004 | Późny wynik FDM nie może zastąpić aktualnego buildu. | `b9a0895b`, `189527bb`. |
| F3D-005 | Resolver kieruje part projection do canonical part target. | `0c305091`–`9a76cb8f`. |
| F3D-006 | Effective registry backendu ma pierwszeństwo. | `a548eaed`, `2db98ac3`. |
| F3D-007 | HUD/diagnostics pokazuje payload i requested revision podczas sync. | `b1f5ee28`. |
| F3D-008 | FDM renderuje surface, wireframe, points i vectors niezależnie. | `3e7606a3`. |
| F3D-009 | Region dziedziczy tylko styl/quantity i pozostaje opt-in. | `94fbb7aa`. |
| F3D-010 | Airbox style jest serializowany; Reset usuwa cały override. | `ecb4ee51`, `7e919f75`. |
| F3D-011 | Object segments są jawnymi degraded carriers z aliasami freshness. | `885d96d4`–`090037bf`. |
| F3D-012 | Inspector mutuje wyłącznie dokładnie wybrany target. | `5db815d1`, `18ad320c`. |
| F3D-013 | Pending target patch jest ograniczony rewizją i ACK go uzgadnia. | P1 sync/controller regression suite. |
| F3D-014 | Hidden target blokuje pass controls w Inspectorze, Ribbonie i commands. | `68a9b647`, `85ea8c1a`. |
| F3D-015 | Inherited/reset usuwa serialized backend override także dla child region. | `9bc76d70`, `747af6b6`. |
| F3D-016 | Renderer-local preferences są osobnym ownerem i nie trafiają do PATCH. | `b04110f5`, `724d60f4`. |
| F3D-017 | Toggle/radio/color controls publikują dostępny stan i poprawne reason. | `188a986e`, `8ebefdb6`. |
| F3D-018 | Cache, URL i realtime używają canonical field identity; exact i broad telemetry mierzą realne keys. | `92433fd6`–`c717eded`. |
| F3D-019 | Production worker runtime jest lease-owned i kończy workery/timery po ostatnim unmount. | `a41b7a4d`–`63da0ae3`. |
| F3D-020 | Glyph cache ma globalny budżet, LRU i telemetry. | `dece90d4`–`043ec685`. |
| F3D-021 | Shader slots mają geometry-lifetime, a audit mierzy create/delete buffers i plateau. | `b1f5ee28`, `4c7015aa`–`7c4c644b`. |
| F3D-022 | Raw surface, wireframe, points, fallback i airbox współdzielą topology positions; production-like Chromium gate mierzy osobno `ARRAY_BUFFER` i `ELEMENT_ARRAY_BUFFER` dla 1/10/100 części FEM oraz czterech kombinacji passów. | `b1f5ee28`, `ffe84048`, `audit:viewport-3d-fem-topology-uploads`. |
| F3D-023 | GPU upload queue izoluje błąd ticketu, rollbackuje partial state i nie zatruwa kolejek. | `6efdfa69`–`2d8b3ded`. |
| F3D-024 | Pointer hold usuwa oba listenery i obsługuje multi-pointer. | `7f5fa0ca`, `8b1a7976`. |
| F3D-025 | Region mapping używa memoized mapy O(R + M). | `7f5fa0ca`. |
| F3D-026 | Browser gate montuje prawdziwy R3F/WebGL, kontroluje idle, workers, subscriptions, GPU i negative controls. | `200a44f3`–`ffe84048`. |
| F3D-027 | API hygiene regexy są semantyczne, mają fixture tests i strict baseline jest zielony. | `ff264bfe`. |
| F3D-028 | Audit build jest produkcyjny, sam posiada serwer, zapisuje JSON/screenshots i jest uruchamiany z uploadem artefaktów w CI. | `200a44f3`, `ffe84048`. |

## Wynik końcowej weryfikacji

- `pnpm --dir apps/control-room typecheck` — pass.
- `pnpm --dir apps/control-room lint` — pass, zero warnings.
- `pnpm --dir apps/control-room test` — pass: 314 plików, 2860 testów.
- `pnpm --dir apps/control-room check:api-hygiene` — pass.
- `./scripts/ci-resource-first-gates.sh --strict` — pass.
- `pnpm --dir apps/control-room audit:viewport-3d-memory-churn` — pass: 120 renderowanych przełączeń, zero refetchy field/topology, idle 5 s bez nowych frames/draws, worker runtime zwolniony, GPU plateau i after-unmount release.
- `pnpm --dir apps/control-room audit:viewport-3d-fem-topology-uploads` — pass: 12 scenariuszy Chromium/WebGL (1/10/100 części FEM × surface/wireframe/points/all); upload pozycji `ARRAY_BUFFER` osiąga plateau około 161 KB zamiast rosnąć z liczbą części.

Negative controls świadomie kończą audit błędem: dropped publication, blank canvas,
subscription leak, continuous idle draw loop, retained worker lease i GPU-buffer
leak. To dowodzi, że bramka nie jest wyłącznie raportem zielonego baseline.
