# Audyt stron wprowadzających, architektury i frontendu

Baza: `056d4f50d10389be83a68b9941d2fbcdcb8fc072`. Wszystkie poniższe strony przeczytano; nie jest to kwalifikacja browser/runtime.

| Strona Sphinx | Zakres dowodu |
|---|---|
| `getting-started/choosing-a-solver.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `getting-started/control-room.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `getting-started/first-fdm-simulation.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `getting-started/first-fem-simulation.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `getting-started/index.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `getting-started/installation.md` | Porównanie z world.py, model/problem.py i justfile; przykłady index/FDM/FEM: capture oraz IR PASS, solver NOT VERIFIED. |
| `architecture/index.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/planner-and-capabilities.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/product.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/provenance.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/runtime.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/semantic-model.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `architecture/ui-architecture.md` | Porównanie granic odpowiedzialności z plannerem i API; UI manifest/transport dopasowane do kernel/types.ts i kodu klienta. |
| `frontend/capability-register.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/control-room/index.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/index.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/airbox-mesh.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/build-lifecycle.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/fdm-grid-view.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/index.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/object-mesh.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/python-round-trip.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/quality-and-reports.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/meshing/region-mesh.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/state-and-commands/index.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `frontend/visualization/index.md` | Porównanie nazw paneli, transakcji i transportu z apps/control-room/src; poprawione linki i indeksy źródeł. Browser NOT VERIFIED. |
| `index.md` | Przeczytano; nawigacja i rozdzielenie kontraktów/sprawdzonych wyników. Changelog porównany z extension i workflow dokumentacji. |
| `backend/index.md` | Przeczytano; nawigacja i rozdzielenie kontraktów/sprawdzonych wyników. Changelog porównany z extension i workflow dokumentacji. |
| `changelog/index.md` | Przeczytano; nawigacja i rozdzielenie kontraktów/sprawdzonych wyników. Changelog porównany z extension i workflow dokumentacji. |

## Istotne ustalenia

- Poprawiono linki wychodzące poza root Sphinx oraz błędne znaczniki roli doc.
- Zastąpiono nieistniejące ścieżki kernel/modules i kernel/state oraz niezgodny manifest deklaracjami z kodu.
- Dekoder FMVP przyjmuje FP64; pola pobierane są przez HTTP, zdarzenia WebSocket unieważniają zasoby.
- Indeksy siedmiu stron meshing wskazują teraz właścicieli odpowiednich transakcji i modeli.
- Usunięto domniemane wsparcie UI dla importu STEP/IGES, stream ribbons i pomiaru pełnego RAM/VRAM.
- Przykłady jawnie rejestrują oddziaływania; przejście FEM CPU/GPU wymaga zgodnego żądania w skrypcie. Robin airbox wymaga własnej kontroli zbieżności.

## Wyniki

- 3 przykłady: lekki capture, jeden etap relax, serializacja IR oraz obecność exchange/demag PASS.
- 161 istniejących source-map: strukturalnie PASS; samo dopasowanie nazwy symbolu nie potwierdza fizyki.
- 7 interpretowanych kontroli dokumentacji Python/API i jednostek DMI: PASS.
- Nawigacja 229 stron: brak niedostępnych doc-targets po korekcie.
- Build Sphinx i przegląd pozostałych grup w toku.
