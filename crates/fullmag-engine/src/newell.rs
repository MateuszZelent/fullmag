//! Re-export of Newell tensor computation from `fullmag-fdm-demag`.
//!
//! The canonical implementation now lives in `fullmag_fdm_demag::newell`.
//! This module re-exports everything so existing engine code continues to work.

pub use fullmag_fdm_demag::newell::*;
