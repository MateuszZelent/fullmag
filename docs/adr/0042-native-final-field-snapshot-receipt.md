# ADR 0042 — receipt natywnej reprezentacji finalnego pola

Status: accepted for implementation. Data: 01.10.2026.

## Decyzja

Finalne pole magnetyzacji z natywnej finalizacji FEM CPU/GPU otrzymuje optional
`native_state_snapshot` na poziomie głównym dokumentu `m_final.json`.
Typ `fullmag.fem_local_node_snapshot_receipt.v1` jest własnością
`fullmag-quantities::fem_state_snapshot_receipt`. Zawiera exact step/time/dt,
hash F64 little-endian pełnego lokalnego AoS oraz representation receipt
odczytany z aktualnego handle natywnego backendu przy finalnym snapshotcie.
Nie rekonstruujemy receiptu z planu ani ostatniego zapamiętanego StepStats.

Receipt pozostaje poza `layout`. Layout hash jest tożsamością przestrzeni;
czas i wartości nie mogą zmieniać jej fingerprintu. Dotychczasowy
`magnetization_state.v1` i codec field JSON v1 zachowują layout/values, a nowy
czytnik przyjmuje brak receiptu w zapisach legacy. Present null, nieznany typ
lub niezgodna struktura nie stają się legacy None.

Finalizer przechowuje mały receipt w istniejącym `AuxiliaryArtifact`, który
writer rozpoznaje po dokładnej ścieżce. Writer sprawdza jednoznaczność,
executed native provenance, node count i digest wartości przed publikacją
JSON. Timestamp receiptu jest autorytetem dla finalnego pola także wtedy,
gdy próbkowany trace diagnostyczny nie zawiera ostatniego endpointu.
Initial state i zaplanowane snapshoty nie dziedziczą finalnego receiptu.

## Periodyczność i granica dowodów

`state_space = local_node_aos` wymaga liczby local nodes równej liczbie
próbek. `true_node_count` musi być dodatnie i nie większe od local. Redukcja
true < local wymaga nonzero `periodic_map_revision`; sama redukcja jest legalna.
Odrzucamy invalid-space assertions i niespójne liczniki reprezentacji.

Źródłowy eksport MFEM wykonuje GetTrueDofs → SetFromTrueDofs → pełne lokalne
GridFunction → AoS → periodic validation. GPU eksportuje również pełny
lokalny AoS. Map revision w natywnym kodzie jest FNV z mapy periodycznej;
nie jest kryptograficznym digestem ani trwałym obiektem mapy. Receipt v1 nie
certyfikuje powiązania native indices z kanonicznym MeshIR. Geometry root
z ADR 0041 nadal ma wyłącznie `representation_evidence = not_verified`.

## Integralność i konsumenci

Parser metadata ma limit 16 KiB i odrzuca ignorowane nested fields. Limit
egzekwuje również przed klonowaniem Value wyjętego z większego dokumentu.
Digest jest liczony inkrementalnie, bez dodatkowej pełnej kopii pola. Workspace
serde_json używa `float_roundtrip`, więc przejście przez JSON nie powinno
zmieniać bitów skończonych F64; regresja obejmuje także znak zera.

Application codec waliduje top-level receipt względem exact endpointu,
wartości i native provenance przed udostępnieniem stanu oraz materializacją
tensora. Immutable source CAS zawiera receipt razem z wartościami;
`tensor_owner_fingerprint` obejmuje jego source object ref. Istniejąca
publikacja SolutionSet zachowuje źródłowy artefakt. Nie powstaje drugi output
catalog ani ścieżka odkrywania receiptu przez skan katalogu.

Receipt nie jest osobnym zasobem API. P6-56 dodaje jawny
`read_pinned_study_tensor_snapshot`: odczyt exact historycznej rewizji,
sprawdzenie źródła w tym samym memberze, accepted state, pełnej tożsamości
bindingu oraz hasha wszystkich uporządkowanych bajtów F64 tensora względem
receiptu z source CAS. Legacy bez receiptu zwraca None po sprawdzeniu bindingu;
nie poświadcza wtedy payloadu. Odczyt całego pola jest osobną operacją,
nie częścią zwykłego pobierania slice ani ścieżką renderowania.

Source JSON ma istniejący limit 64 MiB; limit serializacji nie jest limitem
peak RAM. Podczas odczytu tensora zwalniamy wektor źródłowych wartości i
czytamy po jednym zweryfikowanym chunku do 196 608 B, zgodnie z rozmiarem
chunków producenta. Wciąż potrzebna jest natywna mapa/digest, zanim geometry
root otrzyma mocniejszy status i uruchomimy przestrzenny konsument ilościowy.

## Weryfikacja i rollback

Production default source check obejmuje quantities, application codec i
writer; nie dowodzi kompilacji feature-gated `fem-native` ani wykonania FFI.
Źródła regresji sprawdzają periodic local export, wartości/endpoint, unknown
fields, metadata budget, native provenance, legacy i sparse trace. Unit
compilation pozostaje wyłączona zgodnie z poleceniem użytkownika.
Natywny build, runtime, FMS, RAM, nauka i release wymagają osobnych bramek.

Rollback może wyłączyć nową produkcję, ale zachowuje nowy reader: stary codec
deny_unknown_fields nie odczyta nowego top-level pola. Nie usuwamy zapisanych
source CAS ani typed geometry roots.

## Źródła decyzji

- `backends/fem/cpu/mfem/runtime/aos_field.cpp::copy_mfem_state_to_local_node_aos`.
- `backends/fem/cpu/mfem/runtime/state_io.cpp::context_upload_magnetization_f64`.
- `backends/fem/core/fem_mesh.cpp::periodic_map_revision`.
- `crates/fullmag-runner/src/native_fem.rs::representation_receipt`.
- `crates/fullmag-runner/src/fem/relax/finalize.rs::copy_native_equilibrium_evaluation`.
- `crates/fullmag-runner/src/artifacts.rs::final_native_snapshot_receipt`.
- `crates/fullmag-application/src/study_artifact.rs::validate_native_magnetization_snapshot`.
- `crates/fullmag-runtime-control/src/study_field_tensor.rs::tensor_owner_fingerprint`.
- [Kontrakt geometrii w SI](../physics/0100-mesh-and-region-discretization.md).
