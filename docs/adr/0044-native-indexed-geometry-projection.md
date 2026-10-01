# ADR 0044 — projekcja rzeczywistej geometrii indeksowanej FEM

Data: 01.10.2026. Status: przyjęta dla kodu; kwalifikacja runtime otwarta.
Kontynuacja [ADR 0043](0043-native-local-node-index-map.md).

## Problem

Mapa vertex→local DOF i zgodna partycja periodyczna nie dowodzą, że finalne
współrzędne oraz ordered cell connectivity żywego MFEM odpowiadają saved
MeshIR. Fingerprint stateless preparation nie jest odczytem wykonania.
Pełny MeshIR ma również markery, fasety, periodyczność i inne metadane,
których nie wolno domniemywać z samej przestrzeni MFEM.

## Decyzja

Dodajemy cold C ABI `copy_local_node_geometry_v1` i
`copy_local_cell_geometry_v1`. Każde wywołanie wymaga expected complete
node/cell counts i zakresu 1..4096 encji; maksymalna liczność to 4 194 304
węzłów i komórek. Bufory są caller-owned i mają dokładną długość, alignment
oraz bezpieczny address span. Cały chunk jest walidowany w bounded temp
przed zapisem. Wyjątek nie przekracza C ABI. Bez MFEM stack: unavailable.

Eksport sprawdza ready scalar P1, powiązanie FES z rzeczywistą siatką,
Dimension/SpaceDimension 3, extenty, vertex DOF identity, skończone i
bitowo zgodne coordinates oraz actual cell geometry, arytet i ordered
`GetElementVertices` względem Context. Typed cell records mają dziewięć
U32: type 1/2/3/4 dla Tet4/Prism6/Pyramid5/Hex8 i osiem slotów węzłów.
Unused slots są zero. Original global ordinal nie jest local index.
Właścicielem odczytu jest `cpu/mfem/runtime/indexed_geometry.*`; C ABI
zachowuje wyłącznie walidację caller buffers, wywołanie i propagację błędów.

Rust `&mut NativeFemBackend` wymaga wyłącznego dostępu po stepping i
zwolnieniu preview handoff. Zewnętrzny C caller ma ten sam obowiązek:
nie wolno wykonywać równoległej mutacji solvera/Context. ABI nie tworzy
mutexa ani serwerowego snapshot tokenu. Każdy chunk jest atomowy dla
jego bufora; cały snapshot jest publikowany dopiero po wszystkich chunkach.
Błąd późniejszego chunku odrzuca cały hasher i nie daje częściowego digestu.

SHA-256 preimage: UTF-8 `fullmag.fem_native_indexed_geometry.v1`, NUL,
node count U64LE, cell count U64LE, wszystkie ordered xyz F64LE,
następnie wszystkie ordered dziewięciosłowowe cell records U32LE.
IEEE bits, w tym signed zero, są zachowane; nie haszujemy host byte casts.
To nowy digest projekcji, nie full MeshIR/v3 ani geometry qualification.
Shared incremental hasher ogranicza work buffers do chunku; pełny snapshot
nie jest ponownie alokowany. Nie jest to pomiar peak RAM całego solvera.

Finalizacja porównuje observed digest z accepted MeshIR projection przed
publikacją receiptu. Mały `native_state_snapshot` dostaje optional
`native_indexed_geometry_sha256`, wymagający powiązanej native node map.
Writer/codec zachowują receipt w immutable source CAS. Exact saved reader
ponownie porównuje digest z geometrią dokładnego historycznego ownera.
Nie powstaje dodatkowy CAS root ani zmiana layout fingerprintu.

## Zgodność, rollback i bramki

Legacy receipt bez nowego pola pozostaje czytelny, również z mapą P6-57.
Present null/malformed hash i geometry hash bez map hash są odrzucane.
Wyłączenie nowego writera zachowuje nowe readery dla już zapisanych danych.
Żaden reader nie podnosi `representation_evidence = not_verified`.

Native compile/runtime, mapped CAS/FMS round-trip, CPU/GPU parity, RAM,
binary geometry API, renderer, nauka i release nadal wymagają osobnych
dowodów. Projekcja nie zawiera markerów, faset, magnetic support ani
periodic metadata; ich dotychczasowe typed contracts pozostają wymagane.

Źródła: `backends/fem/src/api.cpp`, `native/include/fullmag_fem.h`,
`crates/fullmag-quantities/src/fem_native_indexed_geometry.rs`,
`crates/fullmag-ir/src/native_indexed_geometry.rs`,
`crates/fullmag-runner/src/native_fem/indexed_geometry.rs` oraz
[kontrakt geometrii](../physics/0100-mesh-and-region-discretization.md).
