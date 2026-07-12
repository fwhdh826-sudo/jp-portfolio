import { useEffect, useState } from 'react'
import { breakpoints } from '../theme/tokens'

/**
 * モバイル判定フック
 * breakpoints.md (840px) 未満のとき true を返す。
 * SSR安全: 初期値は window.innerWidth で即時評価。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoints.md,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoints.md - 1}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return isMobile
}
