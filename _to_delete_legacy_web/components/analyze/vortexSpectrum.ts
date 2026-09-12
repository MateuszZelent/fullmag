/**
 * Client-side FFT / PSD computation for vortex time-trace analysis.
 *
 * Uses the browser's built-in functionality (no external FFT library required).
 * For production accuracy, consider replacing with a Web Worker + FFT library.
 */

import type {
  FftWindow,
  LinewidthResult,
  LorentzianFitResult,
  VortexSpectrumConfig,
  VortexSpectrumResult,
  VortexTimeSample,
} from "./vortexTypes";

/* ── Window functions ─────────────────────────────── */

function windowFn(name: FftWindow, n: number): Float64Array {
  const w = new Float64Array(n);
  if (name === "none") {
    w.fill(1);
    return w;
  }
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    switch (name) {
      case "hann":
        w[i] = 0.5 * (1 - Math.cos(x));
        break;
      case "hamming":
        w[i] = 0.54 - 0.46 * Math.cos(x);
        break;
      case "blackman":
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
        break;
    }
  }
  return w;
}

/* ── Naive DFT (O(n²)) for small-to-medium datasets ─ */

function realDft(
  signal: Float64Array,
): { re: Float64Array; im: Float64Array } {
  const n = signal.length;
  const nf = Math.floor(n / 2) + 1;
  const re = new Float64Array(nf);
  const im = new Float64Array(nf);
  for (let k = 0; k < nf; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (2 * Math.PI * k * t) / n;
      sr += signal[t] * Math.cos(angle);
      si -= signal[t] * Math.sin(angle);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}

/* ── PSD for a single channel ────────────────────── */

function channelPsd(
  values: Float64Array,
  win: Float64Array,
  fs: number,
): Float64Array {
  const n = values.length;

  // Subtract mean
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;

  const windowed = new Float64Array(n);
  let winPow = 0;
  for (let i = 0; i < n; i++) {
    windowed[i] = (values[i] - mean) * win[i];
    winPow += win[i] * win[i];
  }

  const { re, im } = realDft(windowed);
  const nf = re.length;
  const psd = new Float64Array(nf);

  for (let k = 0; k < nf; k++) {
    psd[k] = (2 * (re[k] * re[k] + im[k] * im[k])) / (winPow * fs);
  }
  // DC and Nyquist: not doubled
  psd[0] /= 2;
  if (nf > 1 && n % 2 === 0) psd[nf - 1] /= 2;

  return psd;
}

/* ── Public API ──────────────────────────────────── */

export function computeVortexSpectrum(
  samples: VortexTimeSample[],
  config: VortexSpectrumConfig,
): VortexSpectrumResult {
  // Filter transient
  let data = samples;
  if (config.discardTransientS > 0) {
    data = data.filter((s) => s.time >= config.discardTransientS);
  }
  if (data.length < 4) {
    return {
      frequencies: [],
      psd_mx: [],
      psd_my: [],
      psd_mz: [],
      peak_frequency_hz: null,
      peak_channel: null,
    };
  }

  const n = data.length;
  const dt = (data[n - 1].time - data[0].time) / (n - 1);
  const fs = 1 / dt;

  const win = windowFn(config.window, n);

  const mxArr = new Float64Array(n);
  const myArr = new Float64Array(n);
  const mzArr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mxArr[i] = data[i].mx;
    myArr[i] = data[i].my;
    mzArr[i] = data[i].mz;
  }

  const psdMx = channelPsd(mxArr, win, fs);
  const psdMy = channelPsd(myArr, win, fs);
  const psdMz = channelPsd(mzArr, win, fs);

  const nf = psdMx.length;
  const freqs = new Array<number>(nf);
  for (let k = 0; k < nf; k++) {
    freqs[k] = (k * fs) / n;
  }

  // Find global peak
  let bestPower = -1;
  let bestK = 0;
  let bestCh: "mx" | "my" | "mz" = "mx";
  for (let k = 1; k < nf; k++) {
    const f = freqs[k];
    if (f < config.fMinHz) continue;
    if (config.fMaxHz != null && f > config.fMaxHz) continue;
    for (const [ch, psd] of [
      ["mx", psdMx],
      ["my", psdMy],
      ["mz", psdMz],
    ] as const) {
      if (psd[k] > bestPower) {
        bestPower = psd[k];
        bestK = k;
        bestCh = ch;
      }
    }
  }

  return {
    frequencies: freqs,
    psd_mx: Array.from(psdMx),
    psd_my: Array.from(psdMy),
    psd_mz: Array.from(psdMz),
    peak_frequency_hz: bestPower > 0 ? freqs[bestK] : null,
    peak_channel: bestPower > 0 ? bestCh : null,
  };
}

