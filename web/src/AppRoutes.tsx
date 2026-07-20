import { Route, Routes } from 'react-router-dom'
import App from '@/App'
import Invite from '@/pages/Invite/Invite'
import Manage from '@/pages/Manage/Manage'
import ResetUser from '@/pages/ResetUser/ResetUser'
import User from '@/pages/User/User'

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/invite" element={<Invite />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
    <Route path="/user" element={<User />} />
  </Routes>
)

export default AppRoutes
