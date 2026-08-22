import { Effect } from "effect"
import type { LocalDatabaseMigration } from "../local-migration"

export default {
  id: "0002_message_order_reconcile_once",
  reconcile: true,
  up() {
    return Effect.void
  },
} satisfies LocalDatabaseMigration.Migration
