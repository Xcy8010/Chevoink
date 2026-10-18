# Context lifecycle and fresh-task policy

This is an operational policy for heavy Codex use. It is not a claim that OpenAI guarantees quality degradation after any fixed number of compactions.

## Primary principle

Preserve **hot context for one deliverable**, but externalize durable facts before the thread becomes a warehouse of unrelated history.

A single deliverable may include design, implementation, tests, debugging, and validation when they directly serve the same acceptance target.

## Boundary state machine

### ACTIVE
A primary deliverable is unfinished.

### BOUNDARY_CANDIDATE
A new user prompt may create an independent deliverable. Signals include a different final artifact, a new subsystem with separate acceptance criteria, a substantially different permission/risk boundary, or language such as “另外/顺便/接下来/另一个/while you're at it/another task”. These are only cues; the model must decide semantically.

### CONTINUE_CURRENT
Continue without a window switch when the new request is a clarification, correction, result check, necessary implementation adjustment, or required subtask for the same deliverable.

### SWITCH_RECOMMENDED
Recommend a fresh task when the new work is independently deliverable and the current thread already contains meaningful work/history. First persist and verify the current state, then include the complete copyable handoff prompt in the same response. Follow the delivery checklist in `handoff-contract.md`; a reminder alone is incomplete.

### COMPLETED
The acceptance gate for the primary deliverable is met. A new independent deliverable should normally start in a fresh task if the old task is long or has compacted.

## Compaction traffic lights

- GREEN: no compaction observed in this session.
- YELLOW: first observed compaction. Continue the current atomic slice; at a stable checkpoint update handoff. Avoid beginning a new independent deliverable here.
- RED: second or later observed compaction. At the next safe checkpoint, persist and verify the checkpoint, then recommend a fresh task **with the reviewed handoff prompt attached inline**. Do not start another independent deliverable in this thread.

If the user explicitly chooses to stay in the current task after the recommendation, continue the current primary goal and do not repeat the same warning unless a new boundary/risk appears.

If an earlier recommendation omitted the prompt, supply the missing handoff when noticed or requested; this is completion of the handoff, not a reason to repeat the warning or move the user automatically. An in-flight operation still takes precedence: finish or reconcile its safe slice before declaring the handoff ready.

## Safe checkpoint

A safe checkpoint is the earliest point where:
- no file is intentionally left syntactically broken;
- the current atomic change is either complete or explicitly reverted/stopped;
- the smallest meaningful verification has been run or is explicitly recorded as not run;
- current state can be described from repository evidence.

Do not stop halfway through a migration/write operation merely to satisfy a context policy.

## Fresh-task recovery

New task startup:
1. read project instructions;
2. read `CURRENT.md`;
3. verify branch/HEAD/status and relevant source;
4. read only linked fragments from `PROJECT`, `PROJECT-PROFILE`, `DECISIONS`, `DEBUG`, `VALIDATION` and applicable standards;
5. continue the immediate next action;
6. do not read `archive/` unless current evidence points there.

This follows an **index-first, fragment-on-demand** approach.

## Hook behavior

The packaged hook is deliberately narrow:
- it activates only when `.codex/context/GUARDIAN.json` exists;
- it tracks compaction count per Codex session ID;
- it resets the local count on `SessionStart source=clear`;
- it provides short model-visible reminders on session start/compaction;
- it uses simple phrase cues on `UserPromptSubmit` only to ask the model to check task boundaries;
- it never decides that a prompt is definitely a new task;
- it does not read or summarize the transcript;
- it does not edit source files.

Codex's documented `transcript_path` is intentionally not used as a stable parser interface.

Before resumed writes, check the original authorization source, task/object/revision, operation identity and pending unknown outcomes. A compaction counter is advisory telemetry, not proof of a safe or complete handoff. Unavailable telemetry is unknown. Persist confirmed decisions as they arise; the hook does not perform semantic extraction.
