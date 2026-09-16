# Agent Note: SDK session resume and runtime image sidecar

Status: implemented

English | [中文](2026-09-01-sdk-runtime-resume-and-image-sidecar.zh.md)

## Problem

The packaged SDK runtime could not continue a conversation after a restart, and the single-file executable could not run the image pipeline. `HarnessSdkJsonRpcServer` always created a fresh agent for a requested `sessionId`, so a persisted log was never reloaded even when a matching durable session existed. Separately, the `deepseek-harness-runtime-bin` wheel shipped the single-file exe and its `-rg` sidecar but no native image runtime: `sharp`'s libvips shared libraries lived inside pkg's virtual filesystem, where the native addon cannot dlopen them at run time.

## Decision

### SDK server resumes before it creates

The SDK server routes session creation through one `createOrResumeSession` path. With a session-persistence backend configured it first tries `ctx.agents.resume({ resumeSessionId, agentOptions })`. An absent durable log (the `SessionPersistenceNotFoundError` signal) falls back to `ctx.agents.create`, so a fresh `session/prompt` still starts empty, while a resumed log keeps its own turn numbering and derived history. Corruption or a backend error rethrows instead of silently replacing a usable persisted session with an empty one. A runtime without persistence keeps the prior create-only behavior, and both paths publish the same provider/model agent options.

### The exe carries a sharp/libvips sidecar

`python/sdk-runtime/package.json` now depends on `@deepseek-ai/dsh-attachment-local`, so the packaged closure carries `sharp` and, with it, the target `@img/sharp-libvips-*` platform carrier. The single-file build stages that carrier beside the executable as `<exe>-libvips`, mirroring the existing `-rg` sidecar described in the [single-file executable distribution note](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md). The directory is copied only when the platform carrier is present, so a closure that omits the attachment-local plugin produces the same sharp-free single file as before. The wheel build and hatch hook accept a top-level `<exe>-libvips` directory while still asserting the top-level products. The Python client prepends `<exe>-libvips/lib` to `LD_LIBRARY_PATH` (or `DYLD_LIBRARY_PATH` on macOS) before exec so the packaged runtime can dlopen vips; when no sidecar or `lib` directory exists nothing changes, so regular Node launches and non-sharp closures keep working unchanged.

## Alternatives considered

- **Always create in the SDK server.** This kept the previous behavior but made a persisted session unreachable across restarts; rejected because resuming the durable log is the expected SDK behavior and the rest of the harness already exposes `agents.resume`.
- **Rewrite or delete a corrupt persisted session on resume failure.** Explicitly rejected: it destroys evidence and replaces a potentially recoverable log with an empty one; the change instead fails loud on corruption and rethrows genuine backend errors.
- **Inline sharp into the exe through pkg assets.** `sharp` resolves libvips from the real filesystem at `dlopen` time, which pkg's virtual filesystem cannot satisfy; the native bundle must sit beside the exe as a real directory, exactly as the ripgrep binary does.

## Consequences

One SDK-server `session/prompt` now continues its prior conversation after a runtime restart when the harness home keeps the session log, at the cost of a durable-log lookup on the first access of each session id. The single-file wheel grows by the libvips bundle when the closure carries sharp, adding a directory to the runtime payload; builds that cross-compile without the target platform carrier still produce a sharp-free single file. Because the sidecar directory is optional and copied only when present, non-sharp closures and the dev-only node carrier are unchanged. The default runtime `cordis.yml` does not mount an attachment store, so a bundled attachment-local provider only becomes usable when a supplied configuration mounts it; wiring the store into the default config is out of scope for this change.
