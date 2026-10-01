# P6-55 — receipt reprezentacji finalnego snapshotu FEM

Data: 01.10.2026. Baza: `2292af413f2922eef526a895a06d2e47cd79f018`.
Commit implementacji: `8bb7f068d097d94a5266983d64b07f2ca2d470b9`.
Status: przyrost źródłowy; P6 **IN PROGRESS, około 52%**, cały plan około **49%**.

## Zmiana

Natywna finalizacja FEM odczytuje representation receipt z aktualnego backend
handle przy pobraniu finalnego lokalnego pola. Nowy typ quantities wiąże go
z exact step/time/dt i SHA-256 kolejnych F64 LE `[node][component]`.
Hash nie wymaga dodatkowego pełnego bufora pola. Mały receipt przechodzi przez
istniejący AuxiliaryArtifact do writera `m_final.json`.

Writer sprawdza jednoznaczność, native provenance, node count i wartości.
Timestamp receiptu jest źródłem endpointu dla finalnego JSON, także przy
próbkowanej diagnostyce bez końcowego kroku. Receipt zapisujemy jako optional
top-level `native_state_snapshot`. Nie umieszczamy go w layout, więc czas,
wartości i liczniki nie zmieniają tożsamości przestrzeni. Initial/scheduled
fields nie dziedziczą dowodu finalnego snapshotu.

Application codec rozpoznaje typowany receipt, odrzuca present null/unknown
fields, niespójne liczniki, niezgodny endpoint/wartości i nonnative provenance.
Metadata ma limit 16 KiB także przed klonowaniem nested Value. Brak pola
zachowuje legacy None. Przed materializacją tensora stan przechodzi ten codec.
Receipt zostaje w immutable source CAS; source object ref uczestniczy w
tożsamości ownera wyprowadzonego tensora. Nie dodajemy osobnego katalogu.

Kontrakt i rollback: [ADR 0042](../../../../../adr/0042-native-final-field-snapshot-receipt.md).

## Rozstrzygnięcie periodic export

Follow-up audytu źródłowego potwierdził:

- MFEM `copy_mfem_state_to_local_node_aos` wykonuje GetTrueDofs → SetFromTrueDofs
  i eksportuje pełne local GridFunction do AoS z periodic validation.
- `state_io` i CUDA eksportują local node count, nie wektor true-space-only.
- FFI receipt dopuszcza true < local z nonzero periodic map revision.
- `periodic_map_revision` jest FNV z reduced/representative node arrays;
  nie jest ani licznikiem zdarzeń, ani kryptograficznym map certificate.
- Owner fingerprint obejmuje source object ref. Poprzednia sugestia o
  brakującym powtórzeniu topology/mask w preimage nie jest osobnym błędem.

Nie stosujemy blanket rejection redukcji periodycznej. Nadal brakuje trwałego
native map object/digest i dowodu powiązania z canonical MeshIR indices.
Geometry P6-54 zachowuje `representation_evidence = not_verified`.

## Weryfikacja

Default production API source check przeszedł po rozdzieleniu receiptu od
layout: `201fb1358fd646f486becd202b0c282e`. Końcowy przebieg po uporządkowaniu
nowych funkcji: PASS, exit 0,
`windows-api-source-check/api-source-check/a59c57a3886b4cc2925d0eacf4dabe50/receipt.json`.
Paths są względem `storage/builds/fullmag-0950f4dca4ffe38f`.
Spójność repozytorium PASS. Nie promujemy wyniku na feature-gated native kod.

Review końcowe nie znalazło P0/P1. Wariant z receiptem wewnątrz layout został
odrzucony przed commitem; obecny top-level zapis zachowuje space identity.
P2: JSON Value nie odrzuca duplicate keys; odczyt zachowuje ostatnią wartość.
Nie deklarujemy byte-canonical JSON parsera. Rollout wymaga zachowania readera
z nowym polem także po wyłączeniu writera, co opisuje ADR 0042.

Dodano źródła regresji quantities, producer writera i application codec:
local/true periodic count, map revision, finite F64/negative zero, endpoint,
corrupt values, unknown nested fields, metadata budget, native provenance,
duplicate proof, missing legacy proof, present null i stable space fingerprint.
Nie zostały skompilowane ani uruchomione zgodnie z aktualnym zakazem.

`just runner-container-status` zakończył się exit 1; klient zgłosił
`Container profile allow-list mismatch` (exit 2). Trasa zarządzanego native
buildu tym klientem była zablokowana przed potwierdzeniem health/admission.
Nie zmieniono konfiguracji operatora ani nie uruchomiono drugiego runnera.
Public config zawiera aktywny profil `fem-cpu-slepc-runtime-v2`, którego
starszy klient na masterze nie rozpoznaje.

Znaleziono zgodny istniejący klient w `worktrees/eigensolve-dispersion-plan-20260912`,
HEAD `1cf47b6d25b48cbb5b6813d6995ba5113fb03be4`; jego CLI i container client
miały czysty status. Wywołanie z jawnym `--worktree C:/git/fullmag/fullmag`
potwierdziło worker_alive/accepting_jobs=true, brak worker/coordinator errors,
brak aktywnych jobów i 42 087 309 312 B wolnego storage. Operator pozostaje
Mateusz. Status nie stanowi dowodu buildu ani native snapshotu.

Profil `fem-cpu-release` ma skonfigurowany immutable image
`sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.
Odczyt entrypoint/Makefile/build.rs potwierdził produkcyjne cargo build oraz
CMake target `fullmag_fem`, bez kompilacji unit tests. To pozwala zgłosić
immutable commit przez ten klient bez zmiany aktywnych profili. Nie jest to
zmiana żądanego GPU na CPU; gate dotyczy native FEM CPU compilation.

Zgłoszono build commita implementacji: sequence **189**, job
`529ac93e81744c5faf50494306d50a11`, request key
`7245aa42e25248209789512bcb9b60aa`, profile `fem-cpu-release`.
Source capsule digest:
`0d5297c1e21d5d743fd85cd6f179efd839d7cabe75b324f015f2d4952df46cdb`.
Native source snapshot:
`494960d87cdbdefc8fbd4e18fa051c4b3541ac41135e7dfbc4b8da21fe9da193`,
`source_snapshot_dirty=false`. Capsule zawiera dokładny commit; 107 lokalnych
obcych dirty paths nie jest wejściem buildu. Pierwszy status: **queued**,
exit code nieobecny. To nie jest native compilation PASS; dalsza obserwacja
musi używać tego samego job ID, bez ponownego zgłoszenia po timeout.

Ponowny odczyt podczas kontynuacji potwierdził **queued**, bez kodu zakończenia.
Wcześniejsze 30-sekundowe oczekiwanie zakończyło się timeoutem obserwacji,
nie błędem buildu. Bramka kompilacji pozostaje `NOT VERIFIED`.

| Bramka | Stan |
|---|---|
| Default Rust production source | PASS |
| Spójność i linki dokumentacji | PASS |
| Unit compilation/regressions | NOT RUN |
| Feature-gated `fem-native` compilation | NOT VERIFIED; job 189 zgłoszony |
| Actual FFI CPU/GPU snapshot | NOT VERIFIED |
| Source CAS / tensor runtime / FMS | NOT VERIFIED dla tego przyrostu |
| Native map/digest, renderer, RAM, science, release | Otwarte |

## Kolejny krok

Przez zgodny klient uzyskać native production build i snapshot evidence.
Dodać typed exact source
reader receiptu oraz trwały native index map/digest. Dopiero potem rozszerzyć
geometry evidence i przejść do binarnego geometry API/renderer integration.
