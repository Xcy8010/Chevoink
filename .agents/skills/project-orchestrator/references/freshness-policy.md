# Current-information and anti-misinformation policy

This policy overrides historical package notes whenever time-sensitive facts matter.

## Re-verify

Re-check current official sources for:
- model names and IDs;
- reasoning effort support;
- Codex / ChatGPT model availability;
- quotas, reset mechanisms, plan rules, usage pools;
- API price, context/output limits, supported tools;
- Codex config keys, hook events, skill/plugin/subagent behavior;
- current dependency versions and breaking changes.

## Source priority

1. the relevant vendor's current official documentation and version-specific release notes; for Codex/OpenAI behavior, official OpenAI product/developer/ChatGPT Learn/Help sources;
2. the relevant official repository/schema and the target project's actual pinned configuration, distinguished from newer upstream capabilities;
3. secondary sources only as discovery clues; do not use them as proof of technical parameters or substitute them for the applicable primary source.

Current upstream availability does not require upgrading a project's pinned toolchain. Verify behavior for the installed/selected version. A documented model ID also does not prove availability to this account or host.

Do not use old cached knowledge to override a newer specific official release page.

## Conflict handling

- If a newer specific official release page conflicts with an older catalog, record the conflict and prefer the newer/more specific source for that fact.
- If current official sources still conflict, mark the field `unknown / needs verification` rather than guessing.
- If network/current documentation is unavailable, say it cannot currently be verified and continue only with parts that do not depend on it.

For time-sensitive facts, record verification date, source, conclusion, and remaining uncertainty.
