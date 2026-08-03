from validate_fem_solver_trace import validate_trace


def trace_fixture() -> dict:
    return {
        "format": "fullmag.solver_trace.v1",
        "trace_id": {
            "value": "run-1:0:7:1",
            "run_generation": "run-1",
            "stage_sequence": 0,
            "accepted_step": 7,
            "sample_sequence": 1,
        },
        "segments": {},
        "api_revision": None,
        "completeness": "server_only",
        "unaccounted_server_ns": 0,
        "unaccounted_browser_ns": 0,
    }


def test_accepts_server_only_trace() -> None:
    assert validate_trace(trace_fixture()) == []


def test_rejects_api_revision_without_visibility_segment() -> None:
    trace = trace_fixture()
    trace["api_revision"] = 4

    assert validate_trace(trace) == [
        "api_revision requires api_revision_visibility_ns segment"
    ]


def test_rejects_negative_duration_and_invalid_clock_domain() -> None:
    trace = trace_fixture()
    trace["completeness"] = "partial"
    trace["segments"] = {
        "publisher_queue_ns": {
            "kind": "publisher_queue",
            "duration_ns": -1,
            "clock_domain": "browser_performance",
        }
    }

    assert validate_trace(trace) == [
        "segment publisher_queue_ns has negative duration_ns",
        "segment publisher_queue_ns has clock_domain browser_performance; expected server_monotonic",
    ]


def test_rejects_duplicate_segment_entries_before_normalization() -> None:
    trace = trace_fixture()
    trace["completeness"] = "partial"
    trace["segments"] = [
        {
            "id": "publisher_queue_ns",
            "kind": "publisher_queue",
            "duration_ns": 2,
            "clock_domain": "server_monotonic",
        },
        {
            "id": "publisher_queue_ns",
            "kind": "publisher_queue",
            "duration_ns": 3,
            "clock_domain": "server_monotonic",
        },
    ]

    assert validate_trace(trace) == ["duplicate segment id: publisher_queue_ns"]


def test_rejects_mismatched_browser_render_revision() -> None:
    trace = trace_fixture()
    trace["browser_fetch_api_revision"] = 8
    trace["browser_render_api_revision"] = 7

    assert validate_trace(trace) == [
        "browser render revision is older than fetched revision"
    ]
