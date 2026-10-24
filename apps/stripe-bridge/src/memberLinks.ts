// Manual identity links form stars: many billing addresses may point at one
// Plex address, but no address may be both a payer and a destination.

/** Why the proposed link is invalid, or null when it preserves that model. */
export const memberLinkConflict = ({
  links,
  stripeEmail,
  plexEmail,
}: {
  links: ReadonlyMap<string, string>
  stripeEmail: string
  plexEmail: string | null
}): string | null => {
  // Unlinking must always be possible, including repairing old invalid data.
  if (plexEmail === null) return null
  if (stripeEmail === plexEmail) return 'an address cannot link to itself'
  const proposed = new Map([...links, [stripeEmail, plexEmail]])
  const chain = [...proposed].find(([, destination]) => proposed.has(destination))
  if (!chain) return null
  const [, destination] = chain
  return `${destination} already pays under ${proposed.get(destination) ?? ''}; unlink it first`
}
