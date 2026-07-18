import type { ReactNode } from 'react'
import Footer from '@/components/Footer/Footer'
import Header from '@/components/Header/Header'
import { siteConfig } from '@/site.config'
import styles from '@/components/AdminLayout/AdminLayout.module.scss'

type AdminLayoutProps = {
  children: ReactNode
}

const AdminLayout = ({ children }: AdminLayoutProps) => (
  <div className={styles.layout}>
    <Header brandName={siteConfig.brandName} />
    {children}
    <Footer memberUrl={siteConfig.memberUrl} />
  </div>
)

export default AdminLayout
