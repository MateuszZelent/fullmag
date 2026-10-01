# P6-57 — natywna mapa lokalnych indeksów FEM

Data: 01.10.2026. Baza: `e484716821e25ee4fb72f5371e899d25a983aee4`.
Status: przyrost źródłowy; native compilation/runtime otwarte; P6 około **52%**,
cały plan około **49%**.

## Rozstrzygnięcie audytu

`GetNDofs()==n_nodes` nie dowodzi vertex→local DOF identity. Dotychczasowy
adapter AoS i GridFunction używał indeksu `i` w obu przestrzeniach. Dodano
setup-only kontrolę rzeczywistych `GetVertexDofs`: scalar, jeden DOF na
wierzchołek, indeks równy canonical node index. Kontrola działa również
w stateless mesh/space preparation. Permutacja jest odrzucana; nie opisujemy
jej w receipcie bez zmiany adaptera.

`representation_receipt_v1.true_node_count` zachowuje wcześniejsze znaczenie
core periodic class count. Nowe ABI oddzielnie raportuje MFEM true DOF count.
Core periodic class map nie jest MFEM restriction/prolongation.

## Implementacja

- Additive C ABI 56 B, snapshot metadanych i caller-owned copy trzech tablic
  z tego samego live handle: node→MFEM local DOF, node→core class,
  class→representative. Walidacja scalar P1 identity, revision, extentów,
  reprezentantów, buforów i wyjątków; bez częściowego zapisu po błędzie.
- Safe wrapper Rust sprawdza ABI i extenty przed alokacją, kopiuje actual
  map arrays i waliduje ich semantykę. Finalizacja wiąże mapę z receipt
  dokładnie pobranego finalnego pola. Nie wykonuje device computation
  ani host/device transfer pola dla odczytu mapy.
- Typed map ma inkrementalny, domain-separated hash z count/revision i
  length-prefixed U32 LE arrays. MFEM true count może być inny od core class
  count; obie wartości uczestniczą w tożsamości.
- Mapa trafia do top-level `native_node_map` w `m_final.json`; mały receipt
  zawiera `native_node_map_sha256`. Writer i application codec sprawdzają
  wspólną obecność, digest, representation i provenance. Layout fingerprint
  pozostaje niezależny od snapshotu i mapy.
- Source CAS zawiera actual arrays. Existing tensor owner obejmuje source
  object ref. Exact saved snapshot reader waliduje mapę przy odczycie źródła
  i zwalnia jej tablice przed weryfikacją całego tensora. Nie powstaje luźny
  CAS root wymagający osobnej retencji.
- Legacy receipt bez map hash pozostaje czytelny. Present null, missing
  required map, duplicate map artifact, nonnative map i digest mismatch
  są odrzucane. Limity: 4 194 304 nodes i 64 MiB serialized map. Peak RAM
  pozostaje niezmierzony; cold native export/decode nadal mają bufory O(n).

Kontrakt: [ADR 0043](../../../../../adr/0043-native-local-node-index-map.md).

## Bramki

| Bramka | Stan |
|---|---|
| Niezależny audyt przyczyny i zakresu mapowania | PASS, source-only |
| Production default Rust source check | PASS, exit 0 |
| Końcowy review cross-layer i korekty limitu | Brak P0/P1 |
| Native C++ / feature-gated Rust compilation | NOT VERIFIED |
| Actual CPU/GPU handle export / snapshot | NOT VERIFIED |
| CAS/FMS exact map round-trip | NOT VERIFIED |
| Geometry transport, renderer, RAM, nauka, release | Otwarte |

Dodano źródła regresji scalar/vector/higher-order space, map extents,
identity/permutation, class representatives, oddzielnych MFEM/core counts,
hash round-trip, corrupted/missing/null map i duplicate auxiliary map.
Unit tests nie zostały skompilowane ani uruchomione zgodnie z aktualnym
zakazem. Source check nie dowodzi feature-gated native ścieżek.

Pierwszy production source receipt: `b3cafea1932442e7b836036a03e575df`.
Review wskazał P2 dotyczące sumy rozmiarów wartości i mapy. Dodano wspólny
limit 64 MiB całego mapped source: counting-sink preflight pretty JSON
przed zapisem oraz ta sama stała w codec/materializer. Obejmuje values,
map, provenance i state identity razem. Granica jest sprawdzana bez
alokowania drugiego pełnego serialized JSON na potrzeby preflight.
Źródła regresji obejmują dokładny limit i jego przekroczenie o jeden bajt.
Końcowy production source receipt po tej korekcie: PASS, exit 0,
`7826c433d9fd415ca76d92972a5ce6e7`,
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/`.
Spójność repozytorium, zmienione linki dokumentacji i diff check: PASS.

Build 189 (`529ac93e81744c5faf50494306d50a11`) nadal queued na poprzednim
commicie. Koordynator czeka na istniejący kontener dyspersji. Nie zatrzymano
aktywnego zadania i nie zgłoszono duplikatu. Ten build nie kwalifikuje P6-57.

## Dalsze prace

Uzyskać kompilację nowego immutable commita przez kolejkę i wykonać managed
snapshot proof. Następnie sprawdzić dokładną zgodność z zapisanym MeshIR oraz
round-trip CAS/FMS. Dopiero to pozwoli rozważyć mocniejsze geometry evidence,
binarny geometry API i renderer. `representation_evidence` nadal ma jedyny
dopuszczony stan `not_verified`.
