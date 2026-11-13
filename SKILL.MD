---
name: rust-frontend-performance-refactor
description: Audit, optimize, and safely refactor Rust backend services and vanilla HTML, CSS, and JavaScript frontends for low resource usage, low latency, fast rendering, and removal of genuinely dead code.
---

# Rust Backend + Vanilla Frontend Performance Refactoring

## Mission

Improve the application's real performance and resource efficiency across:

- **Backend:** Rust.
- **Frontend:** plain HTML, CSS, and JavaScript (no React, no Tauri assumptions).
- **Integration:** HTTP/API boundaries, serialization, caching, and browser-to-backend communication.

Prioritize measurable improvements in latency, throughput, CPU, memory, allocations, bundle/network weight, rendering work, and responsiveness. Preserve existing behavior, APIs, accessibility, security, and maintainability.

Do not rewrite code merely to make it look different. Do not trade correctness or reliability for a benchmark win.

## Operating principles

1. **Measure before changing.** Establish a reproducible baseline and identify the actual bottleneck.
2. **Optimize the critical path first.** Focus on code that runs frequently, blocks requests, delays first render, or consumes significant resources.
3. **Prefer simple, local changes.** Avoid broad rewrites when a targeted change is sufficient.
4. **Preserve contracts.** Maintain API schemas, status codes, error semantics, validation, persistence behavior, and user-visible behavior unless a change is explicitly approved.
5. **Prove improvements.** Re-run relevant tests and benchmarks after each meaningful change.
6. **Be conservative with deletion.** Remove code only when evidence shows it is unused and not part of a public, dynamic, generated, plugin, reflection, routing, or externally consumed contract.
7. **Keep a rollback path.** Make changes in small, reviewable steps and report files and behavior affected.

## Required workflow

### Phase 1 — Discover the project

Before editing:

- Inspect the repository structure, manifests, build scripts, lockfiles, CI configuration, tests, and documentation.
- Identify Rust version, edition, framework/runtime, async model, database layer, serialization format, and deployment target.
- Identify frontend entry points, browser support targets, build tooling (if any), asset pipeline, and API usage.
- Trace important user journeys and backend request paths.
- Read existing project conventions before introducing dependencies or patterns.
- Do not assume a framework, database, bundler, or deployment environment that is not present.

Produce a concise inventory of:
- Main backend modules and hot paths.
- Frontend entry points and large or frequently executed scripts.
- External dependencies and their purpose.
- Existing tests, benchmarks, profiling tools, and build commands.
- Potential performance risks and unknowns.

Do not make speculative edits during discovery.

### Phase 2 — Establish a baseline

Use the project's existing tooling first. Record the exact command, environment, workload, and results so measurements can be repeated.

**Rust measurements (as applicable):**
- Build time and binary size.
- Request latency: p50, p95, p99.
- Throughput under a representative workload.
- CPU and peak/resident memory.
- Allocation count/volume where practical.
- Database query count, duration, and connection-pool behavior.
- Async task count, queue depth, blocking time, and timeout rates.

Useful tools, when compatible with the project:
- `cargo test`, `cargo check`, `cargo clippy`
- `cargo bench` and Criterion
- `cargo build --release`
- `cargo tree` and `cargo bloat`
- `cargo flamegraph` / `perf`
- `heaptrack`, DHAT, or an allocator profiler
- `tokio-console` for Tokio applications

Do not add all tools or dependencies by default. Select only what answers a concrete question.

**Browser measurements (as applicable):**
- Initial load and repeat-load performance.
- JavaScript and CSS transfer size and request count.
- Parse, compile, and execution time.
- Long tasks and main-thread blocking.
- Largest Contentful Paint (LCP), Interaction to Next Paint (INP), and Cumulative Layout Shift (CLS).
- DOM node count, layout/reflow frequency, style recalculation, and memory growth.
- Network waterfalls and API request timing.

Use browser DevTools Performance, Network, Memory, and Lighthouse where available. Test representative devices and throttled network/CPU profiles when relevant.

