import type { LocalDatabaseMigration } from "./local-migration"
import messageOrder from "./local-migration/0001_message_order"
import reconcileMessageOrderOnce from "./local-migration/0002_message_order_reconcile_once"

export const migrations = [messageOrder, reconcileMessageOrderOnce] satisfies LocalDatabaseMigration.Migration[]
