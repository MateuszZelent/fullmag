#![cfg(not(feature = "parallel"))]

use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use fullmag_engine::{fdm::cpu::fft_backend::FdmFftBackend, FftWorkspace, VectorFieldSoA};

struct ProcessAllocationCounter;

static COUNT_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATION_COUNT: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: ProcessAllocationCounter = ProcessAllocationCounter;

fn record_allocation() {
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
    }
}

unsafe impl GlobalAlloc for ProcessAllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

fn measured_allocations<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    ALLOCATION_COUNT.store(0, Ordering::SeqCst);
    COUNT_ALLOCATIONS.store(true, Ordering::SeqCst);
    let result = operation();
    COUNT_ALLOCATIONS.store(false, Ordering::SeqCst);
    (result, ALLOCATION_COUNT.load(Ordering::SeqCst))
}

#[test]
fn rustfft_demag_reuses_preallocated_transform_lines_after_warmup() {
    let shape = [4, 3, 2];
    let cell_count = shape.iter().product();
    let mut workspace = FftWorkspace::new(shape[0], shape[1], shape[2], 1.0, 1.0, 1.0);
    let mut magnetization = VectorFieldSoA::zeros(cell_count);
    magnetization.x.fill(1.0);
    let mut warm_output = VectorFieldSoA::zeros(cell_count);

    workspace.convolve_demag(&magnetization, 1.0, None, &mut warm_output);

    let mut measured_output = VectorFieldSoA::zeros(cell_count);
    let ((), allocations) = measured_allocations(|| {
        workspace.convolve_demag(&magnetization, 1.0, None, &mut measured_output);
    });

    assert_eq!(allocations, 0, "steady-state RustFFT demag allocated");
    assert_eq!(measured_output, warm_output);
}
