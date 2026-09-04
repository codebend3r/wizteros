import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { App } from '@/App'
import { AnnualPreview } from '@/pages/AnnualPreview/AnnualPreview'
import { Design } from '@/pages/Design/Design'
import { Email } from '@/pages/Email/Email'
import { Invite } from '@/pages/Invite/Invite'
import { Login } from '@/pages/Login/Login'
import { Manage } from '@/pages/Manage/Manage'
import { ResetUser } from '@/pages/ResetUser/ResetUser'
import { User } from '@/pages/User/User'

// Split out on its own, unlike every other route here, because it is the one
// page that pulls in a charting library. Bundled with the rest that was ~360 kB
// of Recharts downloaded by every visitor to the landing page, to draw charts
// only an allowlisted admin can see. Named so the chunk is recognisable in a
// build report.
const Fleet = lazy(async () => {
  const module = await import('@/pages/Fleet/Fleet')
  return { default: module.Fleet }
})

// Same reason, same library: the income page draws two charts.
const Income = lazy(async () => {
  const module = await import('@/pages/Income/Income')
  return { default: module.Income }
})

export const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/login" element={<Login />} />
    <Route path="/invite" element={<Invite />} />
    <Route path="/email" element={<Email />} />
    <Route
      path="/fleet"
      element={
        // the gate and the layout arrive with the chunk, so this stands in for
        // the whole page rather than for a panel inside it
        <Suspense fallback={<p>Loading the fleet monitor.</p>}>
          <Fleet />
        </Suspense>
      }
    />
    <Route
      path="/income"
      element={
        <Suspense fallback={<p>Loading the income page.</p>}>
          <Income />
        </Suspense>
      }
    />
    <Route path="/design" element={<Design />} />
    {/* Unlisted: absent from menuRoutes and linked from nowhere. */}
    <Route path="/annual" element={<AnnualPreview />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
    <Route path="/user" element={<User />} />
  </Routes>
)
