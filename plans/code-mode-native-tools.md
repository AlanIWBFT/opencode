# OpenCode 原生工具接入 Code Mode 实现计划

## 目标

完成以下三个阶段，使模型能够通过单一原生 `execute` 边界，在解释器内部以受控方式编排工具调用和允许并发的操作：

1. 接入 `read`、`glob`、`grep`、`webfetch`、`websearch` 和条件启用的 `lsp`。
2. 接入互斥的编辑工具组：`apply_patch`，或 `edit` + `write`。
3. 接入互斥的进程工具组：`bash`，或 `exec_command` + `write_stdin` + `terminate_exec`。

本计划不包含 `task`、`skill`、`question`、`todowrite` 和 `plan_exit`。

## 当前实现

OpenCode 目前有两条独立的工具执行路径：

- 原生工具通过 `packages/opencode/src/tool/registry.ts` 注册，并由 `packages/opencode/src/session/tools.ts` 包装为模型工具。
- Code Mode 仅从 `mcp.tools()` 构造 catalog，并在 `packages/opencode/src/tool/code-mode.ts` 中直接调用 MCP transport。

当前关键限制：

- `execute` 只有在存在可见 MCP 工具时才会暴露。
- 原生工具没有 Code Mode exposure 或并发能力声明。
- 原生 direct 调用和 MCP nested 调用分别实现 plugin hooks、权限上下文、附件和错误处理。
- Code Mode adapter 硬编码 `MCP.McpTool`，无法包装 `Tool.Def`。

## 设计原则

### 统一执行边界

提取 direct 和 nested 共用的 child dispatch，统一处理：

- 参数 Schema 校验
- `Tool.Context`
- `tool.execute.before` 和 `tool.execute.after`
- 工具自身的权限询问
- tracing
- abort 传播
- 输出截断
- attachment 收集
- child call ID
- live metadata 更新

Code Mode 不应直接了解 MCP client，也不应为每种原生工具复制一套执行包装。

### 显式 Code Mode 能力

为 `Tool.Def` 增加可选元数据：

```ts
type CodeModeExposure = "nested" | "direct-only" | "hidden"

type CodeModeConcurrency = "parallel" | "serial" | { key: (input: unknown) => string }

interface CodeModeOptions {
  exposure: CodeModeExposure
  concurrency: CodeModeConcurrency
  project?: (result: Tool.ExecuteResult) => unknown
}
```

默认值：

```ts
exposure: "direct-only"
concurrency: "serial"
```

这样 custom/plugin 工具不会未经审核自动进入 Code Mode。

### 复用最终过滤结果

Code Mode candidates 必须经过与原生工具相同的过滤：

- provider/model
- agent 和 session permission
- feature flags
- `apply_patch` 与 `edit/write` 互斥
- `bash` 与 Unified Exec 互斥
- plugin `tool.definition` 变换
- `websearch` provider 条件

不能直接从 `registry.all()` 收集，否则 nested catalog 会与模型实际可用的工具面不一致。

## 架构改动

### 1. 扩展工具定义

修改 `packages/opencode/src/tool/tool.ts`：

- 为 `Tool.Def` 和 `Tool.DefWithoutID` 增加可选 `codeMode` 配置。
- 保持 `Tool.init()`、Schema 解码和输出截断行为不变。
- 默认未声明的工具为 `direct-only` 和 `serial`。

### 2. 拆分 Registry 解析

修改 `packages/opencode/src/tool/registry.ts`，将当前 `tools()` 内部逻辑拆分为：

```text
resolveTools(input)
  -> 应用 model/provider/feature/plugin definition 过滤
  -> 返回最终 Tool.Def[]

partitionCodeMode(tools)
  -> direct tools
  -> nested candidates
```

Code Mode 开启时：

- `nested` 工具不再单独暴露给模型。
- `direct-only` 工具继续直接暴露。
- `execute` 在存在至少一个 native 或 MCP nested 工具时出现。
- `execute` 和 `invalid` 永远不能成为 nested candidate。

### 3. 将 candidates 传入 execute

`SessionTools.resolve()` 创建的 `Tool.Context.extra` 已包含当前 model 和 prompt 信息。扩展该上下文，将本次请求解析出的 Code Mode candidates 传给 `execute`：

```ts
extra: {
  model,
  bypassAgentCheck,
  promptOps,
  codeModeTools,
}
```

为 `extra` 定义明确类型，避免在 Code Mode 中依赖无约束的 `Record<string, unknown>`。

该方式避免 `CodeModeTool` 反向依赖 `ToolRegistry`，从而避免 service layer 循环依赖。

### 4. 泛化 Code Mode catalog

重构 `packages/opencode/src/tool/code-mode.ts`，将硬编码的 MCP catalog entry 改为与来源无关的定义：

```ts
type CatalogEntry = {
  path: string
  id: string
  description: string
  inputSchema: SandboxTool.JsonSchema
  outputSchema?: SandboxTool.JsonSchema
  concurrency: CodeModeConcurrency
  execute(input: unknown, child: ChildContext): Effect.Effect<Tool.ExecuteResult, unknown>
  project(result: Tool.ExecuteResult, collect: (attachment: Attachment) => void): unknown
}
```

