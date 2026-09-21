// テスト専用: jsdom / testing-library を追加せずに React 18 の client render（effect / unmount の
// cleanup を含む）を検証するための最小 fake DOM。既存の CandidateFunnelPanel.test.tsx /
// useCandidatePortfolioFit.test.tsx が個別に持つ fake DOM と同じ方式で、依存は増やさない。
import { act } from 'react'
import type { ReactNode } from 'react'

export class FakeNode {
  readonly attributes: Record<string, string> = {}
  readonly childNodes: FakeNode[] = []
  readonly namespaceURI: string | null
  readonly style: Record<string, string> = {}
  readonly tagName: string | undefined
  ownerDocument: FakeDocument
  parentNode: FakeNode | null = null
  nodeValue: string | null = null

  constructor(readonly nodeType: number, readonly nodeName: string, ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument
    this.tagName = nodeType === 1 ? nodeName : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : null
  }

  appendChild(child: FakeNode) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: FakeNode, before: FakeNode) {
    const index = this.childNodes.indexOf(before)
    if (index < 0) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child: FakeNode) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener() {}
  removeEventListener() {}

  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value)
  }

  removeAttribute(name: string) {
    delete this.attributes[name]
  }

  set textContent(value: string) {
    this.childNodes.length = 0
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value))
  }

  get textContent(): string {
    return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('')
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  /** attribute 値で子孫を探す（data-testid の存在確認用）。 */
  findByAttribute(name: string, value: string): FakeNode[] {
    const hits: FakeNode[] = this.attributes[name] === value ? [this] : []
    for (const child of this.childNodes) hits.push(...child.findByAttribute(name, value))
    return hits
  }
}

export class FakeDocument extends FakeNode {
  readonly activeElement: FakeNode
  readonly body: FakeNode
  readonly documentElement: FakeNode
  defaultView: unknown = null

  constructor() {
    super(9, '#document', null as unknown as FakeDocument)
    this.ownerDocument = this
    this.documentElement = new FakeNode(1, 'HTML', this)
    this.body = new FakeNode(1, 'BODY', this)
    this.activeElement = this.body
  }

  createElement(name: string) {
    return new FakeNode(1, name.toUpperCase(), this)
  }

  createElementNS(namespaceURI: string, name: string) {
    const element = this.createElement(name)
    Object.defineProperty(element, 'namespaceURI', { value: namespaceURI })
    return element
  }

  createTextNode(value: string) {
    const node = new FakeNode(3, '#text', this)
    node.nodeValue = value
    return node
  }

  createComment(value: string) {
    const node = new FakeNode(8, '#comment', this)
    node.nodeValue = value
    return node
  }

  getElementById() {
    return null
  }
}

export interface FakeMount {
  readonly container: FakeNode
  unmount(): Promise<void>
}

/**
 * fake DOM に client render し、effect まで flush してから返す。
 * `run` の間だけ window / document / navigator / IS_REACT_ACT_ENVIRONMENT を差し替え、必ず元へ戻す。
 */
export async function withFakeDom<T>(run: (mount: (node: ReactNode) => Promise<FakeMount>) => Promise<T>): Promise<T> {
  const testDocument = new FakeDocument()
  class FakeHtmlIFrameElement {}
  const testWindow = {
    document: testDocument,
    HTMLIFrameElement: FakeHtmlIFrameElement,
    addEventListener() {},
    removeEventListener() {},
    getSelection() { return null },
  }
  testDocument.defaultView = testWindow

  const names = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: testWindow },
    document: { configurable: true, value: testDocument },
    navigator: { configurable: true, value: { userAgent: 'vitest' } },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
  })

  const { createRoot } = await import('react-dom/client')
  const roots: Array<{ unmount(): void }> = []
  try {
    return await run(async node => {
      const container = testDocument.createElement('div')
      const root = createRoot(container as unknown as Element)
      roots.push(root)
      await act(async () => { root.render(node) })
      return {
        container,
        unmount: async () => { await act(async () => { root.unmount() }) },
      }
    })
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}
