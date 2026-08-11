import type { LocalDatabaseMigration } from "./local-migration"
import messageOrder from "./local-migration/0001_message_order"

export const migrations = [messageOrder] satisfies LocalDatabaseMigration.Migration[]
