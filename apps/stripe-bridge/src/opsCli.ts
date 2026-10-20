import { mapDbPath } from '@/config.js'
import { runOpsCommand, USAGE } from '@/ops/commands.js'
import { openReadOnlyStore } from '@/store/openStore.js'

// The bridge store, read-only, for the operator's skill scripts:
//
//   sudo docker exec stripe-bridge node dist/opsCli.js member someone@example.com
//
// Runs beside the live server in the same container and reads the same file
// (MAP_DB_PATH), over connections SQLite itself refuses to write through. It
// prints one JSON document and exits; it never starts the app.

try {
  const answer = runOpsCommand({
    args: process.argv.slice(2),
    store: openReadOnlyStore(mapDbPath()),
  })
  if (answer.ok) {
    process.stdout.write(`${JSON.stringify(answer.output)}\n`)
  } else {
    console.error(USAGE)
    process.exitCode = 2
  }
} catch (error) {
  // One line, not a stack: the caller is a script reading stderr over ssh.
  console.error(`opsCli: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
