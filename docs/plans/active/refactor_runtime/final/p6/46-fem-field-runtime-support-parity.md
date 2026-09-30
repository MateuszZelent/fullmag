# Przyrost 46 — zgodność opisu pola z aktywnymi regionami runtime

Data: 2026-10-01. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod: `131d884a41c81938b7e4ea11f40f8a36ddec9663`, opublikowany na remote master. Końcowy receipt: `C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/6d65776bc08d49298e2773f5c9e8e1fc/receipt.json`.

## Przyczyna i poprawka

Dodatkowy przegląd natywnej ścieżki po przyroście 45 wskazał dwa P1:
strukturalna walidacja mesha nie była pełną bramką wykonania, a maska
producenta korzystała z pierwotnych markerów, podczas gdy runtime
normalizuje je według kontraktu regionów. Kontrola kompilacji sama
nie wykrywa tej różnicy zachowania.

Fabryka producenta stosuje `validate_mesh_for_execution`, która obejmuje
strukturalną i ścisłą walidację geometrii. Korzysta także z dokładnie tej
samej funkcji `normalized_runtime_element_markers`, której używa plan
wykonawczy FEM. Nie dodaje się osobnej interpretacji magnetic support.
Maska węzłów powstaje z oryginalnego mesha i jawnych normalizowanych
markerów, bez pełnej kopii topologii. Fingerprint topologii nadal
identyfikuje oryginalny accepted mesh.

Wszystkie markery zerowe bez zadanych regionów zachowują istniejącą
interpretację legacy: magnetic support w całym mesh. Dotychczasowy
preview helper też stosował tę regułę; nie stwierdzono w tym przypadku
różnicy wartości maski. Brakowało natomiast jawnego sprawdzenia wspólnego
kontraktu regionów: niejednoznaczne dodatnie markery bez deklaracji
kończą się błędem runtime i teraz także fabryki producenta. Nie zmienia
się algorytm solvera, polityka regionów ani numeryka.

## Dowody i granice

| Bramka | Wynik |
|---|---|
| Końcowa kompilacja źródeł produkcyjnych | PASS, końcowe źródła stabilne, exit 0 |
| Niezależny przegląd geometrii i supportu | PASS, brak pozostałych P0/P1 dla tej poprawki |
| Scoped staging bez obcego formatowania | PASS, HEAD-based candidates, canonical rustfmt zgodny |
| Regresje jednostkowe | NOT COMPILED / NOT RUN |
| Managed runtime, geometria wykonana, peak RAM i release | NOT VERIFIED |

Dodane źródła regresji obejmują zdegenerowaną geometrię, zgodność maski
węzłów dla jawnego regionu z airbox, all-zero legacy oraz odrzucenie
niejednoznacznych dodatnich markerów. Pozostają niewykonane i nieskompilowane
zgodnie z bieżącym zakazem. Kontrola produkcyjna ich nie kompiluje.

Poprawka zamyka wymienione różnice w źródłowym kontrakcie. Nie jest
kwalifikacją solvera ani naukową walidacją pola. Oceny naukowe i accepted
state pozostają oryginalne. Obowiązuje ograniczenie źródłowego JSON do
64 MiB i brak pełnego streamingowego dekodera.

## Następny etap P6

Audyt istniejących typów potwierdził brak trwałego manifestu datasetu:
`DatasetDefinition` i `MaterializedDataset` są obecnie kontraktami,
a binding tensora nie zastępuje ich publikacji. Najmniejszy następny
slice obejmie jeden zapisany artefakt FEM P1, jeden sample/item/field,
pełną coverage z typed tensor rootu i dokładny pinned SolutionSet owner.
Nie wolno użyć mutable artifact paths z bieżącego dataset index jako
trwałego źródła wyników.

Katalog datasetów musi kodować tożsamości przez bezpieczny klucz ścieżki:
aktualne `dataset:study-state:<hash>` zawiera dwukropki i nie jest nazwą
pliku. Manifest musi wiązać definicję, dodatnie rewizje, RunSpec,
exact owner i descriptor oraz zweryfikować cały graf CAS. `Ready` można
opublikować dopiero po trwałej publikacji właściciela i sprawdzeniu danych.
Osobna publikacja SolutionSet wymaga idempotentnej koordynacji/recovery;
nie wolno przedstawiać dwóch niezależnych zapisów jako atomowej operacji.

Przed włączeniem writera datasetów trzeba dodać pełny graf do publication,
recovery, GC, eksportu i importu FMS. Nie tworzy się drugiego Results store
ani kopii payloadów. API/generated client i consumer UI następują po
tej trwałej granicy. Runtime/P7/P8 pozostają otwarte.

Osobny follow-up z przeglądu: sprawdzić powtórną normalizację w natywnym
runtime, gdy dispatch przekazał już markery `0/1`, a `region_materials`
zachowuje pierwotny marker inny niż `1`. Nie jest to zmiana wprowadzona
przez ten przyrost; pozostaje nieweryfikowaną granicą wykonania i nie wolno
na podstawie source check deklarować obsługi tego przypadku w runtime.
