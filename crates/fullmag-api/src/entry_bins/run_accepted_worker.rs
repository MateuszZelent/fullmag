#[cfg(test)]
include!("../test_roots/accepted_worker.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_accepted_worker();
}