If reliable baseline measurements cannot be collected, state the limitation. Do not invent numbers or claim an improvement without evidence.

### Phase 3 — Identify and rank opportunities

For every proposed optimization, document:

- Location and execution path.
- Observed problem and evidence.
- Expected benefit.
- Risk and behavior that could change.
- Validation method.

Prioritize by expected real-world impact, confidence, and implementation risk. Address high-impact bottlenecks before cosmetic cleanup.

## Rust backend optimization

### CPU and allocations

- Profile before replacing algorithms or data structures.
- Prefer appropriate algorithmic complexity and avoid repeated work in hot paths.
- Avoid unnecessary `clone()`, `to_owned()`, `to_string()`, intermediate `Vec`/`String` creation, and repeated serialization.
- Borrow data where ownership permits; use `Cow` or references only when they simplify the design and remain correct.
- Preallocate collections when a reliable size estimate is available.
- Avoid repeated parsing, regex compilation, configuration loading, and expensive initialization inside request handlers.
- Use efficient iterators when they improve clarity; do not assume iterator syntax is automatically faster.
- Avoid unnecessary conversions between data representations.
- Do not introduce unsafe Rust for speculative performance gains.

### Async, concurrency, and I/O

- Never block an async executor thread with blocking I/O or long CPU-bound work.
- Use `spawn_blocking` or a dedicated worker strategy only where appropriate and bounded.
- Avoid unbounded task spawning, channels, queues, and buffers.
- Apply backpressure, timeouts, cancellation, and concurrency limits where needed.
- Do not hold mutexes or write guards across `.await` points.
- Reduce lock contention; prefer message passing or narrower lock scopes when justified by profiling.
- Avoid excessive task creation for tiny operations.
- Reuse clients and connection pools instead of creating them per request.
- Set sensible pool sizes, timeouts, and retry policies based on workload and infrastructure.
- Make retries bounded and safe; do not retry non-idempotent operations blindly.

### Database and external services

- Inspect query plans and indexes before changing query structure.
- Eliminate N+1 queries and unnecessary round trips.
- Fetch only required columns and rows; paginate large result sets.
- Batch operations when this reduces round trips without creating oversized transactions or payloads.
- Use transactions with correct boundaries and isolation requirements.
- Cache only data with a clear invalidation, freshness, and consistency strategy.
- Avoid synchronous external calls on critical paths when an asynchronous or deferred design is safe.
- Set explicit deadlines and handle partial failures.

### Serialization and API efficiency

- Avoid serializing fields the client does not need.
- Avoid repeated serialization/deserialization of the same payload.
- Keep response payloads appropriately sized and stable.
- Preserve API compatibility, validation, and error semantics.
- Consider compression only after measuring payload size, CPU cost, and end-to-end latency.
- Use streaming for genuinely large responses when it improves memory use and time-to-first-byte.
- Avoid chatty frontend/backend request patterns; consolidate requests only when it does not create oversized or slow responses.

### Rust correctness and maintainability

- Preserve error context; do not replace meaningful errors with silent defaults.
- Avoid `.unwrap()` and `.expect()` in fallible production paths unless invariants are explicit and justified.
- Do not suppress compiler, Clippy, or test warnings merely to make output clean.
- Keep public interfaces stable unless a migration is explicitly requested.
- Prefer clear types and explicit invariants over clever abstractions.
- Add or update unit, integration, property, and regression tests for changed behavior.

## Vanilla HTML, CSS, and JavaScript optimization

### JavaScript execution

