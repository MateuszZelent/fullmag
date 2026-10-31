# Dowody: model regionów i materiałów w amumax i Boris

- Data: 2026-11-01
- Dotyczy: [2026-11-01-fdm-unbounded-regions-architecture-design.md](2026-11-01-fdm-unbounded-regions-architecture-design.md)
- Źródła (tylko do odczytu, w głównym checkoutcie): `external_solvers/amumax/src/` oraz
  `external_solvers/BORIS/` (`Boris/` i `BorisCUDALib/`). Polityka repozytorium:
  solwery zewnętrzne służą do nauki; nie kopiujemy ich kodu.
- Oznaczenie ✔ = linia sprawdzona ręcznie. Pozostałe odwołania pochodzą z przeglądu
  źródeł wykonanego przez agentów; `NIEZWERYFIKOWANE` = nie potwierdzone.
- Liczby ruchu pamięci są szacunkami z analizy kodu i PTX, nie pomiarami.

## amumax

Ścieżki względem `external_solvers/amumax/src/`.

### Mapa regionów i limit 256

- `engine/regions.go:14` ✔: `const NREGION = 256 // maximum number of regions, limited by size of byte.`
- Bufor GPU: `RegionsState.gpuBuffer *cuda.Bytes` (`engine/regions.go:18`),
  alokacja `cuda.NewBytes(rs.Mesh().NCell())` (`regions.go:62`);
  `cuda/bytes.go:13-24` — jeden bajt na komórkę.
- Host: `[]byte` (`regions.go:144-147`), rasteryzacja `byte(region)` (`regions.go:119`).
- Kernele przyjmują `uint8_t* regions` (np. `cuda/exchange.cu:12`, `cuda/regiondecode.cu:5`).
- Wszystkie tablice per region mają rozmiar `NREGION`: `cuda/lut.go:9-11`,
  `engine/lutdata.go:16` (`cpuBuf [][NREGION]float32`), `lutdata.go:76`.
- Walidacja `if id < 0 || id > NREGION` (`regions.go:181`) przepuszcza 256, które po
  `byte(256)` zawija się do 0 (używane w `test/regionsload.mx3:17`,
  `test/exchcoupling.mx3:15`).
- Wyciek limitu poza parametry: wyjście per region (`engine/oneregion.go:51`,
  `cuda/regionselect.cu:8`), `m.SetRegion` (`engine/magnetization.go:129`),
  ziarna Voronoi (`ext_makegrains.go:36,100`; `shape.go:234,243`), przesuwana
  ramka (`regions.go:251,276`).

### Parametry materiałowe

- `regionwise` z LUT i funkcjami czasu `updReg [NREGION]func() []float64`
  (`engine/parameter.go:26-32`); zapis `p.cpuBuf[c][region] = float32(v[c])`
  (`parameter.go:146`); leniwy upload `MemCpyHtoD(..., SIZEOF_FLOAT32*NREGION)`
  (`lutdata.go:37-49`).
- Konwersja do `MSlice` (`parameter.go:87-94`): parametr jednorodny → `NilSlice`
  (NULL) + skalar; niejednorodny → `RegionDecode` do pełnego bufora float32
  (`lutdata.go:84-96`; kernel `dst[i] = LUT[regions[i]]`, `cuda/regiondecode.cu:10`).
  Dekodowanie przy każdej ewaluacji pola (`engine/exchange.go:48-49`,
  `anisotropy.go:33-40`).
- W kernelu ✔ `cuda/amul.h:7-9`: `return (arr == NULL)? (mul): (mul * arr[i]);`;
  `inv_Msat` zwraca 0 dla Ms = 0 (`amul.h:20-27`).
- Wariacja per komórka tylko dla wzbudzeń (`B_ext`, `J`, `FixedLayer`, `exx..eyz`)
  przez maski `mulmask` (`engine/excitation.go:17-27,43-55`). Msat, Aex, alpha, Ku1,
  Dind są wyłącznie per region.

### Wymiana

