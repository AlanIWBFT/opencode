export * as SessionNativeIdentity from "./native-identity.js"

import { Provider } from "@opencode/schema/provider"
import type { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Hash } from "@opencode/util/hash"
import type { SessionRunnerModel } from "./runner/model.js"

/** Local replay policy only; native windows keep the upstream wire/storage shape. */
export const metadataKey = "openchamberNativeIdentity"
export interface Provenance extends Schema.Schema.Type<typeof Provenance> {}
export const Provenance = Schema.Struct({
  providerID: Provider.ID,
  provider: Schema.String,
  modelID: Schema.String,
  route: Schema.String,
  protocol: Schema.String,
  endpoint: Schema.String,
})
const decode = Schema.decodeUnknownOption(Provenance)
export type Target = Model.Ref & { readonly identity?: Provenance }
export const target = (resolved: Pick<SessionRunnerModel.Resolved, "model" | "ref">): Target => ({
  ...resolved.ref,
  identity: provenance(resolved),
})
export const read = (native: Readonly<Record<string, unknown>> | undefined) =>
  Option.getOrUndefined(decode(native?.[metadataKey]))

/** V1 did not store an endpoint; bind once when the selected model's configuration is available. */
export const legacyEndpoint = "legacy-openai-v1:unbound"

/** No guessed endpoints. Dynamic URL builders cannot establish a durable deployment identity here. */
export function provenance(resolved: Pick<SessionRunnerModel.Resolved, "model" | "ref">): Provenance | undefined {
  const model = resolved.model
  const endpoint = model.route.endpoint
  if (!endpoint.baseURL || typeof endpoint.path !== "string") return undefined
  return {
    providerID: resolved.ref.providerID,
    provider: model.provider,
    modelID: model.id,
    route: model.route.id,
    protocol: model.route.protocol,
    endpoint: Hash.sha256(
      JSON.stringify([
        endpoint.baseURL,
        endpoint.path,
        Object.entries(endpoint.query ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      ]),
    ),
  }
}

/** OpenAI Responses checkpoints can cross models within the same configured deployment. */
export const replayIdentity = (value: Provenance) => {
  if (value.provider !== "openai" || value.protocol !== "openai-responses") return value
  const { modelID: _, ...identity } = value
  return identity
}

export const compatible = (source: Provenance | undefined, target: Provenance | undefined) =>
  source !== undefined && target !== undefined && isDeepStrictEqual(replayIdentity(source), replayIdentity(target))
