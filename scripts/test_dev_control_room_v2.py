"""Contract regressions for the managed Control Room v2 shell launcher."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "dev-control-room-v2.sh"


def _source() -> str:
    return LAUNCHER.read_text(encoding="utf-8")


def test_launcher_requires_a_managed_api_binary_instead_of_host_compilation() -> None:
    source = _source()

    assert "FULLMAG_API_BINARY" in source
    assert '"${REPO_ROOT}/.fullmag/local/bin/fullmag-api"' in source
    assert "resolve_api_binary" in source
    assert "cargo +nightly run -p fullmag-api" not in source
    assert "managed Fullmag runner" in source


def test_readiness_requires_owned_process_and_matching_instance_before_url_publish() -> None:
    source = _source()

    api_ready = source.index("api_is_ready()")
    api_curl = source.index('"${API_URL}/healthz"', api_ready)
    assert source.index("owned_process_is_alive", api_ready) < api_curl
    identity_check = source.index("endpoint_instance_is_ready()")
    assert '"${INSTANCE_ID}"' in source[identity_check : source.index("owned_process_is_alive", identity_check)]

    frontend_ready = source.index("frontend_is_ready()")
    assert source.index("owned_process_is_alive", frontend_ready) < source.index(
        '"${WEB_URL_BASE}/"', frontend_ready
    )
    readiness_gate = source.index('if [[ "$frontend_ready" != "1" ]]')
    url_publish = source.index('printf \'%s\\n\' "${WEB_URL_BASE}"', readiness_gate)
    assert source.index('frontend_ready=1') < url_publish


def test_launcher_uses_owned_process_groups_and_dev_server_wrapper() -> None:
    source = _source()

    assert "setsid --wait" in source
    assert 'kill -TERM -- "-$pid"' in source
    assert 'kill -KILL -- "-$pid"' in source
    assert "apps/control-room/dev-server.mjs" in source
    assert "pgrep" not in source
    assert "pkill" not in source
    assert "stop_next_on_port" not in source