- Identify scripts that block parsing or rendering. Use `defer`, modules, or carefully justified `async` loading.
- Load non-critical code only when needed; avoid delaying critical interactions.
- Remove repeated DOM queries in hot paths when caching the reference is safe.
- Batch DOM reads and writes to reduce layout thrashing.
- Avoid unnecessary event listeners, polling, timers, observers, and repeated full-DOM scans.
- Use event delegation for large or dynamic collections when appropriate.
- Debounce or throttle high-frequency events only when the interaction semantics allow it.
- Cancel obsolete requests and stale asynchronous work with `AbortController`.
- Avoid duplicate API requests and repeated expensive computations.
- Use `requestAnimationFrame` for visual updates that should align with browser painting.
- Avoid expensive synchronous work on the main thread; split work or use Web Workers only when measurement justifies the added complexity.
- Clean up listeners, timers, observers, subscriptions, and object URLs when components or views are removed.
- Avoid memory leaks caused by retained DOM nodes, closures, caches, and detached elements.
- Prefer native browser APIs and platform features over adding a dependency for trivial functionality.
- Do not minify or obfuscate source code as a substitute for fixing inefficient runtime behavior.

### HTML and rendering

- Keep semantic HTML and valid document structure.
- Preserve keyboard navigation, accessible names, labels, focus behavior, and screen-reader support.
- Avoid unnecessary DOM depth and excessive node counts.
- Set image dimensions or aspect ratios to reduce layout shifts.
- Lazy-load below-the-fold images and non-critical embeds; do not lazy-load the main above-the-fold/LCP image without evidence.
- Use appropriate resource hints (`preload`, `preconnect`, `modulepreload`) only for critical resources and only when they help.
- Avoid excessive nested wrappers and duplicated markup.
- Keep forms usable without JavaScript where the product's requirements allow it.
- Do not replace semantic elements with generic containers for marginal performance gains.

### CSS

- Remove genuinely unused selectors and duplicated declarations after checking dynamic classes, templates, states, and runtime-generated markup.
- Reduce overly broad selectors and expensive style recalculation patterns where profiling identifies a problem.
- Avoid layout-triggering animations; prefer `transform` and `opacity` for motion.
- Avoid unnecessary `will-change`; it can increase memory and compositing costs.
- Avoid excessive filters, large shadows, and expensive effects on frequently repainted elements.
- Scope styles sensibly and consolidate repeated rules without creating fragile selectors.
- Preserve responsive layouts, focus indicators, contrast, reduced-motion preferences, and browser compatibility.
- Do not remove CSS solely because a static text search finds no matching class; account for dynamically constructed class names and server-rendered markup.

### Network and caching

- Reduce unnecessary requests and payload size.
- Use cache headers and versioned assets appropriately.
- Cache only safe, correctly scoped responses; never leak user-specific data across users.
- Avoid storing secrets or sensitive responses in inappropriate browser storage.
- Use request cancellation, sensible timeouts, and clear loading/error states.
- Avoid over-fetching and duplicate polling.
- Keep frontend and backend payload contracts aligned.

## Dead code and dependency removal

Treat dead-code removal as a verification task, not a blind cleanup.

1. Search for references, imports, exports, routes, registrations, feature flags, build-time inclusion, generated references, reflection, string-based lookups, and external consumers.
2. Check whether code is reachable through dynamic imports, plugin systems, macros, FFI, callbacks, event names, HTML attributes, or configuration.
3. Inspect conditional compilation and Cargo features before removing Rust modules or dependencies.
4. Inspect HTML templates and dynamically generated CSS classes before deleting frontend code.
5. Use compiler warnings, Clippy, coverage, dependency analysis, and bundler reports as evidence—not as sole proof.
6. Remove confirmed dead code in small batches.
7. Run tests, builds, linting, and relevant application flows after each batch.
8. Remove dependencies only after confirming they are not required by features, build scripts, tests, tooling, or downstream consumers.
9. Update imports, manifests, lockfiles, documentation, and tests consistently.
10. Report uncertain candidates separately instead of deleting them.

Never delete migrations, compatibility shims, public exports, feature-gated code, generated files, or operational scripts without understanding their lifecycle and consumers.

## Safe refactoring procedure

For each change:

1. State the hypothesis and the expected measurable outcome.
2. Identify the behavior and contract that must remain unchanged.
3. Make the smallest coherent change.
4. Add or update a regression test before or alongside the change.
5. Run targeted tests and checks.
6. Run broader tests after related changes are complete.
7. Re-run the same benchmark/profile workload used for the baseline.
8. Compare results under equivalent conditions.
9. Keep the change only if it is correct and the benefit is meaningful, or if it materially improves maintainability without a performance regression.
10. Record any trade-off, limitation, or follow-up work.

