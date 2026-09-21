import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  banMember,
  cancelSubscription,
  reissueInvite,
  resetExpiry,
  resetTier,
  saveMemberNotes,
  setMemberDownloads,
  setMemberTag,
  type InviteResult,
  type Member,
  type MemberTag,
  type PaidTier,
  type ResetExpiryResult,
  type SetDownloadsResult,
} from '@/lib/adminApi'
import { TIER_DOWNLOADS } from '@/lib/inviteRules'
import {
  memberKeys,
  patchMember,
  restoreMember,
  snapshotMember,
  type MemberSnapshot,
} from '@/lib/memberQueries'
import type { MemberActionRunners, PendingAction } from '@/pages/User/pendingAction'

type OptimisticArgs<TVariables, TData> = {
  email: string
  mutationFn: (variables: TVariables) => Promise<TData>
  /** The change to show at once, before the bridge has answered. */
  patch: (input: { row: Member; variables: TVariables }) => Member
  /** The bridge's canonical version of the same change, when it can differ. */
  settle?: (input: { row: Member; data: TData }) => Member
  /** Run once the bridge has confirmed, for a draft that can now be dropped. */
  onSettled?: () => void
  errorMessage: string
  onFailure: (message: string) => void
}

/**
 * A write the page shows before the bridge confirms it.
 *
 * Both caches are snapshotted on the way in and put back if the call fails, so
 * a rejected change never leaves the optimistic value on screen.
 */
const useOptimisticMemberMutation = <TVariables, TData>({
  email,
  mutationFn,
  patch,
  settle,
  onSettled = () => undefined,
  errorMessage,
  onFailure,
}: OptimisticArgs<TVariables, TData>) => {
  const queryClient = useQueryClient()
  return useMutation<TData, Error, TVariables, MemberSnapshot>({
    mutationFn,
    onMutate: (variables) => {
      const snapshot = snapshotMember({ queryClient, email })
      patchMember({ queryClient, email, patch: (row) => patch({ row, variables }) })
      return snapshot
    },
    onSuccess: (data) => {
      if (settle) {
        patchMember({ queryClient, email, patch: (row) => settle({ row, data }) })
      }
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
      onSettled()
    },
    onError: (_cause, _variables, context) => {
      if (context) {
        restoreMember({ queryClient, email, snapshot: context })
      }
      onFailure(errorMessage)
    },
  })
}

/**
 * Everything the member page can do to a member, plus the state those calls
 * leave behind: what is waiting on a confirmation, what went wrong, and the
 * notices an action came back with.
 *
 * A 401 is not handled here. The query client signs out on any of them, so no
 * call below repeats that guard.
 */
