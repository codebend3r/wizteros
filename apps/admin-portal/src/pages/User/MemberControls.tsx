import { Fragment, useState } from 'react'
import { Spinner } from '@/components/Spinner/Spinner'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import { TierMenuButton } from '@/components/TierMenuButton/TierMenuButton'
import type { Member, MemberTag } from '@/lib/adminApi'
import { DAY_MS, parseTimestamp } from '@/lib/dates'
import { inviteActionLabel, PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import { deriveStatus, TAG_LABELS } from '@/lib/memberStatus'
import type { MemberActions } from '@/pages/User/useMemberActions'
import styles from '@/pages/User/MemberControls.module.scss'

type MemberControlsProps = {
  member: Member
  actions: MemberActions
  savedNotes: string
  notesPending: boolean
}

// The tags an admin can set by hand. `banned` is deliberately absent: it is
// the Ban section's business, not a label to toggle.
const TAG_OPTIONS: ReadonlyArray<{ tag: MemberTag | null; label: string }> = [
  { tag: 'vip', label: TAG_LABELS.vip },
  { tag: 'hvu', label: TAG_LABELS.hvu },
  { tag: null, label: 'Clear tag' },
]

const pad = (value: number): string => String(value).padStart(2, '0')

// The picker's seed: the given date (current expiry, else tomorrow) at one
// minute after midnight, in the local datetime-local format.
const toExpiryDraft = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:01`

/**
 * Everything an admin can do to the member they are looking at. Each control
 * stages its action for confirmation rather than firing it, except the tag
 * buttons, which are reversible in one click.
 */
export const MemberControls = ({
  member,
  actions,
  savedNotes,
  notesPending,
}: MemberControlsProps) => {
  // Frozen at mount: the untouched draft must not drift while the page sits open.
  const [defaultExpiry] = useState(() => new Date(Date.now() + DAY_MS))
  const expiryValue =
    actions.expiryDraft ?? toExpiryDraft(parseTimestamp(member.expires) ?? defaultExpiry)
  const expiryValid = !Number.isNaN(new Date(expiryValue).getTime())

  const notes = actions.notesDraft ?? savedNotes
  const notesDirty = notes !== savedNotes

  return (
    <>
      <div className={styles.actions}>
        <TierMenuButton
          label={inviteActionLabel({ status: deriveStatus({ member }) })}
          busy={actions.invite.isPending}
          onSelect={({ tier }) => {
            actions.clearInviteResult()
            actions.stage({ kind: 'invite', tier })
          }}
        />
      </div>
      <section className={styles.controlSection}>
        <h2 className={styles.sectionTitle}>Hard reset tier</h2>
        <p className={styles.controlHint}>
          Rewrites the recorded tier instantly — no new invite is sent.
        </p>
        <div className={styles.controlRow}>
          {PAID_TIERS.map((tier) => (
            <button
              key={tier}
              className={styles.controlButton}
              type="button"
              onClick={() => actions.stage({ kind: 'hardReset', tier })}
              disabled={actions.hardReset.isPending}
            >
              <TierIcon tier={tier} /> {TIER_LABELS[tier]}
            </button>
          ))}
          {actions.hardReset.isPending && <Spinner label="Resetting tier" />}
        </div>
      </section>
      <section className={styles.controlSection}>
        <h2 className={styles.sectionTitle}>Tag</h2>
        <p className={styles.controlHint}>A manual designation shown as the member's status</p>
        <div className={styles.controlRow}>
          {TAG_OPTIONS.map(({ tag, label }) => (
            <Fragment key={label}>
              <button
                className={styles.controlButton}
                type="button"
                onClick={() => {
                  actions.clearActionError()
                  actions.tag.mutate(tag)
                }}
                disabled={
                  actions.tag.isPending || (tag === null ? !member.tag : member.tag === tag)
                }
              >
                {label}
              </button>
              {actions.tag.isPending && actions.tag.variables === tag && (
                <Spinner label="Updating tag" />
              )}
            </Fragment>
          ))}
        </div>
      </section>
      <section className={styles.controlSection}>
        <h2 className={styles.sectionTitle}>Set expiry</h2>
        <form
          className={styles.controlRow}
          onSubmit={(event) => {
            event.preventDefault()
            actions.stage({ kind: 'expiry', expiresAt: new Date(expiryValue).toISOString() })
          }}
        >
          <input
            className={styles.expiryInput}
            type="datetime-local"
            value={expiryValue}
            aria-label="New expiry date and time"
            onChange={(event) => actions.setExpiryDraft(event.target.value)}
          />
          <button
            className={styles.controlButton}
            type="submit"
            disabled={!expiryValid || actions.expiry.isPending}
          >
            Set expiry
          </button>
          <button
            className={styles.dangerButton}
            type="button"
            onClick={() => actions.stage({ kind: 'neverExpire' })}
            disabled={actions.expiry.isPending || actions.neverExpire.isPending}
          >
            Never expire
          </button>
          {actions.neverExpire.isPending && <Spinner label="Clearing expiry" />}
        </form>
      </section>
      <section className={styles.controlSection}>
        <h2 className={styles.sectionTitle}>Subscription</h2>
        <p className={styles.controlHint}>
          Flags the member's Stripe subscription to cancel at the end of the billing period — access
          shuts off automatically when it lapses.
        </p>
        {!!actions.cancelNotice && <p className={styles.cancelNotice}>{actions.cancelNotice}</p>}
        <div className={styles.controlRow}>
          <button
            className={styles.dangerButton}
            type="button"
            onClick={() => actions.stage({ kind: 'cancelSub' })}
            disabled={actions.cancelSub.isPending}
          >
            {actions.cancelSub.isPending ? 'Cancelling…' : 'Cancel subscription'}
          </button>
        </div>
      </section>
      <section className={styles.controlSection}>
        <h2 className={styles.sectionTitle}>Ban</h2>
        <p className={styles.controlHint}>
          Disables every server record right now, stops their billing at the end of the period, and
          marks the address so the bridge never invites, extends, or restores it again. Clearing the
          tag lifts the ban; access comes back only with a fresh invite.
        </p>
        {!!actions.banNotice && (
          <p className={styles.cancelNotice} role="status">
            {actions.banNotice}
          </p>
        )}
        <div className={styles.controlRow}>
          <button
            className={styles.dangerButton}
            type="button"
            onClick={() => actions.stage({ kind: 'ban' })}
            disabled={actions.ban.isPending || member.tag === 'banned'}
          >
            {actions.ban.isPending ? 'Banning…' : 'Ban member'}
          </button>
        </div>
      </section>
      <section className={styles.notesSection}>
        <h2 className={styles.sectionTitle}>
          Notes
          {notesPending && <Spinner label="Loading notes" />}
        </h2>
        <textarea
          className={styles.notes}
          value={notes}
          placeholder="Notes about this member…"
          aria-label="Member notes"
          rows={6}
          disabled={notesPending}
          onChange={(event) => actions.setNotesDraft(event.target.value)}
        />
        <div className={styles.notesActions}>
          <button
            className={styles.notesSave}
            type="button"
            onClick={() => actions.notes.mutate(notes)}
            disabled={!notesDirty || actions.notes.isPending}
          >
            {actions.notes.isPending ? 'Saving…' : 'Save notes'}
          </button>
          {actions.notes.isSuccess && !notesDirty && (
            <span className={styles.notesSaved}>Saved ✓</span>
          )}
        </div>
      </section>
    </>
  )
}
