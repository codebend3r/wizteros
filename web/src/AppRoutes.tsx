import { Route, Routes } from 'react-router-dom'
import App from '@/App'
import Manage from '@/pages/Manage/Manage'
import ResetUser from '@/pages/ResetUser/ResetUser'

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
  </Routes>
)

export default AppRoutes
