#[cfg(test)]
include!("../test_roots/accepted_fem_preparation_scheduler.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_accepted_fem_preparation_scheduler();
}
