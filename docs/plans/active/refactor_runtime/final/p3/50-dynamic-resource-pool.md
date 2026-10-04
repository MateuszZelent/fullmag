# P3/P5 — dynamiczna trwała pula zasobów

Data checkpointu: 27.09.2026.

Implementacja kontraktu store: `c4678be0580b425b3410d8e3c894f29daeb31c4d`.
Implementacja schedulera i publikatora:
`88363878387064cffdee31a70dc115c5a051c455`.

## Zakres

`scheduler_resource_pool.v1` przechowuje lokalny, monotoniczny snapshot
członkostwa puli. Każda oferta ma stabilne `resource_id`, rodzaj CPU/GPU i
kompletny budżet. `fullmag-api-resource-pool` publikuje kolejną generację przez
compare-and-swap; dopuszczalna jest jawna pusta pula.

Rezydentny `fullmag-api-accepted-scheduler --discover-resources true` odczytuje
snapshot przy każdym skanie. Aktywne nadzory są kluczowane przez `resource_id`,
a nie pozycję w wektorze. Usunięcie A z nowej generacji zatrzymuje nowe
admission na A, ale istniejący worker zachowuje dokładny offer i lease do
terminalnej rekoncyliacji. Ten sam aktywny identyfikator nie może zmienić rodzaju
ani budżetu. Cofnięcie generacji, konflikt tego samego numeru i zniknięcie
opublikowanej puli są błędami fail-closed.

Publikator jest częścią portable bundle i Windows MSI. Scheduler nadal
obsługuje zgodny tryb statycznych `--resource-offer` oraz pojedynczą ofertę
legacy.

## Dowody

| Bramka | Wynik | Receipt / wynik | Uwagi |
|---|---:|---|---|
| Trwałość `SessionStore` | PASS | `3a7b2e9ed95c4fe39e5249db865b867e` | Pusta gen. 1, replay, niepusta gen. 2, CAS, walidacja i reachability. |
| Dynamiczna pula, finalne źródło | 1/1 PASS | `aee0b2e7111f49fa85f05e591446e0eb` | Content `01f81e6636c4944eb52919452e19526e842fe24a17b07392eb13ff1051ddbec6`, `source_changed_during_run=false`. |
| Statyczna pula | 1/1 PASS | `8ea59c9d44f64d868e6276268fba73b1` | Regresja kluczowania wielu zasobów. |
| Resident run discovery | 1/1 PASS | `f3e6e263d3a340e1a759873f4871dad3` | Późny run i trwały kursor bez regresji. |
| Kontrakt dystrybucji | 12/12 PASS | `scripts/test_release_workflow_contract.py` | Portable, validator i MSI zawierają publikator. |

Pierwsza próba dynamiczna `4a9275987db64748b2a4bd99c3b9d8b0` ujawniła
pominięty retry odczytu lease przed spawnem supervisora. Granica używa teraz
wspólnej polityki, która ponawia wyłącznie typowany `StoreWriterBusy` i zachowuje
pięciosekundowy limit. Kolejna próba oraz końcowa bramka przeszły.

## Granica checkpointu

Dowód obejmuje lokalny store i ograniczony FDM CPU/double/strict. Snapshot nie
odkrywa sam hostów ani urządzeń i nie mierzy wolnej pamięci. Nadal brakuje
priorytetów, backpressure, zdalnego heartbeat/Stop ACK, process E2E GPU/FEM,
dowodu zwolnienia pamięci urządzenia i kwalifikacji release.

Po tym przyroście: **P3 84%, P5 64%, całość około 42%**.
