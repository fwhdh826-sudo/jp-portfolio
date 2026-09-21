// UI-9I Phase 1: 共通 primitives（純表示。状態・権限を持たない）。
import type { ReactNode } from 'react'

export function Card({ title, meta, first, className, children, ...rest }: {
  title?: string
  meta?: ReactNode
  first?: boolean
  className?: string
  children: ReactNode
  'aria-label'?: string
  'data-testid'?: string
}) {
  return (
    <section className={`u9-card${first ? ' u9-card--first' : ''}${className ? ` ${className}` : ''}`} {...rest}>
      {(title !== undefined || meta !== undefined) && (
        <div className="u9-card__head">
          {title !== undefined && <h2 className="u9-card__title">{title}</h2>}
          {meta !== undefined && <span className="u9-meta">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

/** 色だけに依存しない状態マーク（ok=丸 / wait=半塗り四角 / fail=赤丸）+ 文字は隣接する値で示す。 */
export function StatusDot({ mark }: { mark: 'ok' | 'wait' | 'fail' }) {
  return <span className="u9-dot" data-mark={mark} aria-hidden="true" />
}

export function LinkRow({ label, onClick, plain }: { label: string; onClick: () => void; plain?: boolean }) {
  return (
    <button type="button" className={`u9-link${plain ? ' u9-link--plain' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <span aria-hidden="true">→</span>
    </button>
  )
}

/**
 * Hero 画像スロット（仕様は ui9i.css の .u9-hero-image に凍結）。
 * 実素材が承認されるまでは src なしで production-safe な中立グラデーション。
 * 装飾のため常に aria-hidden / alt=""。テキストは画像の上に重ねない。
 */
export function HeroImageSlot({ tone, src }: { tone: 'calm' | 'warm' | 'neutral' | 'critical'; src?: string }) {
  return (
    <div className="u9-hero-image" data-tone={tone} data-testid="hero-image-slot" aria-hidden="true">
      {src !== undefined && <img className="u9-hero-image__img" src={src} alt="" loading="eager" decoding="async" />}
    </div>
  )
}
