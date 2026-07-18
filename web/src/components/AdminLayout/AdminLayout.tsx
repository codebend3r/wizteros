import type { ReactNode } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import Footer from '@/components/Footer/Footer'
import Header from '@/components/Header/Header'
import { siteConfig } from '@/site.config'
import styles from '@/components/AdminLayout/AdminLayout.module.scss'

type AdminLayoutProps = {
  children: ReactNode
}

const AdminLayout = ({ children }: AdminLayoutProps) => {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0
  return (
    <div className={styles.layout}>
      <Header brandName={siteConfig.brandName} />
      {children}
      <Footer memberUrl={siteConfig.memberUrl} />
      <button
        className={styles.hardRefresh}
        type="button"
        onClick={() => void queryClient.invalidateQueries()}
        disabled={fetching}
      >
        {fetching ? 'Refreshing…' : 'Hard refresh'}
      </button>
    </div>
  )
}

export default AdminLayout
