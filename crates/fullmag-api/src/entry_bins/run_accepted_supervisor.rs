#[cfg(test)]
include!("../test_roots/accepted_supervisor.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_accepted_supervisor();
}
