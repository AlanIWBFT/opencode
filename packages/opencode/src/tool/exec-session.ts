import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID, type MessageID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Pty } from "@opencode-ai/core/pty"
import type { PtyID } from "@opencode-ai/core/pty/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Queue, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import {
  persistentShellArgs,
  persistentShellBootstrapFrame,
  persistentShellBootstrapRequest,
  persistentShellExtension,
  persistentShellRequest,
  persistentShellRunnerScript,
  persistentShellSupported,
} from "./shell"
import {
  appendModelOutput,
  createModelOutput,
  readModelOutput,
  sanitizeTranscript,
  type ModelOutput,
  type TranscriptMode,
} from "./exec-session/output"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"

const DEFAULT_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 30_000
const UI_PREVIEW_LENGTH = 30_000
const MAX_RUNNING_EXECUTIONS = 25
const MAX_RETAINED_EXECUTIONS = 25
const LIVE_LANE_TARGET = 8
const MAX_LANES_PER_SESSION = 8
const MAX_INTERACTIONS = 100
const MAX_BOOTSTRAP_OUTPUT_LENGTH = 4_000
const BOOTSTRAP_TIMEOUT_MS = 5_000
const WATCH_INTERVAL_MS = 250
const WATCH_INTERVAL = `${WATCH_INTERVAL_MS} millis`

export type Display = "root" | "poll" | "stdin" | "terminate"

export type Interaction = {
  type: "stdin" | "terminate"
  time: number
}

export type Metadata = {
  command: string
  output: string
  interactions: Interaction[]
  execID?: number
  laneID?: number
  shellGeneration?: number
  shellReused?: boolean
  cwd?: string
  sessionExposed?: boolean
  startedAt?: number
  durationMs?: number
  processRunning: boolean
  exitCode?: number
  outputError?: string
  truncated: boolean
  terminationRequested?: boolean
  execDisplay: Display
  execError?: string
}

export type Invocation = {
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  display: Display
  metadata: (input: { title?: string; metadata?: Metadata }) => Effect.Effect<void>
}

export type LaunchInput = {
  command: string
  shell: string
  cwd: string
  laneCwd?: string
  env: Record<string, string>
  laneID?: number
  resetLane?: boolean
  tty?: boolean
  yieldTimeMs?: number
  maxOutputTokens?: number
  invocation: Invocation
  onExecutionStarted?: (execID: number) => Effect.Effect<void>
  onLaneReserved?: () => Effect.Effect<void>
  failLaneRequest?: boolean
  failLaneBootstrap?: boolean
  bootstrapTimeoutMs?: number
  prepare: (cwd: string) => Effect.Effect<{ script: string; env?: Record<string, string> }>
}

export type ContinueInput = {
  execID: number
  chars?: string
  closeStdin?: boolean
  yieldTimeMs?: number
  maxOutputTokens?: number
  invocation: Invocation
}

export type TerminateInput = {
  execID: number
  yieldTimeMs?: number
  maxOutputTokens?: number
  invocation: Invocation
}

export type StopTarget = {
  sessionID: SessionID
  messageIDs?: ReadonlySet<MessageID>
}

export type StopResult = {
  matched: number
  terminated: number
  failed: number
}

export type SnapshotInput = {
  sessionID: SessionID
  messageID: MessageID
  callID: string
}

export type CommitOriginalInput = SnapshotInput & {
  update: (part: SessionV1.ToolPart, metadata: Metadata) => SessionV1.ToolPart
}

export type Chunk = {
  chunkID: string
  command: string
  output: string
  warning?: string
  execID?: number
  running: boolean
  exitCode?: number
  truncated: boolean
  wallTimeMs: number
  metadata: Metadata
  error?: string
}

type PipeTransport = {
  type: "pipe"
  handle: ChildProcessHandle
  stdin: Queue.Queue<Uint8Array, Cause.Done>
  stdinClosed: boolean
  stdinLock: Semaphore.Semaphore
  scope: Scope.Closeable
  outputDone: Deferred.Deferred<void>
}

type PtyTransport = {
  type: "pty"
  id: PtyID
  location: string
  scope: Scope.Closeable
  attachment?: Pty.Attachment
  bootstrapObserved: Deferred.Deferred<void>
  outputDone: Deferred.Deferred<void>
  running: boolean
  exitCode?: number
}

type Entry = {
  execID: number
  lane: Lane
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  command: string
  shellReused: boolean
  cwd?: string
  commandFile?: string
  statusFile?: string
  executionExposed: boolean
  startedAt: number
  started: number
  durationMs?: number
  modelOutput: ModelOutput
  transcript: string
  transcriptMode: TranscriptMode
  interactions: Interaction[]
  truncated: boolean
  running: boolean
  exitCode?: number
  outputError?: string
  terminationRequested: boolean
  finalized: boolean
  dirty: boolean
  startObserved: Deferred.Deferred<void>
  lock: Semaphore.Semaphore
  originalLock: Semaphore.Semaphore
}

type Lane = {
  laneID: number
  sessionID: SessionID
  shell: string
  generation: number
  pluginEnv: Record<string, string>
  cwd: string
  tty: boolean
  state: "idle" | "executing" | "lost"
  lostReason?: string
  transport: PipeTransport | PtyTransport
  nonce: string
  tempDir: string
  runnerFile: string
  bootstrap: {
    ready: boolean
    output: string
    transcriptMode: TranscriptMode
  }
  pending: string
  commandStarted: boolean
  stdinReleased: boolean
  stdinPending: Uint8Array[]
  stdinClosePending: boolean
  active?: Entry
  lastUsed: number
  resourcesReleased: boolean
  releaseDone: Deferred.Deferred<void>
  lock: Semaphore.Semaphore
}

type LanePreparation = {
  staged?: Lane
}

type LaneSlot = {
  generation: number
  committed: { type: "empty" } | { type: "live"; lane: Lane } | { type: "lost"; reason: string }
  preparation?: LanePreparation
  activeLaunch?: LaneLaunch
  launchQueue: LaneLaunch[]
}

type LaneLaunch = {
  slot: LaneSlot
  gate: Deferred.Deferred<void>
  invalidated: Deferred.Deferred<string>
  state: "queued" | "active" | "invalidated" | "done"
  invalidatedReason?: string
}

type State = {
  location: string
  nextExecID: number
  executions: Map<number, Entry>
  exited: number[]
  slots: Map<SessionID, LaneSlot[]>
  lifecycleEpochs: Map<SessionID, number>
  archiveOperations: Map<SessionID, object>
  stopOperations: Map<SessionID, Set<object>>
  nextLaneUse: number
  laneLock: Semaphore.Semaphore
  spawnLock: Semaphore.Semaphore
  reaper?: object
}

function slotsFor(state: State, sessionID: SessionID) {
  const existing = state.slots.get(sessionID)
  if (existing) return existing
  const created: LaneSlot[] = Array.from({ length: MAX_LANES_PER_SESSION }, () => ({
    generation: 0,
    committed: { type: "empty" },
    launchQueue: [],
  }))
  state.slots.set(sessionID, created)
  return created
}

function invalidateSlotLaunches(slot: LaneSlot, laneID: number) {
  const invalidated: LaneLaunch[] = []
  if (slot.activeLaunch) {
    slot.activeLaunch.state = "invalidated"
    slot.activeLaunch.invalidatedReason ??= `lane slot ${laneID} preparation was invalidated because the session changed`
    invalidated.push(slot.activeLaunch)
  }
  const queued = slot.launchQueue.splice(0)
  for (const launch of queued) {
    launch.state = "invalidated"
    launch.invalidatedReason = `lane slot ${laneID} queued command was invalidated because the session changed`
  }
  return [...invalidated, ...queued]
}

function liveLanes(state: State) {
  return Array.from(state.slots.values()).flatMap((slots) =>
    slots.flatMap((slot) => (slot.committed.type === "live" ? [slot.committed.lane] : [])),
  )
}

function allocatedLanes(state: State) {
  return [
    ...liveLanes(state),
    ...Array.from(state.slots.values()).flatMap((slots) =>
      slots.flatMap((slot) => (slot.preparation?.staged ? [slot.preparation.staged] : [])),
    ),
  ]
}

function sessionLifecycleEvent(data: unknown) {
  if (typeof data !== "object" || data === null || !("sessionID" in data) || typeof data.sessionID !== "string") {
    return undefined
  }
  const info = "info" in data && typeof data.info === "object" && data.info !== null ? data.info : undefined
  const time = info && "time" in info && typeof info.time === "object" && info.time !== null ? info.time : undefined
  const archived = time && "archived" in time && typeof time.archived === "number" ? time.archived : undefined
  return { sessionID: SessionID.make(data.sessionID), archived }
}

export interface Interface {
  readonly launch: (input: LaunchInput) => Effect.Effect<Chunk>
  readonly write: (input: ContinueInput) => Effect.Effect<Chunk>
  readonly terminate: (input: TerminateInput) => Effect.Effect<Chunk>
  readonly stop: (targets: readonly StopTarget[]) => Effect.Effect<StopResult>
  readonly commitOriginal: (input: CommitOriginalInput) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExecSession") {}

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const spawner = yield* ChildProcessSpawner

