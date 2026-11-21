#![cfg_attr(test, recursion_limit = "256")]

#[cfg(test)]
include!("../test_roots/fullmag_api.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_api();
}
