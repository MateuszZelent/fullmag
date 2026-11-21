#[cfg(test)]
include!("../test_roots/runtime_service.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_runtime_service();
}
