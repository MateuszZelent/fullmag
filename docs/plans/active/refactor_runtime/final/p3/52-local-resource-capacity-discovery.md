# P3/P5 — lokalne discovery pojemności zasobów

Data checkpointu: 27.09.2026.

## Zakres

`fullmag-api-resource-pool` może teraz zbudować pulę z bieżącej pojemności
hosta. Wykrywa logiczne CPU, dostępną pamięć fizyczną, wolne miejsce na
filesystemie wskazanym przez `--store-root` oraz wolny VRAM kart NVIDIA przez
`nvidia-smi`. Operator podaje stabilny identyfikator hosta i jawne rezerwy CPU,
RAM oraz storage. Brak pomiaru albo rezerwa większa od dostępnej pojemności
kończy publikację fail-closed.

CPU, RAM i storage są wspólną pojemnością hosta. Po odjęciu rezerw publikator
dzieli je równo między ofertę CPU i wykryte oferty GPU, dzięki czemu równoległe
zasoby nie deklarują wielokrotnie tej samej pamięci lub przestrzeni dyskowej.
Każde GPU zachowuje własny zmierzony wolny VRAM i stabilny identyfikator UUID.
`--require-gpu true` blokuje publikację bez karty; tryb opcjonalny publikuje
CPU z jawnym `gpu_status=unavailable` i przyczyną.

Tryb `--dry-run true` wykonuje pełny pomiar i walidację snapshotu bez otwierania
SessionStore oraz bez zmiany generacji puli. Dotychczasowe jawne
`--resource-offer` i pole wyjścia `resource_ids` pozostają zgodne.

## Dowody

| Bramka | Wynik | Dowód | Granica |
|---|---:|---|---|
| Source-only resource-pool binary | PASS | receipt `bdbc2e6b74ff4f09ba55074b1e4509b1` | `cargo check --locked` bez targetów testowych. |
| Managed local discovery dry-run | PASS | receipt `0689f7a754844492a208b379996b9e85` | Pomiar hosta bez publikacji do store. |
| Host CPU/RAM/storage | PASS | 48 000 CPU millis, 96 988 733 440 B RAM, 29 014 499 328 B storage | Wartości chwilowe z czasu próby. |
| NVIDIA discovery | PASS | 1 GPU, UUID `GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`, 8 987 344 896 B wolnego VRAM | Dowodzi dostępności tej karty w czasie próby, nie wykonania solvera GPU. |
| Partycjonowanie wspólnej pojemności | PASS | dwie oferty po 24 000 CPU millis, 48 494 366 720 B RAM i 14 507 249 664 B storage | Brak podwójnego zadeklarowania wspólnych zasobów w snapshotcie. |
| Discovery → publikacja → scheduler → solver | PASS | receipt `61dc4f8fb04345e889207ca3aecaa47a`; szczegóły w [`53-resource-discovery-process-e2e.md`](53-resource-discovery-process-e2e.md) | Osobna bramka procesowa FDM CPU; `dry-run` nadal pozostaje niemutującym dowodem samego discovery. |
| Zachowanie przy braku `nvidia-smi` i przekroczonych rezerwach | NOT RUN | walidacja jest zaimplementowana | Aktywny zakaz kompilowania i uruchamiania testów jednostkowych. |

## Granica checkpointu

Pomiar opisuje chwilowo dostępną pojemność i nie jest egzekwowaniem limitów
przez system operacyjny, kontener albo sterownik. Nie wykrywa hostów zdalnych,
nie agreguje puli klastra i nie dodaje priorytetów ani backpressure. Osobna
bramka procesowa publikuje snapshot do SessionStore, uruchamia rezydentny
scheduler i potwierdza admission oraz zwolnienie dokładnego lease dla FDM CPU.

Po tym przyroście: **P3 85%, P5 68%, całość około 43%**.
