import { Link } from 'react-router-dom'
import AdminGate from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import styles from '@/pages/Invite/Invite.module.scss'

const InviteInner = () => (
  <AdminLayout>
    <main className={styles.page}>
      <Link className={styles.back} to="/manage">
        ← All members
      </Link>
      <h1 className={styles.title}>Invite someone</h1>
    </main>
  </AdminLayout>
)

const Invite = () => (
  <AdminGate title="Westeroz — Invite">
    <InviteInner />
  </AdminGate>
)

export default Invite
