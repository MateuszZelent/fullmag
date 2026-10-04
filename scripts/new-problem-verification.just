verify-new-problem-browser:
    python -B "{{justfile_directory()}}/verify_new_problem_browser.py" --repo-root "{{justfile_directory()}}/.."

generate-new-problem-client:
    python -B "{{justfile_directory()}}/verify_new_problem_browser.py" --repo-root "{{justfile_directory()}}/.." --generate-client
