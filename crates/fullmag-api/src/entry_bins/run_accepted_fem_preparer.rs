#[cfg(test)]
include!("../test_roots/accepted_fem_preparer.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_accepted_fem_preparer();
}