    const pty = Effect.fnUntraced(function* <A, E, R>(location: string, effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(location) }))),
      )
    })

    const cleanupEntry = Effect.fnUntraced(function* (state: State, entry: Entry) {
      state.executions.delete(entry.execID)
      const index = state.exited.indexOf(entry.execID)
      if (index !== -1) state.exited.splice(index, 1)
      yield* cleanupEntryFiles(entry)
    })

    const cleanupEntryFiles = Effect.fnUntraced(function* (entry: Entry) {
      const files = [entry.commandFile, entry.statusFile].filter((file): file is string => Boolean(file))
      entry.commandFile = undefined
      entry.statusFile = undefined
      yield* Effect.forEach(
        files,
        (file) => Effect.promise(() => Bun.file(file).delete()).pipe(Effect.catchCause(() => Effect.void)),
        {
          concurrency: "unbounded",
          discard: true,
        },
      )
    })

    const cleanupLane = Effect.fnUntraced(function* (state: State, lane: Lane) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          lane.state = "lost"
          lane.lostReason ??= "lane closed"
          lane.pluginEnv = {}
          if (lane.resourcesReleased) {
            yield* Deferred.await(lane.releaseDone)
          } else {
            lane.resourcesReleased = true
            if (lane.transport.type === "pipe") {
              yield* Scope.close(lane.transport.scope, Exit.void).pipe(Effect.ignore)
            } else {
              const transport = lane.transport
              yield* pty(
                transport.location,
                Pty.Service.use((service) =>
                  Effect.gen(function* () {
                    yield* service.kill(transport.id).pipe(Effect.ignore)
                    yield* service.remove(transport.id).pipe(Effect.ignore)
                  }),
                ),
              ).pipe(Effect.ignore)
              if (transport.attachment) {
                yield* Deferred.await(transport.outputDone).pipe(Effect.timeout("1 second"), Effect.ignore)
                transport.attachment.detach()
                transport.attachment = undefined
              }
              yield* Scope.close(transport.scope, Exit.void).pipe(Effect.ignore)
              yield* Deferred.succeed(transport.outputDone, undefined).pipe(Effect.ignore)
            }
            yield* Effect.promise(() =>
              rm(lane.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
            ).pipe(Effect.catchCause(() => Effect.void))
            yield* Deferred.succeed(lane.releaseDone, undefined).pipe(Effect.ignore)
          }
          const slot = state.slots.get(lane.sessionID)?.[lane.laneID]
          if (slot?.committed.type === "live" && slot.committed.lane === lane) {
            slot.committed = { type: "lost", reason: lane.lostReason }
          }
        }),
      )
    })

    const reapIdleLanes = Effect.fnUntraced(function* (state: State) {
      while (true) {
        const victims = yield* state.laneLock.withPermits(1)(
          Effect.sync(() => {
            const live = liveLanes(state).filter((lane) => !lane.resourcesReleased)
            const excess = live.length - LIVE_LANE_TARGET
            if (excess <= 0) return []
            const victims = live
              .filter(
                (lane) =>
                  lane.state === "idle" &&
                  !lane.resourcesReleased &&
                  !state.slots.get(lane.sessionID)?.[lane.laneID]?.preparation &&
                  !state.slots.get(lane.sessionID)?.[lane.laneID]?.activeLaunch &&
                  state.slots.get(lane.sessionID)?.[lane.laneID]?.launchQueue.length === 0,
              )
              .sort((left, right) => left.lastUsed - right.lastUsed)
              .slice(0, excess)
            if (victims.length === 0) return []
            for (const lane of victims) {
              lane.state = "lost"
              lane.lostReason = "lane reaped to reduce idle workspace shell usage"
              const slot = state.slots.get(lane.sessionID)?.[lane.laneID]
              if (slot?.committed.type === "live" && slot.committed.lane === lane) {
                slot.committed = { type: "lost", reason: lane.lostReason }
              }
            }
            return victims
          }),
        )
        if (victims.length === 0) return
        yield* Effect.forEach(victims, (lane) => cleanupLane(state, lane), {
          concurrency: "unbounded",
          discard: true,
        })
      }
    })

    const scheduleReaper = Effect.fnUntraced(function* (state: State) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const token = yield* state.laneLock.withPermits(1)(
            Effect.sync(() => {
              if (state.reaper) return undefined
              const token = {}
              state.reaper = token
              return token
            }),
          )
          if (!token) return
          yield* reapIdleLanes(state).pipe(
            Effect.ensuring(
              state.laneLock.withPermits(1)(
                Effect.sync(() => {
                  if (state.reaper === token) state.reaper = undefined
                }),
              ),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }),
      )
    })

    const instanceState = yield* InstanceState.make<State>(
      Effect.fn("ExecSession.state")(function* (ctx) {
        const state: State = {
          location: ctx.directory,
          nextExecID: 1,
          executions: new Map(),
          exited: [],
          slots: new Map(),
          lifecycleEpochs: new Map(),
          archiveOperations: new Map(),
          stopOperations: new Map(),
          nextLaneUse: 1,
          laneLock: Semaphore.makeUnsafe(1),
          spawnLock: Semaphore.makeUnsafe(1),
        }
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(allocatedLanes(state), (lane) => cleanupLane(state, lane), {
              concurrency: "unbounded",
              discard: true,
            })
            yield* Effect.forEach(state.executions.values(), (entry) => cleanupEntry(state, entry), {
              concurrency: "unbounded",
              discard: true,
            })
          }),
        )
        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          const deleted = event.type === Session.Event.Deleted.type
          const updated = event.type === Session.Event.Updated.type
          if (!deleted && !updated) return Effect.void
          const data = sessionLifecycleEvent(event.data)
          if (!data) return Effect.void
          if (updated && !data.archived) {
            state.archiveOperations.delete(data.sessionID)
            return Effect.void
          }
          const archived = updated
          const token = {}
          if (deleted) state.archiveOperations.delete(data.sessionID)
          else state.archiveOperations.set(data.sessionID, token)
          return state.laneLock.withPermits(1)(
            Effect.gen(function* () {
              if (archived && state.archiveOperations.get(data.sessionID) !== token) return
              state.lifecycleEpochs.set(data.sessionID, (state.lifecycleEpochs.get(data.sessionID) ?? 0) + 1)
              const slots = state.slots.get(data.sessionID)
              if (!slots) {
                if (archived && state.archiveOperations.get(data.sessionID) === token) {
                  state.archiveOperations.delete(data.sessionID)
                }
                return
              }
              const removed = Array.from(
                new Set(
                  slots.flatMap((slot) => [
                    ...(slot.committed.type === "live" ? [slot.committed.lane] : []),
                    ...(slot.preparation?.staged ? [slot.preparation.staged] : []),
                  ]),
                ),
              )
              const invalidated = slots.flatMap((slot, laneID) => {
                slot.preparation = undefined
                return invalidateSlotLaunches(slot, laneID)
              })
              yield* Effect.forEach(
                invalidated,
                (launch) => Deferred.succeed(launch.invalidated, launch.invalidatedReason!).pipe(Effect.ignore),
                { concurrency: "unbounded", discard: true },
              )
              if (deleted) state.slots.delete(data.sessionID)
              else for (const lane of removed) lane.lostReason = "session archived"
              yield* Effect.forEach(removed, (lane) => cleanupLane(state, lane), {
                concurrency: "unbounded",
                discard: true,
              })
              if (archived && state.archiveOperations.get(data.sessionID) === token) {
                state.archiveOperations.delete(data.sessionID)
              }
            }),
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return state
      }),
    )

    const current = Effect.fn("ExecSession.current")(function* () {
      return yield* InstanceState.get(instanceState)
    })

    function findEntry(state: State, execID: number, invocation: Invocation) {
      const entry = state.executions.get(execID)
      if (!entry) return `execution not found: ${execID}`
      if (entry.sessionID !== invocation.sessionID) {
        return `execution ${execID} does not belong to this session`
      }
      return entry
    }

    function makeEntry(
      state: State,
      input: LaunchInput,
      processStarted: number,
      details: { id: number; lane: Lane; reused: boolean; commandFile: string; statusFile: string },
    ): Entry {
      return {
        execID: details.id,
        lane: details.lane,
        sessionID: input.invocation.sessionID,
        messageID: input.invocation.messageID,
        callID: input.invocation.callID,
        command: input.command,
        shellReused: details.reused,
        cwd: details.lane.cwd,
        commandFile: details.commandFile,
        statusFile: details.statusFile,
        executionExposed: false,
        startedAt: Date.now(),
        started: processStarted,
        modelOutput: createModelOutput(),
        transcript: "",
        transcriptMode: "text",
        interactions: [],
        truncated: false,
        running: true,
        terminationRequested: false,
        finalized: false,
        dirty: false,
        startObserved: Deferred.makeUnsafe<void>(),
        lock: Semaphore.makeUnsafe(1),
        originalLock: Semaphore.makeUnsafe(1),
      }
    }

    const spawnPipe = Effect.fnUntraced(function* (input: {
      shell: string
      args: string[]
      cwd: string
      env: Record<string, string>
    }) {
      const processScope = yield* Scope.fork(scope)
      const outputDone = yield* Deferred.make<void>()
      const stdin = yield* Queue.bounded<Uint8Array, Cause.Done>(1)
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(input.shell, input.args, {
            cwd: input.cwd,
            env: input.env,
            stdin: { stream: Stream.fromQueue(stdin), endOnDone: true },
            forceKillAfter: "3 seconds",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, processScope),
          Effect.onExit((result) => (Exit.isFailure(result) ? Scope.close(processScope, Exit.void) : Effect.void)),
          Effect.orDie,
        )
      return {
        type: "pipe" as const,
        handle,
        stdin,
        stdinClosed: false,
        stdinLock: Semaphore.makeUnsafe(1),
        scope: processScope,
        outputDone,
      }
    })

    const spawnPty = Effect.fnUntraced(function* (input: {
      shell: string
      args: string[]
      cwd: string
      env: Record<string, string>
      location: string
      title: string
    }) {
      const processScope = yield* Scope.fork(scope)
      const bootstrapObserved = yield* Deferred.make<void>()
      const outputDone = yield* Deferred.make<void>()
      return yield* pty(
        input.location,
        Pty.Service.use((service) =>
          service.create({
            command: input.shell,
            args: input.args,
            login: false,
            cwd: input.cwd,
            title: input.title,
            env: input.env,
          }),
        ),
      ).pipe(
        Effect.map((info) => ({
          type: "pty" as const,
          id: info.id,
          location: input.location,
          scope: processScope,
          bootstrapObserved,
          outputDone,
          running: true,
        })),
        Effect.onExit((result) => (Exit.isFailure(result) ? Scope.close(processScope, Exit.void) : Effect.void)),
      )
    })

    const writeLaneTransport = Effect.fnUntraced(function* (lane: Lane, chunks: readonly Uint8Array[], close: boolean) {
      const bytes =
        chunks.length === 0
          ? undefined
          : chunks.length === 1
            ? chunks[0]
            : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      if (lane.transport.type === "pty") {
        if (close) return false
        if (!bytes?.length) return true
        const transport = lane.transport
        const data = new TextDecoder().decode(bytes)
        if (transport.attachment) {
          return yield* Effect.sync(() => transport.attachment?.write(data)).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        }
        return yield* pty(
          transport.location,
          Pty.Service.use((service) => service.write(transport.id, data)),
        ).pipe(
          Effect.as(true),
          Effect.catchTag("Pty.ExitedError", () => Effect.succeed(false)),
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
        )
      }
      const transport = lane.transport
      return yield* transport.stdinLock.withPermits(1)(
        Effect.gen(function* () {
          if (transport.stdinClosed) return false
          if (bytes?.length && !(yield* Queue.offer(transport.stdin, bytes))) return false
          if (!close) return true
          const closed = yield* Queue.end(transport.stdin)
          transport.stdinClosed = transport.stdinClosed || closed
          if (closed) {
            lane.state = "lost"
            lane.lostReason = "lane stdin closed"
          }
          return closed
        }),
      )
    })

    const flushLaneStdin = Effect.fnUntraced(function* (lane: Lane) {
      const chunks = lane.stdinPending.splice(0)
      const close = lane.stdinClosePending
      lane.stdinClosePending = false
      if (chunks.length === 0 && !close) return true
      return yield* writeLaneTransport(lane, chunks, close)
    })

    const releaseLaneStdin = Effect.fnUntraced(function* (entry: Entry) {
      const lane = entry.lane
      yield* lane.lock.withPermits(1)(
        Effect.gen(function* () {
          if (lane.active !== entry || !entry.running || lane.stdinReleased) return
          if (lane.state !== "executing" || entry.terminationRequested || lane.resourcesReleased) {
            lane.stdinPending = []
            lane.stdinClosePending = false
            return
          }
          lane.stdinReleased = true
          if (yield* flushLaneStdin(lane)) return
          entry.outputError = "lane stdin is no longer available"
          entry.running = false
          entry.dirty = true
          lane.state = "lost"
          lane.lostReason = entry.outputError
          lane.active = undefined
          lane.commandStarted = false
          lane.stdinReleased = false
          lane.pending = ""
          yield* cleanupEntryFiles(entry)
        }),
      )
    })

    const requestTermination = Effect.fnUntraced(function* (entry: Entry, reason: string) {
      return yield* entry.lane.lock.withPermits(1)(
        entry.lock.withPermits(1)(
          Effect.sync(() => {
            if (entry.lane.active !== entry || !entry.running) return false
            entry.terminationRequested = true
            appendInteraction(entry, "terminate")
            entry.lane.state = "lost"
            entry.lane.lostReason = reason
            return true
          }),
        ),
      )
    })

    const killLaneTransport = Effect.fnUntraced(function* (lane: Lane) {
      const transport = lane.transport
      return transport.type === "pty"
        ? yield* pty(
            transport.location,
            Pty.Service.use((service) => service.kill(transport.id)),
          ).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        : yield* transport.handle.kill({ forceKillAfter: "3 seconds" }).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
    })

    const finishLaunch = Effect.fnUntraced(function* (state: State, launch: LaneLaunch) {
      if (launch.state === "invalidated" && launch.slot.activeLaunch !== launch) return
      const next = yield* state.laneLock.withPermits(1)(
        Effect.sync(() => {
          if (launch.slot.activeLaunch === launch) {
            launch.slot.activeLaunch = undefined
            const queued = launch.slot.launchQueue.shift()
            if (queued) {
              queued.state = "active"
              launch.slot.activeLaunch = queued
            }
            if (launch.state !== "invalidated") launch.state = "done"
            return queued
          }
          const index = launch.slot.launchQueue.indexOf(launch)
          if (index !== -1) launch.slot.launchQueue.splice(index, 1)
          if (launch.state !== "invalidated") launch.state = "done"
          return undefined
        }),
      )
      if (next) yield* Deferred.succeed(next.gate, undefined).pipe(Effect.ignore)
      yield* scheduleReaper(state)
    })

    function appendBootstrapOutput(lane: Lane, text: string) {
      lane.bootstrap.output += sanitizeTranscript(lane.bootstrap, text)
      if (lane.bootstrap.output.length > MAX_BOOTSTRAP_OUTPUT_LENGTH) {
        lane.bootstrap.output = lane.bootstrap.output.slice(-MAX_BOOTSTRAP_OUTPUT_LENGTH)
      }
    }

    function consumeBootstrapOutputLocked(lane: Lane, chunk: string) {
      lane.pending += chunk
      const marker = persistentShellBootstrapFrame(lane.nonce, lane.tty)
      const index = lane.pending.indexOf(marker)
      if (index !== -1) {
        appendBootstrapOutput(lane, lane.pending.slice(0, index))
        lane.pending = lane.pending.slice(index + marker.length)
        lane.bootstrap.ready = true
        return true
      }

      let keep = Math.min(marker.length - 1, lane.pending.length)
      while (keep > 0 && !marker.startsWith(lane.pending.slice(-keep))) keep--
      appendBootstrapOutput(lane, lane.pending.slice(0, lane.pending.length - keep))
      lane.pending = lane.pending.slice(lane.pending.length - keep)
      return false
    }

    // The caller owns lane.lock so frame parsing and lane state changes commit atomically.
    const consumeLaneOutputLocked = Effect.fnUntraced(function* (state: State, lane: Lane, chunk: string) {
      if (!lane.bootstrap.ready) {
        if (!consumeBootstrapOutputLocked(lane, chunk)) return
        chunk = ""
      }
      lane.pending += chunk
      const active = lane.active
      if (!active) {
        lane.pending = ""
        return
      }

      const terminal = lane.tty
      const prefix = terminal ? `OC${lane.nonce}:${active.execID}:` : `\x1e${lane.nonce}:${active.execID}:`
      const suffix = terminal ? ":CO" : "\x1f"
      while (true) {
        const start = lane.pending.indexOf(prefix)
        if (start === -1) {
          let keep = Math.min(prefix.length - 1, lane.pending.length)
          while (keep > 0 && !prefix.startsWith(lane.pending.slice(-keep))) keep--
          const text = lane.pending.slice(0, lane.pending.length - keep)
          lane.pending = lane.pending.slice(lane.pending.length - keep)
          if (text && lane.commandStarted) append(active, text)
          return
        }
        const end = lane.pending.indexOf(suffix, start + prefix.length)
        if (end === -1) {
          const text = lane.pending.slice(0, start)
          lane.pending = lane.pending.slice(start)
          if (text && lane.commandStarted) append(active, text)
          return
        }

        const before = lane.pending.slice(0, start)
        const after = lane.pending.slice(end + suffix.length)
        const payload = lane.pending.slice(start + prefix.length, end)
        lane.pending = after
        if (payload === (terminal ? "s" : "start")) {
          lane.commandStarted = true
          yield* Deferred.succeed(active.startObserved, undefined).pipe(Effect.ignore)
          if (lane.state !== "executing" || active.terminationRequested || lane.resourcesReleased) {
            lane.stdinPending = []
            lane.stdinClosePending = false
            continue
          }
          continue
        }
        const output = terminal ? withoutProtocolNewline(before) : before
        if (output && lane.commandStarted) append(active, output)
        const statusFile = active.statusFile
        const cwd = statusFile
          ? yield* Effect.promise(() => Bun.file(statusFile).text()).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
        const completed = payload.startsWith(terminal ? "d:" : "done:")
        const completionPayload = payload.slice(terminal ? 2 : 5)
        const completion = completed && cwd !== undefined ? parseLaneCompletion(completionPayload, cwd) : undefined
        if (!completion || !lane.commandStarted) {
          active.outputError = `lane slot ${lane.laneID} returned an invalid completion frame`
          lane.state = "lost"
          lane.lostReason = "shell protocol error"
        } else {
          active.exitCode = completion.exitCode
          active.cwd = completion.cwd
          lane.cwd = completion.cwd
          const reusable =
            lane.state === "executing" &&
            !active.terminationRequested &&
            !lane.resourcesReleased &&
            (lane.transport.type !== "pipe" || !lane.transport.stdinClosed)
          if (reusable) {
            lane.state = "idle"
            lane.lastUsed = state.nextLaneUse++
          } else {
            lane.state = "lost"
            lane.lostReason ??= active.terminationRequested
              ? "execution terminated"
              : lane.resourcesReleased
                ? "lane closed"
                : "lane stdin closed"
          }
        }
        active.running = false
        active.dirty = true
        lane.active = undefined
        lane.commandStarted = false
        lane.stdinReleased = false
        lane.pending = ""
        yield* cleanupEntryFiles(active)
        return
      }
    })

    const consumeLaneOutput = Effect.fnUntraced(function* (state: State, lane: Lane, chunk: string) {
      yield* lane.lock.withPermits(1)(consumeLaneOutputLocked(state, lane, chunk))
      if (lane.state === "idle") yield* scheduleReaper(state)
    })

    const bootstrapStatus = Effect.fnUntraced(function* (lane: Lane) {
      if (lane.transport.type === "pipe") {
        const running = yield* lane.transport.handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false)))
        if (!running) yield* Deferred.await(lane.transport.outputDone)
        return yield* lane.lock.withPermits(1)(
          Effect.sync(() => ({
            ready: lane.bootstrap.ready,
            running,
            output: lane.bootstrap.output,
          })),
        )
      }

      return {
        ready: lane.bootstrap.ready,
        running: lane.transport.running,
        output: lane.bootstrap.output,
      }
    })

    const attachPtyOutput = Effect.fnUntraced(function* (state: State, lane: Lane) {
      if (lane.transport.type !== "pty") return
      const transport = lane.transport
      const bridge = yield* EffectBridge.make()
      let pending = Promise.resolve()
      let ended = false
      const marker = persistentShellBootstrapFrame(lane.nonce, true)
      let bootstrapProbe = ""
      let startProbe = ""
      let startExecID: number | undefined
      const observeBootstrap = (chunk: string) => {
        bootstrapProbe += chunk
        if (bootstrapProbe.includes(marker)) {
          Effect.runSync(Deferred.succeed(transport.bootstrapObserved, undefined).pipe(Effect.ignore))
          bootstrapProbe = ""
          return
        }
        if (bootstrapProbe.length >= marker.length) bootstrapProbe = bootstrapProbe.slice(1 - marker.length)
      }
      const observeStart = (chunk: string) => {
        const active = lane.active
        if (!active) {
          startProbe = ""
          startExecID = undefined
          return
        }
        if (startExecID !== active.execID) {
          startProbe = ""
          startExecID = active.execID
        }
        const marker = `OC${lane.nonce}:${active.execID}:s:CO`
        startProbe += chunk
        if (startProbe.includes(marker)) {
          Effect.runSync(Deferred.succeed(active.startObserved, undefined).pipe(Effect.ignore))
          startProbe = ""
          return
        }
        if (startProbe.length >= marker.length) startProbe = startProbe.slice(1 - marker.length)
      }
      const enqueue = (effect: Effect.Effect<void>) => {
        pending = pending.then(() => bridge.promise(effect)).catch(() => undefined)
      }
      const finish = (event: { exitCode?: number }) => {
        if (ended) return
        ended = true
        enqueue(
          Effect.gen(function* () {
            transport.running = false
            transport.exitCode = event.exitCode
            yield* Deferred.succeed(transport.outputDone, undefined).pipe(Effect.ignore)
            if (lane.resourcesReleased) return
            lane.state = "lost"
            lane.lostReason ??= "shell exited"
            yield* state.laneLock.withPermits(1)(cleanupLane(state, lane))
          }),
        )
      }
      const attachment = yield* pty(
        transport.location,
        Pty.Service.use((service) =>
          service.attach(transport.id, {
            cursor: 0,
            onData: (chunk) => {
              observeBootstrap(chunk)
              observeStart(chunk)
              enqueue(consumeLaneOutput(state, lane, chunk))
            },
            onEnd: finish,
          }),
        ),
      ).pipe(
        Effect.catchTag("Pty.ExitedError", () => Effect.succeed(undefined)),
        Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(undefined)),
      )
      if (!attachment) {
        const snapshot = yield* pty(
          transport.location,
          Pty.Service.use((service) => service.read(transport.id)),
        ).pipe(Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(undefined)))
        if (snapshot?.truncated) appendBootstrapOutput(lane, "\n... bootstrap output omitted ...\n")
        if (snapshot?.output) yield* consumeLaneOutput(state, lane, snapshot.output)
        transport.running = snapshot?.status === "running"
        transport.exitCode = snapshot?.exitCode
        yield* Deferred.succeed(transport.outputDone, undefined).pipe(Effect.ignore)
        return
      }

      transport.attachment = attachment
      if (attachment.replay) {
        yield* consumeLaneOutput(state, lane, attachment.replay)
        observeBootstrap(attachment.replay)
      }
      attachment.activate()
    })

    const waitForBootstrap = Effect.fnUntraced(function* (state: State, lane: Lane, timeoutMs = BOOTSTRAP_TIMEOUT_MS) {
      const timeout = Math.max(0, timeoutMs)
      if (lane.transport.type === "pty") {
        const outcome = yield* Effect.race(
          Deferred.await(lane.transport.bootstrapObserved).pipe(Effect.as("ready" as const)),
          Deferred.await(lane.transport.outputDone).pipe(Effect.as("exit" as const)),
        ).pipe(
          Effect.timeoutOrElse({
            duration: `${timeout} millis`,
            orElse: () => Effect.succeed("timeout" as const),
          }),
        )
        const status = yield* bootstrapStatus(lane)
        if (outcome === "ready" && status.running) return undefined
        const detail = status.output.trim()
        if (outcome === "exit" || !status.running) {
          return detail
            ? `shell exited before bootstrap completed\nBootstrap output:\n${detail}`
            : "shell exited before bootstrap completed"
        }
        return detail
          ? `shell bootstrap timed out after ${timeout}ms\nBootstrap output:\n${detail}`
          : `shell bootstrap timed out after ${timeout}ms`
      }
      const deadline = performance.now() + timeout
      while (true) {
        const status = yield* bootstrapStatus(lane)
        if (status.ready && status.running) return undefined
        const detail = status.output.trim()
        if (!status.running) {
          return detail
            ? `shell exited before bootstrap completed\nBootstrap output:\n${detail}`
            : "shell exited before bootstrap completed"
        }
        if (performance.now() >= deadline) {
          return detail
            ? `shell bootstrap timed out after ${timeout}ms\nBootstrap output:\n${detail}`
            : `shell bootstrap timed out after ${timeout}ms`
        }
        yield* Effect.sleep("10 millis")
      }
    })

    const createLaneCandidate = Effect.fnUntraced(function* (
      state: State,
      input: LaunchInput,
      laneID: number,
      generation: number,
      cwd: string,
      pluginEnv: Record<string, string>,
    ) {
      if (!persistentShellSupported(input.shell)) return "unsupported persistent shell protocol"
      if (
        process.platform === "linux" &&
        (process.getuid?.() !== process.geteuid?.() || process.getgid?.() !== process.getegid?.())
      ) {
        return "Linux unified exec requires matching real and effective user/group IDs for Bash -p startup"
      }
      const nonce = crypto.randomUUID().replaceAll("-", "")
      const tty = input.tty ?? false
      const extension = persistentShellExtension(input.shell)
      const environment = mergeEnvironment(input.env, pluginEnv)
      if (process.platform === "linux") {
        // -p blocks Bash's option/function inheritance. These overrides also keep
        // nested shells/history quiet and reset the separate compatibility selector.
        environment.BASH_ENV = ""
        environment.ENV = ""
        environment.HISTFILE = ""
        environment.BASH_COMPAT = ""
      }
      let tempDir: string | undefined
      let lane: Lane | undefined
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (extension === "cmd" && os.tmpdir().includes("%")) {
            return "could not prepare persistent shell: cmd temporary paths cannot contain percent signs"
          }
          const created = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-lane-"))).pipe(
            Effect.exit,
          )
          if (Exit.isFailure(created)) {
            const error = Cause.squash(created.cause)
            return `could not prepare persistent shell: ${error instanceof Error ? error.message : String(error)}`
          }
          tempDir = created.value
          const secured = yield* restore(
            process.platform === "win32" ? Effect.void : Effect.promise(() => chmod(tempDir!, 0o700)),
          ).pipe(Effect.exit)
          if (Exit.isFailure(secured)) {
            if (Cause.hasInterrupts(secured.cause)) return yield* Effect.failCause(secured.cause)
            const error = Cause.squash(secured.cause)
            return `could not secure persistent shell files: ${error instanceof Error ? error.message : String(error)}`
          }
          const runnerFile = path.join(tempDir, `runner.${extension}`)
          const bootstrapEnv = extension === "cmd" && tty ? `OPENCODE_CMD_BOOTSTRAP_${nonce.toUpperCase()}` : undefined
          if (bootstrapEnv) environment[bootstrapEnv] = `"${runnerFile.replaceAll('"', '""')}" --bootstrap`
          const args = persistentShellArgs(input.shell, tty, runnerFile, bootstrapEnv)
          const runner = yield* restore(
            Effect.promise((signal) =>
              writeFile(
                runnerFile,
                input.failLaneBootstrap ? "" : persistentShellRunnerScript(input.shell, { nonce, tty }),
                {
                  flag: "wx",
                  mode: 0o600,
                  signal,
                },
              ),
            ),
          ).pipe(Effect.exit)
          if (Exit.isFailure(runner)) {
            if (Cause.hasInterrupts(runner.cause)) return yield* Effect.failCause(runner.cause)
            const error = Cause.squash(runner.cause)
            return `could not prepare persistent shell: ${error instanceof Error ? error.message : String(error)}`
          }
          const spawn: Effect.Effect<PipeTransport | PtyTransport> = tty
            ? spawnPty({
                shell: input.shell,
                args,
                cwd,
                env: environment,
                location: state.location,
                title: `exec slot ${laneID}`,
              })
            : spawnPipe({ shell: input.shell, args, cwd, env: environment })
          // Keep startup masked until the transport is attached to a lane that the finalizer can release.
          const spawned = yield* spawn.pipe(Effect.exit)
          if (bootstrapEnv) delete environment[bootstrapEnv]
          if (Exit.isFailure(spawned)) {
            if (Cause.hasInterrupts(spawned.cause)) return yield* Effect.failCause(spawned.cause)
            const error = Cause.squash(spawned.cause)
            return `could not start persistent shell: ${error instanceof Error ? error.message : String(error)}`
          }
          const transport: PipeTransport | PtyTransport = spawned.value
          lane = {
            laneID,
            sessionID: input.invocation.sessionID,
            shell: input.shell,
            generation,
            pluginEnv: { ...pluginEnv },
            cwd,
            tty,
            state: "idle",
            transport,
            nonce,
            tempDir,
            runnerFile,
            bootstrap: {
              ready: false,
              output: "",
              transcriptMode: "text",
            },
            pending: "",
            commandStarted: false,
            stdinReleased: false,
            stdinPending: [],
            stdinClosePending: false,
            lastUsed: state.nextLaneUse++,
            resourcesReleased: false,
            releaseDone: Deferred.makeUnsafe<void>(),
            lock: Semaphore.makeUnsafe(1),
          }
          if (transport.type === "pipe") {
            yield* Stream.runForEach(Stream.decodeText(transport.handle.all), (chunk) =>
              consumeLaneOutput(state, lane!, chunk),
            ).pipe(
              Effect.catch((error) =>
                lane!.lock.withPermits(1)(
                  Effect.gen(function* () {
                    lane!.state = "lost"
                    const message = error instanceof Error ? error.message : String(error)
                    lane!.lostReason ??= message
                    const active = lane!.active
                    if (!active) return
                    yield* active.lock.withPermits(1)(
                      Effect.sync(() => {
                        if (lane!.pending && lane!.commandStarted) append(active, lane!.pending)
                        lane!.pending = ""
                        if (!active.terminationRequested) active.outputError = message
                        active.running = false
                        active.dirty = true
                      }),
                    )
                    lane!.active = undefined
                    lane!.commandStarted = false
                    lane!.stdinReleased = false
                    lane!.stdinPending = []
                    lane!.stdinClosePending = false
                  }),
                ),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Deferred.succeed(transport.outputDone, undefined).pipe(Effect.ignore)
                  if (lane!.resourcesReleased) return
                  lane!.state = "lost"
                  lane!.lostReason ??= "shell exited"
                  yield* state.laneLock
                    .withPermits(1)(cleanupLane(state, lane!))
                    .pipe(Effect.forkIn(scope, { startImmediately: true }))
                }),
              ),
              Effect.forkIn(transport.scope, { startImmediately: true }),
            )
          } else {
            yield* restore(attachPtyOutput(state, lane))
          }
          const bootstrap = persistentShellBootstrapRequest(input.shell, runnerFile, tty)
          if (bootstrap && !(yield* restore(writeLaneTransport(lane, [bootstrap], false)))) {
            lane.lostReason = "shell stdin is unavailable"
            return `could not initialize persistent shell: ${lane.lostReason}`
          }
          const bootstrapError = yield* restore(waitForBootstrap(state, lane, input.bootstrapTimeoutMs))
          if (bootstrapError) {
            lane.lostReason = bootstrapError
            return `could not initialize persistent shell: ${bootstrapError}`
          }
          const running =
            transport.type === "pipe"
              ? yield* restore(transport.handle.isRunning).pipe(Effect.catch(() => Effect.succeed(false)))
              : yield* restore(
                  pty(
                    transport.location,
                    Pty.Service.use((service) => service.get(transport.id)),
                  ),
                ).pipe(
                  Effect.map((info) => info.status === "running"),
                  Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
                )
          if (!running) {
            lane.lostReason = "shell exited during initialization"
            return `could not initialize persistent shell: ${lane.lostReason}`
          }
          return lane
        }).pipe(
          Effect.onExit((result) =>
            Exit.isSuccess(result) && typeof result.value !== "string"
              ? Effect.void
              : lane
                ? cleanupLane(state, lane)
                : tempDir
                  ? Effect.promise(() =>
                      rm(tempDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
                    ).pipe(Effect.catchCause(() => Effect.void))
                  : Effect.void,
          ),
        ),
      )
    })

    const launchLane = Effect.fn("ExecSession.launchLane")(function* (
      state: State,
      input: LaunchInput,
      started: number,
      launch: LaneLaunch,
    ) {
      const laneID = input.laneID ?? 0
      if (!Number.isInteger(laneID) || laneID < 0 || laneID >= MAX_LANES_PER_SESSION) {
        return failedLaunch(input.command, `invalid lane_id: ${laneID}`, started, { laneID })
      }
      if (!persistentShellSupported(input.shell)) {
        return failedLaunch(input.command, "unsupported persistent shell protocol", started, { laneID })
      }
      const preparation = yield* state.laneLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            state.archiveOperations.has(input.invocation.sessionID) ||
            state.stopOperations.has(input.invocation.sessionID)
          ) {
            return "this session changed while preparing the command"
          }
          const slot = slotsFor(state, input.invocation.sessionID)[laneID]
          if (slot !== launch.slot || launch.invalidatedReason) {
            return `lane slot ${laneID} queued command was invalidated because the session changed`
          }
          if (slot.preparation) return `lane slot ${laneID} is busy preparing a command`
          const current = slot.committed.type === "live" ? slot.committed.lane : undefined
          if (current?.active?.running || (current && current.state === "executing")) {
            return `lane slot ${laneID} is busy${current.active ? ` with execution ${current.active.execID}` : ""}`
          }
          if (current && current.shell !== input.shell && !input.resetLane) {
            return `lane slot ${laneID} configured shell changed; retry with reset_lane: true`
          }
          if (current && input.tty !== undefined && current.tty !== input.tty && !input.resetLane) {
            return `lane slot ${laneID} tty mode changed; retry with reset_lane: true`
          }
          const cwd =
            current && !input.resetLane && input.laneCwd === undefined ? current.cwd : (input.laneCwd ?? input.cwd)
          const pending: LanePreparation = {}
          slot.preparation = pending
          return {
            slot,
            current,
            cwd,
            pending,
            lostReason: slot.committed.type === "lost" && !input.resetLane ? slot.committed.reason : undefined,
          }
        }),
      )
      if (typeof preparation === "string") return failedLaunch(input.command, preparation, started, { laneID })

      let staged: Lane | undefined
      let files: string[] = []
      let activated = false
      return yield* Effect.acquireUseRelease(
        Effect.succeed(preparation),
        () =>
          Effect.gen(function* () {
            const prepared = yield* input.prepare(preparation.cwd)
            const pluginEnv = prepared.env ?? {}
            const reset = Boolean(input.resetLane)
            if (preparation.current && !reset && !sameEnvironment(preparation.current.pluginEnv, pluginEnv)) {
              return failedLaunch(
                input.command,
                `lane slot ${laneID} environment changed; the existing slot was preserved, retry with reset_lane: true`,
                started,
                { laneID },
              )
            }
            const generation = preparation.slot.generation + 1
            const created =
              reset || !preparation.current
                ? yield* state.spawnLock.withPermits(1)(
                    Effect.gen(function* () {
                      if (reset && preparation.current) yield* cleanupLane(state, preparation.current)
                      preparation.slot.committed = {
                        type: "lost",
                        reason: "shell generation replacement did not complete",
                      }
                      const candidate = yield* Effect.uninterruptibleMask((restore) =>
                        restore(createLaneCandidate(state, input, laneID, generation, preparation.cwd, pluginEnv)),
                      )
                      if (typeof candidate !== "string") preparation.pending.staged = candidate
                      return candidate
                    }),
                  )
                : preparation.current
            if (typeof created === "string") return failedLaunch(input.command, created, started, { laneID })
            if (!created)
              return failedLaunch(input.command, "could not initialize persistent shell", started, { laneID })
            staged = created

            const token = crypto.randomUUID()
            const extension = persistentShellExtension(input.shell)
            const commandFile = path.join(created.tempDir, `command-${token}.${extension}`)
            const statusFile = path.join(created.tempDir, `status-${token}.cwd`)
            files = [commandFile, statusFile]
            const written = yield* Effect.promise(async (signal) => {
              await writeFile(commandFile, prepared.script, { flag: "wx", mode: 0o600, signal })
              await writeFile(statusFile, "", { flag: "wx", mode: 0o600, signal })
            }).pipe(Effect.exit)
            if (Exit.isFailure(written)) {
              yield* cleanupLane(state, created)
              const error = Cause.squash(written.cause)
              return failedLaunch(
                input.command,
                `could not prepare lane command: ${error instanceof Error ? error.message : String(error)}`,
                started,
                { laneID },
              )
            }
            if (input.onLaneReserved) yield* input.onLaneReserved()

            const entry = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const registered = yield* state.laneLock.withPermits(1)(
                  Effect.gen(function* () {
                    if (
                      launch.invalidatedReason ||
                      state.archiveOperations.has(input.invocation.sessionID) ||
                      state.stopOperations.has(input.invocation.sessionID)
                    ) {
                      return `lane slot ${laneID} preparation was invalidated because the session changed`
                    }
                    if (preparation.slot.preparation !== preparation.pending)
                      return `lane slot ${laneID} preparation was invalidated`
                    if (
                      Array.from(state.executions.values()).filter((entry) => entry.running).length >=
                      MAX_RUNNING_EXECUTIONS
                    ) {
                      return `too many running executions (${MAX_RUNNING_EXECUTIONS}); terminate an existing execution before starting another`
                    }
                    const entry = makeEntry(state, input, performance.now(), {
                      id: state.nextExecID++,
                      lane: created,
                      reused: !reset && Boolean(preparation.current),
                      commandFile,
                      statusFile,
                    })
                    created.active = entry
                    created.lastUsed = state.nextLaneUse++
                    created.state = "executing"
                    created.commandStarted = false
                    created.stdinReleased = false
                    created.stdinPending = []
                    created.stdinClosePending = false
                    const request = persistentShellRequest(input.shell, {
                      executionID: entry.execID,
                      commandFile,
                      runnerFile: created.runnerFile,
                      statusFile,
                      nonce: created.nonce,
                      tty: created.tty,
                      cwd: input.laneCwd,
                    })
                    if (input.failLaneRequest || !(yield* writeLaneTransport(created, [request], false))) {
                      created.active = undefined
                      created.state = "lost"
                      created.lostReason = "shell stdin is unavailable"
                      return `lane slot ${laneID} stdin is unavailable`
                    }
                    preparation.slot.generation = created.generation
                    preparation.slot.committed = { type: "live", lane: created }
                    state.executions.set(entry.execID, entry)
                    preparation.slot.preparation = undefined
                    yield* Deferred.await(entry.startObserved).pipe(
                      Effect.andThen(releaseLaneStdin(entry)),
                      Effect.ignore,
                      Effect.forkIn(scope, { startImmediately: true }),
                    )
                    yield* watch(state, entry).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
                    return entry
                  }),
                )
                if (typeof registered === "string") return registered
                activated = true
                if (input.onExecutionStarted) yield* input.onExecutionStarted(registered.execID)
                return registered
              }),
            )
            if (typeof entry === "string") {
              if (created.state === "lost") yield* cleanupLane(state, created)
              return failedLaunch(input.command, entry, started, { laneID })
            }
            yield* updateCurrent(input.invocation, entry)
            const chunk = yield* collect(
              state,
              entry,
              input.invocation,
              started,
              input.yieldTimeMs,
              input.maxOutputTokens,
              false,
            )
            return preparation.lostReason
              ? {
                  ...chunk,
                  warning: `Lane slot ${laneID} was recreated because its previous shell state was lost (${preparation.lostReason}). The command ran in a new shell; previous cwd, environment variables, functions, modules, and activated environments were not preserved.`,
                }
              : chunk
          }),
        () =>
          Effect.gen(function* () {
            if (!activated) {
              yield* Effect.forEach(
                files,
                (file) => Effect.promise(() => Bun.file(file).delete()).pipe(Effect.catchCause(() => Effect.void)),
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              )
            }
            if (staged && !(preparation.slot.committed.type === "live" && preparation.slot.committed.lane === staged))
              yield* cleanupLane(state, staged)
            yield* state.laneLock.withPermits(1)(
              Effect.sync(() => {
                if (preparation.slot.preparation === preparation.pending) preparation.slot.preparation = undefined
              }),
            )
            yield* scheduleReaper(state)
          }),
      )
    })

    const launch: Interface["launch"] = Effect.fn("ExecSession.launch")(function* (input) {
      const started = performance.now()
      const state = yield* current()
      const laneID = input.laneID ?? 0
      if (!Number.isInteger(laneID) || laneID < 0 || laneID >= MAX_LANES_PER_SESSION) {
        return failedLaunch(input.command, `invalid lane_id: ${laneID}`, started, { laneID })
      }
      const lifecycleEpoch = yield* state.laneLock.withPermits(1)(
        Effect.sync(() => state.lifecycleEpochs.get(input.invocation.sessionID) ?? 0),
      )
      const session = yield* sessions
        .get(input.invocation.sessionID)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      if (!session) {
        return failedLaunch(input.command, "this session no longer exists", started, { laneID: input.laneID ?? 0 })
      }
      if (
        session.time.archived ||
        state.archiveOperations.has(input.invocation.sessionID) ||
        state.stopOperations.has(input.invocation.sessionID)
      ) {
        return failedLaunch(
          input.command,
          "this session is archived; unarchive it before running another command",
          started,
          {
            laneID: input.laneID ?? 0,
          },
        )
      }
      if (Array.from(state.executions.values()).filter((entry) => entry.running).length >= MAX_RUNNING_EXECUTIONS) {
        return failedLaunch(
          input.command,
          `too many running executions (${MAX_RUNNING_EXECUTIONS}); terminate an existing execution before starting another`,
          started,
        )
      }
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const invalidated = yield* Deferred.make<string>()
          const queued = yield* state.laneLock.withPermits(1)(
            Effect.sync(() => {
              if (
                (state.lifecycleEpochs.get(input.invocation.sessionID) ?? 0) !== lifecycleEpoch ||
                state.archiveOperations.has(input.invocation.sessionID) ||
                state.stopOperations.has(input.invocation.sessionID)
              ) {
                return "this session changed while queuing the command"
              }
              const slot = slotsFor(state, input.invocation.sessionID)[laneID]
              const launch: LaneLaunch = {
                slot,
                gate,
                invalidated,
                state: slot.activeLaunch ? "queued" : "active",
              }
              if (slot.activeLaunch) slot.launchQueue.push(launch)
              else slot.activeLaunch = launch
              return launch
            }),
          )
          if (typeof queued === "string") return failedLaunch(input.command, queued, started, { laneID })
          if (queued.state === "active") yield* Deferred.succeed(queued.gate, undefined).pipe(Effect.ignore)

          const invalidatedResult = Deferred.await(queued.invalidated).pipe(
            Effect.map((reason) => failedLaunch(input.command, reason, started, { laneID })),
          )
          const execute = Deferred.await(queued.gate).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                queued.invalidatedReason
                  ? Effect.succeed(failedLaunch(input.command, queued.invalidatedReason, started, { laneID }))
                  : launchLane(state, input, started, queued),
              ),
            ),
          )
          return yield* restore(Effect.raceFirst(execute, invalidatedResult)).pipe(
            Effect.ensuring(finishLaunch(state, queued)),
          )
        }),
      )
    })

    const write: Interface["write"] = Effect.fn("ExecSession.write")(function* (input) {
      const started = performance.now()
      const state = yield* current()
      const found = findEntry(state, input.execID, input.invocation)
      if (typeof found === "string") return unavailable(input.execID, found, started, input.invocation.display)
      const entry = found
      yield* refresh(state, entry)
      if ((input.chars || input.closeStdin) && !entry.running) {
        yield* updateOriginal(entry).pipe(Effect.ignore)
        return yield* failedAfterExit(entry, `execution ${entry.execID} has already exited`, started, input)
      }
      const chars = input.chars
      if (chars || input.closeStdin) {
        const laneTransport = entry.lane.transport
        if (input.closeStdin && laneTransport.type === "pty") {
          return failed(
            entry,
            `execution ${entry.execID} does not support closing stdin with tty enabled`,
            started,
            input.invocation.display,
          )
        }
        const wrote = yield* entry.lane.lock.withPermits(1)(
          Effect.gen(function* () {
            if (entry.lane.active !== entry || !entry.running) return false
            const chunk = chars ? new TextEncoder().encode(chars) : undefined
            if (!entry.lane.stdinReleased) {
              if (chunk) entry.lane.stdinPending.push(chunk)
              if (input.closeStdin) entry.lane.stdinClosePending = true
              return true
            }
            return yield* writeLaneTransport(entry.lane, chunk ? [chunk] : [], Boolean(input.closeStdin))
          }),
        )
        if (!wrote) {
          yield* refresh(state, entry)
          if (!entry.running) {
            yield* updateOriginal(entry).pipe(Effect.ignore)
            return yield* failedAfterExit(entry, `execution ${entry.execID} has already exited`, started, input)
          }
          return failed(
            entry,
            `execution ${entry.execID} stdin is no longer available`,
            started,
            input.invocation.display,
          )
        }
        yield* refresh(state, entry)
        yield* entry.lock.withPermits(1)(Effect.sync(() => appendInteraction(entry, "stdin")))
        yield* updateCurrent(input.invocation, entry)
        yield* updateOriginal(entry).pipe(Effect.ignore)
      }
      return yield* collect(state, entry, input.invocation, started, input.yieldTimeMs, input.maxOutputTokens, true)
    })

    const terminate: Interface["terminate"] = Effect.fn("ExecSession.terminate")(function* (input) {
      const started = performance.now()
      const state = yield* current()
      const found = findEntry(state, input.execID, input.invocation)
      if (typeof found === "string") return unavailable(input.execID, found, started, input.invocation.display)
      const entry = found
      yield* refresh(state, entry)
      if (entry.running) {
        const shouldKill = yield* requestTermination(entry, "execution terminated")
        if (shouldKill) {
          const killed = yield* killLaneTransport(entry.lane)
          if (!killed) {
            yield* refresh(state, entry)
            if (entry.running) {
              yield* updateOriginal(entry).pipe(Effect.ignore)
              return failed(
                entry,
                `execution ${entry.execID} could not be terminated`,
                started,
                input.invocation.display,
              )
            }
          }
          yield* updateOriginal(entry).pipe(Effect.ignore)
        }
      }
      return yield* collect(
        state,
        entry,
        input.invocation,
        started,
        input.yieldTimeMs ?? 500,
        input.maxOutputTokens,
        true,
      )
    })

    const stop: Interface["stop"] = Effect.fn("ExecSession.stop")(function* (targets) {
      const state = yield* current()
      const selected = new Set(targets.map((target) => target.sessionID))
      const tokens = new Map(Array.from(selected, (sessionID) => [sessionID, {}] as const))
      return yield* Effect.acquireUseRelease(
        state.laneLock.withPermits(1)(
          Effect.gen(function* () {
            const staged: Lane[] = []
            const invalidated: LaneLaunch[] = []
            for (const [sessionID, token] of tokens) {
              const operations = state.stopOperations.get(sessionID) ?? new Set()
              operations.add(token)
              state.stopOperations.set(sessionID, operations)
              state.lifecycleEpochs.set(sessionID, (state.lifecycleEpochs.get(sessionID) ?? 0) + 1)
              const slots = state.slots.get(sessionID)
              if (!slots) continue
              for (const [laneID, slot] of slots.entries()) {
                if (slot.preparation?.staged) staged.push(slot.preparation.staged)
                slot.preparation = undefined
                invalidated.push(...invalidateSlotLaunches(slot, laneID))
              }
            }
            yield* Effect.forEach(
              invalidated,
              (launch) => Deferred.succeed(launch.invalidated, launch.invalidatedReason!).pipe(Effect.ignore),
              { concurrency: "unbounded", discard: true },
            )
            return staged
          }),
        ),
        () =>
          Effect.gen(function* () {
            const entries = Array.from(state.executions.values()).filter((entry) => selected.has(entry.sessionID))
            const results = yield* Effect.forEach(
              entries,
              Effect.fnUntraced(function* (entry) {
                yield* refresh(state, entry)
                if (!entry.running) {
                  yield* updateOriginal(entry).pipe(Effect.ignore)
                  return "completed" as const
                }

                const shouldKill = yield* requestTermination(entry, "execution stopped")
                if (!shouldKill) {
                  yield* refresh(state, entry)
                  yield* updateOriginal(entry).pipe(Effect.ignore)
                  return entry.running ? ("failed" as const) : ("completed" as const)
                }
                yield* killLaneTransport(entry.lane)
                const deadline = performance.now() + 3_500
                while (entry.running && performance.now() < deadline) {
                  yield* Effect.sleep("50 millis")
                  yield* refresh(state, entry)
                }
                yield* updateOriginal(entry).pipe(Effect.ignore)
                return entry.running ? ("failed" as const) : ("terminated" as const)
              }),
              { concurrency: "unbounded" },
            )
            return {
              matched: results.filter((result) => result !== "completed").length,
              terminated: results.filter((result) => result === "terminated").length,
              failed: results.filter((result) => result === "failed").length,
            }
          }),
        (staged) =>
          state.laneLock.withPermits(1)(
            Effect.gen(function* () {
              const removed = Array.from(
                new Set([...liveLanes(state).filter((lane) => selected.has(lane.sessionID)), ...staged]),
              )
              for (const lane of removed) lane.lostReason = "session history stopped or changed"
              yield* Effect.forEach(removed, (lane) => cleanupLane(state, lane), {
                concurrency: "unbounded",
                discard: true,
              })
              for (const [sessionID, token] of tokens) {
                const operations = state.stopOperations.get(sessionID)
                operations?.delete(token)
                if (operations?.size === 0) state.stopOperations.delete(sessionID)
              }
            }),
          ),
      )
    })

    const collect = Effect.fn("ExecSession.collect")(function* (
      state: State,
      entry: Entry,
      invocation: Invocation,
      started: number,
      yieldTimeMs: number | undefined,
      maxOutputTokens: number | undefined,
      updateOriginalCard: boolean,
    ) {
      yield* waitForUpdates(state, entry, invocation, yieldTimeMs, updateOriginalCard)
      yield* refresh(state, entry)
      const output = yield* entry.lock.withPermits(1)(
        Effect.sync(() => {
          if (invocation.display === "root" && entry.running) entry.executionExposed = true
          return readModel(entry, maxOutputTokens)
        }),
      )
      yield* updateCurrent(invocation, entry)
      if (updateOriginalCard) yield* updateOriginal(entry).pipe(Effect.ignore)
      return {
        chunkID: crypto.randomUUID().slice(0, 8),
        command: entry.command,
        output: output.text,
        execID: entry.running ? entry.execID : undefined,
        running: entry.running,
        exitCode: entry.exitCode,
        truncated: output.truncated,
        wallTimeMs: performance.now() - started,
        metadata: metadata(entry, invocation.display),
      }
    })

    function readModel(entry: Entry, maxOutputTokens: number | undefined) {
      return readModelOutput(entry.modelOutput, entry.running, maxOutputTokens)
    }

    const refresh = Effect.fn("ExecSession.refresh")(function* (state: State, entry: Entry) {
      const lane = entry.lane
      if (lane.transport.type === "pty" && lane.transport.running && entry.running) {
        const changed = entry.dirty
        entry.dirty = false
        return changed
      }
      const status =
        lane.transport.type === "pipe"
          ? {
              running: yield* lane.transport.handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false))),
              exitCode: undefined as number | undefined,
              output: "",
              truncated: false,
            }
          : {
              running: lane.transport.running,
              exitCode: lane.transport.exitCode,
              output: "",
              truncated: false,
            }
      const exitCode = status.running
        ? undefined
        : lane.transport.type === "pipe"
          ? yield* Deferred.await(lane.transport.outputDone).pipe(
              Effect.andThen(
                lane.transport.handle.exitCode.pipe(
                  Effect.map(Number),
                  Effect.catch(() => Effect.succeed(undefined)),
                ),
              ),
            )
          : status.exitCode
      const changed = yield* lane.lock.withPermits(1)(
        entry.lock.withPermits(1)(
          Effect.gen(function* () {
            const before = stateKey(entry)
            if (!status.running && entry.running) {
              if (lane.pending && lane.commandStarted) append(entry, lane.pending)
              lane.pending = ""
              entry.running = false
              entry.exitCode = exitCode
              if (!entry.terminationRequested) {
                entry.outputError ??= lane.lostReason ?? "lane shell exited before command completion"
              }
              entry.dirty = true
              lane.state = "lost"
              lane.lostReason ??= entry.outputError
              lane.active = undefined
              lane.commandStarted = false
              lane.stdinReleased = false
              lane.stdinPending = []
              lane.stdinClosePending = false
            }
            const changed = entry.dirty || before !== stateKey(entry)
            entry.dirty = false
            if (!entry.running) yield* finalize(state, entry)
            return changed
          }),
        ),
      )
      if (lane.state === "lost" && !entry.running) {
        yield* state.laneLock.withPermits(1)(cleanupLane(state, lane))
      }
      return changed
    })

    const watch = Effect.fn("ExecSession.watch")(function* (state: State, entry: Entry) {
      while (entry.running) {
        yield* Effect.sleep(WATCH_INTERVAL)
        if (yield* refresh(state, entry)) yield* updateOriginal(entry).pipe(Effect.ignore)
      }
      yield* refresh(state, entry)
      yield* updateOriginal(entry).pipe(Effect.ignore)
    })

    const findOriginal = Effect.fn("ExecSession.findOriginal")(function* (entry: Entry) {
      if (!entry.callID) return undefined
      const message = Option.getOrUndefined(
        yield* sessions
          .findMessage(entry.sessionID, (message) => message.info.id === entry.messageID)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none()))),
      )
      const part = message?.parts.find(
        (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === entry.callID,
      )
      return part
    })

    const writeOriginal = Effect.fn("ExecSession.writeOriginal")(function* (entry: Entry) {
      const part = yield* findOriginal(entry)
      if (!part) return
      const current = yield* entry.lock.withPermits(1)(Effect.sync(() => metadata(entry, "root")))
      const updated = withMetadata(part, current)
      if (updated === part) return
      yield* sessions.updatePart(updated)
    })

    const updateOriginal = Effect.fn("ExecSession.updateOriginal")((entry: Entry) =>
      entry.originalLock.withPermits(1)(writeOriginal(entry)),
    )

    const commitOriginal: Interface["commitOriginal"] = Effect.fn("ExecSession.commitOriginal")(function* (input) {
      const state = yield* current()
      const entry = Array.from(state.executions.values()).find(
        (entry) =>
          entry.sessionID === input.sessionID && entry.messageID === input.messageID && entry.callID === input.callID,
      )
      if (!entry) return false
      return yield* entry.originalLock.withPermits(1)(
        Effect.gen(function* () {
          yield* refresh(state, entry)
          const part = yield* findOriginal(entry)
          if (!part) return false
          const current = yield* entry.lock.withPermits(1)(Effect.sync(() => metadata(entry, "root")))
          const updated = input.update(part, current)
          if (updated !== part) yield* sessions.updatePart(updated)
          return true
        }),
      )
    })

    function updateCurrent(invocation: Invocation, entry: Entry) {
      return invocation
        .metadata({ title: entry.command, metadata: metadata(entry, invocation.display) })
        .pipe(Effect.ignore)
    }

    const finalize = Effect.fnUntraced(function* (state: State, entry: Entry) {
      if (entry.finalized) return
      entry.finalized = true
      entry.durationMs = performance.now() - entry.started
      yield* cleanupEntryFiles(entry)
      state.exited.push(entry.execID)
      while (state.exited.length > MAX_RETAINED_EXECUTIONS) {
        const oldest = state.exited.shift()
        const entry = oldest === undefined ? undefined : state.executions.get(oldest)
        if (entry) yield* cleanupEntry(state, entry)
      }
    })

    const waitForUpdates = Effect.fn("ExecSession.waitForUpdates")(function* (
      state: State,
      entry: Entry,
      invocation: Invocation,
      yieldTimeMs: number | undefined,
      updateOriginalCard: boolean,
    ) {
      if (!entry.running) return
      const end = performance.now() + normalizeYieldTime(yieldTimeMs)
      while (performance.now() < end) {
        const remaining = end - performance.now()
        if (remaining <= 0) return
        yield* Effect.sleep(`${Math.max(1, Math.ceil(Math.min(WATCH_INTERVAL_MS, remaining)))} millis`)
        const changed = yield* refresh(state, entry)
        if (!entry.running) return
        if (!changed) continue
        yield* updateCurrent(invocation, entry)
        if (updateOriginalCard) yield* updateOriginal(entry).pipe(Effect.ignore)
      }
    })

    function append(entry: Entry, text: string) {
      const output = sanitizeTranscript(entry, text)
      appendModelOutput(entry.modelOutput, output)
      entry.dirty = true
      if (output.length >= UI_PREVIEW_LENGTH) {
        let start = output.length - UI_PREVIEW_LENGTH
        const first = output.charCodeAt(start)
        const previous = output.charCodeAt(start - 1)
        if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++
        entry.transcript = output.slice(start)
        entry.truncated = true
        return
      }
      const retained = entry.transcript.length + output.length - UI_PREVIEW_LENGTH
      if (retained <= 0) {
        entry.transcript += output
        return
      }
      let removed = retained
      const first = entry.transcript.charCodeAt(removed)
      const previous = entry.transcript.charCodeAt(removed - 1)
      if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) removed++
      entry.transcript = entry.transcript.slice(removed) + output
      entry.truncated = true
    }

    function appendInteraction(entry: Entry, type: Interaction["type"]) {
      entry.interactions.push({ type, time: Date.now() })
      if (entry.interactions.length > MAX_INTERACTIONS) entry.interactions.shift()
    }

    function stateKey(entry: Entry) {
      return `${entry.running}:${entry.exitCode}:${entry.outputError}:${entry.transcript.length}:${entry.truncated}`
    }

    function metadata(entry: Entry, execDisplay: Display, execError?: string): Metadata {
      return {
        command: entry.command,
        output: entry.transcript,
        interactions: [...entry.interactions],
        execID: entry.execID,
        laneID: entry.lane.laneID,
        shellGeneration: entry.lane.generation,
        shellReused: entry.shellReused,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.executionExposed ? { sessionExposed: true } : {}),
        startedAt: entry.startedAt,
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        processRunning: entry.running,
        exitCode: entry.exitCode,
        ...(entry.outputError ? { outputError: entry.outputError } : {}),
        truncated: entry.truncated,
        ...(entry.terminationRequested ? { terminationRequested: true } : {}),
        execDisplay,
        ...(execError ? { execError } : {}),
      }
    }

    function withMetadata(part: SessionV1.ToolPart, metadata: Metadata): SessionV1.ToolPart {
      if (part.state.status === "pending") return part
      if (part.state.status === "running") {
        return {
          ...part,
          state: {
            ...part.state,
            title: metadata.command,
            metadata: { ...part.state.metadata, ...metadata },
          },
        }
      }
      if (part.state.status === "completed") {
        return {
          ...part,
          state: {
            ...part.state,
            metadata: { ...part.state.metadata, ...metadata },
          },
        }
      }
      return {
        ...part,
        state: {
          ...part.state,
          metadata: { ...part.state.metadata, ...metadata },
        },
      }
    }

    function unavailable(id: number, error: string, started: number, execDisplay: Display): Chunk {
      const command = `execution ${id}`
      return {
        chunkID: crypto.randomUUID().slice(0, 8),
        command,
        output: error,
        running: false,
        truncated: false,
        wallTimeMs: performance.now() - started,
        error,
        metadata: {
          command,
          output: error,
          interactions: [],
          execID: id,
          processRunning: false,
          truncated: false,
          execDisplay,
          execError: error,
        },
      }
    }

    function failedLaunch(command: string, error: string, started: number, details?: Pick<Metadata, "laneID">): Chunk {
      return {
        chunkID: crypto.randomUUID().slice(0, 8),
        command,
        output: error,
        running: false,
        truncated: false,
        wallTimeMs: performance.now() - started,
        error,
        metadata: {
          command,
          output: error,
          interactions: [],
          ...details,
          processRunning: false,
          truncated: false,
          execDisplay: "root",
          execError: error,
        },
      }
    }

    function failed(entry: Entry, error: string, started: number, execDisplay: Display): Chunk {
      return {
        chunkID: crypto.randomUUID().slice(0, 8),
        command: entry.command,
        output: error,
        execID: entry.running ? entry.execID : undefined,
        running: entry.running,
        exitCode: entry.exitCode,
        truncated: entry.truncated,
        wallTimeMs: performance.now() - started,
        error,
        metadata: {
          ...metadata(entry, execDisplay),
          output: error,
          execError: error,
        },
      }
    }

    const failedAfterExit = Effect.fnUntraced(function* (
      entry: Entry,
      error: string,
      started: number,
      input: ContinueInput,
    ) {
      const output = yield* entry.lock.withPermits(1)(Effect.sync(() => readModel(entry, input.maxOutputTokens)))
      return {
        chunkID: crypto.randomUUID().slice(0, 8),
        command: entry.command,
        output: output.text ? `${error}\n\n${output.text}` : error,
        running: false,
        exitCode: entry.exitCode,
        truncated: output.truncated,
        wallTimeMs: performance.now() - started,
        error,
        metadata: {
          ...metadata(entry, input.invocation.display),
          output: error,
          execError: error,
        },
      }
    })

    return Service.of({ launch, write, terminate, stop, commitOriginal })
  }),
)

