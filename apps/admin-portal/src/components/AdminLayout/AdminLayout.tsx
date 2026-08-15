import type { ReactNode } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { Footer } from '@/components/Footer/Footer'
import { Header } from '@/components/Header/Header'
import { SideMenu } from '@/components/SideMenu/SideMenu'
import { siteConfig } from '@/site.config'
import styles from '@/components/AdminLayout/AdminLayout.module.scss'

type AdminLayoutProps = {
  children: ReactNode
}

export const AdminLayout = ({ children }: AdminLayoutProps) => {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0
  return (
    <div className={styles.layout}>
      <Header brandName={siteConfig.brandName} />
      <div className={styles.body}>
        <SideMenu />
        <div className={styles.content}>{children}</div>
      </div>
      <Footer
        memberUrl={siteConfig.memberUrl}
        billingPortalUrl={siteConfig.billingPortalUrl}
        tone="quiet"
      />
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
