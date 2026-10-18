# SYS — Systems, native resources, libraries and artifacts

Conditional: native/resource ownership, SDK/package/CLI compatibility, platform targets or measured performance. Not mandatory tools for every project.

## SYS-01 Ownership and lifetime

Identify who allocates, releases and cancels resources: memory, handles, file/socket descriptors, locks, tasks and threads. Preserve the runtime's ownership/lifetime and thread-affinity rules. Check error/early-return/cancellation paths, bounded queues and cleanup. Adopt actual project checks such as sanitizers or analyzers only where available and appropriate; never pretend a language-specific checker ran on another stack.

## SYS-02 Consumer and target compatibility

Treat public APIs, ABI/binary layouts, serialization, CLI arguments/exit codes and plugin protocols as versioned contracts where relevant. Establish supported platform/compiler/runtime/feature combinations. Do not silently change packaging, exported symbols, default flags or minimum supported versions. Confirm consumer compatibility using representative declared targets; an inventory is not a completed platform matrix.

## SYS-03 Artifact integrity

Bind checks to actual source, dependencies, configuration, generated code and produced artifact identity. Use the project's adopted packaging/reproducibility/signing process; do not invent signing keys or publish without authority. Build success is not install/upgrade/uninstall or consumer acceptance. Offline dependencies and platform-specific environments may limit validation and must be named.

## SYS-04 Measured performance and resource limits

State workload, baseline, environment, warm/cold/cache assumptions and relevant metrics before a performance claim. Preserve correctness; a quicker partial result is not an optimization. Measure representative latency/throughput/resource behavior and relevant tails when needed; do not hard-code a universal target. Use bounded benchmarks in authorized environments, never unsolicited production load. Record uncertainty and untested targets.
