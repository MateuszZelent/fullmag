#[cfg(test)]
include!("../test_roots/fullmag_api.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_api();
}
