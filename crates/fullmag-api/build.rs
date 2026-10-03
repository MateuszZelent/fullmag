#[path = "../../scripts/rust/windows_version_resource.rs"]
mod windows_version_resource;

fn main() {
    windows_version_resource::compile_version_resource("Fullmag API");
}