提供两个 adapter：

- `fromNativeTool(def)`
- `fromMcpTool(entry)`

namespace 约定：

- MCP 保持 `tools.<server>.<tool>`。
- 原生工具使用保留 namespace `tools.$opencode.<tool>`。

MCP namespace 会经过标识符清洗并将 `$` 替换为 `_`，因此 `$opencode` 不会与 MCP Server namespace 冲突。

### 5. 统一结果投影

原生工具默认向 sandbox 投影：

```json
{
  "output": "...",
  "metadata": {},
  "attachments": [
    {
      "type": "file",
      "mime": "...",
      "filename": "..."
    }
  ]
}
```

attachment 的 URL 和二进制内容不能进入 sandbox，只能由外层 `execute` 累计。

特殊投影：

- `lsp` 优先返回 `metadata.result`。
- Unified Exec 必须保留 `execID`、`laneID`、`running` 和 `exitCode` 等 metadata。
- 编辑工具保留 changed files 和 diff metadata。
- 其他读取工具返回 output 和必要 metadata。

## 阶段一：读取和查询工具

接入：

- `read`
- `glob`
- `grep`
- `webfetch`
- `websearch`
- 条件启用的 `lsp`

建议配置：

| 工具        | Exposure | Concurrency    |
| ----------- | -------- | -------------- |
| `read`      | nested   | parallel       |
| `glob`      | nested   | parallel       |
| `grep`      | nested   | parallel       |
| `webfetch`  | nested   | parallel，有界 |
| `websearch` | nested   | parallel，有界 |
| `lsp`       | nested   | parallel，有界 |

要求：

- `websearch` 继续使用 Registry 现有 provider/runtime 启用条件。
- `lsp` 继续受 `experimentalLspTool` 控制。
- `read` 返回的图片和 PDF 附件在 sandbox 外累计。
- 网络工具共享并发上限，初始建议为 4。
- ripgrep 和 LSP 调用也采用有界并发，不能允许无限 `Promise.all`。

验证脚本：

```js
const [files, matches, source] = await Promise.all([
  tools.$opencode.glob({ pattern: "**/*.ts" }),
  tools.$opencode.grep({ pattern: "ToolRegistry", path: "packages/opencode" }),
  tools.$opencode.read({
    filePath: "packages/opencode/src/tool/registry.ts",
  }),
])

return { files, matches, source }
```

## 阶段二：编辑工具

沿用 `registry.ts` 当前模型条件，接入互斥工具组：

```text
GPT patch 模型 -> apply_patch
其他模型      -> edit + write
```

建议配置：

| 工具          | Exposure | Concurrency |
| ------------- | -------- | ----------- |
| `apply_patch` | nested   | serial      |
| `edit`        | nested   | serial      |
| `write`       | nested   | serial      |

第一版应将整个编辑组串行化，以最小改动保证正确性。后续再考虑按 canonical path 加锁，使不重叠文件可以并行修改。

要求：

- `apply_patch` 不能与 `edit/write` 同时出现在 catalog。
- 继续由工具自身执行 `edit` 和 `external_directory` 权限检查。
- permission deny 应在脚本内表现为可捕获错误。
- plugin before/after hooks 每个 child call 各触发一次。
- 返回结构化 changed files 和 diff 信息。

## 阶段三：进程工具

沿用 runtime flag 接入互斥工具组：

```text
默认                         -> bash
experimentalUnifiedExecTool -> exec_command
                               poll_exec
                               write_stdin
                               terminate_exec
```

### Bash

初始配置：

```text
exposure: nested
concurrency: serial
```

即使脚本使用 `Promise.all`，shell child calls 也先串行执行。无法仅根据命令字符串可靠判断文件、端口、lockfile 和其他资源冲突。

必须保留：

- shell AST permission
- 显式外部 `workdir` 和可静态识别路径的 `external_directory` permission
- timeout
- plugin `shell.env`
- abort 时子进程清理
- 输出截断

`external_directory` 在 Shell 路径上是尽力而为的授权提示，不是文件系统 sandbox。AST 扫描只能识别部分字面量路径，无法可靠拦截变量、重定向、脚本、子进程或运行时生成路径产生的外部访问；Shell child call 一旦获准，仍拥有宿主用户的文件系统权限。显式外部 `workdir` 必须继续稳定触发授权，但不能据此宣称任意 Shell 文件访问受到隔离。

### Unified Exec

以下四个工具必须同时进入：

- `exec_command`
- `poll_exec`
- `write_stdin`
- `terminate_exec`

输出契约：

- child result 中的 output 是 framed execution 活跃期间观察到的共享 lane 输出，不表示这些字节都由当前命令因果产生。
- Code Mode 不分析 shell 后台语义，也不尝试发现、监管或清理由命令遗留的 process、job、runspace、远端任务或外部管理服务。
- 需要可靠 poll、stdin、terminate 和 transcript 的长任务必须保持前台运行；遗留工作产生的混流由模型结合上下文解释。
- Unified Exec 只接受明确支持的 PowerShell、cmd 和 recognized POSIX shell adapter；未知 shell 直接返回 unsupported protocol 错误。

