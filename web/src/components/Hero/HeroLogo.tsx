import { useRef, useState } from 'react'
import logoImage from '@/assets/logo.jpg'
import logoVideo from '@/assets/logo.mp4'
import styles from '@/components/Hero/HeroLogo.module.scss'

export const HeroLogo = () => {
  const [isHovering, setIsHovering] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const showVideo = () => {
    setIsHovering(true)
    const video = videoRef.current
    if (video) {
      video.currentTime = 0
      video.play().catch(() => undefined)
    }
  }

  const showImage = () => {
    setIsHovering(false)
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
  }

  return (
    // Hover swaps in a decorative, aria-hidden video. Nothing is conveyed by it,
    // so there is no keyboard equivalent to add.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <figure className={styles.logo} onMouseEnter={showVideo} onMouseLeave={showImage}>
      <img className={styles.image} src={logoImage} alt="Westeroz mascot" />
      <video
        ref={videoRef}
        className={`${styles.video} ${isHovering ? styles.videoVisible : ''}`}
        src={logoVideo}
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
      />
    </figure>
  )
}
