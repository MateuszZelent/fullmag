#[cfg(test)]
include!("../test_roots/resource_pool.rs");

#[cfg(not(test))]
fn main() {
    fullmag_api::run_resource_pool();
}
