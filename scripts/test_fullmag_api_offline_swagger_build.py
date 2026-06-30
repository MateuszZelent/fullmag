from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_swagger_ui_dependency_is_optional_feature() -> None:
    cargo_toml = read("crates/fullmag-api/Cargo.toml")

    assert 'swagger-ui = ["dep:utoipa-swagger-ui"]' in cargo_toml
    assert (
        'utoipa-swagger-ui = { version = "8", features = ["axum"], optional = true }'
        in cargo_toml
    )


def test_openapi_json_is_served_without_swagger_ui_dependency() -> None:
    router_v2 = read("crates/fullmag-api/src/router_v2/mod.rs")
    main_rs = read("crates/fullmag-api/src/main.rs")

    assert '"/v2/platform/openapi.json"' in router_v2
    assert "openapi_v2::openapi_json()" in router_v2
    assert '#[cfg(feature = "swagger-ui")]' in main_rs
    assert '#[cfg(not(feature = "swagger-ui"))]' in main_rs
    assert '"/v2/platform/docs/swagger"' in main_rs


def test_install_cli_builds_api_without_default_features() -> None:
    makefile = read("Makefile")

    api_build_lines = [
        line.strip()
        for line in makefile.splitlines()
        if "cargo +nightly build -p fullmag-api" in line
    ]
    assert api_build_lines, "expected install-cli to build fullmag-api"
    assert all("--no-default-features" in line for line in api_build_lines)
