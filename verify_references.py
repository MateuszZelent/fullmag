import os
import re

audit_file = "/home/kkingstoun/git/fullmag/fullmag/docs/audits/2026-11-18-eigensolve-performance-and-gpu-readiness-audit.md"
base_dir = "/home/kkingstoun/git/fullmag"

# Extract file:line pairs
references = set()
with open(audit_file, "r") as f:
    for line in f:
        # Looking for filename.ext:line pattern
        matches = re.findall(r"([a-zA-Z0-9_/.-]*\.[a-z]+):([0-9]+)", line)
        for match in matches:
            references.add(match)

# Verify
results = []
for filename, line in references:
    # Try to find the file
    cmd = f"find {base_dir} -name '{os.path.basename(filename)}' | grep '{filename}'"
    # This is a bit simplistic, but let's see.
    # For now, let's just assume we can find the file if we search for the base path.
    # Actually, a better approach is to use the full path if we can find it.
    
    # Just checking if the file exists and has that many lines
    # This might be too slow for all files.
    # Let's just try to check if the file is reachable.
    
    # I'll manually check the most important ones, and this script just reports the rest.
    pass
