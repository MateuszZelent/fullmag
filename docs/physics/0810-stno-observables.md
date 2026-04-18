# STNO Observables — Extraction and Analysis Reference

## Overview

This document describes the observables relevant to STNO characterization and how they are extracted from fullmag simulation output using the `fullmag.analysis` module.

For the current public benchmark slice, the canonical artifact-backed entrypoints are:

```python
from fullmag.analysis import analyze_stno_artifacts, write_stno_report

report = analyze_stno_artifacts("run_output/stno_vortex_ref_minimal")
write_stno_report("run_output/stno_vortex_ref_minimal", report=report)
```

---

## 1. Power Spectral Density (PSD)

The primary STNO observable is the PSD of a spatially-averaged magnetization component (typically ⟨mₓ⟩ or ⟨m_y⟩).

### Extraction pipeline

```
time trace  →  discard transient  →  windowing  →  FFT  →  |FFT|²  →  PSD
```

**Python API:**
```python
from fullmag.analysis import psd_from_trace, peak_frequency

freqs, psd = psd_from_trace(t, mx, window="hann", discard_transient=5e-9)
f_peak = peak_frequency(freqs, psd, fmin=100e6, fmax=5e9)
```

### Parameters

| Parameter | Meaning | Typical value |
|-----------|---------|---------------|
| `window` | FFT windowing function (SciPy names) | `"hann"` |
| `discard_transient` | Time [s] discarded from beginning | 5–20 ns |
| `fmin`, `fmax` | Frequency search range [Hz] | 100 MHz – 5 GHz |

### Interpretation

- **Peak frequency** = vortex gyrotropic mode frequency
- Scales with applied current density $J$ above threshold
- Typical range: 100 MHz – 1 GHz for vortex STNOs
- For the current reference benchmark, the signal is selected from the real `mx` / `my` artifact traces, not from synthetic data.

---

## 2. Linewidth (FWHM)

The spectral linewidth is the full width at half maximum (FWHM) of the PSD peak. It quantifies oscillation coherence.

### Method 1: Half-maximum crossing (fast)

```python
from fullmag.analysis import linewidth_halfmax

result = linewidth_halfmax(freqs, psd, fmin=100e6, fmax=2e9)
# result = {"f_center": float, "fwhm": float, "peak_power": float}
```

Simple geometric estimator. Suitable for clean peaks with low background.

### Method 2: Lorentzian fit (production)

```python
from fullmag.analysis import fit_lorentzian_linewidth, LinewidthFitResult

result: LinewidthFitResult = fit_lorentzian_linewidth(
    freqs, psd, fmin=100e6, fmax=2e9
)
print(f"f0 = {result.f0_hz/1e6:.1f} MHz, FWHM = {result.fwhm_hz/1e6:.2f} MHz")
print(f"Q = {result.q_factor:.0f}, R² = {result.fit_r2}")
```

The model:

$$
S(f) = B_0 + B_1 f + \frac{A}{1 + \left(\frac{f - f_0}{\gamma}\right)^2}
$$

where FWHM $= 2\gamma$. The linear background $(B_0 + B_1 f)$ accounts for broadband noise.

### Quality factor

$$
Q = \frac{f_0}{\Delta f_\mathrm{FWHM}}
$$

Typical values: $Q \sim 10$–$10^4$ depending on temperature, current, damping.

### Convergence requirements

| Factor | Impact on linewidth |
|--------|-------------------|
| Simulation time | Longer → narrower bins → sharper peak |
| Temperature | Higher T → broader linewidth |
| Mesh resolution | Must resolve exchange length |
| Time step | Must be ≪ 1/(2 f_peak) |

**Rule of thumb:** simulate for $\geq 50/\Delta f_\mathrm{expected}$ to resolve the linewidth.

---

## 3. Vortex Core Position Tracking

The vortex core is identified by the out-of-plane magnetization component $m_z$.

### Basic tracker

