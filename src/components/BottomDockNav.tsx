import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { TAB_META } from '../constants/tabs'
import type { TabId } from '../types'

const PRIMARY_DOCK_IDS: TabId[] = ['T0', 'T5', 'T1', 'T7']
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Tab トラップ境界判定: 現在のfocus indexが境界（Shift+Tabで先頭 / Tabで末尾）にある
// 場合のみ、折り返し先indexを返す。境界でなければnull（ブラウザ既定のTab移動に委ねる）。
export function computeDockTabTrapTarget(
  focusableCount: number,
  activeIndex: number,
  shiftKey: boolean,
): number | null {
  if (focusableCount === 0) return null
  if (shiftKey) return activeIndex === 0 ? focusableCount - 1 : null
  return activeIndex === focusableCount - 1 ? 0 : null
}

export function BottomDockNav() {
  const activeTab     = useAppStore(s => s.activeTab)
  const setTab        = useAppStore(s => s.setTab)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const sheetRef      = useRef<HTMLDivElement>(null)

  // Close sheet and restore focus to the More button
  const closeSheet = useCallback(() => {
    setMoreOpen(false)
    setTimeout(() => moreButtonRef.current?.focus(), 0)
  }, [])

  // Focus management: open → focus first item; Escape → close; Tab trap
  useEffect(() => {
    if (!moreOpen) return
    const sheet = sheetRef.current
    if (!sheet) return

    const getFocusables = () =>
      Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))

    getFocusables()[0]?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSheet()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = getFocusables()
      const activeIndex = focusables.indexOf(document.activeElement as HTMLElement)
      const target = computeDockTabTrapTarget(focusables.length, activeIndex, e.shiftKey)
      if (target !== null) {
        e.preventDefault()
        focusables[target]?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [moreOpen, closeSheet])

  const primaryTabs = TAB_META.filter(t => PRIMARY_DOCK_IDS.includes(t.id))

  const handleTabSelect = (id: TabId) => {
    setTab(id)
    closeSheet()
  }

  return (
    <>
      {/* More sheet backdrop */}
      {moreOpen && (
        <div
          className="bottom-dock__overlay"
          onClick={closeSheet}
          aria-hidden="true"
        />
      )}

      {/* More sheet */}
      {moreOpen && (
        <div
          ref={sheetRef}
          className="bottom-dock__more-sheet"
          role="dialog"
          aria-label="すべての画面"
          aria-modal="true"
        >
          <div className="bottom-dock__more-header">
            <span className="bottom-dock__more-title">すべての画面</span>
            <button
              className="bottom-dock__more-close"
              onClick={closeSheet}
              type="button"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
          <div className="bottom-dock__more-grid">
            {TAB_META.map(tab => (
              <button
                key={tab.id}
                className={`bottom-dock__more-item${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => handleTabSelect(tab.id)}
                type="button"
                aria-current={activeTab === tab.id ? 'page' : undefined}
              >
                <span className="bottom-dock__more-icon" aria-hidden="true">{tab.icon}</span>
                <span className="bottom-dock__more-label">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Dock */}
      <nav className="bottom-dock" aria-label="メインナビゲーション">
        {primaryTabs.map(tab => (
          <button
            key={tab.id}
            className={`bottom-dock__item${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => handleTabSelect(tab.id)}
            type="button"
            aria-current={activeTab === tab.id ? 'page' : undefined}
            title={tab.title}
          >
            <span className="bottom-dock__icon" aria-hidden="true">{tab.icon}</span>
            <span className="bottom-dock__label">{tab.label}</span>
          </button>
        ))}
        <button
          ref={moreButtonRef}
          className={`bottom-dock__item${moreOpen ? ' active' : ''}`}
          onClick={() => setMoreOpen(v => !v)}
          type="button"
          aria-expanded={moreOpen}
          aria-label="その他の画面"
        >
          <span className="bottom-dock__icon" aria-hidden="true">☰</span>
          <span className="bottom-dock__label">More</span>
        </button>
      </nav>
    </>
  )
}
