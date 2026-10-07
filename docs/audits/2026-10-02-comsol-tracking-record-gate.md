# S06/S12 — provenance trackingu w bramce COMSOL

## Stan zastany i regresja

Bazowy commit: `9d036af61c49cca7b3a5b0519405d85691d3b91a`.
`scripts/validate_comsol_dispersion_scientific_gate.py::_validate_branches`
sprawdzał kompletność próbek, odwołania do raw modów i częstotliwości.
Kompletna tabela bez `tracking_edge` otrzymywała jednak wynik `pass`.
To nie jest dowód ciągłości fizycznej gałęzi. Wykonana regresja ze ścieżką
trzech próbek i zmiennymi raw ID potwierdziła RED na bazie, GREEN po poprawce.

## Zmiana

`_validate_branch_tracking_evidence` wykorzystuje istniejący niezależny
`validate_tracking_edge_provenance`: polityka, source/metric, poprzednik,
raw ID, gap, rank i principal cosines muszą spełniać wspólny kontrakt.
Dla C1/A1 wymagane są także kompletne records, bezpośrednia ciągłość
sąsiednich próbek, spójna masa P1 i weighted pair albo subspace transport.
Frequency fallback, restart, gap, diagonal mass i Euclidean nie spełniają
tej bramki. Seed w pierwszej próbce nie dostaje fikcyjnego overlapu.
Kąty główne są odrębne od pair overlap; próba wpisania principal minimum
do `overlap_prev` jest odrzucana. C0 nie ma ścieżki wymagającej ciągłości.

Fixture'y testowe zawierają jawnie syntetyczne records. Nie uzupełniano nimi
żadnych rzeczywistych, historycznych wyników. Nowe przepisy kwalifikacji
nie podmieniają częstotliwości, gałęzi ani artefaktów solvera.

## Weryfikacja

| Kontrola | Wynik |
| --- | --- |
| Brak provenance, poprzedni kod | RED: `pass` zamiast oczekiwanego `fail` |
| Nowe kontrolne przypadki | 7 PASS, w tym fallback/metric, błędny predecessor, subspace kontra pair, aggregate |
| Istniejąca suite bramki COMSOL | 49 PASS, 63,53 s po korekcie globalnych statusów |
| Mapa naukowa 0831 | PASS |
| Native compilation / solver | Nie wykonywano |
| Nowe punkty dyspersji | 0 |

## P1 z review — globalna kwalifikacja

Review potwierdził, że sama nowa kontrola records nie wystarczała:
pusty globalny `reasons` nadal dawał `QUALIFIED` mimo niewykonanego replay.
Naprawiono propagację tej brakującej bramki. `campaign_contract_status=pass`
oznacza przejście kontrolek kampanii; dla C1/A1 nie jest kwalifikacją naukową.
`tracking_field_metric_replay.status=missing` blokuje globalne `qualified`,
`qualification` pozostaje `NOT VERIFIED`, a `scientific_qualification`
pozostaje `not_verified`. Agregator wymaga statusu naukowego także niezależnie
od starego pola `status`; historyczne raporty bez tego dowodu nie kwalifikują.

Regresja kampanii ze wszystkimi cases i syntetycznymi poprawnymi records
potwierdza contract pass, lecz C1/A1 i aggregate nie kwalifikują. C0 nie ma
ścieżki modów i zachowuje swoje istniejące bramki. Replay nie jest jeszcze
zaimplementowany; nie przyjęto jego deklaracji z zewnętrznego JSON jako dowodu.
Pełne wykonanie hash-bound metryki/pól pozostaje kolejnym zadaniem S06/S12.

## Pozostałe ograniczenia

To dodatkowy warunek strukturalny. Raport pokazuje
`field_metric_replay=NOT VERIFIED`; poprawny rekord nie dowodzi, że
opublikowany score odpowiada polom solvera. Odtworzenie metryki/overlapów
i kątów z hash-bound pól, continuity przez degeneracje i zbieżność kroku k
pozostają wymagane przez pełny plan. Status `pass` tej kontroli ani fixture
campaign nie jest odbiorem całego S06/S12 i release qualification.

Pozostaje także przegląd rozdzielenia ciągłej gałęzi od punktowego
najniższego pasma: obecny gate analityczny wymaga lowest-positive w każdym
k. Nie należy uznawać takiego sortowania za dowód śledzenia modów przez
crossing. Ten przyrost nie zmienia semantyki selekcji oracle.