export const useMemberActions = ({ email }: { email: string }) => {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [cancelNotice, setCancelNotice] = useState<string | null>(null)
  const [banNotice, setBanNotice] = useState<string | null>(null)
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState<string | null>(null)

  const invite = useMutation({
    mutationFn: (tier: PaidTier) => reissueInvite({ email, tier }),
    onSuccess: (result, tier) => {
      setInviteResult(result)
      // Existing access survives the invite window now, so keep expiry and
      // servers as they are — only the tier, downloads, and the freshly
      // restarted grace clock change until the member redeems.
      patchMember({
        queryClient,
        email,
        patch: (row) => ({
          ...row,
          tier,
          downloads: TIER_DOWNLOADS[tier],
          invited_at: new Date().toISOString(),
        }),
      })
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
      setPending(null)
    },
    onError: () => {
      setPending(null)
      setActionError('Could not create invite.')
    },
  })

  const hardReset = useMutation({
    mutationFn: (tier: PaidTier) => resetTier({ email, tier }),
    onSuccess: (_result, tier) => {
      patchMember({
        queryClient,
        email,
        patch: (row) => ({ ...row, tier, downloads: TIER_DOWNLOADS[tier] }),
      })
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
    },
    onError: () => setActionError('Could not reset tier.'),
  })

  const expiry = useOptimisticMemberMutation<string, ResetExpiryResult>({
    email,
    mutationFn: (expiresAt) => resetExpiry({ email, expiresAt }),
    patch: ({ row, variables }) => ({ ...row, expires: variables, subscribed: true }),
    // Settle on the bridge's canonical value in case it normalized ours.
    settle: ({ row, data }) => ({ ...row, expires: data.expires }),
    onSettled: () => setExpiryDraft(null),
    errorMessage: 'Could not set expiry.',
    onFailure: setActionError,
  })

  const neverExpire = useOptimisticMemberMutation<void, ResetExpiryResult>({
    email,
    mutationFn: () => resetExpiry({ email }),
    // A cleared expiry reads back as "—": the bridge derives subscribed from
    // the expiry, so both flip together.
    patch: ({ row }) => ({ ...row, expires: null, subscribed: false }),
    onSettled: () => setExpiryDraft(null),
    errorMessage: 'Could not clear expiry.',
    onFailure: setActionError,
  })

  const downloads = useOptimisticMemberMutation<boolean, SetDownloadsResult>({
    email,
    mutationFn: (allow) => setMemberDownloads({ email, allow }),
    patch: ({ row, variables }) => ({ ...row, downloads: variables }),
    settle: ({ row, data }) => ({ ...row, downloads: data.downloads }),
    errorMessage: 'Could not toggle allow downloads for this user.',
    onFailure: setActionError,
  })

  const tag = useMutation({
    mutationFn: (next: MemberTag | null) => setMemberTag({ email, tag: next }),
    onSuccess: (result) => {
      patchMember({ queryClient, email, patch: (row) => ({ ...row, tag: result.tag }) })
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
    },
    onError: () => setActionError('Could not change the tag.'),
  })

  const cancelSub = useMutation({
    mutationFn: () => cancelSubscription({ email }),
    onSuccess: (result) => {
      setCancelNotice(
        result.cancel_at
          ? `Cancellation scheduled — access ends ${new Date(result.cancel_at).toLocaleString()}.`
          : 'Cancellation scheduled.',
      )
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
    },
    onError: () => setActionError('Could not cancel the subscription.'),
  })

  const ban = useMutation({
    mutationFn: () => banMember({ email }),
    onSuccess: (result) => {
      patchMember({ queryClient, email, patch: (row) => ({ ...row, tag: 'banned' }) })
      const records = `${result.disabled} server record${result.disabled === 1 ? '' : 's'} disabled`
      const billing = result.cancel_at
        ? `billing stops ${new Date(result.cancel_at).toLocaleDateString()}.`
        : 'no subscription to cancel.'
      setBanNotice(`Banned. ${records}; ${billing}`)
      void queryClient.invalidateQueries({ queryKey: memberKeys.events(email) })
    },
    onError: () => setActionError('Could not ban the member.'),
  })

  const notes = useMutation({
    mutationFn: (value: string) => saveMemberNotes({ email, notes: value }),
    onSuccess: (result) => {
      queryClient.setQueryData(memberKeys.notes(email), result)
      setNotesDraft(null)
    },
    onError: () => setActionError('Could not save notes.'),
  })

  const runners: MemberActionRunners = {
    invite: ({ tier }) => invite.mutate(tier),
    hardReset: ({ tier }) => hardReset.mutate(tier),
    expiry: ({ expiresAt }) => expiry.mutate(expiresAt),
    neverExpire: () => neverExpire.mutate(),
    cancelSub: () => cancelSub.mutate(),
    ban: () => ban.mutate(),
    downloads: ({ allow }) => downloads.mutate(allow),
  }

  return {
    invite,
    hardReset,
    expiry,
    neverExpire,
    downloads,
    tag,
    cancelSub,
    ban,
    notes,
    runners,
    pending,
    /** Put an action in front of the admin to confirm, on a clean error line. */
    stage: (action: PendingAction) => {
      setActionError(null)
      setPending(action)
    },
    clearPending: () => setPending(null),
    actionError,
    clearActionError: () => setActionError(null),
    inviteResult,
    clearInviteResult: () => setInviteResult(null),
    cancelNotice,
    banNotice,
    expiryDraft,
    setExpiryDraft,
    notesDraft,
    setNotesDraft,
  }
}

export type MemberActions = ReturnType<typeof useMemberActions>
