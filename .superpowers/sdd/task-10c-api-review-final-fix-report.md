# Task 10C — końcowa poprawka po review API/native-layer membership

## Zakres

Poprawka obejmuje wyłącznie trzy findings z review zakresu
`087b4875a..7eb428990`:

1. kanoniczna maska publikowanego FMRM po zamianie komórek nieaktywnych na
   `u32::MAX` jest źródłem `region_mask_hash` oraz generation/fingerprint;
2. centralny `ControlRoomApi` udostępnia binarny endpoint membership warstwy,
   a codec ma osobny kontrakt native-layer względem layoutu i deskryptora;
3. test API dowodzi niezależności dwóch warstw z tym samym `region_id`,
   osobnymi materiałami, legendami, siatkami i maskami.

Nie zmieniono runtime, CUDA/GPU, renderera ani browser smoke.

## RED

Przed implementacją uruchomiono:

```text
TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/codecs/fdmRegionMembershipCodec.test.ts \
  src/kernel/api/ControlRoomApi.test.ts
```

Wynik: 2 wymagane failures przy 132 istniejących testach PASS:

- `fdmMultilayerLayerRegionMembershipBytes is not a function`;
- `validateFdmNativeLayerRegionMembershipContract is not a function`.

Rustowy test został najpierw rozszerzony o nieaktywną komórkę oraz drugą
warstwę. Pierwsza próba RED nie zwróciła końcowego wyniku z powodu utraconej
sesji kompilacji/locku artefaktów. Nie traktowano jej jako dowodu. Końcowa
weryfikacja została uruchomiona na świeżym, zarządzanym `CARGO_TARGET_DIR`.

## Implementacja

- Plan-first layout hashuje dokładnie bajty maski FMRM, czyli `u32` little
  endian po zamianie nieaktywnych komórek na `u32::MAX`.
- Wspólny helper generation odtwarza kontrakt
  `fdm_multilayer_membership_generation.v1` używany przez writer artefaktów.
- Plan-first i persisted carrier używają tej samej generation jako
  `membership_fingerprint`; persisted payload z inną generation zwraca `409`.
- `ControlRoomApi.data.domain` udostępnia JSON descriptor i companion binary
  wyłącznie przez centralne stałe ścieżek OpenAPI.
- Native validator nie używa globalnego `DomainMeta`. Porównuje FMRM z
  `FdmMultilayerLayoutResource`, właściwą warstwą i
  `FdmNativeLayerRegionMembershipResource`, w tym mask hash, legend hash,
  geometrię, rewizję, generation, identity i lokalne object IDs.

## GREEN

- Focused Rust API: `1 passed; 0 failed; 866 filtered out`.
- OpenAPI Rust: `9 passed; 0 failed; 858 filtered out`.
- Frontend codec/facade: `2 files passed`, `134 passed; 0 failed`.
- Control Room typecheck: PASS.
- Targeted ESLint pięciu zmienionych plików frontendowych: PASS.
- `check:api-hygiene`: PASS.
- `check:architecture-hygiene`: PASS.
- `pnpm --dir apps/control-room generate:api`: PASS; brak zmiany schematu,
  typów i wygenerowanego klienta. Jedyny zmienny build identity w JSON został
  pominięty w patchu.
- `git diff --check`: PASS.

## Granica kwalifikacji

To jest dowód source/API/codec. Nie stanowi managed runtime ani browser/WebGL
qualification dla FDM/FEM.