/** Estimate FWHM linewidth around a peak using half-maximum crossing. */
export function estimateLinewidth(
  frequencies: number[],
  psd: number[],
  fCenter: number,
): LinewidthResult {
  if (frequencies.length === 0) {
    return { f_center_hz: fCenter, fwhm_hz: 0, peak_power: 0 };
  }

  let peakIdx = 0;
  let peakPower = 0;
  for (let i = 0; i < frequencies.length; i++) {
    if (psd[i] > peakPower) {
      peakPower = psd[i];
      peakIdx = i;
    }
  }

  const halfMax = peakPower / 2;
  let iLow = peakIdx;
  let iHigh = peakIdx;
  while (iLow > 0 && psd[iLow] >= halfMax) iLow--;
  while (iHigh < frequencies.length - 1 && psd[iHigh] >= halfMax) iHigh++;

  return {
    f_center_hz: frequencies[peakIdx],
    fwhm_hz: frequencies[iHigh] - frequencies[iLow],
    peak_power: peakPower,
  };
}

/* ── Lorentzian + linear background fit ────────── */

/**
 * Lorentzian model: S(f) = B0 + B1·f + A / (1 + ((f - f0) / γ)²)
 * where FWHM = 2γ.
 */
function lorentzianModel(
  f: number,
  f0: number,
  gamma: number,
  A: number,
  B0: number,
  B1: number,
): number {
  return B0 + B1 * f + A / (1 + ((f - f0) / gamma) ** 2);
}

/**
 * Simple Gauss–Newton–like iterative Lorentzian fit (client-side, no scipy).
 *
 * Uses Levenberg–Marquardt-style damped least-squares with analytical Jacobian.
 * Parameters: [f0, γ, A, B0, B1]
 */
