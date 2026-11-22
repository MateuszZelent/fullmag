//! Shared process and API implementation for the Fullmag API executables.

include!("main.rs");

#[cfg(not(test))]
#[path = "accepted_fem_preparer.rs"]
mod accepted_fem_preparer;
#[cfg(not(test))]
#[path = "accepted_fem_preparation_supervisor.rs"]
mod accepted_fem_preparation_supervisor;
#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;
#[path = "accepted_worker_execution_receipt.rs"]
mod accepted_worker_execution_receipt;
#[path = "accepted_profile_admission.rs"]
mod accepted_profile_admission;
#[path = "owned_worker_process.rs"]
mod owned_worker_process;
mod scheduler_idle_backoff;
mod scheduler_owner_control;
mod worker_startup_gate;

#[path = "accepted_worker_main.rs"]
mod accepted_worker_main;
#[cfg(not(test))]
#[path = "accepted_fem_preparer_main.rs"]
mod accepted_fem_preparer_main;
#[cfg(not(test))]
#[path = "accepted_fem_preparation_supervisor_main.rs"]
mod accepted_fem_preparation_supervisor_main;
#[cfg(not(test))]
#[path = "accepted_fem_preparation_scheduler_main.rs"]
mod accepted_fem_preparation_scheduler_main;
#[path = "accepted_supervisor_main.rs"]
mod accepted_supervisor_main;
#[path = "accepted_scheduler_main.rs"]
mod accepted_scheduler_main;
#[cfg(not(test))]
#[path = "runtime_service_main.rs"]
mod runtime_service_main;
#[path = "resource_pool_main.rs"]
mod resource_pool_main;
#[cfg(not(test))]
#[path = "preparation_resource_pool_main.rs"]
mod preparation_resource_pool_main;
#[cfg(not(test))]
#[path = "preparation_retry_main.rs"]
mod preparation_retry_main;

/// Run the API server executable.
pub fn run_api() {
    if std::env::args().nth(1).as_deref() == Some(live_prepared_fdm_fields::WORKER_ARGUMENT) {
        if let Err(error) = live_prepared_fdm_fields::run_worker() {
            eprintln!("Prepared field worker failed: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    // `#[tokio::main]` turns this async entrypoint into a synchronous function.
    run_api_server()
}

/// Print the OpenAPI document using the dedicated code-generation executable.
pub fn print_openapi_v2() {
    fullmag_build_info::print_startup_stamp();
    println!(
        "{}",
        serde_json::to_string_pretty(&openapi_v2::openapi_json())
            .expect("OpenAPI v2 document should serialize to JSON")
    );
}

/// Run the accepted worker command-line process.
pub fn run_accepted_worker() {
    accepted_worker_main::main();
}

/// Run the accepted FEM preparer command-line process.
#[cfg(not(test))]
pub fn run_accepted_fem_preparer() {
    accepted_fem_preparer_main::main();
}

/// Run the accepted FEM preparation supervisor command-line process.
#[cfg(not(test))]
pub fn run_accepted_fem_preparation_supervisor() {
    accepted_fem_preparation_supervisor_main::main();
}

/// Run the accepted FEM preparation scheduler command-line process.
#[cfg(not(test))]
pub fn run_accepted_fem_preparation_scheduler() {
    accepted_fem_preparation_scheduler_main::main();
}

/// Run the accepted worker supervisor command-line process.
pub fn run_accepted_supervisor() {
    accepted_supervisor_main::main();
}

/// Run the accepted task scheduler command-line process.
pub fn run_accepted_scheduler() {
    accepted_scheduler_main::main();
}

/// Run the native runtime service command-line process.
#[cfg(not(test))]
pub fn run_runtime_service() {
    runtime_service_main::main();
}

/// Run the compute resource pool command-line process.
pub fn run_resource_pool() {
    resource_pool_main::main();
}

/// Run the preparation resource pool command-line process.
#[cfg(not(test))]
pub fn run_preparation_resource_pool() {
    preparation_resource_pool_main::main();
}

/// Run the preparation retry command-line process.
#[cfg(not(test))]
pub fn run_preparation_retry() {
    preparation_retry_main::main();
}
