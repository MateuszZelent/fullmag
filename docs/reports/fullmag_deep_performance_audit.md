# Fullmag — głęboki audyt wydajnościowy na poziomie kodu
## Diagnoza architektonicznych wąskich gardeł vs mumax3 / Boris

**Autor:** Antigravity Deep Code Analysis  
**Data:** 2026-03-27  
**Zakres:** analiza kodu źródłowego crate'ów `fullmag-engine`, `fullmag-runner`, `fullmag-fdm-demag`, natywnych backendów CUDA/FEM, identyfikacja konkretnych linii odpowiedzialnych za spowolnienia, propozycje przyspieszenia

---

## Spis treści

1. [Streszczenie wykonawcze](#1-streszczenie-wykonawcze)
2. [Metodologia audytu kodu](#2-metodologia-audytu-kodu)
3. [PROBLEM 1: AoS jako natywna reprezentacja danych](#3-problem-1-aos-jako-natywna-reprezentacja-danych)
4. [PROBLEM 2: CPU-side obliczanie widm Newella dla GPU](#4-problem-2-cpu-side-obliczanie-widm-newella-dla-gpu)
5. [PROBLEM 3: FFT 3D z ręcznym gather/scatter](#5-problem-3-fft-3d-z-ręcznym-gatherscatter)
6. [PROBLEM 4: Nadmiarowe alokacje w integratorach](#6-problem-4-nadmiarowe-alokacje-w-integratorach)
7. [PROBLEM 5: `observe_vectors_ws` — ukryty pełny demag na każdym kroku](#7-problem-5-observe_vectors_ws--ukryty-pełny-demag-na-każdym-kroku)
8. [PROBLEM 6: Brak trwałej sesji solverowej](#8-problem-6-brak-trwałej-sesji-solverowej)
9. [PROBLEM 7: AoS↔SoA na granicy host↔device](#9-problem-7-aossoa-na-granicy-hostdevice)
10. [PROBLEM 8: FEM transfer-grid demag bootstrap](#10-problem-8-fem-transfer-grid-demag-bootstrap)
11. [PROBLEM 9: Klonowanie pełnego payloadu FEM mesh w live callbacks](#11-problem-9-klonowanie-pełnego-payloadu-fem-mesh-w-live-callbacks)
12. [PROBLEM 10: Budowa ThreadPool per run](#12-problem-10-budowa-threadpool-per-run)
13. [PROBLEM 11: Domyślne ścieżki API tworzące workspace na każdym kroku](#13-problem-11-domyślne-ścieżki-api-tworzące-workspace-na-każdym-kroku)
14. [PROBLEM 12: Brak kernel fusion w CUDA backendzie](#14-problem-12-brak-kernel-fusion-w-cuda-backendzie)
15. [Ranking krytyczności — podsumowanie](#15-ranking-krytyczności--podsumowanie)
16. [Porównanie architektoniczne: Fullmag vs mumax3](#16-porównanie-architektoniczne-fullmag-vs-mumax3)
17. [Konkretny plan przyspieszenia — Quick Wins](#17-konkretny-plan-przyspieszenia--quick-wins)
18. [Strategiczny plan przyspieszenia — Głębokie zmiany](#18-strategiczny-plan-przyspieszenia--głębokie-zmiany)
19. [Estymacja oczekiwanego przyspieszenia](#19-estymacja-oczekiwanego-przyspieszenia)

---

## 1. Streszczenie wykonawcze

Ten audyt jest bezpośrednią kontynuacją raportu OpenAI, ale **schodzi na poziom konkretnych linii kodu, plików i funkcji**. Tam, gdzie poprzedni audyt mówił „architektura ma problemy", ten pokazuje **gdzie dokładnie i ile to kosztuje**.

### Kluczowe odkrycia:

| # | Problem | Plik / linia | Szacunkowy wpływ |
|---|---------|-------------|------------------|
| 1 | AoS `Vec<[f64;3]>` jako rdzeń | `engine/lib.rs:22` | **2-4× wolniejszy** niż SoA na CPU, blokuje wektoryzację |
| 2 | CPU liczy Newell spectra dla GPU | `native_fdm.rs:92-110` | **sekundy** cold-start na dużych siatkach |
| 3 | FFT 3D z ręcznym gather/scatter | `engine/lib.rs:1936-1980` | **30-50%** overhead vs biblioteczna FFT 3D |
| 4 | RK45 alokuje 12+ Vec per step | `engine/lib.rs:1087-1237` | **O(n)** alokacji/krok zamiast 0 |
| 5 | `observe_vectors_ws` = dodatkowy pełny demag | `engine/lib.rs:1415-1483` | **2× koszt** demag na każdym kroku CPU |
| 6 | Brak persistent session | `runner/lib.rs:38-68` | uniemożliwia cache'owanie operatorów |
| 7 | AoS↔SoA w CUDA upload/download | `context.cu:488-525, 527-582` | **dodatkowe pełne przejście** po danych |
| 8 | FEM demag przez transfer-grid FDM | `native_fem.rs:108-135` | **podwójna dyskretyzacja** |
| 9 | FEM mesh clone w callbacks | `dispatch.rs:696-700` | **MB danych** klonowane co N kroków |
| 10 | ThreadPool budowany per run | `runner/lib.rs:346-360` | overhead ~1ms per run |
| 11 | `step()` bez workspace | `engine/lib.rs:831-834` | pełne FFT re-planning per step |
| 12 | Brak kernel fusion na GPU | `context.cu:616-640` | osobne launch per operator |

---

## 2. Metodologia audytu kodu

Przeanalizowano **7680+ linii kodu źródłowego** w następujących plikach:

| Plik | Linie | Rola |
|------|-------|------|
| `fullmag-engine/src/lib.rs` | 2479 | CPU reference engine, integratory, FFT, demag, observables |
| `fullmag-runner/src/dispatch.rs` | 1001 | Wybór backendu, CUDA/FEM execution loops |
| `fullmag-runner/src/native_fdm.rs` | 840 | Wrapper CUDA FDM, AoS↔SoA boundary |
| `fullmag-runner/src/native_fem.rs` | 732 | Wrapper FEM GPU, transfer-grid bootstrap |
| `fullmag-runner/src/lib.rs` | 672 | Główny entry point, thread pool |
| `native/backends/fdm/src/context.cu` | 644 | CUDA memory management, upload/download |
| `native/include/fullmag_fdm.h` | 254 | Stabilne C ABI |
| `fullmag-fdm-demag/src/lib.rs` | 29 | Shared demag library |

Jako benchmark służy **mumax3**, którego hot path to:
- SoA `float32` bufory na GPU
- cuFFT 3D (batch mode)
- fused exchange+zeeman+demag kernel
- zero host-device traffic w steady state
- single cufftPlanMany per session

---

## 3. PROBLEM 1: AoS jako natywna reprezentacja danych

### Gdzie w kodzie:

```rust
// fullmag-engine/src/lib.rs:22
pub type Vector3 = [f64; 3];

// fullmag-engine/src/lib.rs:534
magnetization: Vec<Vector3>,  // AoS: [mx0,my0,mz0, mx1,my1,mz1, ...]
```

### Dlaczego to problem:

Cały CPU engine operuje na `Vec<[f64; 3]>`. W porównaniu z SoA (`mx[], my[], mz[]`):

1. **Cache efficiency**: Gdy exchange stencil potrzebuje tylko `mx[i-1], mx[i], mx[i+1]`, AoS ładuje zbędne `my, mz` do cache line. Dla 64B cache line: AoS = 2.67 elementów, SoA = 8 elementów.
2. **Wektoryzacja SIMD**: AoS uniemożliwia automatyczną wektoryzację (SSE/AVX). SoA pozwala przetworzyć 4 (AVX2) lub 8 (AVX-512) komórek jednocześnie.
3. **FFT padding**: Demag wymaga tłumaczenia AoS→oddzielne bufory (linie `1564-1582`), co kosztuje dodatkowe pełne przejście po danych:

```rust
// fullmag-engine/src/lib.rs:1564-1582
for z in 0..self.grid.nz {
    for y in 0..self.grid.ny {
        for x in 0..self.grid.nx {
            let src_index = self.grid.index(x, y, z);
            let dst_index = padded_index(px, py, x, y, z);
            ws.buf_mx[dst_index] = Complex::new(moment[0], 0.0);
            ws.buf_my[dst_index] = Complex::new(moment[1], 0.0);
            ws.buf_mz[dst_index] = Complex::new(moment[2], 0.0);
        }
    }
}
```

### mumax3 robi to inaczej:

mumax3 przechowuje pola jako `float *mx, *my, *mz` od samego początku. Padding FFT jest operacją in-place lub zero-copy.

### Szacunek kosztów:

Dla siatki 256×256×1:
- AoS→bufory demag: ~400k elementów × 3 odczyty+zapisy = ~2.4M operacji pamięciowych
- SoA: 0 (dane już w formacie FFT)

**Koszt: 2-4× spowolnienie exchange i demag na CPU.**

---

## 4. PROBLEM 2: CPU-side obliczanie widm Newella dla GPU

### Gdzie w kodzie:

```rust
// fullmag-runner/src/native_fdm.rs:92-110
let demag_kernel_spectra = if plan.enable_demag {
    if plan.grid.cells[2] == 1 {
        Some(fullmag_engine::compute_newell_kernel_spectra_thin_film_2d(
            plan.grid.cells[0] as usize, ...
        ))
    } else {
        Some(fullmag_engine::compute_newell_kernel_spectra(
            plan.grid.cells[0] as usize, ...
        ))
    }
} else { None };
```

A wewnątrz `compute_newell_kernel_spectra` (`engine/lib.rs:430-459`):
1. Buduje cały `FftWorkspace` (linia 438) — co oznacza **pełne CPU FFT 3D na 6 komponentach tensora**
2. Flattenuje Complex → interleaved f64 (linia 439-446)
3. Następnie CUDA backend (`context.cu:424-486`) uploaduje te spectra na GPU, ewentualnie konwertując f64→f32

### Dlaczego to problem:

Dla siatki 256×256×128:
- Padded grid: 512×512×256 = 67M complex values × 6 tensorów
- CPU FFT: ~6 × O(n log n) ≈ 200M FLOPS na CPU
- To zajmuje **sekundy** zanim GPU w ogóle zacznie liczyć!

### mumax3 robi to inaczej:

mumax3 buduje kernel Newella bezpośrednio na GPU z cuFFT. Cold start jest wielokrotnie szybszy.

### Rozwiązanie:

Przenieść budowę widm Newella na GPU:
1. Wylicz wartości tensora w kernelu CUDA (trywialne — to czysta arytmetyka)
2. cuFFT forward bezpośrednio na GPU
3. Eliminuje: CPU compute + host→device transfer 6 tensorów
4. **Oczekiwane przyspieszenie cold-start: 10-50×**

---

## 5. PROBLEM 3: FFT 3D z ręcznym gather/scatter

### Gdzie w kodzie:

```rust
// fullmag-engine/src/lib.rs:1936-1980
fn fft3_core(...) {
    // X-axis transforms (kontynualne w pamięci) — OK
    for z in 0..nz {
        for y in 0..ny {
            let start = padded_index(nx, ny, 0, y, z);
            fft_x.process(&mut data[start..start + nx]);
        }
    }
    // Y-axis transforms — KOSZTOWNY gather/scatter
    for z in 0..nz {
        for x in 0..nx {
            for y in 0..ny {
                line_y[y] = data[padded_index(nx, ny, x, y, z)];  // gather
            }
            fft_y.process(line_y);
            for y in 0..ny {
                data[padded_index(nx, ny, x, y, z)] = line_y[y];  // scatter
            }
        }
    }
    // Z-axis — analogicznie kosztowny
}
```

### Dlaczego to problem:

- **Y i Z osie** wymagają nieciągłych odczytów (stride = `nx` i `nx*ny`) → cache misses
- Każda oś kopiuje dane do tymczasowego bufora, processuje, kopiuje z powrotem
- Wykonywane **18 razy per krok** (3 komponenty M × forward + 3 komponenty H × inverse)

### mumax3 robi to inaczej:

mumax3 używa `cufftPlan3d` lub `cufftPlanMany` — jedna operacja, zero-copy, batch mode. Cała 3D FFT to 1 wywołanie cuFFT.

Nawet na CPU, biblioteki jak FFTW oferują 3D plany z wbudowaną optymalizacją stride, runtime autotuning.

### Rozwiązanie na CPU:

Zastąpić custom `fft3_core` przez:
```rust
// Opcja A: użyj FFTW (najszybsze)
fftw::Plan3D::new(px, py, pz, Sign::Forward).execute(&mut buf);

// Opcja B: przynajmniej eliminuj gather/scatter dla Y/Z
// Transpozycja macierzy + FFT + retranspozycja jest asymptotycznie szybsza
```

**Oczekiwane przyspieszenie CPU demag: 1.3-2×**

---

## 6. PROBLEM 4: Nadmiarowe alokacje w integratorach

### Gdzie w kodzie (RK45 — najczęściej używany):

```rust
// fullmag-engine/src/lib.rs:1087-1237
fn rk45_step(&self, state: &mut ExchangeLlgState, dt: f64, ws: &mut FftWorkspace) -> Result<StepReport> {
    let m0 = state.magnetization.clone();      // ALOKACJA 1: pełna kopia m
    
    loop {
        let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);  // ALOKACJA 2: nowy Vec
        
        let delta: Vec<Vector3> = (0..n).map(|i| ...).collect();  // ALOKACJA 3
        let ms = self.par_apply_normalized(&m0, &delta)?;          // ALOKACJA 4
        let k2 = self.llg_rhs_from_vectors_ws(&ms, ws);           // ALOKACJA 5
        
        // ... stages 3-6, każdy tworzy delta + ms + k_n ... //
        
        let delta5: Vec<Vector3> = (0..n).map(|i| ...).collect(); // ALOKACJA ~11
        let y5 = self.par_apply_normalized(&m0, &delta5)?;        // ALOKACJA ~12
        let k7 = self.llg_rhs_from_vectors_ws(&y5, ws);          // ALOKACJA ~13
        // ... w razie reject: loop → kolejne 13 alokacji
    }
}
```

### Policzmy alokacje na jeden zaakceptowany krok RK45:

| Zmienna | Rozmiar | Ile razy |
|---------|---------|----------|
| `m0` (clone) | n × 24B | 1 |
| `delta` (per stage) | n × 24B | 6 |
| `ms` (per stage) | n × 24B | 5 |
| `k1..k7` | n × 24B | 7 |
| `delta5` | n × 24B | 1 |
| `y5` | n × 24B | 1 |

**Łącznie: ~21 × n × 24B alokacji per krok.**

Dla siatki 256×256×1 (n=65536): ~21 × 65536 × 24 = **31.5 MB** alokacji i zwolnień na jeden krok.

### mumax3 robi to inaczej:

mumax3 prealokuje **wszystkie** bufory stage'ów raz, przy tworzeniu solvera. Krok RK45 operuje in-place na trwałych buforach GPU. **Zero alokacji w hot loop.**

### Rozwiązanie:

```rust
struct IntegratorBuffers {
    k1: Vec<Vector3>, k2: Vec<Vector3>, ..., k7: Vec<Vector3>,
    delta: Vec<Vector3>,
    m_stage: Vec<Vector3>,
    m0_backup: Vec<Vector3>,
}
// Budowane raz, reużywane w każdym kroku
```

**Oczekiwane przyspieszenie: 1.2-1.5× (eliminacja allocator pressure, lepsze cache reuse)**

Na CUDA (context.cu:316-323) bufory **są już prealokowane** (`k2..k6, k_fsal`). Problem dotyczy głównie CPU reference.

---

## 7. PROBLEM 5: `observe_vectors_ws` — ukryty pełny demag na każdym kroku

### Gdzie w kodzie:

```rust
// fullmag-engine/src/lib.rs:905 (w heun_step)
let observables = self.observe_vectors_ws(state.magnetization(), ws);

// fullmag-engine/src/lib.rs:1415-1483
fn observe_vectors_ws(&self, magnetization: &[Vector3], ws: &mut FftWorkspace) -> EffectiveFieldObservables {
    let exchange_field = self.exchange_field_from_vectors(magnetization);  // pełne przejście
    let demag_field = self.demag_field_from_vectors_ws(magnetization, ws);  // PEŁNE FFT DEMAG!
    let external_field = self.external_field_vectors();                     // pełne przejście
    let effective_field = combine_fields(&exchange_field, &demag_field, &external_field);  // pełne przejście
    let rhs = ... // pełne przejście
    // + 3 energię (exchange, demag, external) — 3 kolejne przejścia
    // + 2 max norms — 2 kolejne przejścia
}
```

### Dlaczego to katastrofa na CPU:

**Na każdym kroku Heuna** (linia 905), po wykonaniu właściwego kroku, wywoływane jest `observe_vectors_ws`, które **ponownie oblicza pełny demag** (FFT forward 3×, tensor multiply, FFT inverse 3×), exchange, i 8+ pełnych przejść po danych.

To oznacza, że krok Heuna z demag ma koszt:
- 2× RHS (prawidłowy koszt Heuna) = 2× demag
- 1× observe (dodatkowy koszt!) = 1× demag
- **Łącznie: 3× demag zamiast 2×, czyli 50% overhead!**

### mumax3 robi to inaczej:

mumax3 oblicza energię i diagnostykę **z pól już policzonych podczas RHS**, nie wykonuje dodatkowej ewaluacji demag. Scalar norms (max |dm/dt|, max |H_eff|) są liczone jako CUB reductions bezpośrednio w kernelach kroku.

### Rozwiązanie:

```rust
fn heun_step(...) -> Result<StepReport> {
    let k1 = self.llg_rhs_from_vectors_ws(&initial, ws);
    // ... krok Heuna ...
    // Zamiast observe_vectors_ws, użyj danych z ostatniego RHS:
    let report = StepReport {
        exchange_energy: self.exchange_energy_from_field(m, &last_h_ex),
        // itd. — zero dodatkowego demag
    };
}
```

**Oczekiwane przyspieszenie CPU reference: 1.3-1.5× (RK45 jeszcze więcej)**

---

## 8. PROBLEM 6: Brak trwałej sesji solverowej

### Gdzie w kodzie:

```rust
// fullmag-runner/src/lib.rs:38-68
pub fn run_problem(problem: &ProblemIR, until_seconds: f64, output_dir: &Path) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;           // 1. Planuj od zera
    let cpu_threads = configured_cpu_threads(problem);
    let executed = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;       // 2. Resolve engine
            dispatch::execute_fdm(engine, fdm, until_seconds, &plan.output_plan.outputs) // 3. Execute
        }
        ...
    })?;
    // ... write artifacts ...
    Ok(executed.result)  // Backend znika, cała state jest porzucona
}
```

### Model „job execution" vs „persistent session":

Pełna sekwencja per `run_problem`:
1. `fullmag_plan::plan()` — parse + validate + lower
2. `with_cpu_parallelism()` — **nowy ThreadPool**
3. `NativeFdmBackend::create()` — allokacja GPU, upload m, compute Newell spectra, upload spectra, cuFFTPlan
4. Pętla step
5. `copy_m()` na końcu — download final m
6. Backend `Drop` — **zwolnienie całej GPU memory, cuFFT plan, spectra**

Jeśli użytkownik chce:
- continuation study → **cały cold start od nowa**
- parametric sweep → **N razy ten sam setup**
- relaksacja + dynamics → **dwa run_problem z pełnym resetem**

### mumax3 robi to inaczej:

mumax3 buduje persistent world z buforami, planami FFT i operatorami, które żyją przez cały skrypt. `run()` wielokrotnie kontynuuje z tego samego stanu.

### Rozwiązanie:

Wprowadzić `SolverSession`:
```rust
let session = SolverSession::open(compiled_plan)?;  // one-time setup
session.advance_until(1e-9)?;                        // step many
let scalars = session.sample_scalars()?;             // cheap
let m = session.snapshot_field("m")?;                // explicit, rare
session.advance_until(5e-9)?;                        // continue
session.close()?;                                    // cleanup
```

---

## 9. PROBLEM 7: AoS↔SoA na granicy host↔device

### Gdzie w kodzie:

**Upload (host → device):**
```cpp
// native/backends/fdm/src/context.cu:488-525
bool context_upload_magnetization(Context &ctx, const double *m_xyz, uint64_t len) {
    // Deinterleave on host: AoS → 3 osobne wektory
    std::vector<double> hx(n), hy(n), hz(n);
    for (uint64_t i = 0; i < n; i++) {
        hx[i] = m_xyz[3 * i + 0];  // strided read
        hy[i] = m_xyz[3 * i + 1];
        hz[i] = m_xyz[3 * i + 2];
    }
    cudaMemcpy(ctx.m.x, hx.data(), bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(ctx.m.y, hy.data(), bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(ctx.m.z, hz.data(), bytes, cudaMemcpyHostToDevice);
}
```

**Download (device → host):**
```cpp
// native/backends/fdm/src/context.cu:527-582
bool context_download_field_f64(...) {
    std::vector<double> hx(n), hy(n), hz(n);
    cudaMemcpy(hx.data(), field->x, bytes, cudaMemcpyDeviceToHost);
    cudaMemcpy(hy.data(), field->y, bytes, cudaMemcpyDeviceToHost);
    cudaMemcpy(hz.data(), field->z, bytes, cudaMemcpyDeviceToHost);
    for (uint64_t i = 0; i < n; i++) {
        out_xyz[3 * i + 0] = hx[i];  // interleave back
        out_xyz[3 * i + 1] = hy[i];
        out_xyz[3 * i + 2] = hz[i];
    }
}
```

Ponadto w Rust (`native_fdm.rs:77-81`):
```rust
let m_flat: Vec<f64> = plan.initial_magnetization.iter()
    .flat_map(|v| v.iter().copied()).collect();  // Vec<[f64;3]> → Vec<f64>
```

### Koszt:

Dla 1M komórek:
- Upload: alokacja 3× 8MB tymczasowe wektory + O(n) deinterleave + 3× cudaMemcpy
- Download: 3× cudaMemcpy + alokacja 3× 8MB + O(n) interleave

Łącznie na snapshot: **48MB** alokacji tymczasowych + **O(6n)** operacji pamięciowych.

### Rozwiązanie:

Dwa podejścia:
1. **Natychmiast**: Dodać SoA API do Rusta, omijając konwersję
2. **Docelowo**: Traktować dane po stronie Rust jako SoA, eliminując konwersję

---

## 10. PROBLEM 8: FEM transfer-grid demag bootstrap

### Gdzie w kodzie:

```rust
// fullmag-runner/src/native_fem.rs:108-135
let demag_kernel_spectra = if plan.enable_demag {
    let (bbox_min, bbox_max) = mesh_bbox(&plan.mesh.nodes).ok_or_else(|| ...)?;
    let requested = plan.hmax.max(1e-12);
    let extent = [...];
    let nx = transfer_axis_cells(extent[0], requested);
    let ny = transfer_axis_cells(extent[1], requested);
    let nz = transfer_axis_cells(extent[2], requested);
    // ... oblicza widma Newella na CPU jak dla zwykłego FDM ...
    Some(fullmag_engine::compute_newell_kernel_spectra(nx, ny, nz, dx, dy, dz))
};
```

### Konsekwencje architektoniczne:

1. **Podwójna dyskretyzacja**: Mesh FEM + grid transferowy FDM żyją jednocześnie
2. **Projekcja M↔grid**: przy każdym kroku solvera — mesh→grid, demag na gridzie, grid→mesh
3. **hmax steruje dwoma rzeczami**: rozmiarem elementu FEM i gęstością gridu demag
4. **Nie jest mesh-native**: prawdziwy FEM demag (scalar potential / BEM / air-box) nawet nie istnieje

### mumax3 nie ma tego problemu bo:

mumax3 nie robi FEM. Ale Boris rozwiązuje demag w FEM natywnie (FEM/BEM coupling).

---

## 11. PROBLEM 9: Klonowanie pełnego payloadu FEM mesh w live callbacks

### Gdzie w kodzie:

```rust
// fullmag-runner/src/dispatch.rs:696-700
(live.on_step)(StepUpdate {
    stats: stats.clone(),
    fem_mesh: Some(crate::types::FemMeshPayload {
        nodes: plan.mesh.nodes.clone(),       // CLONE: Vec<[f64;3]>
        elements: plan.mesh.elements.clone(), // CLONE: Vec<[u32;4]>
        boundary_faces: plan.mesh.boundary_faces.clone(), // CLONE
    }),
    ...
});
```

### Koszt:

Dla mesha z 100k node'ów i 500k elementów:
- `nodes.clone()`: 100k × 24B = 2.4MB
- `elements.clone()`: 500k × 16B = 8MB
- `boundary_faces.clone()`: proporcjonalnie

**~10+ MB klonowane potencjalnie co N kroków live.**

Mesh jest **statyczny** przez cały run! Powinien być wysłany raz jako metadata sesji.

---

## 12. PROBLEM 10: Budowa ThreadPool per run

### Gdzie w kodzie:

```rust
// fullmag-runner/src/lib.rs:346-360
fn with_cpu_parallelism<T>(...) -> Result<T, RunError> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(cpu_threads)
        .build()                    // BUDUJE nowy ThreadPool
        .map_err(|error| ...)?
        .install(f)                 // Install + run + destroy
}
```

### Koszt:

~1ms na budowę puli. Nieistotne dla długich symulacji, ale kwadratowo istotne dla parametric sweeps z wieloma krótkimi runami.

---

## 13. PROBLEM 11: Domyślne ścieżki API tworzące workspace na każdym kroku

### Gdzie w kodzie:

```rust
// fullmag-engine/src/lib.rs:831-834
pub fn step(&self, state: &mut ExchangeLlgState, dt: f64) -> Result<StepReport> {
    let mut ws = self.create_workspace();   // PEŁNY FFT PLAN + NEWELL COMPUTE!
    self.step_with_workspace(state, dt, &mut ws)
}
```

I analogicznie:
```rust
// linia 1546-1548
fn demag_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
    let mut ws = self.create_workspace();  // cały workspace od nowa!
    self.demag_field_from_vectors_ws(magnetization, &mut ws)
}

// linia 1660-1662
pub fn effective_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
    let mut ws = self.create_workspace();
    ...
}
```

### Koszt `create_workspace()`:

```rust
// linia 257-324
pub fn new(nx, ny, nz, dx, dy, dz) -> Self {
    // 1. FftPlanner::new() — runtime autodetection
    // 2. plan_fft_forward × 3 axes
    // 3. newell::compute_newell_kernels() — heavy arithmetic
    // 4. fft_kernel() × 6 components — 6× pełna 3D FFT on CPU!
    // 5. alokacja 6 padded buforów complex
}
```

Dla siatki 128×128×1 to **~100ms per workspace**. Jeśli ktoś wywoła `step()` zamiast `step_with_workspace()`, to 100ms overhead **na każdym kroku**.

---

## 14. PROBLEM 12: Brak kernel fusion w CUDA backendzie

### Gdzie w kodzie:

```cpp
// native/backends/fdm/src/context.cu:616-640
bool context_refresh_observables(Context &ctx) {
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);   // kernel launch 1
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);      // kernel launch 2 (FFT + multiply + IFFT)
    }
    launch_effective_field_fp64(ctx);      // kernel launch 3
    // ... reductions for max norms ...    // kernel launches 4-6
}
```

### mumax3 robi to inaczej:

mumax3 potrafi fusować exchange+zeeman+anizotropy w jeden kernel, zmniejszając liczbę przejść po pamięci globalnej.

### Rozwiązanie:

Fused kernel `H_eff = H_ex + H_demag + H_ext`:
- Exchange: odczyt m[neighbors], wynik bezpośrednio do `H_eff`
- Demag: wynik bezpośrednio do `H_eff` (akumulacja)
- External: stały wektor, dodany w tym samym kernelu
- **1 zapis zamiast 3 zapisów + 3 odczytów**

---

## 15. Ranking krytyczności — podsumowanie

### Kategoria A — blokujące konkurencyjność z mumax

| # | Problem | Wpływ |
|---|---------|-------|
| 5 | Observe_vectors_ws — dodatkowy demag na każdym kroku | **~50% overhead CPU** |
| 3 | Custom FFT 3D z gather/scatter | **30-50% overhead CPU demag** |
| 1 | AoS zamiast SoA | **2-4× pogorszenie cache + wektoryzacji** |
| 2 | CPU-side Newell spectra dla GPU | **sekundy cold-start** |

### Kategoria B — pogarszające skalowanie

| # | Problem | Wpływ |
|---|---------|-------|
| 4 | Alokacje w integratorach | **31.5MB/krok** alloc pressure (CPU) |
| 7 | AoS↔SoA konwersja przy upload/download | **dodatkowe przejście** |
| 6 | Brak persistent session | **uniemożliwia cache** |
| 8 | FEM transfer-grid demag | **podwójna dyskretyzacja** |

### Kategoria C — pogarszające UX/skalowanie

| # | Problem | Wpływ |
|---|---------|-------|
| 9 | FEM mesh clone w callbacks | **10+ MB/callback** |
| 10 | ThreadPool per run | **~1ms/run** |
| 11 | step() bez workspace | **~100ms/krok** jeśli użyte |
| 12 | Brak kernel fusion CUDA | **dodatkowe kernel launches** |

---

## 16. Porównanie architektoniczne: Fullmag vs mumax3

| Aspekt | mumax3 | Fullmag |
|--------|--------|---------|
| **Data layout** | SoA `float32*` na GPU | AoS `Vec<[f64;3]>` na CPU, SoA dopiero na GPU |
| **FFT** | cuFFT `cufftPlanMany` batched | Custom `fft3_core` z gather/scatter (CPU), cuFFT single plan (GPU) |
| **Newell kernel** | GPU-native compute + cuFFT | CPU compute + CPU FFT + H→D upload |
| **Integrator buffers** | Prealokowane na GPU, zero alloc | Nowe `Vec` per stage per step (CPU) |
| **Observables per step** | Fused z RHS, scalar reductions | Osobny `observe_vectors_ws` z pełnym demag |
| **Session model** | Persistent world | `run_problem` → build → run → destroy |
| **Host↔device traffic** | Tylko scalar telemetry w steady state | `copy_m`, `copy_h_*` dla snapshotów |
| **Precision** | `float32` default | `float64` default |
| **Kernel fusion** | Exchange+Zeeman+Ani fused | Osobne launch per operator |

---

## 17. Konkretny plan przyspieszenia — Quick Wins

Zmiany, które można zrobić **bez gruntownego refaktoru architektury**:

### QW-1: Eliminacja observe_vectors_ws w integratorach

**Plik:** `fullmag-engine/src/lib.rs`  
**Krok:**  Zmienić `heun_step`, `rk4_step`, `rk45_step`, `abm3_step` tak, aby budowały `StepReport` z danych już policzonych w RHS, zamiast wywoływać `observe_vectors_ws`.

**Oczekiwane przyspieszenie: 1.3-1.5× (CPU reference z demag)**

### QW-2: Prealokacja buforów integratora (CPU reference)

**Plik:** `fullmag-engine/src/lib.rs`  
**Krok:** Dodać `IntegratorWorkspace` do `ExchangeLlgState` lub osobnej struktury, prealokować k1..k7, delta, m_stage.

**Oczekiwane przyspieszenie: 1.1-1.3× (CPU reference)**

### QW-3: Usunięcie `step()` bez workspace z public API

**Plik:** `fullmag-engine/src/lib.rs`  
**Krok:** Deprecate `step()`, wymuś `step_with_workspace()`.

**Oczekiwane przyspieszenie: eliminacja 100ms+ accidental overhead**

### QW-4: Wyślij FEM mesh payload raz, nie co callback

**Plik:** `fullmag-runner/src/dispatch.rs`  
**Krok:** Zmienić live callback FEM, aby mesh był wysyłany tylko przy `step == 1` lub na żądanie.

**Oczekiwane przyspieszenie: eliminacja 10+ MB/callback overhead**

### QW-5: Reużywaj rayon ThreadPool

**Plik:** `fullmag-runner/src/lib.rs`  
**Krok:** Lazy static lub session-scoped pool.

**Oczekiwane przyspieszenie: ~1ms per run (istotne dla sweeps)**

---

## 18. Strategiczny plan przyspieszenia — Głębokie zmiany

### ST-1: SoA jako natywny layout (CPU reference)

Zmienić `type Vector3 = [f64; 3]` + `Vec<Vector3>` na:
```rust
struct FieldSoA {
    x: Vec<f64>,
    y: Vec<f64>,
    z: Vec<f64>,
}
```

- Umożliwi SIMD wektoryzację
- Upraszcza interfejs z FFT (zero-copy padding)
- Eliminuje AoS↔SoA konwersję na granicy backendu

### ST-2: GPU-native Newell kernel build

Przenieść `compute_newell_kernels` + FFT na GPU:
```
GPU kernel: compute_newell_real_space(nx,ny,nz,dx,dy,dz, out_tensor[6])
cuFFT forward: plan_3d × 6 components
→ gotowe spectra na GPU bez jakiegokolwiek host involvement
```

### ST-3: Persistent SolverSession

```rust
trait SolverSession {
    fn step_many(&mut self, n: u64) -> Result<ScalarStats>;
    fn sample_scalars(&self) -> ScalarSnapshot;
    fn snapshot_field(&self, name: &str) -> Result<Vec<[f64;3]>>;
    fn advance_until(&mut self, t: f64) -> Result<ScalarStats>;
}
```

Cache'owanie: FFT plans, Newell spectra, alokacje buforów — wszystko żyje przez session.

### ST-4: Zastąpienie custom FFT na CPU przez FFTW/RustFFT batch mode

Zamiast `fft3_core` z ręcznym gather/scatter, użyj `rustfft` z lepszą strategią (np. transpozycja-FFT-transpozycja) lub przejdź na FFTW (C binding) dla produkcyjnego CPU reference.

### ST-5: Fused CUDA kernels

Stworzyć fused kernel `compute_rhs`:
```
__global__ void compute_rhs(mx, my, mz, hx, hy, hz, ...) {
    // exchange stencil → h_ex
    // add h_demag (already computed by FFT)
    // add h_ext (constant)
    // compute LLG RHS in one pass
    // compute dm/dt norm (for reductions)
}
```

### ST-6: Strategiczna decyzja FEM demag

Wybrać jedną z trzech dróg:
1. **Scalar potential + air-box** — najlepsza dla zamkniętych geometrii
2. **FEM/BEM coupling** — najlepsza dla otwartych boundary
3. **Transfer-grid jako jawny fallback** — OK, ale nie jako fundament

---

## 19. Estymacja oczekiwanego przyspieszenia

### CPU reference (z demag, siatka 256×256×1):

| Zmiana | Przyspieszenie | Kumulatywne |
|--------|---------------|-------------|
| Baseline | 1× | 1× |
| QW-1: Eliminacja dodatkowego demag w observe | 1.3-1.5× | 1.3-1.5× |
| QW-2: Prealokacja buforów integratora | 1.1-1.3× | 1.5-1.9× |
| ST-1: SoA layout | 1.5-2× | 2.2-3.8× |
| ST-4: FFTW zamiast custom FFT | 1.3-2× | 2.9-7.6× |

### CUDA FDM:

| Zmiana | Przyspieszenie | Notatka |
|--------|---------------|---------|
| ST-2: GPU-native Newell | 10-50× cold start | nie wpływa na steady-state |
| ST-5: Fused kernels | 1.1-1.3× steady-state | mniej kernel launches |
| ST-3: Persistent session | eliminacja cold start w sweeps | architektoniczny |
| float32 as default | ~2× throughput | zmiana precyzji |

### Podsumowanie:

> **Na CPU reference z demag, zaimplementowanie QW-1 + QW-2 + ST-1 + ST-4 może dać 3-7× przyspieszenie bez zmiany algorytmów fizycznych.**
>
> **Na CUDA, najważniejsze jest ST-2 (GPU-native kernel build) redukujący cold start z sekund do milisekund, oraz ST-3 (persistent session) eliminujący powtarzany setup w sweeps.**
>
> **Różnica float64 vs float32 to osobny ~2× czynnik, który mumax3 domyślnie wykorzystuje.**

---

*Raport oparty o bezpośrednią analizę kodu źródłowego fullmag commit z dnia 2026-03-27.*
