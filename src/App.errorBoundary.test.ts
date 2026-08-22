// UI-9F-B — F-P0-4 wiring test.
//
// AppErrorBoundary が App root 近傍に実際に配置されていることを、TypeScript の AST で
// 検証する（正規表現ではなく JSX の親子関係を見る）。
// jsdom が依存に無いため「throw → fallback」の統合 render はここでは行えない。
// boundary 自体の振る舞いは AppErrorBoundary.test.tsx、
// 実ブラウザでの render throw → fallback は browser probe が担保する。
// このプロジェクトは @types/node を導入していない（package.json 変更は scope 外）。
// candidateFunnel.contract.test.ts と同じく、最小の ambient 宣言経由で Node API を取る。
// パスは vitest の cwd（repo root）基準の相対パスで解決される。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function require(id: string): any
}

import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const fs = require('fs') as { readFileSync: (p: string, enc: string) => string }

function read(repoRelativePath: string): string {
  return fs.readFileSync(repoRelativePath, 'utf-8')
}

function parse(repoRelativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    repoRelativePath, read(repoRelativePath), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX,
  )
}

function jsxTagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText()
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText()
  return null
}

/** `ancestor` タグの内側に `descendant` タグが現れる JSX 要素を探す。 */
function findWrapping(sourceFile: ts.SourceFile, ancestor: string, descendant: string): ts.JsxElement | null {
  let found: ts.JsxElement | null = null

  const containsTag = (node: ts.Node, tag: string): boolean => {
    let hit = false
    const walk = (n: ts.Node) => {
      if (hit) return
      if (jsxTagName(n) === tag) { hit = true; return }
      ts.forEachChild(n, walk)
    }
    ts.forEachChild(node, walk)
    return hit
  }

  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isJsxElement(node) && jsxTagName(node) === ancestor && containsTag(node, descendant)) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

describe('F-P0-4: AppErrorBoundary が App root 近傍に配置されている', () => {
  it('App.tsx が AppErrorBoundary を import している', () => {
    expect(read('src/App.tsx')).toContain("from './components/shared/AppErrorBoundary'")
  })

  it('App.tsx で ActiveTabPanel が AppErrorBoundary の内側にある', () => {
    expect(findWrapping(parse('src/App.tsx'), 'AppErrorBoundary', 'ActiveTabPanel')).not.toBeNull()
  })

  it('その boundary は main-content（app-shell の内側）に置かれている — shell は例外時も残る', () => {
    expect(findWrapping(parse('src/App.tsx'), 'main', 'AppErrorBoundary')).not.toBeNull()
  })

  it('boundary は key={activeTab} を持ち、タブ切替が復旧導線になる', () => {
    const wrapper = findWrapping(parse('src/App.tsx'), 'AppErrorBoundary', 'ActiveTabPanel')!
    const keyAttr = wrapper.openingElement.attributes.properties.find(
      p => ts.isJsxAttribute(p) && p.name.getText() === 'key',
    )
    expect(keyAttr).toBeDefined()
    expect(keyAttr!.getText()).toContain('activeTab')
  })

  it('main.tsx の root render も AppErrorBoundary で包まれている', () => {
    expect(read('src/main.tsx')).toContain("from './components/shared/AppErrorBoundary'")
    expect(findWrapping(parse('src/main.tsx'), 'AppErrorBoundary', 'App')).not.toBeNull()
  })
})
