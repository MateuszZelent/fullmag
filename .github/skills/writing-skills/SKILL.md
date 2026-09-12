---
name: writing-skills
description: "Use when creating or revising skill instructions, triggers, references, or their validation."
---

# Maintain useful skills

Define the concrete requests the skill should handle and the observable mistakes it should prevent. Inspect existing instructions and callers before adding another workflow. Keep one source of shared guidance and read detailed references only when needed.

Write a concise `name` and `description` with a clear trigger. In the body, include the outcome, essential steps, non-obvious constraints, stopping conditions, and useful references. Prefer explicit decision criteria over universal rituals, persuasion tables, or claims that the model lacks basic competence. Preserve required artifact formats, safety boundaries, and scientific checks.

User intent and existing authorization take precedence over skill guidelines within the host's system/developer constraints. Do not impose approval, commits, publication, model switching, or other skills merely because the workflow traditionally includes them. Preserve supported metadata and invocation policy unless a requested change requires otherwise.

Validate frontmatter and referenced paths. Run changed helper scripts. For substantial behavioral changes, exercise representative positive and negative scenarios and compare baseline with the proposed version. Use independent forward-testing when complexity or risk warrants it and delegation is available and authorized; ordinary wording changes do not require repeated multi-agent trials.

Check results against the task, not exact wording. Report structural validation separately from behavioral evidence and actual token/cost measurements. Do not claim a better success rate from a shorter file alone. Fix observed failures without deleting unrelated work or expanding the skill with speculative rules.

For Codex-specific metadata or validation tooling, consult the available skill-creator guidance when needed. Keep deployment local unless commit, push, or publication was requested.
