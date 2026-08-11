import { Message } from "@opencode/ai"
import { OpenAI } from "@opencode/ai/providers"
import { ResponsesCompaction } from "@opencode/ai/protocols/utils/responses-compaction"
import { Provider } from "@opencode/schema/provider"
import { Schema } from "effect"
import { SessionProviderContext } from "../session/provider-context.js"
import type { SessionV1 } from "@opencode/schema/session-v1"

const Metadata = Schema.Struct({
  openaiNativeCompactionLock: Schema.Struct({
    version: Schema.Literal(1),
    strategy: Schema.Literal("openai-responses-compact"),
    model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  }),
  openaiNativeCompactionWindow: Schema.Struct({
    version: Schema.Literals([1, 2]),
    output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
})

/** Convert the saved replay window, never its UI placeholder, into the official canonical representation. */
export function legacyNativeCheckpoint(parts: readonly (typeof SessionV1.Part.Type)[]) {
  const part = parts.find((part) => part.type === "text" && part.metadata?.openaiNativeCompactionWindow !== undefined)
  if (!part || part.type !== "text") return undefined
  const metadata = Schema.decodeUnknownSync(Metadata)(part.metadata)
  const source = metadata.openaiNativeCompactionLock.model
  const model = OpenAI.responses(source.modelID)
  const output = Schema.decodeUnknownSync(ResponsesCompaction.Response.fields.output)(
    metadata.openaiNativeCompactionWindow.output.map((item) =>
      item.role && !item.type ? { ...item, type: "message" } : item,
    ),
  )
  if (!output.some((item) => item.type === "compaction"))
    throw new Error("Legacy OpenAI checkpoint has no encrypted compaction item")
  return SessionProviderContext.encode(
    {
      providerID: Provider.ID.make(source.providerID),
      provider: "openai",
      modelID: source.modelID,
      route: model.route.id,
      protocol: model.route.protocol,
      endpoint: SessionProviderContext.legacyEndpoint,
    },
    output.map((item): Message => ResponsesCompaction.toMessage(item, model)),
  )
}
