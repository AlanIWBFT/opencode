import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ExecSessionControl } from "@opencode/core/tool/exec-session/control"
import { ConflictError } from "@opencode/protocol/errors"
import { Effect, Option, RcMap } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef } from "../location"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  Effect.gen(function* () {
    const control = yield* ExecSessionControl.Service
    return handlers
      .handle(
        "debug.location",
        Effect.fn(function* () {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          return Array.from(yield* RcMap.keys(locations.rcMap))
        }),
      )
      .handle(
        "debug.location.evict",
        Effect.fn(function* (ctx) {
          const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
          // Resolve through requestRef so the key matches the shape the location
          // middleware cached the services under.
          const ref = requestRef(ctx.request)
          if (ctx.query.preserveExec) {
            if (!(yield* control.releaseLocation(ref, locations.invalidate(ref))))
              return yield* new ConflictError({
                message: "Persistent command slots still use this location",
                resource: "exec",
              })
            return
          }
          yield* locations.invalidate(ref)
        }),
      )
  }),
)
