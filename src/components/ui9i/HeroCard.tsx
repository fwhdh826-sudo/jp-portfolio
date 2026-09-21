// UI-9I Phase 1: T0 Hero。権威は OfficialDecision（headline を verbatim）。
// この component は文言を合成しない — view-model が渡す値だけを描画する。
import type { HeroViewModel } from '../../presentation/ui9i/todayHome'
import { HeroImageSlot } from './primitives'

export function HeroCard({ hero, onCta, imageSrc }: {
  hero: HeroViewModel
  onCta: () => void
  imageSrc?: string
}) {
  const showDot = hero.state === 'decision_unavailable'
  return (
    <section
      className="u9-hero u9-area-hero"
      data-state={hero.state}
      data-tone={hero.tone}
      aria-labelledby="u9-hero-headline"
    >
      {hero.safeModeBanner && (
        <div className="u9-hero__banner" data-testid="safe-mode-banner">
          <span className="u9-hero__banner-mark" aria-hidden="true">▲</span>
          <span className="u9-nowrap">SAFE MODE</span>
        </div>
      )}
      <div className="u9-hero__row">
        <div className="u9-hero__body">
          <span className="u9-hero__eyebrow u9-nowrap">
            {showDot && <span className="u9-hero__eyebrow-dot" aria-hidden="true" />}
            {hero.eyebrow}
          </span>
          <h1 className="u9-hero__headline" id="u9-hero-headline" data-testid="hero-headline">{hero.headline}</h1>
          {hero.secondaryCopy !== null && <p className="u9-hero__copy" data-testid="hero-secondary">{hero.secondaryCopy}</p>}
        </div>
        <HeroImageSlot tone={hero.tone} src={imageSrc} />
        {hero.state === 'normal' && <span className="u9-hero__arrow" aria-hidden="true">→</span>}
      </div>
      {hero.guardNote !== null && <div className="u9-hero__note" data-testid="hero-guard-note">{hero.guardNote}</div>}
      {hero.cta !== null && (
        <button type="button" className="u9-hero__cta" onClick={onCta} data-testid="hero-cta">
          <span>{hero.cta.label}</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
    </section>
  )
}
