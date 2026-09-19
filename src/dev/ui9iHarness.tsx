// UI-9I Phase 1: 視覚検証用 dev ハーネス（Vite dev 専用）。
// `dev/ui9i-harness.html?state=<scenario>` で、固定 fixture（canonical 入力）を
// 本番と同じ projector（assembleTodayHomeViewModel）→ 同じ view（TodayHomeView）→
// 同じ shell（UserSidebarNav / UserDockNav）で描画する。
// vite build の入力は index.html のみのため、本番バンドルには含まれない。
import { createRoot } from 'react-dom/client'
import '../styles/v10.css'
import '../styles/ui9i.css'
import { applyTheme } from '../theme/tokens'
import { assembleTodayHomeViewModel } from '../presentation/ui9i/todayHome'
import { scenarioInputs, type HomeScenario } from '../presentation/ui9i/ui9i.fixtures'
import { TodayHomeView } from '../components/ui9i/TodayHomeView'
import { UserDockNav, UserSidebarNav } from '../components/ui9i/UserNav'

applyTheme()

const SCENARIOS: HomeScenario[] = ['normal', 'actionable', 'candidate_unavailable', 'safe_mode', 'data_wait', 'decision_unavailable', 'boot']
const requested = new URLSearchParams(window.location.search).get('state') as HomeScenario | null
const scenario: HomeScenario = requested !== null && SCENARIOS.includes(requested) ? requested : 'normal'
const vm = assembleTodayHomeViewModel(scenarioInputs(scenario))

createRoot(document.getElementById('root')!).render(
  <div className="app-shell" data-ui9i="true" data-harness-state={scenario}>
    <div className="app-shell-body">
      <UserSidebarNav />
      <main className="main-content u9-main">
        <div className="u9">
          <TodayHomeView
            vm={vm}
            dateLabel="10月6日（月）"
            yearLabel="2026年"
            actions={{ onOpenAudit: () => {}, onOpenPortfolio: () => {}, onOpenCandidates: () => {} }}
          />
        </div>
      </main>
    </div>
    <UserDockNav />
  </div>,
)
