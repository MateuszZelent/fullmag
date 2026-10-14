"""Include compiler-input regressions in the managed development check suite."""
from test_windows_compiler_inputs import CompilerInputsChecks


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(CompilerInputsChecks)
