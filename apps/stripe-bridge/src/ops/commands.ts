import type { ReadOnlyStore } from '@/store/openStore.js'

// What `dist/opsCli.js` answers. The skill scripts run it inside the bridge
// container over ssh rather than copying bridge.db off the NAS or reading it
// with SQL of their own, so they see the store exactly as the bridge does
// (its tie-break between rows, its tier aliases, its tag guard) and never
// touch the file. Every command is a read; there is no command that writes.

export const USAGE = [
  'usage: node dist/opsCli.js <command>',
  '  baselines        every baseline invite the bridge minted',
  '  customers        every customer row, one per email, and every member tag',
  '  member <email>   one address: its customer row and ids, tag, downloads override, last events',
].join('\n')

/** How many of a member's events the dossier shows. */
const MEMBER_EVENTS = 12

export type OpsAnswer = Readonly<{ ok: true; output: unknown }> | Readonly<{ ok: false }>

/** Answer one command against the store, or say it is not one. */
export const runOpsCommand = ({
  args,
  store,
}: {
  args: readonly string[]
  store: ReadOnlyStore
}): OpsAnswer => {
  const [command, email, ...extra] = args
  if (extra.length > 0) {
    return { ok: false }
  }
  if (command === 'baselines' && email === undefined) {
    return { ok: true, output: { baselines: store.allBaselineInvites() } }
  }
  if (command === 'customers' && email === undefined) {
    return {
      ok: true,
      output: {
        customers: [...store.allCustomerRows()].map(([address, row]) => ({
          email: address,
          ...row,
        })),
        tags: [...store.allMemberTags()].map(([address, tag]) => ({ email: address, tag })),
      },
    }
  }
  if (command === 'member' && !!email?.includes('@')) {
    return {
      ok: true,
      output: {
        email: email.toLowerCase(),
        customer: store.customerRow({ email }),
        customer_ids: store.customerIdsForEmail({ email }),
        tag: store.getMemberTag({ email }),
        downloads: store.getMemberDownloads({ email }),
        events: store.eventsForEmail({ email, limit: MEMBER_EVENTS }),
      },
    }
  }
  return { ok: false }
}