并发规则：

- 不同数字 lane slot 中的 exec session 可以并发。
- `exec_command` 不使用 Code Mode 自己的 semaphore；direct 和 Code Mode 都复用 ExecSession 的 slot 启动串行化，只等待前一工具调用结束 initial yield window，不等待长命令退出。前一命令已完成时继续复用，仍在运行时返回带 execution ID 的 busy。
- 同一 `exec_id` 的 write、poll 和 terminate 使用相同锁键串行。
- 新 shell generation 的创建和 reset 使用全局 spawn semaphore；已有 idle generation 上的命令不受该 semaphore 限制。
- 8 个 live shell 仅作为异步回收目标，不阻塞新 generation；后台 reaper 只回收 LRU、idle、未 reservation 的 slot，25 个 running execution 仍是硬上限。
- `terminate_exec` 与 `write_stdin` 竞争时由 session lock 保证顺序。
- 返回投影必须保留 `metadata.execID`，不能要求脚本解析 output 文本。
- `poll_exec` 是唯一轮询入口；`write_stdin` 必须发送非空字符或显式关闭 pipe stdin。

生命周期策略：

- Code Mode 正常结束时，保留仍在运行的 session，与 direct 调用行为一致。
- Code Mode abort/cancel 时，终止该 `execute` cell 创建且仍运行的 session。
- 脚本显式调用 `terminate_exec` 时正常回收并返回最终输出。
- 不允许 child call 终止其他 OpenCode session 创建的 exec session。

复用 ExecSession 已有的 Session ID ownership 校验，并在 session entry 创建后立即向 Code Mode 注册异常退出清理操作。

## 权限和错误

每个 native child call 必须：

1. 生成 `${outerCallID}/${counter}` 形式的 child call ID。
2. 调用共享 before hook。
3. 执行原始 `Tool.Def.execute()`。
4. 调用共享 after hook。
5. 将普通错误转换为 Code Mode 可捕获的 `toolError`。
6. 将 interrupt 保持为 interrupt，不能包装为普通脚本错误。
7. 更新 outer `execute` 的 `toolCalls` metadata。

Code Mode adapter 不统一提前询问权限。每个工具根据真实输入实现各自的 permission pattern，应继续由工具自身调用 `ctx.ask()`；这些 pattern 表达产品授权和可见性语义，不把 Shell 提升为安全 sandbox。

## 测试计划

扩展 `packages/opencode/test/tool/code-mode.test.ts`：

- native catalog 包含目标工具及其 Schema。
- 没有 MCP 时 `execute` 仍然可见。
- `execute`、`invalid` 和 direct-only 工具不进入 catalog。
- native child hook 使用 synthetic child call ID。
- native permission allow、ask 和 deny。
- `Promise.all` 并发读取。
- network 和 LSP 并发上限。
- attachment 不进入 sandbox。
- native metadata 结构化投影。
- abort 中断所有运行中的 child calls。

新增 `packages/opencode/test/tool/code-mode-native-integration.test.ts`：

- 使用真实临时目录测试 read、glob 和 grep。
- 测试 patch/edit/write 的实际文件结果。
- 测试 bash 和 Unified Exec 生命周期。
- 测试 abort 后没有遗留该 cell 创建的进程。

扩展 Registry 测试：

- model 决定 `apply_patch` 与 `edit/write`。
- flag 决定 `bash` 与 Unified Exec。
- feature 决定 `lsp`。
- provider 决定 `websearch`。
- direct-only 工具始终保持直接暴露。

测试必须从 `packages/opencode` 运行，不能从仓库根目录运行。类型检查使用 `bun typecheck`，不直接运行 `tsc`。

## 实施拆分

建议拆成三个可独立审查的提交：

1. `feat(opencode): add native tools to code mode`
   - exposure 和 concurrency 元数据
   - shared dispatch
   - generic catalog
   - 第一阶段读取工具
2. `feat(opencode): add code mode editing tools`
   - 编辑工具互斥
   - 串行写入
   - 文件集成测试
3. `feat(opencode): add code mode exec tools`
   - bash/Unified Exec 互斥
   - session keyed serialization
   - abort cleanup 和 ownership 测试

每个阶段完成后：

- 运行对应测试，不附带 build。
- 从 `packages/opencode` 运行 `bun typecheck`。
- 检查并统一修改文件为 CRLF。
- 本改动不修改公共 Protocol 或 Server `HttpApi`，无需运行 client code generation。

## 完成标准

- 无 MCP 配置时，Code Mode 仍可通过 native nested tools 使用 `execute`。
- nested native tools 通过单一 `execute` 暴露，脚本内部可并发执行允许并发的读取和查询。
- 编辑和进程工具遵守互斥选择、权限、串行和生命周期约束。
- direct 与 nested 调用共享 hooks、tracing、abort、截断和 attachment 语义。
- `question`、`plan_exit`、`todowrite`、`task`、`skill`、`invalid` 和 `execute` 不进入 nested catalog。
- 所有新增单元测试、集成测试和 package typecheck 通过。
