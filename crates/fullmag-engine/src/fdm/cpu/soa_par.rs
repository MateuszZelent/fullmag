//! Per-cell maps over SoA vector fields for the FDM CPU hot loops.
//!
//! Every helper evaluates an independent closure per cell and writes only that
//! cell's components, so the parallel and serial builds produce bitwise
//! identical fields.  Reductions are deliberately not provided here: their
//! summation order would depend on the work split.

use crate::{Result, Vector3, VectorFieldSoA};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// Cells per parallel task.  Large enough to amortise scheduling for the
/// cheap per-cell stage updates, small enough to balance 2D films.
#[cfg(feature = "parallel")]
const SOA_PAR_CHUNK: usize = 4096;

/// Call `f(i, x, y, z)` with mutable references to the components of cell
/// `i` of `out`, for every `i < n`.
pub(crate) fn soa_for_each_mut<F>(out: &mut VectorFieldSoA, n: usize, f: F)
where
    F: Fn(usize, &mut f64, &mut f64, &mut f64) + Sync + Send,
{
    let VectorFieldSoA { x, y, z } = out;
    let (x, y, z) = (&mut x[..n], &mut y[..n], &mut z[..n]);
    #[cfg(feature = "parallel")]
    {
        x.par_chunks_mut(SOA_PAR_CHUNK)
            .zip(y.par_chunks_mut(SOA_PAR_CHUNK))
            .zip(z.par_chunks_mut(SOA_PAR_CHUNK))
            .enumerate()
            .for_each(|(chunk, ((xs, ys), zs))| {
                let base = chunk * SOA_PAR_CHUNK;
                for j in 0..xs.len() {
                    f(base + j, &mut xs[j], &mut ys[j], &mut zs[j]);
                }
            });
    }
    #[cfg(not(feature = "parallel"))]
    {
        for i in 0..n {
            f(i, &mut x[i], &mut y[i], &mut z[i]);
        }
    }
}

/// Call `f(row, x, y, z)` with the mutable component slices of every
/// contiguous row of `row_len` cells in `out`; `row` counts rows from zero.
/// Stencils use it to derive the row's (y, z) once instead of dividing the
/// flat index of every cell.
pub(crate) fn soa_for_each_row_mut<F>(out: &mut VectorFieldSoA, row_len: usize, f: F)
where
    F: Fn(usize, &mut [f64], &mut [f64], &mut [f64]) + Sync + Send,
{
    debug_assert!(row_len > 0 && out.len() % row_len == 0);
    let VectorFieldSoA { x, y, z } = out;
    #[cfg(feature = "parallel")]
    {
        x.par_chunks_mut(row_len)
            .zip(y.par_chunks_mut(row_len))
            .zip(z.par_chunks_mut(row_len))
            .enumerate()
            .with_min_len((SOA_PAR_CHUNK / row_len).max(1))
            .for_each(|(row, ((xs, ys), zs))| f(row, xs, ys, zs));
    }
    #[cfg(not(feature = "parallel"))]
    {
        x.chunks_mut(row_len)
            .zip(y.chunks_mut(row_len))
            .zip(z.chunks_mut(row_len))
            .enumerate()
            .for_each(|(row, ((xs, ys), zs))| f(row, xs, ys, zs));
    }
}

/// Store `f(i)` into cell `i` of `out` for every `i < n`.
pub(crate) fn soa_fill<F>(out: &mut VectorFieldSoA, n: usize, f: F)
where
    F: Fn(usize) -> Vector3 + Sync + Send,
{
    soa_for_each_mut(out, n, |i, x, y, z| {
        let value = f(i);
        *x = value[0];
        *y = value[1];
        *z = value[2];
    });
}

/// Store `f(i)` into cell `i` of `out` for every `i < n`, stopping at the
/// first error.  On error the contents of `out` are unspecified; callers
/// discard the stage, exactly as with the serial `?` loop.  With several
/// failing cells the serial build reports the lowest index and the parallel
/// build may report another one; projection errors carry no cell index.
pub(crate) fn soa_try_fill<F>(out: &mut VectorFieldSoA, n: usize, f: F) -> Result<()>
where
    F: Fn(usize) -> Result<Vector3> + Sync + Send,
{
    let VectorFieldSoA { x, y, z } = out;
    let (x, y, z) = (&mut x[..n], &mut y[..n], &mut z[..n]);
    #[cfg(feature = "parallel")]
    {
        x.par_chunks_mut(SOA_PAR_CHUNK)
            .zip(y.par_chunks_mut(SOA_PAR_CHUNK))
            .zip(z.par_chunks_mut(SOA_PAR_CHUNK))
            .enumerate()
            .try_for_each(|(chunk, ((xs, ys), zs))| {
                let base = chunk * SOA_PAR_CHUNK;
                for j in 0..xs.len() {
                    let value = f(base + j)?;
                    xs[j] = value[0];
                    ys[j] = value[1];
                    zs[j] = value[2];
                }
                Ok(())
            })
    }
    #[cfg(not(feature = "parallel"))]
    {
        for i in 0..n {
            let value = f(i)?;
            x[i] = value[0];
            y[i] = value[1];
            z[i] = value[2];
        }
        Ok(())
    }
}
