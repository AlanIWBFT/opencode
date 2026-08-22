import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode database tools", () => {
  cliIt.live(
    "checks message order consistency",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "check-message-order"])
        opencode.expectExit(result, 0, "db check-message-order")
        expect(result.stdout).toContain("Message order is consistent")
      }),
    60_000,
  )

  cliIt.live(
    "repairs message order consistency",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["db", "repair-message-order"])
        opencode.expectExit(result, 0, "db repair-message-order")
        expect(result.stdout).toContain("Message order repaired")
      }),
    60_000,
  )
})
