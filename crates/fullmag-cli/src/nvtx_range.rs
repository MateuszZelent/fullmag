#![allow(unexpected_cfgs)]

#[cfg(fullmag_enable_nvtx)]
pub(crate) struct Range(u64);

#[cfg(not(fullmag_enable_nvtx))]
pub(crate) struct Range;

impl Range {
    #[cfg(fullmag_enable_nvtx)]
    pub(crate) fn new(name: &'static [u8]) -> Self {
        unsafe extern "C" {
            fn fullmag_fem_nvtx_range_start(name: *const std::ffi::c_char) -> u64;
        }
        debug_assert_eq!(name.last(), Some(&0));
        Self(unsafe { fullmag_fem_nvtx_range_start(name.as_ptr().cast()) })
    }

    #[cfg(not(fullmag_enable_nvtx))]
    pub(crate) const fn new(_: &'static [u8]) -> Self {
        Self
    }
}

#[cfg(fullmag_enable_nvtx)]
impl Drop for Range {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn fullmag_fem_nvtx_range_end(id: u64);
        }
        unsafe { fullmag_fem_nvtx_range_end(self.0) };
    }
}
