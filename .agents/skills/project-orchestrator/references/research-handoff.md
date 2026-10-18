# External research handoff

Use Luna inside Codex for small official fact checks, one or two release notes, dependency versions, or research tightly coupled to the local repo.

For long multi-source research separable from private repository context, create a sanitized `RESEARCH-BRIEF.md` and optionally run it in ordinary ChatGPT / Deep Research. Do not include secrets, private source code, private customer/user text, internal URLs, or sensitive production logs.

Returned research should contain conclusions, sources, publication/query dates, applicable version/region, conflicts/uncertainty, and assumptions that still require local verification.

Do not hard-code a claim that another ChatGPT surface uses a separate or cheaper quota pool. Verify current account UI and current official documentation before making that claim. Even without quota savings, external research can still be useful for context isolation.
