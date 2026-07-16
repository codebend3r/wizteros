import { useRef, useState } from 'react'
import logoImage from '@/assets/logo.jpg'
import logoVideo from '@/assets/logo.mp4'
import styles from '@/components/Hero/HeroLogo.module.scss'

const HeroLogo = () => {
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

export default HeroLogo
