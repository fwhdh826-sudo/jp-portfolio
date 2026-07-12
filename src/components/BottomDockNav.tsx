import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { TAB_META } from '../constants/tabs'
import type { TabId } from '../types'

const PRIMARY_DOCK_IDS: TabId[] = ['T0', 'T5', 'T1', 'T7']
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
      if (focusables.length === 0) return
      const first = focusables[0]
      const last  = focusables[focusables.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [moreOpen, closeSheet])

  // T7では既存MobileBottomActionBarを優先 — Dockを非表示
  if (activeTab === 'T7') return null

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
                aria-selected={activeTab === tab.id}
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
            aria-selected={activeTab === tab.id}
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
