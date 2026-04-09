import { useAppStore } from '../../store/useAppStore'

export function T4_Correlation() {
  const corr     = useAppStore(s => s.correlation)
  const holdings = useAppStore(s => s.holdings)

  if (!corr) {
    return (
      <div className="tab-panel" style={{ textAlign: 'center', paddingTop: 48 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔗</div>
        <div style={{ fontFamily: 'var(--head)', fontSize: 11, color: 'var(--d)', letterSpacing: '.1em', marginBottom: 8 }}>
          相関データ未ロード
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
          GitHub Actions が毎平日 8:30 JST に自動生成します
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--b1)', marginTop: 6 }}>
          staticモード: 相関行列なし
        </div>
      </div>
    )
  }

  const matrix = corr.matrix

  const corrVal = (ci: string, cj: string): number => {
    const ki = ci + '.T', kj = cj + '.T'
    return matrix[ki]?.[kj] ?? 0
  }

  const corrColor = (v: number) => {
    if (v >= 0.7)  return 'var(--r)'
    if (v >= 0.4)  return 'var(--a)'
    if (v <= -0.1) return 'var(--g)'
    return 'var(--d)'
  }
  const corrBg = (v: number) => {
    if (v >= 0.7)  return 'rgba(232,64,90,.22)'
    if (v >= 0.4)  return 'rgba(212,160,23,.16)'
    if (v <= -0.1) return 'rgba(45,212,160,.14)'
    return 'transparent'
  }

  const codes = holdings.map(h => h.code)

  // volatilities
  const vols = corr.volatilities ?? {}

  return (
    <div className="tab-panel">
      {/* メタ情報 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 4 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>
          更新: {corr.last_updated} / 期間: {corr.period}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g)' }}>yfinance 実測</div>
      </div>

      {/* ヒートマップ */}
      <div className="card">
        <div className="card-title">相関行列 ヒートマップ <span className="badge live">実測</span></div>
        <div className="tw">
          <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'var(--mono)' }}>
            <thead>
              <tr>
                <th style={{ padding: '4px 8px', color: 'var(--d)', background: 'var(--bg3)' }}></th>
                {codes.map(c => (
                  <th key={c} style={{
                    padding: '4px 6px', color: 'var(--w)', background: 'var(--bg3)',
                    writingMode: 'vertical-rl', textOrientation: 'mixed', height: 56, fontSize: 9,
                  }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {codes.map(ci => {
                const hi = holdings.find(h => h.code === ci)
                return (
                  <tr key={ci}>
                    <td style={{ padding: '4px 8px', color: 'var(--w)', whiteSpace: 'nowrap', fontSize: 9, background: 'var(--bg3)', position: 'sticky', left: 0 }}>
                      {ci} <span style={{ color: 'var(--d)' }}>{hi?.name?.slice(0, 4)}</span>
                    </td>
                    {codes.map(cj => {
                      const v = corrVal(ci, cj)
                      const isDiag = ci === cj
                      return (
                        <td key={cj} style={{
                          padding: '3px 4px',
                          textAlign: 'center',
                          background: isDiag ? 'rgba(45,212,160,.1)' : corrBg(v),
                          color: isDiag ? 'var(--g)' : corrColor(v),
                          fontWeight: isDiag ? 700 : 400,
                          minWidth: 36,
                        }}>
                          {isDiag ? '1.00' : v.toFixed(2)}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {/* 凡例 */}
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {[
            { label: '高相関 ≥0.7', color: 'var(--r)' },
            { label: '中相関 ≥0.4', color: 'var(--a)' },
            { label: '低相関 <0.4', color: 'var(--d)' },
            { label: '負相関 <0',   color: 'var(--g)' },
          ].map(l => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 2,
                background: `${l.color}44`,
                border: `1px solid ${l.color}`,
              }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ボラティリティ実測値 */}
      {Object.keys(vols).length > 0 && (
        <div className="card">
          <div className="card-title">ボラティリティ σ <span className="badge live">yfinance実測</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {Object.entries(vols).map(([k, v]) => {
              const code = k.replace('.T', '')
              const volPct = (v * 100).toFixed(1)
              const col = v > 0.4 ? 'var(--r)' : v > 0.25 ? 'var(--a)' : 'var(--g)'
              return (
                <div key={k} style={{
                  background: 'var(--bg3)',
                  border: `1px solid var(--b1)`,
                  borderRadius: 6,
                  padding: '6px 10px',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--w)' }}>{code}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: col }}>
                    {volPct}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
