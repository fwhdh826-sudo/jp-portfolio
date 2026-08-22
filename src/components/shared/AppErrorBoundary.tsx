/**
 * AppErrorBoundary — 描画例外で全画面が白紙になることを防ぐ（UI-9F F-P0-4 / §6.1(4)）
 *
 * 設計上の制約（意図的）:
 *  - portfolio / localStorage を勝手に clear しない。復旧は再読み込みのみ。
 *  - store（domain state）を一切書き換えない。boundary は表示層だけで完結する。
 *  - stack / error.message などの debug 情報を通常 UI へ出さない。console.error にのみ出す。
 *
 * fallback は StateBanner の critical tone を使う（新規 color token は追加しない）。
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { StateBanner } from './StateBanner'
import { spacing } from '../../theme/tokens'

export interface AppErrorBoundaryProps {
  children: ReactNode
  /** テスト/probe から reload 導線を差し替えるためだけの hook。既定は window.location.reload。 */
  onReload?: () => void
}

export interface AppErrorBoundaryState {
  hasError: boolean
}

export const APP_ERROR_BOUNDARY_TITLE = '画面を表示できませんでした'
export const APP_ERROR_BOUNDARY_MESSAGE =
  '表示処理でエラーが発生しました。保存済みのポートフォリオデータは変更していません。'
  + '再読み込みしても解消しない場合は、他のタブへ切り替えるか、時間をおいて再度お試しください。'

function defaultReload(): void {
  if (typeof window !== 'undefined') window.location.reload()
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // debug 情報の出力先は console のみ。UI には出さない。
    console.error('[AppErrorBoundary] render exception', error, errorInfo.componentStack)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{ padding: spacing[4] }} data-app-error-boundary="fallback">
        <StateBanner
          tone="critical"
          live="assertive"
          label={APP_ERROR_BOUNDARY_TITLE}
          message={APP_ERROR_BOUNDARY_MESSAGE}
          action={{ label: '再読み込み', onClick: this.props.onReload ?? defaultReload }}
        />
      </div>
    )
  }
}
