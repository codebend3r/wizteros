import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { InviteResultNotice } from '@/components/InviteResultNotice/InviteResultNotice'
import { MemberProblems } from '@/components/MemberProblems/MemberProblems'
import { Preloader } from '@/components/Preloader/Preloader'
import {
  fetchMember,
  fetchMemberEvents,
  fetchMemberNotes,
  fetchPlexAccess,
  type Member,
} from '@/lib/adminApi'
import { MEMBERS_QUERY_KEY, memberKeys } from '@/lib/memberQueries'
import { MemberControls } from '@/pages/User/MemberControls'
import { MemberDetails } from '@/pages/User/MemberDetails'
import { MemberHistory } from '@/pages/User/MemberHistory'
import { PendingActionModal } from '@/pages/User/PendingActionModal'
import { useMemberActions } from '@/pages/User/useMemberActions'
import styles from '@/pages/User/User.module.scss'

const DETAIL_STALE_MS = 5 * 60 * 1000

const UserInner = () => {
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''
  const actions = useMemberActions({ email })

  const {
    data: member,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: memberKeys.member(email),
    queryFn: () => fetchMember({ email }),
    enabled: !!email,
    staleTime: DETAIL_STALE_MS,
    // Seed from the /manage table so the detail page is instant when the
    // member list is already cached — /admin/member costs the same ~15s
    // Wizarr fan-out as the full list.
    initialData: () =>
      queryClient
        .getQueryData<Member[]>(MEMBERS_QUERY_KEY)
        ?.find((row) => row.email.toLowerCase() === email.toLowerCase()),
  })

  // Best-effort: a bridge without the endpoint (or plex.tv down) just leaves
  // the tier-derived fallback in place.
  const { data: plexAccess, isPending: plexChecking } = useQuery({
    queryKey: memberKeys.plexAccess(email),
    queryFn: () => fetchPlexAccess({ email }),
    enabled: !!email,
    staleTime: DETAIL_STALE_MS,
  })

  const { data: memberNotes, isPending: notesPending } = useQuery({
    queryKey: memberKeys.notes(email),
    queryFn: () => fetchMemberNotes({ email }),
    enabled: !!email,
    staleTime: DETAIL_STALE_MS,
  })

  const { data: memberEvents, isPending: eventsPending } = useQuery({
    queryKey: memberKeys.events(email),
    queryFn: () => fetchMemberEvents({ email }),
    enabled: !!email,
    staleTime: DETAIL_STALE_MS,
  })

  // What plex.tv says it is sharing, or null while that cannot be claimed
  // either way; the details panel is handed the answer rather than the inputs.
  const sharing = plexChecking ? null : (plexAccess?.servers ?? null)
  const error = !!loadError

  return (
    <AdminLayout>
      <main className={styles.page}>
        <Link className={styles.back} to="/manage">
          ← All members
        </Link>
        <h1 className={styles.title}>{member?.member ?? (email !== '' ? email : 'Member')}</h1>
        {!email && <p className={styles.notice}>No email provided.</p>}
        {error && <p className={styles.error}>Could not load member.</p>}
        {!!actions.actionError && <p className={styles.error}>{actions.actionError}</p>}
        {!!actions.inviteResult && <InviteResultNotice result={actions.inviteResult} />}
        {!!email && isPending && !error && (
          <Preloader message="Loading member… (this can take ~15s)" />
        )}
        {member === null && <p className={styles.notice}>No member found for {email}.</p>}
        {!!member && <MemberProblems member={member} />}
        {!!member && (
          <div className={styles.columns}>
            <MemberDetails
              member={member}
              sharing={sharing}
              checking={plexChecking}
              expiryUpdating={actions.expiry.isPending || actions.neverExpire.isPending}
              downloadsUpdating={actions.downloads.isPending}
              onToggleDownloads={() =>
                actions.stage({ kind: 'downloads', allow: !(member.downloads ?? false) })
              }
            />
            <div className={styles.controls}>
              <MemberControls
                member={member}
                actions={actions}
                savedNotes={memberNotes?.notes ?? ''}
                notesPending={notesPending}
              />
              <MemberHistory member={member} events={memberEvents ?? []} pending={eventsPending} />
            </div>
          </div>
        )}
        {!!member && !!actions.pending && (
          <PendingActionModal
            member={member}
            pending={actions.pending}
            actions={actions.runners}
            sending={actions.invite.isPending}
            onClose={actions.clearPending}
          />
        )}
      </main>
    </AdminLayout>
  )
}

export const User = () => (
  <AdminGate title="Westeroz — Member">
    <UserInner />
  </AdminGate>
)
