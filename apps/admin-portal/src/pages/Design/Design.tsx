import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import { PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import { STATUS_EMOJI, type MemberStatus } from '@/lib/memberStatus'
import styles from '@/pages/Design/Design.module.scss'

// The in-app design reference. Every token is the real declaration from
// styles/globals.scss and every component spec is lifted from the module
// stylesheet that owns it. Rows carry IN CODE when they document what ships
// and PROPOSED when they are an addition, so this page cannot quietly become
// a false source of truth.

const SECTIONS = [
  { id: 'color', label: 'Color' },
  { id: 'type', label: 'Type' },
  { id: 'space', label: 'Space & radius' },
  { id: 'tier-icon', label: 'Tier icon' },
  { id: 'status', label: 'Status & tags' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'table', label: 'Table' },
  { id: 'pills', label: 'Library pills' },
  { id: 'rules', label: 'Rules' },
] as const

type Swatch = { token: string; value: string; use: string }

const SURFACE_TOKENS: ReadonlyArray<Swatch> = [
  { token: '--color-bg', value: '#243158', use: 'page + sticky cells' },
  { token: '--color-surface', value: '#2c3a66', use: 'cards, inputs, menus' },
  { token: '--color-border', value: '#3d4b7c', use: 'every 1px border' },
  { token: '--color-text', value: '#f4ead6', use: 'body text' },
  { token: '--color-muted', value: '#aab4d4', use: 'labels, secondary' },
  { token: '--color-accent-text', value: '#241a05', use: 'text on amber' },
]

const ACCENT_TOKENS: ReadonlyArray<Swatch> = [
  { token: '--color-accent', value: '#f7b32b', use: 'links, subscribed' },
  { token: '--color-bronze', value: '#cf9a66', use: 'bronze' },
  { token: '--color-silver', value: '#c3c8d4', use: 'silver' },
  { token: '--color-gold', value: '#ffcf5c', use: 'gold + link hover' },
  { token: '--color-youth', value: '#f0a3a3', use: 'youth + error text' },
]

const STATE_TOKENS: ReadonlyArray<Swatch> = [
  { token: '--color-state-shared', value: '#9ed4a4', use: 'entitled and shared' },
  { token: '--color-state-not-shared', value: '#f7b32b', use: 'entitled, not shared' },
  { token: '--color-state-not-entitled', value: '#e69a9a', use: 'shared, not entitled' },
]

const TYPE_FAMILIES = [
  { token: '--font-display', family: 'Bricolage Grotesque', sample: 'Members' },
  {
    token: '--font-body',
    family: 'Instrument Sans',
    sample: 'Rewrites the recorded tier instantly; no new invite is sent.',
  },
  { token: '--font-mono', family: 'JetBrains Mono', sample: 'amolsharma@me.com · 4 / 28' },
  { token: '--font-pixel', family: 'Silkscreen', sample: 'PRICING EYEBROWS ONLY' },
  { token: '--font-brand', family: 'Lily Script One', sample: 'Westeroz' },
] as const

const TYPE_SIZES = [
  { token: '--font-size-hero', note: 'clamp 2.5rem to 4rem', sampleSize: 'hero' },
  { token: '--font-size-xl', note: '2.25rem / 36px', sampleSize: 'xl' },
  { token: '--font-size-lg', note: '1.25rem / 20px', sampleSize: 'lg' },
  { token: '--font-size-md', note: '1rem / 16px', sampleSize: 'md' },
  { token: '--font-size-sm', note: '0.875rem / 14px', sampleSize: 'sm' },
  { token: '--font-size-xs', note: '0.75rem / 12px', sampleSize: 'xs' },
] as const

const SPACE_STEPS = [
  { token: 'space-1', width: '0.5rem', note: '0.5rem · cell padding, icon gaps' },
  { token: 'space-2', width: '1rem', note: '1rem · default gap' },
  { token: 'space-3', width: '1.5rem', note: '1.5rem · page gap' },
  { token: 'space-4', width: '2rem', note: '2rem · page padding' },
  { token: 'space-6', width: '3rem', note: '3rem' },
  { token: 'space-8', width: '5rem', note: '5rem · section breaks' },
] as const

type SpecimenRow = {
  member: string
  email: string
  tier: 'bronze' | null
  emoji: string
  status: string
  subscribed: boolean
  action: string
}

const SPECIMEN_ROWS: ReadonlyArray<SpecimenRow> = [
  {
    member: 'amols7',
    email: 'amolsharma@me.com',
    tier: 'bronze',
    emoji: '🟢',
    status: 'Subscribed',
    subscribed: true,
    action: 'Re-invite',
  },
  {
    member: '809lenny',
    email: '809lenny@gmail.com',
    tier: null,
    emoji: '⚪',
    status: 'Uninvited',
    subscribed: false,
    action: 'Invite',
  },
]

const STATUSES: ReadonlyArray<MemberStatus> = [
  'Subscribed Monthly',
  'Expired Member',
  'Invited',
  'Declined Invite',
  'Uninvited',
  'VIP',
]

const RULES = [
  {
    kind: 'in-code',
    title: 'Never name content on a priced surface',
    detail:
      'No titles, libraries, catalog size or genres near a price or CTA. Sell capability and ' +
      'infrastructure. Library names stay admin-only.',
  },
  {
    kind: 'in-code',
    title: 'Never meaning by colour alone',
    detail:
      'Every state colour ships beside its word. Status uses emoji plus text for the same reason.',
  },
  {
    kind: 'in-code',
    title: 'Every mutation confirms first',
    detail:
      'Tier resets, expiry changes, downloads toggles, never-expire and cancellation all route ' +
      'through a confirm modal naming the member and the effect.',
  },
  {
    kind: 'in-code',
    title: 'Design for a 15-second load',
    detail:
      'Both admin pages warn that fetching can take about 15 seconds. Any new screen needs a ' +
      'real loading state, not a bare spinner.',
  },
  {
    kind: 'in-code',
    title: 'Gaps, not margins',
    detail:
      'User-agent margins are stripped in globals.scss so only intentional grid and flex gaps ' +
      'control spacing. 48rem is the single breakpoint.',
  },
  {
    kind: 'proposed',
    title: 'One amber fill per marketing view',
    detail:
      'New with these redesigns and scoped to the homepage. The admin keeps its outlined buttons.',
  },
] as const

const SpecimenStatus = ({
  emoji,
  status,
  subscribed,
}: Omit<SpecimenRow, 'member' | 'email' | 'tier' | 'action'>) => (
  <span className={styles.statusRow}>
    <span aria-hidden="true">{emoji}</span>
    <span className={subscribed ? styles.subscribed : ''}>{status}</span>
  </span>
)

const Tag = ({ kind }: { kind: 'in-code' | 'proposed' }) =>
  kind === 'in-code' ? (
    <span className={styles.tagInCode}>In code</span>
  ) : (
    <span className={styles.tagProposed}>Proposed</span>
  )

const SwatchGrid = ({ swatches }: { swatches: ReadonlyArray<Swatch> }) => (
  <ul className={styles.swatchGrid}>
    {swatches.map(({ token, value, use }) => (
      <li key={token} className={styles.swatch}>
        <span className={styles.swatchChip} style={{ background: `var(${token})` }} />
        <span className={styles.swatchToken}>{token}</span>
        <span className={styles.swatchValue}>{value}</span>
        <span className={styles.swatchUse}>{use}</span>
      </li>
    ))}
  </ul>
)

const SectionHeader = ({ title, note }: { title: string; note: string }) => (
  <header className={styles.sectionHeader}>
    <h2 className={styles.sectionTitle}>{title}</h2>
    <span className={styles.sectionNote}>{note}</span>
  </header>
)

const SAMPLE_SIZE_CLASS: Record<(typeof TYPE_SIZES)[number]['sampleSize'], string> = {
  hero: styles.sampleHero,
  xl: styles.sampleXl,
  lg: styles.sampleLg,
  md: styles.sampleMd,
  sm: styles.sampleSm,
  xs: styles.sampleXs,
}

const FAMILY_SAMPLE_CLASS: Record<(typeof TYPE_FAMILIES)[number]['token'], string> = {
  '--font-display': styles.sampleDisplay,
  '--font-body': styles.sampleBody,
  '--font-mono': styles.sampleMono,
  '--font-pixel': styles.samplePixel,
  '--font-brand': styles.sampleBrand,
}

const DesignInner = () => (
  <AdminLayout>
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.title}>Design</h1>
        <p className={styles.lede}>
          Every token below is the real declaration from{' '}
          <code className={styles.code}>styles/globals.scss</code>, and every component spec is
          lifted from the module stylesheet that owns it. Rows carry <Tag kind="in-code" /> when
          they document what ships and <Tag kind="proposed" /> when they are an addition, so this
          page cannot quietly become a false source of truth.
        </p>
      </header>
      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="On this page">
          <p className={styles.tocLabel}>On this page</p>
          <ul className={styles.tocList}>
            {SECTIONS.map(({ id, label }) => (
              <li key={id}>
                <a className={styles.tocLink} href={`#${id}`}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.sections}>
          <section id="color" className={styles.section}>
            <SectionHeader title="Color" note="the declared custom properties, nothing more" />
            <div className={styles.group}>
              <p className={styles.groupLabel}>
                Surface & text <Tag kind="in-code" />
              </p>
              <SwatchGrid swatches={SURFACE_TOKENS} />
              <p className={styles.note}>
                Two surfaces only. There is no darker page tone and no separate chrome colour; the
                header sits on the same background as the page.
              </p>
            </div>
            <div className={styles.group}>
              <p className={styles.groupLabel}>
                Accent & tiers <Tag kind="in-code" />
              </p>
              <SwatchGrid swatches={ACCENT_TOKENS} />
              <p className={styles.note}>
                Youth doubles as the error colour: <code className={styles.code}>.error</code> in
                both Manage and User resolves to it.
              </p>
            </div>
            <div className={styles.group}>
              <p className={styles.groupLabel}>
                Library access states <Tag kind="in-code" />
              </p>
              <SwatchGrid swatches={STATE_TOKENS} />
              <p className={styles.note}>
                The only state colours in the system, and globals.scss requires each to ship beside
                a text label. There is no info or VIP colour; VIP is an emoji.
              </p>
            </div>
          </section>

          <section id="type" className={styles.section}>
            <SectionHeader title="Type" note="five families, one job each" />
            <ul className={styles.typeRows}>
              {TYPE_FAMILIES.map(({ token, family, sample }) => (
                <li key={token} className={styles.typeRow}>
                  <span className={styles.typeMeta}>
                    <span className={styles.typeToken}>{token}</span>
                    <span className={styles.typeFamily}>{family}</span>
                  </span>
                  <span className={FAMILY_SAMPLE_CLASS[token]}>{sample}</span>
                </li>
              ))}
            </ul>
            <ul className={styles.sizeGrid}>
              {TYPE_SIZES.map(({ token, note, sampleSize }) => (
                <li key={token} className={styles.sizeCell}>
                  <span className={SAMPLE_SIZE_CLASS[sampleSize]} aria-hidden="true">
                    Aa
                  </span>
                  <span className={styles.typeToken}>{token}</span>
                  <span className={styles.swatchUse}>{note}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className={styles.pair}>
            <section id="space" className={styles.section}>
              <SectionHeader title="Space & radius" note="six steps, two radii" />
              <ul className={styles.spaceRows}>
                {SPACE_STEPS.map(({ token, width, note }) => (
                  <li key={token} className={styles.spaceRow}>
                    <span className={styles.spaceToken}>{token}</span>
                    <span className={styles.spaceBar} style={{ width }} aria-hidden="true" />
                    <span className={styles.swatchUse}>{note}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.note}>No space-5 or space-7 exists. Do not invent one.</p>
              <div className={styles.radiusRow}>
                <div className={styles.radiusCell}>
                  <span className={styles.radiusChipMd} aria-hidden="true" />
                  <span className={styles.typeToken}>--radius-md</span>
                  <span className={styles.swatchUse}>12px · everything</span>
                </div>
                <div className={styles.radiusCell}>
                  <span className={styles.radiusChipLg} aria-hidden="true" />
                  <span className={styles.typeToken}>--radius-lg</span>
                  <span className={styles.swatchUse}>20px · large cards</span>
                </div>
              </div>
            </section>

            <section id="tier-icon" className={styles.section}>
              <SectionHeader title="Tier icon" note="TierIcon.module.scss" />
              <p className={styles.note}>
                A 0.75em circle with a 2px inset dark ring, baseline aligned, rendered before the
                tier name. It is the only tier marker in the app: no coloured tier pills, no metal
                gradient caps.
              </p>
              <ul className={styles.tierList}>
                {PAID_TIERS.map((tier) => (
                  <li key={tier} className={styles.tierRow}>
                    <TierIcon tier={tier} /> {TIER_LABELS[tier]}
                  </li>
                ))}
              </ul>
              <p className={styles.note}>
                Downloads follow the tier: Gold and Youth true, Bronze and Silver false.
              </p>
            </section>
          </div>

          <section id="status" className={styles.section}>
            <SectionHeader title="Status & tags" note="memberStatus.ts + User.tsx" />
            <div className={styles.pairTight}>
              <div className={styles.group}>
                <p className={styles.groupLabel}>
                  Six derived statuses <Tag kind="in-code" />
                </p>
                <ul className={styles.statusList}>
                  {STATUSES.map((status) => (
                    <li key={status} className={styles.statusRow}>
                      <span aria-hidden="true">{STATUS_EMOJI[status]}</span>
                      <span className={status === 'Subscribed Monthly' ? styles.subscribed : ''}>
                        {status}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={styles.group}>
                <p className={styles.groupLabel}>
                  Two tags <Tag kind="in-code" />
                </p>
                <ul className={styles.statusList}>
                  <li className={styles.statusRow}>
                    <span aria-hidden="true">💎</span>
                    <span>VIP</span>
                  </li>
                  <li className={styles.statusRow}>
                    <span aria-hidden="true">⭐</span>
                    <span>HVU</span>
                  </li>
                </ul>
                <p className={styles.note}>
                  A tag overrides the derived status. Emoji carry meaning here, marked aria-hidden
                  with the text beside them; this is the one place the system uses emoji, so keep
                  them.
                </p>
                <p className={styles.note}>
                  Only Subscribed Monthly takes the accent colour and 600 weight. Every other status
                  is plain body text.
                </p>
              </div>
            </div>
          </section>

          <div className={styles.pair}>
            <section id="buttons" className={styles.section}>
              <SectionHeader title="Buttons" note="MembersTable + Manage + User" />
              <div className={styles.group}>
                <p className={styles.groupLabel}>
                  Admin <Tag kind="in-code" />
                </p>
                <div className={styles.specimenRow}>
                  <button className={styles.specimenButton} type="button">
                    Transparent
                  </button>
                  <button
                    className={`${styles.specimenButton} ${styles.buttonSurface}`}
                    type="button"
                  >
                    Surface
                  </button>
                  <button
                    className={`${styles.specimenButton} ${styles.buttonDanger}`}
                    type="button"
                  >
                    Danger
                  </button>
                  <button className={styles.specimenButton} type="button" disabled>
                    Disabled
                  </button>
                </div>
                <p className={styles.note}>
                  The admin has no filled primary button. Emphasis is an accent border on hover, and
                  disabled is opacity 0.4; that is the whole vocabulary.
                </p>
              </div>
              <div className={styles.group}>
                <p className={styles.groupLabel}>
                  Marketing <Tag kind="proposed" />
                </p>
                <div className={styles.specimenRow}>
                  <button className={styles.buttonAmber} type="button">
                    Amber fill
                  </button>
                  <span className={styles.amberChip}>
                    <button className={styles.buttonOnAmber} type="button">
                      On amber
                    </button>
                  </span>
                </div>
                <p className={styles.note}>
                  Filled amber is new in these redesigns and belongs to the homepage only: one per
                  view, on the single thing you want clicked. It does not belong in the admin.
                </p>
              </div>
            </section>

            <section id="inputs" className={styles.section}>
              <SectionHeader title="Inputs" note="Manage + User" />
              <div className={styles.group}>
                <label className={styles.inputLabel} htmlFor="design-search">
                  Search by email
                </label>
                <input
                  id="design-search"
                  className={styles.inputSpecimen}
                  type="search"
                  placeholder="name@example.com"
                />
                <input
                  className={styles.inputMono}
                  type="text"
                  readOnly
                  value="2026-09-10 00:01"
                  aria-label="Expiry input specimen"
                />
                <textarea
                  className={styles.textareaSpecimen}
                  placeholder="Notes about this member…"
                  aria-label="Notes specimen"
                  rows={3}
                />
                <p className={styles.error}>Could not load member.</p>
                <p className={styles.note}>
                  Uppercase muted 12px label above the field, surface fill, 12px radius, muted
                  placeholder, 24rem cap. Errors are a plain paragraph in youth pink, never a
                  red-bordered field.
                </p>
              </div>
            </section>
          </div>

          <section id="table" className={styles.section}>
            <SectionHeader title="Table" note="MembersTable.module.scss" />
            <div className={styles.tableWrap}>
              <table className={styles.specimenTable}>
                <thead>
                  <tr>
                    <th>Member ▲</th>
                    <th>Email</th>
                    <th>Tier</th>
                    <th>Status</th>
                    <th className={styles.actionHead}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {SPECIMEN_ROWS.map(
                    ({ member, email, tier, emoji, status, subscribed, action }) => (
                      <tr key={member}>
                        <td>{member}</td>
                        <td className={styles.tableEmail}>{email}</td>
                        {tier ? (
                          <td>
                            <span className={styles.tierRow}>
                              <TierIcon tier={tier} /> {tier}
                            </span>
                          </td>
                        ) : (
                          <td className={styles.mutedCell}>unknown</td>
                        )}
                        <td>
                          <SpecimenStatus emoji={emoji} status={status} subscribed={subscribed} />
                        </td>
                        <td className={styles.actionCell}>
                          <button className={styles.specimenButton} type="button">
                            {action}
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            <ul className={styles.noteList}>
              <li>
                Cells are space-1 / space-2 padding with a bottom border only: no zebra striping, no
                row fill.
              </li>
              <li>
                Headers are uppercase 12px muted at 0.08em tracking. Only Member, Email and Status
                sort, marked ▲ / ▼.
              </li>
              <li>
                The Action column is sticky right on a page-coloured background with a left shadow,
                so Invite never scrolls out of reach.
              </li>
              <li>
                Emails are mono, underlined in muted, and link to the member page. Servers/Libs
                takes a dotted underline with the server names in its title attribute.
              </li>
              <li className={styles.noteProposed}>
                <Tag kind="proposed" /> The selected-row treatment, surface fill plus a 3px accent
                inset, arrives with the bulk-select proposal and is not in the app.
              </li>
            </ul>
          </section>

          <section id="pills" className={styles.section}>
            <SectionHeader title="Library pills" note="libraryAccess.ts + User.module.scss" />
            <div className={styles.specimenRow}>
              <span className={styles.pillShared}>
                <span>01. Movies</span>
                <span className={styles.pillState}>shared</span>
              </span>
              <span className={styles.pillNotShared}>
                <span>04. Documentaries</span>
                <span className={styles.pillState}>not shared</span>
              </span>
              <span className={styles.pillNotEntitled}>
                <span>02. Sitcoms</span>
                <span className={styles.pillState}>not entitled</span>
              </span>
            </div>
            <p className={styles.note}>
              Each pill names its library and states its access in words. globals.scss is explicit
              that these are paired with text labels and never carry meaning by colour alone, so a
              legend-plus-swatch grid is not an acceptable substitute; the label travels with the
              pill. A server no tier grants also carries a{' '}
              <span className={styles.warning}>no tier grants this</span> warning in its heading.
            </p>
          </section>

          <section id="rules" className={styles.section}>
            <SectionHeader title="Rules" note="the ones that break the app when ignored" />
            <ul className={styles.ruleGrid}>
              {RULES.map(({ kind, title, detail }) => (
                <li
                  key={title}
                  className={kind === 'proposed' ? styles.ruleCardProposed : styles.ruleCard}
                >
                  <p className={styles.ruleTitle}>
                    <Tag kind={kind} /> {title}
                  </p>
                  <p className={styles.note}>{detail}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  </AdminLayout>
)

export const Design = () => (
  <AdminGate title="Westeroz — Design">
    <DesignInner />
  </AdminGate>
)
