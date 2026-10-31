# Korekta architektury FDM: regiony bez limitu 256 i heterogeniczne Ms/A/α na CUDA

- Data: 2026-11-01
- Status: **projekt — decyzje 1–5 (sekcja 8) czekają na zatwierdzenie użytkownika.**
  Implementacja nie rozpoczęta.
- Baza: `master` 8a7b0eb32.
- Dowody z solverów referencyjnych:
  [2026-11-01-fdm-unbounded-regions-architecture-evidence.md](2026-11-01-fdm-unbounded-regions-architecture-evidence.md).
- Powiązane kontrakty: [`docs/specs/material-assignment-and-spatial-fields-v0.md`](../../specs/material-assignment-and-spatial-fields-v0.md)
  („No hard 256-region architecture rule”), nota fizyczna
  [`docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`](../../physics/0104-material-regions-parameter-fields-and-interface-couplings.md) §3.1,
  [`docs/specs/capability-matrix-v0.md`](../../specs/capability-matrix-v0.md).

Dokument nie jest dowodem działającego runtime. Liczby ruchu pamięci są szacunkami,
nie pomiarami.

## 0. Cel i kryteria ukończenia

Cel: usunąć twardy limit 256 regionów w FDM (CPU i CUDA) odziedziczony po modelu
mumax3 oraz znieść ograniczenie CUDA do jednorodnych Ms, Aex i alpha. Boris nie ma
limitu regionów i działa z wydajnością porównywalną z amumax, a kontrakt
`material-assignment-and-spatial-fields-v0.md` już zabrania wspólnej reguły 256.

Kryteria ukończenia:

1. zatwierdzony projekt (ten dokument, decyzje 1–5);
2. nota fizyczna w `docs/physics/` z sidecarem `.source-map.json` oraz aktualizacja
   specyfikacji i capability matrix — przed zmianą numeryki;
