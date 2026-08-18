import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme } from './theme/tokens'

// UI-9A: React render前にCSS custom propertiesを:rootへ注入する。
// これが無いと src/** 全体の var(--*) 参照が未定義値のまま解決され、
// 色・spacing・radius・shadow指定が無効化される。
applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(<StrictMode><App /></StrictMode>)