- `exchParam` z tablicami `lut`, `scale`, `inter` po `NREGION*(NREGION+1)/2` float32
  = 131 584 B każda, dla `lex2`, `din2`, `dbulk2` (`engine/exchange.go:20-22,101-108`).
- Reguła ✔ `engine/exchange.go:157`: `p.lut[I] = p.scale[I]*exchAverage(exi, exj) + p.inter[I]`;
  `exchAverage` to średnia harmoniczna przy zgodnych znakach (`exchange.go:188-196`);
  domyślnie `scale = 1`, `inter = 0` (`:117-120`); `ext_InterExchange` ustawia
  `scale = 0` (`:136-140`), `ext_ScaleExchange` ustawia `inter = 0` (`:143-147`).
- Indeks symetryczny `symidx` (`exchange.go:177-182`, `cuda/exchange.h:5`).
- Kernel: dla każdego sąsiada `a__ = aLUT2d[symidx(r0, regions[i_])]`
  (`cuda/exchange.cu:38-81`); po sumie ✔ `cuda/exchange.cu:83-86`:
  `float invMs = inv_Msat(Ms_, Ms_mul, I); Bx[I] += B.x*invMs;` — tylko Ms komórki
  centralnej.
- LUT przechowuje surowe Aex (J/m). Komentarze „Aex/Msat” w `cuda/exchange.go:14` i
  `cuda/dmi.cu:13` są nieaktualne.

### Ruch pamięci (wymiana 3D, fp32)

PTX (`cuda/exchange_wrapper.go`, `sm_52`): 28 × `ld.global.nc.f32`
(3 m0 + 18 m sąsiadów + 6 LUT + 1 Ms), 7 × `ld.global.nc.u8`, 3 × `ld.global.f32`
i 3 × `st.global.f32` (read-modify-write B).

| Element | Wydane bajty | Unikalny DRAM (sąsiedzi z cache) |
|---|---|---|
| m (3 × f32) | 84 B | 12 B |
| regiony (u8) | 7 B | 1 B |
| LUT (f32) | 24 B | ≈ 0 (cache; NIEZWERYFIKOWANE) |
| Ms | 0 B (jednorodne) / 4 B | 0 / 4 B |
| B odczyt + zapis | 24 B | 24 B |
| **Razem** | ~139–143 B | **~37 B / ~41 B** (+~5 B decode przy niejednorodnym Ms) |

## Boris

Ścieżki: `B/` = `external_solvers/BORIS/Boris/`, `CL/` = `external_solvers/BORIS/BorisCUDALib/`.

### Parametry materiałowe

- `template <typename PType, typename SType> class MatP` (`B/MaterialParameter.h:30-31`):
  `value_at_0K` i `current_value` (`:54,59`), skalowanie T jako tablica co 1 K
  `t_scaling` (`:66`) lub wzór `Tscaling_eq` (`:73`), skalowanie przestrzenne
  `VEC<SType> s_scaling` (`:102-103`) lub wzór x,y,z,t `Sscaling_eq` (`:106`).
  Wartość: `value_to_scale * s_scaling[position]` (`:858`).
- Domyślnie `s_scaling_type = MATPVAR_NONE` (`:118`); tablica alokowana tylko przy
  generatorze przestrzennym (`:2025`, `:2058`); `is_sdep()` = wzór ustawiony lub
  tablica niepusta (`:499`).
- GPU: `class MatPCUDA` (`B/MaterialParameterCUDA.h:22-54`) z `cuVEC<SType>* ps_scaling`;
  wskaźnik ustawiany tylko dla niepustej tablicy
  (`B/MaterialParameterPolicyCUDA.h:88-89`); `is_sdep()` na urządzeniu
  (`B/MaterialParameterCUDA.h:153`).
- Odczyt po pozycji, najbliższa komórka ✔ `B/MaterialParameterCUDA.h:662`:
  `else return current_value * (*ps_scaling)[ps_scaling->get_relpos_from_crelpos(position)];`
  (`CL/cuVEC.h:318`) — rozdzielczość tablicy może różnić się od M.