3. IR/plan akceptują > 256 regionów;
4. CUDA wykonuje heterogeniczne Ms/Aex/alpha;
5. przebiegi headless pokazują zgodność CPU vs GPU na przypadku wielomateriałowym
   (dwa materiały z override'em interfejsu; siatka 1000 ziaren) oraz niezmieniony
   przypadek jednorodny względem `master`;
6. zmierzony narzut czasu kroku;
7. PR do `master`.

## 1. Stan Fullmag (zweryfikowany w kodzie, master 8a7b0eb32)

1. Limit 256 występuje wyłącznie w:
   - `MAX_FDM_REGION_IDS = 255` i `validate_fdm_region_lut_indices`
     ([`crates/fullmag-ir/src/execution.rs:180`](../../../crates/fullmag-ir/src/execution.rs));
   - planerze: `materialize_object_region_mask`, błąd `fdm_region_lut_capacity_exceeded`
     ([`crates/fullmag-plan/src/fdm.rs:1004`](../../../crates/fullmag-plan/src/fdm.rs));
   - ABI natywnym: `FULLMAG_FDM_MAX_EXCHANGE_REGIONS 256`
     ([`native/include/fullmag_fdm.h:47`](../../../native/include/fullmag_fdm.h)),
     walidacja id regionów i budowa LUT 256×256 f64 = 512 KiB
     ([`backends/fdm/api/c_api.cpp:1416-1627`](../../../backends/fdm/api/c_api.cpp));
   - `crates/fullmag-fdm-sys/src/lib.rs:15`.

   Python DSL, API i Control Room używają już `u32`.
2. ABI ma już pola `ms_field`, `a_field`, `alpha_field`
   (`fullmag_fdm.h:516-521`), ale odrzucają je natywny backend
   (`c_api.cpp:1394`) i runner
   ([`crates/fullmag-runner/src/fdm/gpu/cuda/native.rs:1441`](../../../crates/fullmag-runner/src/fdm/gpu/cuda/native.rs)).
3. **Błąd parytetu:** CPU reference ignoruje `region_mask` i `inter_region_exchange`.
   Wymiana na CPU to zawsze średnia harmoniczna z `a_field`
   ([`crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs:42`](../../../crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs)).
   Override `explicit` lub `disabled` działa na CUDA i jest po cichu pomijany na CPU,
   wbrew nocie 0104 §3.1.
4. **Błąd lowering:** planer obniża tryb `harmonic_mean × scale` do
   `A_material × scale` (`fdm.rs:1687`). Przy niejednorodnym A jest to sprzeczne z
   notą 0104 (`harmonic(A_i, A_j) × scale`).
5. Runner CUDA wysyła `exchange_pair_default = HARMONIC_MEAN` i jawne pary; backend
   natywny buduje z tego LUT o wartości `A` wszędzie (materiał jednorodny) z nadpisaniami par.
   Plik `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` nie jest
   kompilowany (martwy; własna LUT z `A_ij = 0`). Poza zakresem — osobny follow-up.
6. Jednorodne `ctx.Ms`/`ctx.alpha`/`ctx.A` na CUDA są używane w około 25 miejscach:
   wymiana (fp64, fp32, T0, T1), pakowanie demag i korekta brzegowa, połączony kernel
   pola/RHS (anizotropia, DMI, magnetosprężystość, szum termiczny, LLG), gęstości
   energii, redukcje (wymiana, demag, Zeeman) oraz kernele RHS wszystkich integratorów
   (Heun, RK4, RK23, DP45, ABM3; fp64 i fp32).

## 2. Solwery referencyjne (skrót; pełne dowody w pliku `-evidence.md`)

### amumax (linia mumax3)

- Limit: `const NREGION = 256 // maximum number of regions, limited by size of byte.`
  Mapa regionów to jeden `uint8` na komórkę; każda tablica parametrów ma rozmiar
  `[256]float32`.
- Wymiana: symetryczna tablica 256·257/2 float32 (128.5 KiB) na `lex2`, `din2`,
  `dbulk2`; wpis `scale·harmonic(A_i, A_j) + inter`. Kernel czyta
  `aLUT2d[symidx(r0, regions[n])]` dla każdego sąsiada, sumuje i mnoży raz przez
  `1/Ms` komórki centralnej. Tablica przechowuje surowe A (J/m), nie A/Ms.
- Parametry materiałowe istnieją tylko per region. Wariacja per komórka dotyczy
  tylko wzbudzeń (B_ext, J, odkształcenie).
- Parametr jednorodny: kernel dostaje NULL + skalar (`amul(arr, mul, i)`).
  Niejednorodny: przebieg „decode” rozwija tablicę do pełnego bufora per komórka
  przy każdej ewaluacji pola.

### Boris

- Parametr `MatP`: wartość bazowa (0 K / bieżąca), opcjonalne skalowanie
  temperaturowe (tablica co 1 K lub wzór), opcjonalne skalowanie przestrzenne
  (tablica `s_scaling` lub wzór x,y,z,t).
- Tablica przestrzenna jest domyślnie pusta i alokowana tylko przy generatorze
  przestrzennym. Kernel rozgałęzia się na `is_sdep()` (test wskaźnika, jednolity w
  warpie): bez zależności przestrzennej nie czyta tablicy i nie mnoży przez 1.
- Brak regionów i identyfikatorów materiału w obrębie siatki. Heterogeniczność to
  wiele siatek plus skalowanie przestrzenne; praktycznie brak limitu (ok. 65 535 siatek).
- Wymiana: `Hexch = 2*A*M.delsq_neu(idx)/(MU0*Ms*Ms)` — A i Ms w centrum komórki,
  laplasjan na **M**, bez średniej harmonicznej i bez wartości na ścianach.
- Sprzężenie między siatkami: SurfExchange J1/J2 [J/m²] oraz opcjonalne bezpośrednie
  FM–FM, w którym każda strona używa własnych A i Ms.
- Precyzja GPU: fp32 domyślnie.

### Ruch pamięci na komórkę dla wymiany (unikalny DRAM, sąsiedzi z cache; szacunek)

| Solwer / ścieżka | fp32 | fp64 |
|---|---|---|
| amumax, jednorodne / niejednorodne Ms | ~37 / ~41 B (+5 B na decode) | — |
| Boris, jednorodne / przestrzenne A, Ms | ~40 / ~48 B | ~76 / ~92 B |
| Fullmag dziś: ścieżka jednorodna / LUT regionów | ~25 / ~29 B | ~49 / ~53 B |
| **Propozycja: ściany + tablica Ms** | ~41 B | ~81 B |
| Alternatywa: A per komórka, harmoniczna w kernelu | ~33 B | ~65 B |

Liczby Fullmag: m (24 B fp64), `active_mask` (1 B), `region_mask` (4 B), zapis `h_ex`
(24 B); LUT z cache. Ścieżka fp32 Fullmag nadal czyta LUT jako `double`.

## 3. Co przejmujemy, a czego świadomie nie

**Przejmujemy od Boris:**

- model parametru „skalar + opcjonalna tablica per komórka”: bez tablicy kernel idzie
  gałęzią skalarną (jednolitą w warpie) bez dodatkowego ruchu pamięci;
- brak identyfikatora regionu lub materiału w gorącej pętli. Regiony służą topologii:
  obserwablom, redukcjom i przypisaniu override'ów; `u32`, bez limitu.

**Przejmujemy od amumax:**

- formułę pary `scale·H(A_i, A_j)`, zastępowaną przez wartość jawną przy override
  `explicit` (zgodne z notą 0104);
- wymianę na jednostkowym **m** z lokalnym `1/Ms_i` stosowanym po sumie po sąsiadach.

**Nie przejmujemy:**

- ∇²M Borisa z A_i w centrum komórki. Przy skoku Ms zachodzi
  $\nabla^2(M_s \mathbf m)/M_s \ne \nabla^2 \mathbf m$, a A w centrum komórki nie jest
  symetryczne na interfejsie, więc pole nie jest gradientem energii. Narusza to
  wymóg noty 0104, że redukcja energii używa tego samego `A_ij` co kernel pola.
  To jest nasza interpretacja wzoru; Boris obsługuje interfejsy głównie przez osobne siatki.
- Modelu wielu siatek Borisa dla interfejsów materiałowych. Odpowiada mu nasza ścieżka
  multilayer, która pozostaje osobna.
- Modelu bajt + tablica i dekodowania co krok z amumax — to źródło limitu 256 i
  dodatkowego ruchu pamięci.
- Skalowania temperaturowego parametrów (Boris) — poza zakresem; możliwe później jako
  kolejny mnożnik w tym samym wzorcu.

## 4. Poziomy wykonania (tiers)

| Poziom | Kiedy | Wymiana | Ms, α |
|---|---|---|---|
| **U (uniform)** | brak regionów, albo regiony bez override'ów przy jednorodnym A | kernel laplasjanu bez zmian (bitowo jak `master`) | skalary |
| **H (heterogeneous)** | niejednorodne A lub dowolny override | współczynniki ścianowe $A_f$ (+x/+y/+z na komórkę); mapa regionów nie jest czytana | opcjonalne tablice, `NULL → skalar` |
| **P (material id + tablice)** | **odłożony** | id materiału `u16`/`u32` + tablice parametrów; średnia harmoniczna w kernelu, rzadka tablica par | z tablic materiałów |

**Zależność od PR #374 (fdm-hot-loop-perf).** PR dodaje `Context::exchange_lut_uniform`
(`backends/fdm/include/context.hpp`), ustawiane w `fullmag_fdm_backend_create_impl`
(`backends/fdm/api/c_api.cpp`), gdy wszystkie wpisy LUT są równe `ctx->A`. Wtedy
`launch_exchange_field_fp64` kieruje przypadek „regiony bez override'ów” na szybki
laplasjan. Jest to dokładnie reguła wejścia do poziomu U. Pomiar z tego PR: gałąź
jednorodna jest 1.65× szybsza na kernel. Szerokość maski (u8 vs u32) i liczba
regionów (1 vs 64) nie zmieniały czasu kernela. Implementacja tego projektu musi
bazować na `master` po scaleniu #374. Punktem odniesienia dla bitowej zgodności
przypadku jednorodnego z regionami jest wtedy szybki laplasjan, a nie ścieżka LUT.
Wybór poziomu U przenosi się z testu `all_of` na LUT do planera/buildera
(`ExchangeFaces` = `None`).

Poziom P realizuje „medium path” ze specyfikacji `material-assignment-and-spatial-fields-v0.md`.
Planer może nadal operować pojęciem tabeli materiałów; na GPU poziom H obsługuje
zarówno przypadek kawałkami stały, jak i pola ciągłe.

### Reguła ścianowa

Dla ściany między komórkami $i$ i $j$ (regiony $r_i$, $r_j$):

$$
A_f = \begin{cases}
0 & i \text{ lub } j \text{ nieaktywne albo brak sąsiada (brzeg bez PBC)} \\
A^{\mathrm{expl}}_{r_i r_j} & \text{override explicit} \\
s_{r_i r_j}\, H(A_i, A_j) & \text{override „harmonic × scale” (disabled} \equiv s = 0) \\
H(A_i, A_j) & \text{w pozostałych przypadkach}
\end{cases}
$$

$$
H(a, b) = \begin{cases} a & a = b \\ 0 & ab = 0 \\ \dfrac{2ab}{a+b} & \text{w pozostałych przypadkach} \end{cases}
$$

Gałąź $a = b$ daje dokładnie $A$ w arytmetyce zmiennoprzecinkowej, co zachowuje bitową
zgodność przypadku „jednorodny materiał z regionami” z obecną ścieżką LUT.

Pole i energia wymiany:

$$
\mathbf H_{\mathrm{ex},i} = \frac{2}{\mu_0 M_{s,i}} \sum_{f \in \partial i} A_f \frac{\mathbf m_j - \mathbf m_i}{h_f^2},
\qquad
E_{\mathrm{ex}} = V \sum_{f} A_f \frac{|\mathbf m_j - \mathbf m_i|^2}{h_f^2}
$$

Spełnione jest $\mathbf H_{\mathrm{ex},i} = -\frac{1}{\mu_0 M_{s,i} V}\,\partial E_{\mathrm{ex}}/\partial \mathbf m_i$.
Domyślne $A = 0$ między obiektami pozostaje realizowane jako jawne pary `disabled`.

### Benchmark przed wyborem wariantu

Przed wyborem wariantu w obrębie poziomu H wykonujemy mikrobenchmark (zdarzenia CUDA,
w kontenerze `backend` grupy Docker tego worktree), w fp64 i fp32, na rozmiarach
2D i 3D. Porównywane warianty:

1. ścieżka jednorodna (punkt odniesienia);
2. obecna LUT 256×256;
3. H-faces: trzy tablice ścian + tablica Ms;
4. H-cellA: A per komórka, średnia harmoniczna liczona w kernelu (dzielenia fp64 są
   drogie na kartach konsumenckich);
5. **opcjonalnie P:** id materiału `u16`/`u32` + tablice parametrów w pamięci
   współdzielonej, harmoniczna w kernelu. Użytkownik decyduje przy zatwierdzeniu,
   czy P wchodzi do benchmarku (decyzja 4).

Domyślnym wariantem jest H-faces, bo jednym kernelem obsługuje override'y i pola
ciągłe. Poziom P dodajemy tylko, gdy na przypadku heterogenicznym z demag skraca
cały krok o ponad 10% względem H.

## 5. Zmiany w IR, ABI i kodzie

### IR i plan (`fullmag-ir`, `fullmag-plan`)

- Usunięcie `MAX_FDM_REGION_IDS` i bramki 255. Identyfikatory regionów `u32`.
  Walidacja zostaje: para musi istnieć w legendzie, mieć id ≠ 0 i dwa różne regiony.
- Nowe pole planu `inter_region_exchange_scale: Vec<(u32, u32, f64)>` dla trybu
  „harmonic × scale”; `inter_region_exchange` pozostaje dla wartości jawnych
  (w tym `disabled = 0`). `serde` default, więc stare plany czytają się bez zmian.
  Naprawia błąd lowering z sekcji 1, pkt 4.
- `Ms ≤ 0` w aktywnej komórce daje błąd planera (decyzja 3).

### Wspólny builder (`fullmag-engine`)

- Moduł budujący `ExchangeFaces { x_plus, y_plus, z_plus }` z: siatki, PBC,
  `active_mask`, `region_mask`, A (skalar lub `a_field`) oraz par override.
- Złożoność O(N + P), mapa par bez limitu. Zwraca `None` dla poziomu U.
- Jedna implementacja reguły dla CPU i CUDA: parytet na poziomie współczynników.

### CPU reference

- Poziom H (pole i energia) liczony na ścianach. Naprawia ignorowane override'y
  (decyzja 2). Ścieżka jednorodna SoA bez zmian.

### ABI natywne (`native/include/fullmag_fdm.h`, `backends/fdm`)

- Append-only ogon `fullmag_fdm_plan_desc_v2` bramkowany `struct_size` (jak przy
  rotated DMI) z `exchange_face_xp/yp/zp` i długościami.
- Odblokowanie `ms_field` i `alpha_field`. GPU dostaje ściany zamiast `a_field`.
- Wycofanie `exchange_lut`, `exchange_pairs`, `exchange_pair_default` i
  `FULLMAG_FDM_MAX_EXCHANGE_REGIONS`; niezerowe wartości dają błąd
  `fdm_exchange_lut_retired`. Pola zostają w strukturze dla stabilności układu.
- Usunięcie sprawdzania id regionu względem 255. `region_mask` pozostaje `u32`.
- Tożsamość workspace (`workspace_dependency_identity.cpp`) hashuje ściany zamiast LUT.

### CUDA

- Wymiana fp64/fp32: kernel ścianowy o tej samej postaci arytmetycznej co obecna
  ścieżka LUT; szybki laplasjan bez zmian.
- Ms per komórka:
  - pakowanie demag: $\mathbf M = M_{s,i}\mathbf m_i$ przed FFT (także z φ dla T0/T1);
  - prefaktory lokalne $2/(\mu_0 M_{s,i})$: anizotropia, DMI, magnetosprężystość;
  - energie demag, Zeemana i gęstości energii;
  - amplituda szumu termicznego $\sigma_i \propto \sqrt{\alpha_i / M_{s,i}}$.
- α per komórka: $\bar\gamma_i = \gamma/(1+\alpha_i^2)$ w kernelu połączonym i we
  wszystkich kernelach RHS integratorów, fp64 i fp32.
- Wzorzec `p ? p[i] : skalar` zachowuje arytmetykę ścieżki jednorodnej.
- Redukcje per region liczone na ścianach.

### Bramki capability w v1 (fail closed; decyzja 1)

CUDA odrzuca heterogeniczne Ms/α w połączeniu z:

- Zhang-Li, Slonczewskim, SOT, transportem spinu lub ładunku;
- korektą brzegową T0/T1 (dla samych regionów T0/T1 przechodzą na ściany);
- polami `dind_field`/`dbulk_field`, które nadal nie są wspierane na CUDA.

Ścieżka multilayer pozostaje bez zmian.

### Dokumentacja

- Nowa nota `docs/physics/0402-fdm-face-exchange-coefficients-and-heterogeneous-cuda-materials.md`
  z `.source-map.json`, według `scientific-documentation-contract` (15 sekcji).
- Korekta noty 0104 §3.1 (brak limitu, semantyka scale, reguła ścianowa).
- Status w `material-assignment-and-spatial-fields-v0.md` i capability matrix
  (wiersze o polach per komórka i regionach obiektu).

## 6. Kompromisy

- Koszt: w poziomie H około 1.6× ruchu pamięci kernela wymiany. Względem całego kroku
  zdominowanego przez FFT demag spodziewamy się od kilku do kilkunastu procent;
  potwierdzi to benchmark.
- Pamięć: +24 B na komórkę na ściany (fp64; 12 B w fp32) oraz po 8 B na Ms i α.
- Zysk: brak limitu regionów, jedna ścieżka dla override'ów i pól ciągłych, pole
  wariacyjne, parytet CPU/GPU, nietknięta ścieżka jednorodna.

## 7. Weryfikacja

- Mikrobenchmark z sekcji 4 przed wyborem wariantu.
- Przebiegi headless `fullmag-bin <script> --backend fdm --headless --json --output-dir <dir>`
  w kontenerze `backend` grupy, CPU vs CUDA fp64 (fp32 informacyjnie):
  1. dwa materiały (różne Ms, A, α) z jawnym override'em interfejsu oraz wariant ze
     scale = 0.5;
  2. 1000 ziaren (Voronoi, Ms/A/α ±10% na ziarno, kilka override'ów);
  3. przypadek jednorodny z regionami i bez: hash `m_final` na GPU bitowo zgodny z `master`.
- Tabela narzutu czasu kroku: fp64/fp32 × exchange-only/z demag, z wyłączonym
  podglądem (`FULLMAG_DISABLE_PREVIEW_3D/2D=1`, `FULLMAG_DISABLE_LIVE_MAGNETIZATION=1`),
  bo podgląd zniekształca pomiary GPU.
- Bez `cargo test` i `just test` (zakaz do odwołania). Nowe testy trafiają do CI
  `rust-contracts`; lokalnie `just check-*-source`.

## 8. Decyzje czekające na zatwierdzenie

1. **Bramki capability z sekcji 5** w v1, zamiast pełnej implementacji STT/SOT,
   transportu i T0/T1 dla heterogenicznego Ms. *Rekomendacja: tak.*
2. **Zmiana zachowania CPU:** override'y zaczynają działać. To poprawka błędu, ale
   wyniki CPU zmienią się dla planów z override'ami. *Rekomendacja: tak.*
3. **`Ms ≤ 0` w aktywnej komórce jest błędem.** Alternatywa: konwencja mumax, w
   której Ms = 0 oznacza próżnię. *Rekomendacja: błąd; geometria przez `active_mask`.*
4. **Poziom P odłożony**, chyba że benchmark pokaże ponad 10% zysku na krok.
   Do decyzji: czy P wchodzi do benchmarku już teraz. *Rekomendacja: odłożyć, P w
   benchmarku opcjonalnie.*
5. **Implementacja w `worktrees/fdm-unbounded-regions-20261031`** na branchu
   `codex/fdm-unbounded-regions-20261031`, zgodnie z AGENTS.md.
   *Rekomendacja: tak.*

## 9. Poza zakresem

- Martwy plik `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`.
- Ścieżka multilayer (osobne per-warstwowe materiały).
- Zależność parametrów od temperatury.
- Pola DMI per komórka na CUDA.
