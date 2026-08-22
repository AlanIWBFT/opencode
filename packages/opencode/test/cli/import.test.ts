import { test, expect } from "bun:test"
import {
  formatImportFileError,
  parseShareUrl,
  persistImportedSession,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, PlatformError } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LocalMessageOrder } from "@opencode-ai/core/database/local-message-order"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"

const dbIt = testEffect(LayerNode.compile(Database.node))

const sessionRow = (id: SessionSchema.ID) => ({
  id,
  project_id: ProjectV2.ID.global,
  slug: id,
  directory: "/project",
  title: "import test",
  version: "test",
})

const seedProject = Effect.fnUntraced(function* (db: Database.Interface["db"]) {
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

dbIt.effect("repairs partial order sidecars atomically and idempotently", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* seedProject(db)
    const sessionID = SessionSchema.ID.make("ses_import_atomic")
    const userID = SessionV1.MessageID.make("msg_import_user")
    const assistantID = SessionV1.MessageID.make("msg_import_assistant")
    const userPartID = SessionV1.PartID.make("prt_import_user")
    const assistantPartID = SessionV1.PartID.make("prt_import_assistant")
    const imported = [
      {
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          parentID: userID,
          time: { created: 2 },
          modelID: "model",
          providerID: "provider",
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: assistantPartID,
            sessionID,
            messageID: assistantID,
            type: "text",
            text: "answer",
          },
        ],
      },
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ id: userPartID, sessionID, messageID: userID, type: "text", text: "question" }],
      },
    ]

    yield* persistImportedSession(db, sessionRow(sessionID), imported as any)
    yield* db
      .delete(LocalMessageOrder.MessageOrderTable)
      .where(eq(LocalMessageOrder.MessageOrderTable.message_id, userID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(LocalMessageOrder.PartOrderTable)
      .where(eq(LocalMessageOrder.PartOrderTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(LocalMessageOrder.SessionOrderTable)
      .where(eq(LocalMessageOrder.SessionOrderTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* persistImportedSession(db, sessionRow(sessionID), imported as any)
    yield* persistImportedSession(db, sessionRow(sessionID), imported as any)

    const messages = yield* db
      .select({ id: MessageTable.id, seq: LocalMessageOrder.MessageOrderTable.seq })
      .from(MessageTable)
      .innerJoin(
        LocalMessageOrder.MessageOrderTable,
        eq(LocalMessageOrder.MessageOrderTable.message_id, MessageTable.id),
      )
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(asc(LocalMessageOrder.MessageOrderTable.seq))
      .all()
      .pipe(Effect.orDie)
    const parts = yield* db
      .select({ id: PartTable.id, seq: LocalMessageOrder.PartOrderTable.seq })
      .from(PartTable)
      .innerJoin(LocalMessageOrder.PartOrderTable, eq(LocalMessageOrder.PartOrderTable.part_id, PartTable.id))
      .where(eq(PartTable.session_id, sessionID))
      .orderBy(asc(LocalMessageOrder.PartOrderTable.seq))
      .all()
      .pipe(Effect.orDie)
    const order = yield* db
      .select()
      .from(LocalMessageOrder.SessionOrderTable)
      .where(eq(LocalMessageOrder.SessionOrderTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)

    expect(messages).toEqual([
      { id: userID, seq: 2 },
      { id: assistantID, seq: 3 },
    ])
    expect(parts).toEqual([
      { id: assistantPartID, seq: 0 },
      { id: userPartID, seq: 1 },
    ])
    expect(order).toEqual({ session_id: sessionID, message_seq: 4, part_seq: 2 })
  }),
)

dbIt.effect("rejects an assistant whose parent sidecar belongs to another session", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* seedProject(db)
    const sessionID = SessionSchema.ID.make("ses_import_parent_order")
    const otherSessionID = SessionSchema.ID.make("ses_import_parent_order_other")
    const userID = SessionV1.MessageID.make("msg_import_parent_order_user")
    const assistantID = SessionV1.MessageID.make("msg_import_parent_order_assistant")
    yield* persistImportedSession(db, sessionRow(sessionID), [
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [],
      },
    ] as any)
    yield* db
      .update(LocalMessageOrder.MessageOrderTable)
      .set({ session_id: otherSessionID })
      .where(eq(LocalMessageOrder.MessageOrderTable.message_id, userID))
      .run()
      .pipe(Effect.orDie)

    const exit = yield* persistImportedSession(db, sessionRow(sessionID), [
      {
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          parentID: userID,
          time: { created: 2 },
          modelID: "model",
          providerID: "provider",
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ] as any).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      yield* db.select().from(MessageTable).where(eq(MessageTable.id, assistantID)).get().pipe(Effect.orDie),
    ).toBeUndefined()
  }),
)

dbIt.effect("rolls back the entire import when a sidecar write fails", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* seedProject(db)
    const sessionID = SessionSchema.ID.make("ses_import_rollback")
    const messageID = SessionV1.MessageID.make("msg_import_rollback")
    const partID = SessionV1.PartID.make("prt_import_rollback")
    yield* db
      .run(
        `
        CREATE TRIGGER fail_import_part_order
        BEFORE INSERT ON local_part_order
        WHEN NEW.part_id = '${partID}'
        BEGIN
          SELECT RAISE(ABORT, 'forced import failure');
        END
      `,
      )
      .pipe(Effect.orDie)

    const exit = yield* persistImportedSession(db, sessionRow(sessionID), [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ id: partID, sessionID, messageID, type: "text", text: "rollback" }],
      },
    ] as any).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
    ).toBeUndefined()
    expect(
      yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get().pipe(Effect.orDie),
    ).toBeUndefined()
    expect(yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)).toBeUndefined()
    expect(
      yield* db
        .select()
        .from(LocalMessageOrder.SessionOrderTable)
        .where(eq(LocalMessageOrder.SessionOrderTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ).toBeUndefined()
  }),
)

dbIt.effect("rejects inconsistent part ownership before writing the session", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* seedProject(db)
    const sessionID = SessionSchema.ID.make("ses_import_invalid")
    const messageID = SessionV1.MessageID.make("msg_import_invalid")
    const exit = yield* persistImportedSession(db, sessionRow(sessionID), [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        parts: [
          {
            id: SessionV1.PartID.make("prt_import_invalid"),
            sessionID,
            messageID: SessionV1.MessageID.make("msg_other"),
            type: "text",
            text: "invalid",
          },
        ],
      },
    ] as any).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
    ).toBeUndefined()
  }),
)
