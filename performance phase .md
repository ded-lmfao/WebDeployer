# Phase 2 — Runtime Performance Verification and Optimization

Perform a second performance engineering pass across the Rust backend and modular vanilla JavaScript frontend.

## Objectives

1. Establish reproducible runtime performance baselines.
2. Identify remaining CPU, memory, allocation, database and rendering bottlenecks.
3. Optimize only measurable bottlenecks.
4. Preserve all existing API schemas, security boundaries, authentication behavior and UI functionality.

## Rust backend

- Benchmark `/api/overview` at different project/database counts.
- Measure P50, P95 and P99 request latency.
- Measure requests per second under concurrent load.
- Profile CPU usage and peak RSS.
- Inspect SQLite query plans using EXPLAIN QUERY PLAN.
- Identify unnecessary allocations, cloning, locking and serialization.
- Verify prepared statement reuse and connection lock duration.
- Investigate asynchronous blocking operations.
- Evaluate index read benefits against write overhead.

## Static assets

- Benchmark embedded and disk-based `/style.css`.
- Measure 200 and 304 response latency.
- Verify ETag correctness and cache behavior.
- Measure compressed asset sizes.
- Avoid unnecessary runtime filesystem operations.

## Frontend

- Profile initial page loading and module evaluation.
- Measure JavaScript execution, DOM mutations and rendering.
- Identify unnecessary event listeners, timers and polling.
- Verify DOM cache invalidation.
- Eliminate redundant calculations and repeated allocations.
- Measure chart rendering performance with realistic datasets.
- Check layout shifts and long tasks.

## Memory and resource efficiency

Measure:
- Idle RSS.
- Peak RSS.
- CPU usage under idle and concurrent workloads.
- Memory growth during sustained operation.
- Allocation hotspots.
- Resource cleanup after repeated navigation and polling.

## Safety requirements

- Do not remove security checks.
- Do not change public API contracts.
- Do not introduce unnecessary dependencies.
- Do not introduce caching without invalidation guarantees.
- Do not sacrifice readability for insignificant micro-optimizations.
- Do not modify working behavior without regression tests.

## Deliverables

Provide:
1. Before/after benchmark tables.
2. Profiling evidence for every significant optimization.
3. List of modified files.
4. Regression test results.
5. Memory and CPU comparisons.
6. Remaining bottlenecks.
7. Explicitly identify anything that could not be benchmarked.

Do not claim performance improvements without measured evidence.