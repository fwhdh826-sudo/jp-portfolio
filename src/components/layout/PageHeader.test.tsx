import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageHeader } from './PageHeader'
import { TAB_META } from '../../constants/tabs'

describe('PageHeader — UI-9D L1 semantic見出し', () => {
  it.each(TAB_META)('$id: h1がちょうど1件でTAB_META.titleと一致する', meta => {
    const html = renderToStaticMarkup(<PageHeader tabId={meta.id} />)
    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)]
    expect(h1Matches).toHaveLength(1)
    expect(h1Matches[0][1]).toBe(meta.title)
  })

  it.each(TAB_META)('$id: サブタイトルがTAB_META.descriptionと一致する', meta => {
    const html = renderToStaticMarkup(<PageHeader tabId={meta.id} />)
    const pMatches = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    expect(pMatches).toHaveLength(1)
    expect(pMatches[0][1]).toBe(meta.description)
  })

  it('新しいページ文言を創作していない（TAB_METAの再利用のみ）', () => {
    const html = renderToStaticMarkup(<PageHeader tabId="T0" />)
    expect(html).toContain(TAB_META.find(m => m.id === 'T0')!.title)
    expect(html).toContain(TAB_META.find(m => m.id === 'T0')!.description)
  })
})
