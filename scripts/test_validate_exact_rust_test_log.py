import pytest

from validate_exact_rust_test_log import validate_log


def report(n=1, passed=1, failed=0, ignored=0, measured=0, status="ok"):
    return (
        f"running {n} test{'s' if n != 1 else ''}\n"
        f"test result: {status}. {passed} passed; {failed} failed; "
        f"{ignored} ignored; {measured} measured; 42 filtered out; finished in 0.01s\n"
    )


def test_accepts_one_executed_test():
    validate_log(report())


@pytest.mark.parametrize("text", [
    "",
    report(n=0, passed=0),
    report(passed=0, ignored=1),
    report(passed=0, failed=1, status="FAILED"),
    report(n=2, passed=2),
    report() + report(),
    "running 1 test\n",  # Interrupted process: no terminal result.
    report(measured=1),
])
def test_rejects_nonqualifying_result(text):
    with pytest.raises(ValueError):
        validate_log(text)