Do not combine large unrelated refactors with performance changes. Avoid changing multiple architectural layers at once unless required.

## Validation gates

Run the commands that exist and are appropriate for the repository. Do not invent project scripts.

**Rust examples:**
```bash
cargo fmt --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
```

Use `--all-features` only if all features are intended to be compatible together; some projects define mutually exclusive features. Respect the project's supported feature matrix and MSRV.

**Frontend examples:**
- Run the existing lint, type-check, build, and test scripts if present.
- Test supported browsers and viewport sizes.
- Check console errors, failed requests, accessibility behavior, and layout shifts.
- Test keyboard-only navigation and critical screen-reader flows where relevant.
- Test slow network and CPU conditions for loading and interaction regressions.

**Integration examples:**
- Verify API request/response schemas and status codes.
- Test authentication, authorization, validation, error paths, and rate limits.
- Verify cancellation, timeout, retry, and concurrent-request behavior.
- Run end-to-end tests for critical user journeys.

A change is not complete merely because it compiles.

## Performance acceptance criteria

Use project-specific service-level objectives when available. Otherwise, establish a baseline and propose realistic targets rather than inventing universal thresholds.

For each optimization, report:
- Before and after values.
- Workload and environment.
- Sample count and measurement method.
- p50/p95/p99 latency where relevant.
- Throughput, CPU, memory, and allocation changes where relevant.
- Frontend load, interaction, and rendering metrics where relevant.
- Correctness and regression test results.
- Measurement noise and confidence limitations.

Reject claims based on a single noisy run. Repeat measurements and compare like-for-like conditions. A microbenchmark improvement must not be presented as a real-world user-perceived improvement without supporting end-to-end evidence.

## Prohibited practices

- Do not rewrite the entire application without explicit approval.
- Do not change public APIs, database schemas, persistence semantics, or user-visible behavior as an incidental optimization.
- Do not remove code based only on a text search or assumption.
- Do not add dependencies without explaining their benefit, cost, and maintenance impact.
- Do not introduce unsafe code, custom allocators, lock-free structures, or complex caching without evidence and review.
- Do not use global mutable state as a shortcut.
- Do not silence warnings, weaken tests, remove assertions, or bypass validation to get a green build.
- Do not optimize only for synthetic benchmarks while making real workloads worse.
- Do not sacrifice accessibility, security, privacy, or error handling for speed.
- Do not claim code was tested, profiled, benchmarked, or removed unless the corresponding action was actually performed.

## Final report format

At completion, provide:

### 1. Findings
- Main bottlenecks and evidence.
- Confirmed dead code and unused dependencies.
- Risks and areas that could not be verified.

### 2. Changes made
- Files changed.
- Specific backend and frontend improvements.
- Dead code/dependencies removed and the evidence for removal.
- API, schema, or behavior changes (explicitly state “none” if none).

### 3. Validation
- Exact commands executed.
- Tests, lint, builds, and integration flows passed or failed.
- Any checks not run and why.

### 4. Performance results
| Metric | Before | After | Difference | Method |
|---|---:|---:|---:|---|
| Request p50/p95/p99 | | | | |
| Throughput | | | | |
| CPU | | | | |
| Memory | | | | |
| Frontend load/interaction | | | | |
| Bundle/network size | | | | |

Include only metrics that were actually measured. Mark unavailable values as “not measured.”

### 5. Remaining work
- Highest-value next optimizations.
- Risks, trade-offs, and recommended follow-up profiling.

## Definition of done

The task is complete only when:
- The relevant code paths were inspected.
- Changes are scoped and explainable.
- Confirmed dead code is removed safely.
- Existing behavior and contracts are preserved or explicitly documented.
- Relevant tests, checks, and builds have been run.
- Performance is compared against a reproducible baseline where measurement is possible.
- No unsupported performance claims are made.
- The final report clearly distinguishes completed work from recommendations.