import { Route, Routes } from 'react-router-dom'
import { App } from '@/App'
import { AnnualPreview } from '@/pages/AnnualPreview/AnnualPreview'
import { Design } from '@/pages/Design/Design'
import { Email } from '@/pages/Email/Email'
import { Fleet } from '@/pages/Fleet/Fleet'
import { Invite } from '@/pages/Invite/Invite'
import { Login } from '@/pages/Login/Login'
import { Manage } from '@/pages/Manage/Manage'
import { ResetUser } from '@/pages/ResetUser/ResetUser'
import { User } from '@/pages/User/User'

export const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/login" element={<Login />} />
    <Route path="/invite" element={<Invite />} />
    <Route path="/email" element={<Email />} />
    <Route path="/fleet" element={<Fleet />} />
    <Route path="/design" element={<Design />} />
    {/* Unlisted: absent from menuRoutes and linked from nowhere. */}
    <Route path="/annual" element={<AnnualPreview />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
    <Route path="/user" element={<User />} />
  </Routes>
)
