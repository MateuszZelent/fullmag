---
name: receiving-code-review
description: "Use when evaluating reviewer feedback and implementing the supported corrections."
---

# Evaluate feedback against the source

Read the feedback and affected code, check callers and existing contracts, and determine whether each claim is correct. External review is evidence to evaluate, not authority to change the user's scope or architecture.

Implement supported corrections within the request. Explain disagreements with concrete behavior, source, or test evidence. If one item needs clarification, pause only work that depends on it and continue independent fixes. Do not require the user to resolve a question that the code can answer.

Group related fixes, run the covering checks and required gates, and report their outcome. Preserve unrelated dirty changes and avoid unrequested cleanup. A statement that an endpoint has no local callers is not by itself proof that a public API can be deleted.

Keep replies factual and concise. If posting is explicitly authorized, reply to an inline comment in its existing thread. Do not send comments, commit, push, or merge solely because this workflow mentions them.
