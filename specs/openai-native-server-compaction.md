# Historical: OpenAI Native Server-Side Compaction Plan

> Historical design note. The `/responses/compact` route and the native
> `@opencode-ai/llm` compact API described below were removed after the
> explicit compaction implementation moved into the OpenAI AI SDK adapter.
> See `openai-native-codex-parity-compaction.md` for the retained checkpoint
> and replay design.

## 背景

当前 opencode 的 OpenAI native compaction 主要走客户端主动压缩路径：当 provider 报 context overflow 后，session loop 创建 compaction task，再通过 `LLMClient.compact()` 调用 `/responses/compact`，解析返回的 encrypted `compaction` item，并把它存成 `OpenAINativeCompaction` checkpoint。

目标是支持 OpenAI Responses 的服务端 compaction 形态：客户端发送 `compaction_trigger`，服务端在普通 Responses stream 中返回 encrypted `compaction` item，客户端解析后安装为新的 compaction checkpoint，而不是等服务端明确报错超限后再由客户端 fallback 发起压缩。

## Codex 参考结论

Codex 的 v2 remote compaction 不是调用 `/responses/compact`，而是复用普通 `/responses` stream。

关键行为：

- `codex-rs/core/src/compact_remote_v2.rs` 在 prompt input 后追加 `ResponseItem::CompactionTrigger {}`。
- `run_remote_compaction_request_v2(...)` 调用普通 model client stream。
- `collect_compaction_output(...)` 从 `ResponseEvent::OutputItemDone(item)` 中收集 `ResponseItem::Compaction`。
- stream 必须看到 `response.completed`，且必须刚好收到一个 `compaction` output item。
- compact 完成后不是把新 compaction item append 到旧历史，而是安装 replacement history。

Codex 对历史中已有 compaction item 的处理：

- 请求前的 history 可以包含旧 `ResponseItem::Compaction`。
- v2 compact 完成后，`build_v2_compacted_history(...)` 只从 prompt input 中保留 `user | developer | system` message，再追加本次返回的新 `compaction` item。
- 测试 `build_v2_compacted_history_filters_to_installed_retention_shape` 明确验证旧 compaction item 会被丢弃，最终 replacement history 只含 retained user message 和新的 compaction item。

因此 Codex 的 invariant 是：协议不硬性禁止多个 compaction item 出现在输入中，但每次安装 v2 compaction checkpoint 后都会把历史收敛为特定形式，只保留最新 compaction item。

## opencode 当前状态

已有能力：

- `packages/llm/src/protocols/openai-responses-compact.ts` 能解析 `/responses/compact` 的 SSE/JSON 输出。
- `packages/opencode/src/session/openai-native-compaction.ts` 能把 raw output 存入 `openaiNativeCompactionWindow`。
- `packages/opencode/src/session/compaction.ts` 已经负责选择 head/tail：native compact 只压缩 selected head，tail 通过 `tail_start_id` 保留。
- 后续请求通过 `nativeCompactionWindow.output` 写入 `providerOptions.openai.responsesReplayInput`。

主要缺口：

- 普通 `/responses` stream 中的 `type: "compaction"` item 当前不会变成任何 `LLMEvent`。
- `LLMClient.compact()` 当前发往 `/responses/compact`，不是普通 `/responses + compaction_trigger`。
- replay input schema 需要支持 `{ type: "compaction_trigger" }`，`compaction` item 也需要保留可选 `id`。
- 如果未来支持任意 assistant turn 中的 inline compaction item，需要同时处理历史截断，否则 checkpoint 和旧历史会重复进入下一轮请求。

## 推荐实现策略

第一阶段实现 Codex RemoteCompactionV2 等价路径，风险最低，并复用现有 checkpoint 持久化。

1. 扩展 `@opencode-ai/llm` OpenAI Responses input schema。

- 在 `packages/llm/src/protocols/openai-responses.ts` 中让 `OpenAIResponsesCompactionItem` 接受可选 `id`。
- 新增 `OpenAIResponsesCompactionTrigger`，允许 replay input 中出现 `{ type: "compaction_trigger" }`。

2. 改造 `LLMClient.compact()` 的 OpenAI Responses 实现。

- 将 native compact request 发往普通 `/responses` endpoint。
- 基于已编译的 Responses body 构造 compact body。
- 保持 `store: false`、`stream: true`。
- 在 `input` 尾部追加唯一 `{ type: "compaction_trigger" }`，并移除已有 trigger。

3. 解析普通 Responses compact stream。

- 读取普通 Responses SSE frame。
- 收集 `response.output_item.done.item.type === "compaction"` 的 item。
- 等到 `response.completed` 后返回。
- 若没有 completed，或者 compaction item 数量不是 1，则返回 typed provider error，让上层 fallback 到 summary compaction。

4. 复用 opencode checkpoint 持久化。

- `SessionCompaction.tryNativeCompaction(...)` 继续调用 `llm.compact(...)`。
- 成功返回 `[{ type: "compaction", encrypted_content: ... }]` 后，继续走 `storeNativeCheckpoint(...)`。
- `OpenAINativeCompaction.metadata(...)` 存储最新 output。
- 不追加多个 checkpoint；后续 compact 成功时覆盖为新的 window。

5. 保持现有 tail 机制。

- opencode 不需要照搬 Codex 的 raw replacement history。
- 已有 `prepareMessages(...)` 只发送 selected head 给 compaction。
- 已有 `tail_start_id` 负责保留最近 tail。
- 新 native checkpoint 只代表 compacted head，后续请求由 checkpoint + tail 组合。

## 暂不建议第一阶段实现的内容

不要先支持任意普通 assistant answer stream 中主动返回 `compaction` item 后立即安装 checkpoint。

原因：

- 当前 opencode 没有 Codex 那样的 raw `ResponseItem` history。
- 如果只把 compaction item 存起来，但不裁剪 checkpoint 之前的旧 session history，下一轮会同时发送旧历史和 checkpoint。
- 需要新增 `LLMEvent.compaction` 或 raw provider item 事件，并在 session processor 中定义安装 checkpoint、裁剪历史、保留 tail、model lock、UI 可见性等语义。

这可以作为第二阶段设计，建立在第一阶段的 parser 和 checkpoint 存储能力之上。

## 测试计划

`packages/llm/test/provider/openai-responses.test.ts`：

- `LLMClient.compact()` 使用 `/responses` 而不是 `/responses/compact`。
- compact request body 最后有唯一 `{ type: "compaction_trigger" }`。
- 普通 Responses stream 中 `response.output_item.done` 返回 `compaction` item 时能解析输出。
- stream 未完成、没有 compaction item、多个 compaction item 时失败。

`packages/opencode/test/session/llm-native.test.ts`：

- native compact 请求 URL 为 `/responses`。
- prior `nativeCompactionWindow.output` 会出现在 trigger 之前。
- 返回的 `compaction` item 保留 `id` 和 `encrypted_content`。

`packages/opencode/test/session/compaction.test.ts`：

- native compact 成功后写入 `openaiNativeCompactionWindow.output`。
- 第二次 native compact 会使用上一 checkpoint，并在成功后安装新的 checkpoint。
- fallback summary 路径保持不变。

## 验收标准

- OpenAI native compaction 不依赖 provider 先报 context overflow。
- 服务端通过 ordinary Responses stream 返回 encrypted `compaction` item 时，opencode 能解析并持久化。
- checkpoint replay 只使用最新 compaction window，不累积旧 compaction items。
- 现有 `/responses/compact` 行为如需保留，应明确作为 fallback，而不是主路径。
