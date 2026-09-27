import { Stripe } from 'stripe'
import { describe, expect, it } from 'vitest'
import { isSignatureError, toSubscription, verifyWebhook } from '@/clients/stripe.js'

const SECRET = 'whsec_test_secret'

const signedPayload = (): Readonly<{ payload: Buffer; signature: string }> => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
  return {
    payload: Buffer.from(body),
    signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET }),
  }
}

/** The error `verifyWebhook` threw, or undefined when it returned. */
const thrownBy = (verify: () => void): unknown => {
  try {
    verify()
    return undefined
  } catch (error) {
    return error
  }
}

describe('toSubscription', () => {
  it('reads the fields the bridge uses off a subscription with a customer id', () => {
    expect(
      toSubscription({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: true,
        cancel_at: 1_790_000_000,
      }),
    ).toEqual({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: 1_790_000_000,
    })
  })

  it('takes the id of an expanded customer', () => {
    // an expanded (or deleted) customer arrives as an object, never the id
    const out = toSubscription({
      id: 'sub_2',
      customer: { id: 'cus_2' },
      status: 'past_due',
      cancel_at_period_end: false,
      cancel_at: null,
    })
    expect(out.customer).toBe('cus_2')
  })

  it('has a null cancel_at when no cancellation is scheduled', () => {
    const out = toSubscription({
      id: 'sub_3',
      customer: 'cus_3',
      status: 'canceled',
      cancel_at_period_end: false,
    })
    expect(out.cancel_at).toBeNull()
  })
})

describe('verifyWebhook', () => {
  it('accepts a payload signed with the secret', () => {
    const { payload, signature } = signedPayload()
    expect(() => verifyWebhook({ payload, signature, secret: SECRET })).not.toThrow()
  })

  it('rejects a tampered payload', () => {
    const { signature } = signedPayload()
    const tampered = Buffer.from(JSON.stringify({ id: 'evt_2', type: 'forged' }))
    const error = thrownBy(() => verifyWebhook({ payload: tampered, signature, secret: SECRET }))
    expect(isSignatureError(error)).toBe(true)
  })

  it('rejects a payload signed with a different secret', () => {
    const { payload, signature } = signedPayload()
    const error = thrownBy(() => verifyWebhook({ payload, signature, secret: 'whsec_other' }))
    expect(isSignatureError(error)).toBe(true)
  })

  it('rejects a missing signature', () => {
    const { payload } = signedPayload()
    const error = thrownBy(() => verifyWebhook({ payload, signature: null, secret: SECRET }))
    expect(isSignatureError(error)).toBe(true)
  })

  it('rejects a correctly signed payload that is not JSON', () => {
    // Python caught this as ValueError alongside the signature error
    const body = 'not json'
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET })
    const error = thrownBy(() =>
      verifyWebhook({ payload: Buffer.from(body), signature, secret: SECRET }),
    )
    expect(isSignatureError(error)).toBe(true)
  })

  it('does not claim an unrelated error', () => {
    expect(isSignatureError(new Error('database is locked'))).toBe(false)
  })
})
