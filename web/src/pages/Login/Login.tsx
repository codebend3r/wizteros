import { Navigate } from 'react-router-dom'
import { LoginGate } from '@/components/LoginGate/LoginGate'

// Reuses LoginGate's session logic: signed-out shows the form; a successful
// login (or arriving already signed in) falls through to the redirect.
const Login = () => (
  <LoginGate title="Admin login">
    <Navigate to="/manage" replace />
  </LoginGate>
)

export default Login