export function fitLorentzianLinewidth(
  frequencies: number[],
  psd: number[],
  opts?: { fMinHz?: number; fMaxHz?: number; maxIter?: number },
): LorentzianFitResult | null {
  const fMin = opts?.fMinHz ?? 0;
  const fMax = opts?.fMaxHz ?? Infinity;
  const maxIter = opts?.maxIter ?? 200;

  // Filter to range
  const idx: number[] = [];
  for (let i = 0; i < frequencies.length; i++) {
    if (frequencies[i] >= fMin && frequencies[i] <= fMax) idx.push(i);
  }
  if (idx.length < 6) return null;

  const f = idx.map((i) => frequencies[i]);
  const y = idx.map((i) => psd[i]);
  const n = f.length;

  // Initial guesses
  let peakIdx = 0;
  for (let i = 1; i < n; i++) {
    if (y[i] > y[peakIdx]) peakIdx = i;
  }
  const f0_init = f[peakIdx];
  const A_init = y[peakIdx];
  const B0_init = Math.min(...y);

  // FWHM from half-max crossing
  const halfMax = (A_init + B0_init) / 2;
  let iLo = peakIdx;
  let iHi = peakIdx;
  while (iLo > 0 && y[iLo] >= halfMax) iLo--;
  while (iHi < n - 1 && y[iHi] >= halfMax) iHi++;
  const gamma_init = Math.max((f[iHi] - f[iLo]) / 2, (f[1] - f[0]) * 2);

  // params: [f0, gamma, A, B0, B1]
  const p = [f0_init, gamma_init, A_init - B0_init, B0_init, 0];
  let lambda = 1e-3;

  for (let iter = 0; iter < maxIter; iter++) {
    // Compute residuals and Jacobian
    const r = new Array(n);
    // J[i][j] = ∂model/∂p_j at f[i]
    const J: number[][] = [];
    for (let i = 0; i < n; i++) {
      const fi = f[i];
      const [f0, g, A, B0, B1] = p;
      const u = (fi - f0) / g;
      const denom = 1 + u * u;
      const modelVal = B0 + B1 * fi + A / denom;
      r[i] = y[i] - modelVal;

      // Partial derivatives
      const dLdf0 = (2 * A * (fi - f0)) / (g * g * denom * denom);
      const dLdg = (2 * A * (fi - f0) ** 2) / (g ** 3 * denom ** 2);
      const dLdA = -1 / denom;
      const dLdB0 = -1;
      const dLdB1 = -fi;
      J.push([dLdf0, dLdg, dLdA, dLdB0, dLdB1]);
    }

    // J^T J + λI
    const np = 5;
    const JtJ: number[][] = Array.from({ length: np }, () =>
      new Array(np).fill(0),
    );
    const JtR = new Array(np).fill(0);

    for (let i = 0; i < n; i++) {
      for (let a = 0; a < np; a++) {
        JtR[a] += J[i][a] * r[i];
        for (let b = 0; b < np; b++) {
          JtJ[a][b] += J[i][a] * J[i][b];
        }
      }
    }

    // Add damping
    for (let a = 0; a < np; a++) {
      JtJ[a][a] *= 1 + lambda;
    }

    // Solve 5x5 system via Gauss elimination
    const aug = JtJ.map((row, i) => [...row, JtR[i]]);
    for (let col = 0; col < np; col++) {
      let maxRow = col;
      for (let row = col + 1; row < np; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      if (Math.abs(aug[col][col]) < 1e-30) break;
      for (let row = col + 1; row < np; row++) {
        const factor = aug[row][col] / aug[col][col];
        for (let j = col; j <= np; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }
    const dp = new Array(np).fill(0);
    for (let row = np - 1; row >= 0; row--) {
      let s = aug[row][np];
      for (let col = row + 1; col < np; col++) {
        s -= aug[row][col] * dp[col];
      }
      dp[row] = Math.abs(aug[row][row]) > 1e-30 ? s / aug[row][row] : 0;
    }

    // Trial update
    const pTrial = p.map((v, i) => v + dp[i]);

    // Enforce gamma > 0
    if (pTrial[1] <= 0) pTrial[1] = gamma_init * 0.1;
    if (pTrial[2] < 0) pTrial[2] = 0;

    // Compute new cost
    let cost0 = 0;
    let cost1 = 0;
    for (let i = 0; i < n; i++) {
      cost0 += r[i] ** 2;
      const rNew = y[i] - lorentzianModel(f[i], pTrial[0], pTrial[1], pTrial[2], pTrial[3], pTrial[4]);
      cost1 += rNew ** 2;
    }

    if (cost1 < cost0) {
      for (let j = 0; j < np; j++) p[j] = pTrial[j];
      lambda *= 0.5;
    } else {
      lambda *= 2;
    }

    // Convergence check
    const dpNorm = Math.sqrt(dp.reduce((s, v) => s + v * v, 0));
    const pNorm = Math.sqrt(p.reduce((s, v) => s + v * v, 0));
    if (dpNorm < 1e-10 * (pNorm + 1e-30)) break;
  }

  const [f0, gamma, A, B0, B1] = p;
  const fwhm = 2 * Math.abs(gamma);

  // R²
  let ssTot = 0;
  let ssRes = 0;
  let yMean = 0;
  for (let i = 0; i < n; i++) yMean += y[i];
  yMean /= n;
  for (let i = 0; i < n; i++) {
    ssTot += (y[i] - yMean) ** 2;
    const pred = lorentzianModel(f[i], f0, gamma, A, B0, B1);
    ssRes += (y[i] - pred) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;

  return {
    f0_hz: f0,
    fwhm_hz: fwhm,
    q_factor: fwhm > 0 ? f0 / fwhm : 0,
    amplitude: A,
    background_offset: B0,
    background_slope: B1,
    fit_r2: r2,
    fit_window_hz: [f[0], f[n - 1]],
    method: "lorentzian_lm_client",
  };
}