```python
from fullmag.analysis import track_vortex_core

xc, yc = track_vortex_core(mz, x, y, method="weighted_centroid", power=4.0)
```

Methods: `"weighted_centroid"` (default), `"argmax_mz"`.

### Sub-pixel tracker (production)

```python
from fullmag.analysis import track_vortex_core_subpixel, CoreTrackResult

result: CoreTrackResult = track_vortex_core_subpixel(
    mz, x, y,
    method="quadratic_subpixel",
    window=5,
)
print(f"Core at ({result.x/1e-9:.2f}, {result.y/1e-9:.2f}) nm, "
      f"confidence={result.confidence:.2f}")
```

Methods ranked by accuracy:

| Method | Accuracy | Speed | Notes |
|--------|----------|-------|-------|
| `argmax_mz` | grid-limited | fastest | Nearest grid point |
| `weighted_centroid` | sub-grid | fast | Good for well-localized cores |
| `quadratic_subpixel` | sub-pixel | moderate | 2D parabolic fit in local window |
| `gaussian_local_fit` | sub-pixel | moderate | Same as quadratic (future: Gaussian model) |
| `continuity_regularized` | sub-pixel | moderate | Jump clamping for trajectory continuity |

### Confidence scoring

Each `CoreTrackResult` includes a `confidence` ∈ [0, 1]:
- **> 0.8**: Reliable core position
- **0.3–0.8**: Acceptable, some ambiguity
- **< 0.3**: Unreliable (e.g., clamped jump, nearly uniform mz)

---

## 4. Orbit Metrics

Given a time series of vortex core positions $(x_c(t), y_c(t))$:

### Orbit radius

```python
from fullmag.analysis import core_orbit_radius

radii = core_orbit_radius(xc, yc, center=(0.0, 0.0))
mean_radius = np.mean(radii)
```

### Phase and frequency

```python
from fullmag.analysis import core_phase

phases = core_phase(xc, yc, center=(0.0, 0.0), unwrap=True)
# Gyration frequency from phase slope:
omega = np.polyfit(t, phases, 1)[0]
f_gyration = abs(omega) / (2 * np.pi)
```

### Advanced orbit analysis

```python
from fullmag.analysis import compute_orbit_metrics, OrbitMetrics

metrics: OrbitMetrics = compute_orbit_metrics(xc, yc, t)
print(f"Radius = {metrics.mean_radius/1e-9:.1f} nm")
print(f"Ellipticity = {metrics.ellipticity:.3f}")
print(f"Gyration = {metrics.angular_frequency_hz/1e6:.1f} MHz")
```

**Ellipticity** is computed from PCA of the trajectory:

$$
e = \sqrt{1 - \frac{\lambda_2}{\lambda_1}}
$$

where $\lambda_1 > \lambda_2$ are eigenvalues of the position covariance matrix.
- $e = 0$: circular orbit
- $e \to 1$: highly elongated orbit

## 5. Artifact workflow contract

The current STNO report path expects:

- `scalars.csv` with at least `time`, `mx`, `my`, `mz`,
- optional `fields/m/step_*.json` for vortex-core tracking,
- real solver artifacts from the executable benchmark path.

The current report summary computes:

- peak frequency,
- linewidth,
- Q factor,
- steady-state score,
- orbit radius and ellipticity when `fields/m` snapshots exist.

---

## 6. Deprecated Functions

| Deprecated | Replacement | Notes |
|------------|-------------|-------|
| `linewidth_lorentzian()` | `fit_lorentzian_linewidth()` | Old half-max based, no background correction |

---

## 7. References

1. Slavin & Tiberkevich, IEEE Trans. Magn. 45 (2009) — STNO theory
2. Dussaux et al., Nat. Commun. 1, 8 (2010) — vortex STNO experiments
3. Grimaldi et al., Phys. Rev. B 89 (2014) — linewidth measurements
4. Thiele, Phys. Rev. Lett. 30 (1973) — vortex core dynamics
