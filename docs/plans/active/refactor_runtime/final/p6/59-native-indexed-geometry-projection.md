# P6-59 — projekcja rzeczywistej geometrii MFEM

Data: 01.10.2026. Baza: `63c988f62463fd4b75027418b3857996120dda8e`.
Status: przyrost źródłowy. P6 około **52%**, cały plan około **49%**.

## Implementacja

- Dwa additive native ABI eksportują actual MFEM nodes/cells w bounded
  chunkach do 4096 encji. Node coordinates są F64; cell records to type
  i osiem zero-padded slots U32. Walidowane są extenty, pointer span,
  scalar P1 identity, actual coordinates bit-for-bit, types/arity i
  ordered connectivity. Wszystkie dane chunku przed pierwszym zapisem.
  Actual MFEM read/validation ma właściciela w `runtime/indexed_geometry.*`,
  jawnie podpiętego do CMake; fasada ABI nie przejmuje tej odpowiedzialności.
- Safe wrapper ma wyłączne `&mut` na terminalnym handle. Kolejne porcje
  są haszowane inkrementalnie; ich błędy odrzucają cały snapshot digest.
  Maksymalny node chunk to 98 304 B, cell chunk 147 456 B po każdej stronie
  ABI. To work buffer bound, nie zmierzony peak RAM solvera.
- Wspólny nowy schemat projekcji wiąże counts, IEEE F64LE coordinates
  i U32LE cell records w ich exact index order. Nie udaje full MeshIR/v3.
  Zgodność signed zero jest wymagana, nie normalizowana po drodze.
- Finalizacja sprawdza digest względem accepted MeshIR przed małym receipt.
  Geometry hash wymaga map hash. Exact saved reader porównuje tę samą
  projekcję z payloadem canonical geometrii historycznego owner/member.
  Legacy bez nowego pola pozostaje czytelny.

Kontrakt i rollback: [ADR 0044](../../../../../adr/0044-native-indexed-geometry-projection.md).
Cold ABI wymaga wykluczenia równoległej mutacji; nie dodaje mutexa ani
snapshot tokenu. Atomowość chunku nie oznacza publikacji niepełnego snapshotu.
Preview handoff jest zwalniany przed tym odczytem.

## Weryfikacja

Pierwszy production source check: PASS, exit 0,
`5067867fb46c4496a2ed5a1e78efab9d`,
`storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/`.
Końcowy production source check po wyodrębnieniu saved geometry validator:
PASS, exit 0, `52bf0718f61e402c8ab839932125ebd0`.
Niezależny review: brak P0/P1 i regresji kontraktu; potwierdzono ABI,
atomowość chunku, signed zero, preview exclusivity, receipt/reader oraz
podpięcie osobnego TU do CMake. Spójność repozytorium, zmienione linki
dokumentacji i staged diff check: PASS.

Dodano źródła regresji chunk ordering/incomplete snapshots, invalid index,
padding/nonfinite input, signed zero, connectivity tamper, receipt map binding
i niezależny frozen SHA-256 preimage fixture Python hashlib/struct.
Native ABI fixture sprawdza actual coordinates/cell records oraz brak
częściowego zapisu po błędnym późniejszym węźle lub connectivity mismatch.
Unit tests nie są kompilowane ani uruchamiane zgodnie z aktualnym zakazem.
Domyślny production source check nie kompiluje C++ ani native Rust feature.

Implementacja: `e56041781b439b23f47bbcceed43aaf54f39c708`.
Zlecono build **191**, `78d0c52ecb0245aa85f9411d76f8b914`, profil
`fem-cpu-release`, źródło dokładnie powyższego commita, bez dirty paths.
Request key: `9eeaf6436de34768936cd5e157dd9f84`.
Source capsule SHA-256: `8e583a8371eb895032100476ffa01bb70e217786917c450a40ad2e7204a8c853`.
Native source snapshot SHA-256: `fa868082b2c122084adbe7ebf86ad347b92313fb6943efea0b093f07f6380e7c`.
Odczyt po zgłoszeniu: **queued**, coordinator/exit code null.
Native compilation oraz runtime: **NOT VERIFIED**.

Starszy build 189 (`529ac93e81744c5faf50494306d50a11`) rozpoczął wykonanie
i ma status **running**; pozostawiono go do zakończenia. Build 190
(`c80236a8ce674d6e9709346363d86ea3`) rewalidowano jako nadal queued
i anulowano dopiero po przyjęciu buildu 191. Stan końcowy 190: **cancelled**,
coordinator/exit code null. Powód: zastąpienie starszych źródeł aktualnym
commitem, nie timeout obserwatora ani błąd kompilacji. Nie zatrzymano
żadnego wykonującego się zadania i nie usuwano jego danych.

## Pozostałe prace

Uzyskać native production build i rzeczywisty snapshot/geometry proof oraz
pełny round-trip CAS/FMS mapped source. Następnie binary geometry API,
resource hooks, renderer i browser/WebGL. Marker/facet/periodic/support,
CPU/GPU parity, RAM, nauka i release pozostają odrębnymi bramkami.
`representation_evidence = not_verified` bez zmiany.