function normalizeYieldTime(value: number | undefined) {
  if (value === undefined) return DEFAULT_YIELD_TIME_MS
  return Math.max(0, Math.min(MAX_YIELD_TIME_MS, value))
}

function sameEnvironment(left: Record<string, string>, right: Record<string, string>) {
  const entries = (environment: Record<string, string>) => {
    const result = new Map<string, string>()
    for (const [key, value] of Object.entries(environment)) {
      result.set(process.platform === "win32" ? key.toUpperCase() : key, value)
    }
    return result
  }
  const expected = entries(left)
  const actual = entries(right)
  if (expected.size !== actual.size) return false
  for (const [key, value] of expected) {
    if (!actual.has(key) || actual.get(key) !== value) return false
  }
  return true
}

function mergeEnvironment(base: Record<string, string>, overlay: Record<string, string>) {
  if (process.platform !== "win32") return { ...base, ...overlay }
  const result: Record<string, string> = {}
  const names = new Map<string, string>()
  for (const [key, value] of [...Object.entries(base), ...Object.entries(overlay)]) {
    const normalized = key.toUpperCase()
    const existing = names.get(normalized)
    if (existing !== undefined) delete result[existing]
    result[key] = value
    names.set(normalized, key)
  }
  return result
}

function parseLaneCompletion(payload: string, cwd: string) {
  const exitCode = Number(payload)
  const physicalCwd = cwd.replace(/\r?\n$/, "")
  return Number.isInteger(exitCode) && physicalCwd && path.isAbsolute(physicalCwd)
    ? { exitCode, cwd: physicalCwd }
    : undefined
}

function withoutProtocolNewline(input: string) {
  if (input.endsWith("\r\n")) return input.slice(0, -2)
  if (input.endsWith("\r") || input.endsWith("\n")) return input.slice(0, -1)
  return input
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, EventV2Bridge.node, CrossSpawnSpawner.node, locationServiceMapNode],
})

export * as ExecSession from "./exec-session"
