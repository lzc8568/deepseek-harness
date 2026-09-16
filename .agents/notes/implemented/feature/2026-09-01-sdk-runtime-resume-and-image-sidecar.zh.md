# Agent Note: SDK session resume and runtime image sidecar

Status: implemented

[English](2026-09-01-sdk-runtime-resume-and-image-sidecar.md) | 中文

## Problem

打包后的 SDK 运行时无法在重启后继续一段对话，单文件可执行也无法跑起图像管线。`HarnessSdkJsonRpcServer` 对每个请求的 `sessionId` 总是新建一个 agent，因此即使磁盘上存在对应的持久化会话也不会被重新装载。另外，`deepseek-harness-runtime-bin` wheel 只携带单文件 exe 和它的 `-rg` sidecar，但没有原生图像运行时：`sharp` 的 libvips 共享库位于 pkg 的虚拟文件系统内，原生 addon 在运行时无法 dlopen 它们。

## Decision

### SDK server 先恢复再新建

SDK server 把会话创建统一收敛到 `createOrResumeSession`。配置了 session-persistence 后端时，它先尝试 `ctx.agents.resume({ resumeSessionId, agentOptions })`。只有持久化日志真正缺失（`SessionPersistenceNotFoundError` 信号）才回退到 `ctx.agents.create`，因此新鲜的 `session/prompt` 仍从空会话开始，而恢复出的日志保留自己的 turn 编号与派生历史。损坏或后端错误会原样抛出，而不是悄无声息地用空会话替换掉一个可用的持久化会话。没有持久化的运行时保持原先只新建的行为，两条路径发布完全相同的 provider/model agent 选项。

### exe 携带 sharp/libvips sidecar

`python/sdk-runtime/package.json` 现已依赖 `@deepseek-ai/dsh-attachment-local`，于是打包闭包携带 `sharp`，并随之携带目标平台的 `@img/sharp-libvips-*` carrier。单文件构建把该 carrier 放在可执行文件旁，命名为 `<exe>-libvips`，与现有 `-rg` sidecar 的做法一致（见[单文件可执行分发笔记](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)）。目录仅在平台 carrier 存在时才被复制，因此不含 attachment-local 插件的闭包仍产出与之前相同的无 sharp 单文件。wheel 构建与 hatch hook 接受顶层的 `<exe>-libvips` 目录，同时继续断言顶层产物。Python client 在 exec 前把 `<exe>-libvips/lib` 前置到 `LD_LIBRARY_PATH`（macOS 为 `DYLD_LIBRARY_PATH`），使打包后的运行时能 dlopen vips；没有 sidecar 或 `lib` 目录时不做任何改动，常规 Node 启动与非 sharp 闭包照常工作。

## Alternatives considered

- **SDK server 总是新建。** 保留了旧行为，但让持久化会话在重启后不可达；予以拒绝，因为恢复持久化日志是 SDK 应有的行为，且 harness 其余部分已经暴露 `agents.resume`。
- **恢复失败时改写或删除损坏的持久化会话。** 明确拒绝：这会销毁证据，并把可能可恢复的日志替换成空会话；本次改动改为对损坏响亮失败，并对真实后端错误原样抛出。
- **通过 pkg assets 把 sharp 内联进 exe。** `sharp` 在 `dlopen` 时从真实文件系统解析 libvips，pkg 的虚拟文件系统无法满足；原生 bundle 必须像 ripgrep 二进制那样以真实目录形式放在 exe 旁。

## Consequences

当 harness home 保留会话日志时，一次 SDK-server `session/prompt` 会在运行时重启后继续先前的对话，代价是每个 session id 首次访问时要做一次持久化日志查找。闭包携带 sharp 时单文件 wheel 会因 libvips bundle 而增大，runtime 载荷里多出一个目录；跨编译而缺少目标平台 carrier 的构建仍产出无 sharp 的单文件。由于 sidecar 目录是可选的、仅在存在时复制，非 sharp 闭包与仅开发的 node carrier 均不受影响。默认 runtime `cordis.yml` 并未挂载 attachment store，因此打包进闭包的 attachment-local provider 只有在调用方提供的配置挂载它时才可用；把 store 接入默认配置超出本次改动的范围。
