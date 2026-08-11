import { expect } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionExecSnapshots } from "@opencode/core/session/exec-snapshots"
import { KV } from "@opencode/core/kv"
import { SessionExec } from "@opencode/schema/session-exec"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionExecSnapshots.node, KV.node])))
const snapshot = (revision: number, childID?: string) =>
  Schema.decodeUnknownSync(SessionExec.Snapshot)({
    sessionID: "ses_snapshots",
    assistantMessageID: "msg_snapshots",
    id: "call/with/slashes",
    ...(childID === undefined ? {} : { childID }),
    revision,
    metadata: {
      command: "echo progress",
      output: `preview ${revision}`,
      interactions: [],
      processRunning: true,
      truncated: false,
      execDisplay: "root",
    },
  })

it.effect("periodic previews replace one KV record and a stale acknowledgement cannot erase a new preview", () =>
  Effect.gen(function* () {
    const snapshots = yield* SessionExecSnapshots.Service
    const kv = yield* KV.Service
    for (let revision = 1; revision <= 12; revision++)
      yield* snapshots.save({ kind: "exec", snapshot: snapshot(revision) })
    yield* snapshots.save({ kind: "exec", snapshot: snapshot(4) })
    yield* snapshots.acknowledge({ kind: "exec", snapshot: snapshot(11) })
    expect(yield* snapshots.list(SessionID.make("ses_snapshots"))).toEqual([{ kind: "exec", snapshot: snapshot(12) }])
    expect((yield* kv.scan({ prefix: "session-exec/ses_snapshots/" })).entries).toHaveLength(1)
    yield* snapshots.acknowledge({ kind: "exec", snapshot: snapshot(12) })
    expect(yield* snapshots.list(SessionID.make("ses_snapshots"))).toEqual([])
  }),
)

it.effect("direct commands, Script parents and children have independent snapshots and session cleanup is scoped", () =>
  Effect.gen(function* () {
    const snapshots = yield* SessionExecSnapshots.Service
    const entries: SessionExecSnapshots.Entry[] = [
      { kind: "exec", snapshot: snapshot(1) },
      { kind: "exec", snapshot: snapshot(2, "0") },
      { kind: "exec", snapshot: snapshot(3, "root") },
      { kind: "script", snapshot: { ...snapshot(4), toolCalls: [] } },
    ]
    for (const entry of entries) yield* snapshots.save(entry)
    const other = {
      kind: "exec" as const,
      snapshot: { ...snapshot(5), sessionID: SessionID.make("ses_snapshots_other") },
    }
    yield* snapshots.save(other)
    expect(yield* snapshots.list(SessionID.make("ses_snapshots"))).toHaveLength(4)
    expect(yield* snapshots.list(SessionID.make("ses_snapshots"), snapshot(1).assistantMessageID)).toHaveLength(4)
    yield* snapshots.remove(SessionID.make("ses_snapshots"))
    expect(yield* snapshots.list(SessionID.make("ses_snapshots"))).toEqual([])
    expect(yield* snapshots.list(other.snapshot.sessionID)).toEqual([other])
  }),
)

it.effect("a new runtime preserves the last preview and settles lost command and Script activity once", () =>
  Effect.gen(function* () {
    const snapshots = yield* SessionExecSnapshots.Service
    const kv = yield* KV.Service
    const command: SessionExecSnapshots.Entry = { kind: "exec", snapshot: snapshot(5) }
    const script: SessionExecSnapshots.Entry = {
      kind: "script",
      snapshot: {
        ...snapshot(6),
        toolCalls: [
          { id: "pending", tool: "read", status: "running" },
          { id: "done", tool: "read", status: "completed" },
        ],
      },
    }
    yield* snapshots.save(command)
    yield* snapshots.save(script)
    const context = yield* Layer.build(
      SessionExecSnapshots.layer.pipe(Layer.provide(Layer.succeed(KV.Service, kv)), Layer.fresh),
    )
    const recovered = Context.get(context, SessionExecSnapshots.Service)
    expect(recovered).not.toBe(snapshots)
    const entries = yield* recovered.list(command.snapshot.sessionID)
    const exec = entries.find((entry) => entry.kind === "exec")!
    const parent = entries.find((entry) => entry.kind === "script")!
    expect(exec.snapshot.metadata.processRunning).toBe(false)
    expect(exec.snapshot.metadata.output).toBe(command.snapshot.metadata.output)
    expect(exec.snapshot.metadata.execError).toContain("live execution state is unavailable")
    expect(exec.snapshot.metadata.exitCode).toBeUndefined()
    expect(exec.snapshot.revision).toBe(6)
    expect(parent.snapshot.toolCalls.map((call) => call.status)).toEqual(["error", "completed"])
    expect(yield* recovered.list(command.snapshot.sessionID)).toEqual(entries)
    for (const entry of entries) yield* recovered.acknowledge(entry)
    expect(yield* recovered.list(command.snapshot.sessionID)).toEqual([])
  }),
)
