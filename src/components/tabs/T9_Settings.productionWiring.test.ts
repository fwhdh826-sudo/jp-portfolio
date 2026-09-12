import { describe, expect, it } from 'vitest'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import t9Source from './T9_Settings.tsx?raw'

// OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-01 ticket section 3/4): production-path proof that T9's
// CSV drop area — the normal, ordinary T9 SBI full-portfolio refresh a user actually clicks — is
// wired to the two-stage authority action (importSbiPortfolioFullExport), never the legacy
// importCsv writer that can downgrade a v6 COMPLETE generation to v5. Source-text assertion
// follows this repo's own established convention for wiring-fact tests (see
// T9_Settings.refresh.test.tsx's identical pattern for the refresh button).
describe('T9 production CSV import wiring (P1-01)', () => {
  it('binds the drop-area action to importSbiPortfolioFullExport, never the legacy importCsv writer', () => {
    expect(t9Source).toContain('useAppStore(s => s.importSbiPortfolioFullExport)')
    expect(t9Source).not.toContain('useAppStore(s => s.importCsv)')
  })

  it('renders CsvDropArea with the SBI full-export-bound callback', () => {
    expect(t9Source).toContain('<CsvDropArea onFile={handleImportCsv} isLoading={isLoading} />')
  })

  it('handleImportCsv calls importSbiPortfolioFullExport, not importCsv', () => {
    expect(t9Source).toContain('async (file: File, options?: SbiFullExportImportOptions) => importSbiPortfolioFullExport(file, options)')
  })
})
