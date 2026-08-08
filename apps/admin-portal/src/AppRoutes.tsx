import { Route, Routes } from 'react-router-dom'
import { App } from '@/App'
import { Email } from '@/pages/Email/Email'
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
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
    <Route path="/user" element={<User />} />
  </Routes>
)
