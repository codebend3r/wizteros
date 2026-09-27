import { describe, expect, it } from 'vitest'
import { renderInviteEmail } from '@/clients/emailTemplate.js'

describe('renderInviteEmail', () => {
  it('contains the invite url and expiry', () => {
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 7 })
    expect(html).toContain('href="http://inv.test/j/abc"')
    expect(html).toContain('http://inv.test/j/abc')
    expect(html).toContain('7 days')
  })

  it('carries the brand and the call to action', () => {
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 7 })
    expect(html).toContain('WESTEROZ')
    expect(html).toContain('Set up your account')
  })

  it('keeps the infrastructure framing copy', () => {
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 7 })
    expect(html).toContain('server costs')
    expect(html).toContain('access will be removed')
  })

  it('tells new members to reuse their checkout email', () => {
    // Brand-new members create their Plex account at redemption, and every
    // bridge join (expiry stamping, renewal, cancel, the admin roster) keys on
    // the email, so the invite email must steer them to sign up with the same
    // address it was delivered to.
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 7 })
    expect(html).toContain('Plex account')
    expect(html).toContain('same email address')
  })

  it('uses inline styles only', () => {
    // Gmail strips <style> blocks in some contexts; everything must be inline.
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 7 })
    expect(html).not.toContain('<style')
    expect(html).not.toContain('src="http') // no external assets
  })

  it('interpolates the expiry days', () => {
    const html = renderInviteEmail({ inviteUrl: 'http://inv.test/j/abc', expiresDays: 14 })
    expect(html).toContain('14 days')
    expect(html).not.toContain('7 days')
  })
})
