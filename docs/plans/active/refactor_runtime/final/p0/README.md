# P0 — wykonanie pierwszego etapu na masterze

Źródło zadania: [finalny plan refaktoryzacji](../03-plan-refaktoryzacji.md), pakiety P0-A–F. Użytkownik jawnie wybrał pracę bezpośrednio na `masterze`. Audyt wejściowy pozostaje zachowany; ten podfolder rejestruje implementację i dowody.

**Minimalna bramka przejścia do P1 jest zaliczona.** Zarządzany build CLI/API/Pythona/frontendu zakończył się `succeeded`, exit 0; zweryfikowano hashe 109 artefaktów. Autoryzowane regresje P0 na Windows: **70 passed, 0 failed, 0 ignored**, source identity nie zmieniła się podczas wykonania. Nie jest to pełna kwalifikacja P0 ani wydania: power loss, pozostałe platformy, API runtime i pomiary baseline pozostają otwarte. Szczegóły dowodów i ograniczeń zapisano w [statusie implementacji](03-implementation-status.md) oraz [odbiorze minimalnym](05-minimal-gate.md).

### Rewalidacja bieżącego checkoutu

Po późniejszych poprawkach P0/P1 ponownie wykonano `just verify-session-persistence` na `master@14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, dirty source, bez zmiany źródła podczas runu. Najnowszy run `4315e35f99d74ffdb77159aaee82a9f5` ma stan `passed`, exit 0 i **51 + 7 + 12 = 70 passed, 0 failed, 0 ignored**. Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/windows-session-check/session-persistence/4315e35f99d74ffdb77159aaee82a9f5/receipt.json`; source digest `e2d92e4dc84a05ffe3c733141ae3981fc575bde85bc2d436688346596d7aa4df`, receipt SHA-256 `30F08AC207B7D2110D498CAD5035E004F4430A9FB5CF8F4AE5BFB773EF07D4A5`, log SHA-256 `6D036D9E4D259A9B5609E06B60B2AFAE3D3F4E309E3C7DE471F9D3B6F908A045`.

Ponownie wykonano także `just verify-fem-mixed-p1-capability-contract`: walidator i **9 testów Python** przeszły, a managed receipt `3c62609c6fd5478a93f62bbf99c6a4ed` ma **24/24 testy capability**, source unchanged, receipt SHA-256 `AADA3E065D58D704C8E81DDD3D9F2C14E811270DA9A8B2EEE741AD002959C23F`. Te przebiegi aktualizują dowód kontraktowy; nie kwalifikują power-loss, API runtime ani fizyki.

| Dokument | Zawartość |
|---|---|
| [01-inventory.md](01-inventory.md) | Wejścia, API, handlery, konsumenci, ABI, lane’y i 18 materiałów audytu. |
| [inventory.json](inventory.json) | Maszynowy zapis inwentaryzacji i hashy. |
| [02-baseline.md](02-baseline.md) | Zachowane fixture’y, historyczne dowody i progi przyszłych pomiarów. |
| [02-baseline-manifest.json](02-baseline-manifest.json) | Tożsamość fixture’ów i receiptów; brak pomiaru pozostaje jawny. |
| [03-implementation-status.md](03-implementation-status.md) | Aktualny stan A–F, ograniczenia i kroki odblokowania. |
| [04-storage-protocol.md](04-storage-protocol.md) | Zapis, GC, import/eksport, platformy i procedura diagnozy niepewnej publikacji. |
| [05-minimal-gate.md](05-minimal-gate.md) | Wynik wykonanych regresji i warunki rozpoczęcia P1. |
| [06-completion-audit.md](06-completion-audit.md) | Pełna lista warunków P0; źródłowa korekta reporting capabilities FEM/FK i jej regresja są udokumentowane, a API runtime pozostaje osobną bramką. |

Nie uruchamiano GC na danych użytkownika ani nie zmieniano współdzielonych submodułów. Nie wykonywano stagingu, commita, pushu ani merge nieweryfikowanej implementacji.
