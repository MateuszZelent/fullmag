# ADR 0043 — trwała mapa indeksów lokalnego pola FEM

Data: 01.10.2026. Status: zaakceptowany kontrakt; wykonanie native NOT VERIFIED.

## Problem

Obecny adapter kopiuje AoS node `i` do scalar GridFunction slot `i`. Równa
liczba DOF i wierzchołków nie dowodzi zgodnej numeracji. Ponadto istniejący
`representation_receipt_v1.true_node_count` pochodzi z klas periodycznych
Fullmaga, nie z `FiniteElementSpace::GetTrueVSize()`. Zachowujemy znaczenie
tego starszego pola; nowy kontrakt rozdziela obie przestrzenie.

## Decyzja

W setupie kontekstu i stateless preparation sprawdzamy rzeczywiste scalar
vertex DOF: dokładnie jeden indeks na wierzchołek, równy canonical node index.
Nie obsługujemy permutacji przez samo opisanie jej w receipcie, ponieważ
obecny adapter nie wykonuje remappingu. Nie skanujemy przestrzeni w hot loop.

Additive C ABI `fullmag_fem_local_node_map_v1` odczytuje ten sam handle co
finalny snapshot. Zawiera oddzielne local-node count, MFEM local/true DOF
count, core periodic class count i core map revision. Osobna funkcja kopiuje
caller-owned tablice: canonical node→MFEM local DOF, local node→core class,
core class→representative. Nie udaje mapy MFEM true→local prolongation.

FFI odrzuca nieznaną wersję, błędny rozmiar, niezgodne extenty, brak scalar
P1 identity i nieprawidłowe klasy/representatives. Rust sprawdza ABI oraz
extenty przed alokacją. Obsługiwana liczba node map entries nie przekracza
4 194 304; JSON mapy ma limit 64 MiB. Są to limity wejścia, nie zmierzony
peak RAM. Native cold export i dekodowanie mają dodatkowe bufory O(n).

Mapped source JSON ma wspólny limit 64 MiB dla wartości, mapy i całej
metadata razem. Writer liczy rozmiar dokładnej pretty JSON serialization
przez ograniczony sink przed utworzeniem pliku. Codec i materializer używają
tej samej stałej; dwa osobno poprawne payloady nie omijają wspólnej granicy.

`fullmag.fem_local_node_index_map.v1` jest top-level `native_node_map` w
źródłowym `m_final.json`, oddzielnie od layout fingerprint. Mały snapshot
receipt zawiera optional `native_node_map_sha256`. Hash mapy jest liczony
inkrementalnie z bajtów:

1. UTF-8 schema string i pojedynczy NUL;
2. pięć U64 LE: local count, MFEM local count, MFEM true count, core class
   count, core revision;
3. trzy tablice w kolejności nazw powyżej: U64 LE długość, potem U32 LE entries.

Actual map arrays i map digest powstają z wykonującego handle. Finalizacja
sprawdza zgodność mapy z representation receiptem. Writer i application codec
sprawdzają wspólną obecność mapy/hasza, ich integralność, extenty i native
provenance. Mapa jest częścią immutable source CAS, który już uczestniczy
w tożsamości ownera tensora; nie powstaje nowy luźny CAS root.

## Zgodność i ograniczenia

Exact saved snapshot reader dla mapowanego źródła wymaga jednego geometry
bindingu w dokładnym historycznym owner/member i zgodnego tensor descriptor.
Porównuje actual core class arrays oraz compatibility revision z klasami
odtworzonymi z canonical MeshIR periodic node pairs. Porównanie partycji
nie certyfikuje live native coordinates/connectivity i nie zmienia
`representation_evidence`. Legacy źródło bez mapy zachowuje dawny odczyt.

Legacy bez mapy/hasza pozostaje czytelne. Present null, mapa bez hasza lub
hash bez mapy są błędem. Nowe dane wymagają zachowania nowego readera po
rollback writera. Nie zmieniamy schematu `representation_receipt_v1` ani
znaczenia jego pól. Nie dodajemy endpointów ani transportu viewportu.

Nadal `representation_evidence = not_verified`. Mapa indeksów nie zastępuje
managed native compilation/runtime, dokładnego powiązania zapisanego MeshIR
z wykonaniem, FMS round-trip, parytetu CPU/GPU, pomiaru RAM i walidacji nauki.
Nie aktywuje przestrzennego renderera. Wcześniejszy build 189 ma inne źródła
i nie może kwalifikować tego przyrostu.

## Źródła

- `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp` — canonical vertices,
  connectivity oraz local DOF identity guard.
- `backends/fem/src/api.cpp` — handle-bound local-node map ABI.
- `backends/fem/core/fem_mesh.cpp` — actual core periodic classes.
- `crates/fullmag-quantities/src/fem_local_node_map.rs` — payload i digest.
- [ADR 0042](0042-native-final-field-snapshot-receipt.md).
- [Geometria i dyskretyzacja](../physics/0100-mesh-and-region-discretization.md).
- [MFEM GetVertexDofs](https://docs.mfem.org/4.8/classmfem_1_1FiniteElementSpace.html)
  — indeksy zwracane przez API są lokalnymi DOF, nie true DOF.
