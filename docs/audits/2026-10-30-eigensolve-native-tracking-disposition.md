# I1/I6 — disposition natywnego providera tracking, 30.10.2026

Źródła sprawdzone na `c593135c08c7007a3c723ad0cfbb977a36a452e8`.
Review tylko do odczytu, bez testów i buildów. Pełny trace z liniami i hashami
zachowano w zewnętrznym `final-integration-20261030/native-tracking-disposition.md`.

| Historyczny kontrakt | Decyzja | Obecny dowód |
|---|---|---|
| `4c7d24499542bfad6ad7082c6906e061c5dad51d`: provider P1 | Obecny odpowiednik; nie przenosić ponownie | `14fc9280e39a1551743a375a491257819012ce5e` odzyskał identyczne bloby provider.cpp/.hpp; guardy wymiarów i P1, Tet4/Prism6, CSR i puste wiersze powietrza w `tracking_mass_provider.cpp:95–380` |
| `2976b2bdd806ec197e5b2ed9a93dc58dc73a78dd`: immutable snapshot C ABI | Obecny odpowiednik z adaptacją źródłowej tożsamości | `tracking_mass_snapshot.cpp:179–208` odczytuje runtime build-info zamiast makra compile-time; wrapper `native_fem/tracking_mass.rs:294–390` wymaga zgodnego źródła, ABI, generacji, rozmiarów i digestów |
| `ba26ef88a46175f183ee290b41639fc102f9d7c7`: zamknięcie warunku testu | Poprawka obecna w źródle | `tracking_mass_snapshot_contract_test.cpp:505` zawiera brakujące #endif; nie jest to nowy dowód wykonania CTest |
| `18cfc2a2e0e684934839a04e3ce2ae6cf8f7c693`: admission przed alokacją | Obecny w historii | `fem/eigen_path.rs:3548–3588`: checkpoint/admission Completed przed utworzeniem metryki; failure/interruption nie alokuje nowej metryki |

Producent tworzy natywny CSR dla tych samych vertexów/maski magnetyka
(`fem/eigen_path.rs:554–590`). Tracker odrzuca niezgodne pary metryk
(`eigen/tracking.rs:253–260`); artifact modu zachowuje metrykę i dokładne
powiązania mesh/equilibrium/handoff (`eigen/artifacts/mode_bundle.rs:201–215,303–327`).
Parser sprawdza raw mode index, source mesh, k oraz długości/wartości pola
(`fem/eigen_path_artifacts.rs:2689–2813`); remap do sample namespace jest jawny
(`:4230–4324`).

Prism6 pozostaje pokryciem providera/API: produkcyjny MeshTopology jest Tet4.
Enum provenance score nadal nazywa Tet4 i wymaga neutralnej nazwy dopiero
przy przyszłym podłączeniu Prism6. Kwalifikacja runtime tracking jest otwarta.
Review dotyczy tych kontraktów, nie wszystkich plików historycznych commitów;
pozostawiono ich globalny pending-semantic-review. I1/I6 nie są zamknięte.