- Gałąź w kernelu ✔ `B/MeshParamsControlCUDA.h:61-71`: `if (matp.is_sdep()) { ... }
  else { update_parameters_mcoarse_spatial(...) }` — bez zależności przestrzennej
  brak odczytu tablicy.
- Brak regionów i identyfikatorów materiału w siatce (wyszukiwanie
  `regionid|region_id|material_id|matid` bez wyników). Siatki w
  `vector_key<MeshBase*> pMesh` (`B/SuperMesh.h:174`); praktyczny limit ~65 535 z
  16-bitowego pakowania (`B/SurfExchangeCUDA.cu:597`; wniosek, NIEZWERYFIKOWANE).

### Wymiana w siatce ferromagnetycznej

- ✔ `B/ExchangeCUDA.cu:31-33`: `cuBReal Ms = *cuMesh.pMs; cuBReal A = *cuMesh.pA;
  cuMesh.update_parameters_mcoarse(idx, ...)` — A i Ms w centrum komórki.
- ✔ `B/ExchangeCUDA.cu:50`: `Hexch = 2 * A * M.delsq_neu(idx) / ((cuBReal)MU0 * Ms * Ms);`
  — laplasjan na M (A/m), bez średniej harmonicznej (wyszukiwanie „harmonic” bez wyników).
- `delsq_neu` (`CL/cuVEC_VC_del.h:10-198`): pusta komórka → 0 (`:14`); Neumann na
  wolnej powierzchni (`:58`); PBC (`:54`); halo multi-GPU (`:23-41`); kierunek na
  granicy kompozytu zerowany (`:43-46`) i uzupełniany przez kernel sprzężenia.

### Sprzężenie między siatkami

- SurfExchange J1/J2 [J/m²] (`B/SurfExchange.cpp:21-23`); J ustala górna siatka
  (`B/MeshParams.h:99`); pole `Hsurfexch = (m_j / (MU0 * Ms * h.z)) * (J1 + 2 * J2 * dot_prod)`
  (`B/SurfExchangeCUDA.cu:71`); tryb objętościowy ±x/±y/±z (`:469-844`).
- Bezpośrednie FM–FM: `exchange_couple_to_meshes` (`B/Mesh_Ferromagnetic.h:112`);
  ✔ `B/ExchangeCoupling_CUDA.cu:54-56,70` — A i Ms strony głównej,
  `Hexch = (2 * A / (MU0 * Ms * Ms)) * (M_2 + M_m1 - 2 * M_1) / hRsq;`; brak średniej A.
- Demag wspólny przez `SDemag` (multilayered convolution domyślnie;
  `B/SDemag.h:24,61`).

### Precyzja i ruch pamięci

- ✔ `CL/cuBLib_Flags.h:7`: `#define SINGLEPRECISION 1`; `cuBReal` = `cufftReal` lub
  `cufftDoubleReal` (`CL/cuBRealComplex.h:7-19`). Strona CPU w double.

| Przypadek | float | double |
|---|---|---|
| M centrum (sąsiedzi z cache) | 12 B | 24 B |
| `ngbrFlags` (int) | 4 B | 4 B |
| Heff odczyt + zapis | 24 B | 48 B |
| **Minimum, jednorodne A/Ms** | **~40 B** | **~76 B** |
| + tablice przestrzenne A i Ms | +8 B | +16 B |
| + pole temperatury | +4 B | +8 B |

## Fullmag (master 8a7b0eb32) — do porównania

- Ścieżka LUT fp64: m 24 B + `active_mask` 1 B + `region_mask` 4 B + zapis `h_ex` 24 B
  ≈ 53 B; LUT 256×256 f64 (512 KiB) z cache. Ścieżka jednorodna ≈ 49 B.
  fp32 ≈ 29 B, przy czym LUT nadal jest `double`
  (`backends/fdm/gpu/cuda/interactions/exchange_fp32.cu:39`).
- CUDA odrzuca `ms/a/alpha_field` (`crates/fullmag-runner/src/fdm/gpu/cuda/native.rs:1441`,
  `backends/fdm/api/c_api.cpp:1394`).
- CPU ignoruje `region_mask` i `inter_region_exchange`
  (`crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs:42`).
