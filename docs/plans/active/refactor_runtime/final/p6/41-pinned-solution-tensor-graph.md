# Przyrost 41 — przypięty tensor i trwały graf chunków

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i kontrakt: `738b0f9e4c31ca4bb7d09c044bede977912c2975`, opublikowany na remote master.

## Wynik

Dodano read-only resolver tensora z dokładnej rewizji SolutionSet. Wymaga
runu, RunSpec digest, set/revision, member/artifact i root CAS hash.
Nie przyjmuje descriptora od klienta ani nie wybiera aktywnej sesji/current.
Zweryfikowany root ma limit 4 MiB, zgodne axes/shape, little endian,
spójne zakresy wyrównane do dtype i najwyżej 16384 chunków.
Statusy wykonania, accepted state i oceny naukowe pozostają oryginalne.

Znaleziono i usunięto lukę źródłową: artefakt `fullmag.tensor.v1` był
traktowany jako pojedynczy CAS leaf. Teraz publikacja sprawdza również
SHA-256 i długości chunków przed zapisem rewizji. Katalog sprawdza typed
graf przed promocją po awarii, a trwałe referencje i pin retirement
obejmują descriptor oraz payloady. Store/Archive walkers rozwijają ten
sam typowany graf podczas GC, eksportu i importu.

## Granice

- Resolver zwraca metadane; nie certyfikuje wszystkich payloadów przy każdym
  odczycie. Publication barrier i odczyt rzeczywistych CAS bytes mają osobne zadania.
- Project ownership pozostaje w aplikacji/API. Resolver sesji pilnuje runu
  i digestu RunSpec, bez dodawania alternatywnego katalogu projektu.
- Nieznane schema IDs nadal są opaque leaves. Nie oznacza to kwalifikacji
  ich struktur; nowy structural writer wymaga osobnej obsługi całego grafu.
- Nie opublikowano MaterializedDataset ani wyniku porównania i nie dodano
  comparison API/UI. Powiązanie dataset→tensor pozostaje następnym krokiem.
- Ograniczono typed root read; starsze checkpoint traversal i pełne koszty
  katalogu/recovery nadal mają otwarte bramki pamięci/performance.

## Dowody i ograniczenia wykonania

Produkcja API/session/quantities: **PASS**, exit 0,
`source_changed_during_run=false`, receipt
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/5dd3296921ea4ca586917092b0401056/receipt.json`.
Nie kompilowano ani nie uruchamiano unit tests. Dodano siedem regresji
źródłowych: parser/budżety, błędne chunky przed publikacją, fences resolvera,
ochrona chunków w store/archive, bezpośrednia bariera katalogu i trwały graf.
Regresja orphan-reconcile oraz end-to-end import/recovery pozostają otwarte.

Niezależny bounded review rdzenia i hooków: **PASS dla przyrostu**, bez blokera P0.
Wskazano P1 integracyjny: export SolutionSet może nie dołączyć run intent,
więc po imporcie nowy resolver nie rozwiąże właściciela. Nie zaliczono typed
FMS round-trip; wymagane jest closure ownera i osobny regression check.

Sprawdzono parser/format nowych plików, scoped staged diff i UTF-8 spec.
Dla trzech wcześniej dirty plików potwierdzono równoważność po normalizacji
formatu, pozostawiając cudze zmiany poza indexem.

## Aktualny stan runnera

Ponowny odczyt 30.09.2026: `worker_alive=true`, `accepting_jobs=true`,
`worker_error=null`, `storage_free_bytes=18151600128` (około 16,9 GiB).
Poprzednia blokada storage nie jest już aktualnym stanem.

Job source36 `a5b88dbd27414615ae44413357d542b7` ma `failed`, exit 2:
`workspace mountpoint is unsafe: /workspace/.fullmag-cargo`.
Późniejszy odczyt: job source37 `106c264dfe954e6b816a7811bbde2d4b` ma
`failed`, exit 2: wymagany Rust nightly nie jest zainstalowany.
Ten sam układ mountów przeszedł w job37 kontrolę, więc nie luzowano guard job36.
Żaden z tych stanów nie dowodzi runtime przyrostu 41.
Nie zlecano nowego ciężkiego buildu, nie restartowano runnera ani nie usuwano danych.

Kontrakt: [Przypięty tensor SolutionSet](../../../../../specs/pinned-solution-tensor-v1.md).

## Następne kroki

1. Domknięcie RunSpec/run intent ownera eksportowanych SolutionSet i typed round-trip.
2. Trwały dataset owner/materializer wiążący semantykę datasetu z przypiętym tensorem.
3. Publikacja signed-difference z pełną provenance, następnie comparison API/client.
4. PlotDefinition/export recipes i istniejący consumer UI.
5. Regresje wykonane po odwołaniu zakazu, managed runtime i pomiary pamięci.
