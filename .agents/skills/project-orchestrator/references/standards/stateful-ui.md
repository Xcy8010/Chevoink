# UI — Stateful interfaces and editor lifetimes

Apply only to a project with an affected UI/editor. Use native framework semantics, not React-specific rules everywhere.

## UI-01 State ownership and restoration

Name each state's actual scope: global/user/project/object/task/view/session. One object ID need not distinguish two tasks. Restore incoming state before enabling outgoing persistence; a ready flag must not race the actual state commit. Test A -> B -> A, refresh/restart, unmount/dispose and rapid switches. Include framework development replay/double-invocation modes where applicable.

## UI-02 Late results and steering

Before applying an async result, validate originating owner/task/object/revision or generation token. Cancel or fence old work before replacement delivery. Queue edits must not overwrite drafts; new objects must not accept/reject another object's pending review. Removing one confirmation does not remove unrelated destructive-operation protection. A cancelled indicator alone does not stop backend execution.

## UI-03 Preserve identity and behavior

Maintain component/widget identity, focus, selections, scroll, save timing and refs/handles across refactors. Avoid declarations/keys/lifecycle changes that remount or dispose state unexpectedly. Test actual call order, failure and cache updates, not only render/import success. Preserve product wording and controls unless explicitly changed; do not add unrelated implementation announcements.

## UI-04 Truthful activity and bounded previews

Distinguish preparing arguments, authorized execution, cancellation, persisted effect and final result. Preserve a stable operation/call ID while a preparation indicator becomes execution. Show real activity and clear terminal activity; no stuck cursors/spinners in historical text. Reconnection needs only bounded latest previews, not a permanent copy of each body frame. Timers are cancellable and scoped; determine timing thresholds from the current product and its measured interaction requirements.

## UI-05 Input and accessible layout

For editors test semantic emptiness, composition/IME, paste and recovery; voice/attachments only where supported. Preserve accessible names, tooltips and keyboard focus for icon controls; respect reduced-motion settings. Check responsive width, collapsed combinations, drag/scroll and loading placeholders for actual supported targets. No auto-opening overlays on irrelevant data changes unless designed that way.

DOM/unit tests are not actual browser/device/performance acceptance. Report which targets and interactions were exercised and which remain unverified.
