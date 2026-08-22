import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppErrorBoundary } from './components/shared/AppErrorBoundary'
import { applyTheme } from './theme/tokens'

// UI-9A: React render前にCSS custom propertiesを:rootへ注入する。
// これが無いと src/** 全体の var(--*) 参照が未定義値のまま解決され、
// 色・spacing・radius・shadow指定が無効化される。
applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
// F-P0-4: shell 自体（header / StatusBar / GlobalErrorBanner）の描画例外でも
// 白紙にせず、root 直下でも境界を張る。
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
