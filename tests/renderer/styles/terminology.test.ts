import { beforeAll, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * 术语统一防回退。
 * 扫描 renderer 的 JSX 可见文本、常用文案属性、描述对象字段和中文模板字符串；
 * TypeScript AST 会跳过注释，并能处理换行 JSX，避免正则只检查同一行而漏报。
 */
const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer')
const UI_PROPERTIES = new Set(['placeholder', 'title', 'hint', 'desc', 'description', 'label', 'name', 'aria-label'])

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSourceFiles(full))
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  }
  return null
}

function extractUserStrings(file: string, code: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
  const strings: string[] = []
  const add = (value: string | null | undefined) => {
    const text = value?.replace(/\s+/g, ' ').trim()
    if (text && /[㐀-鿿]/.test(text)) strings.push(text)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text)
    if (ts.isTemplateExpression(node)) add(literalText(node))
    if (ts.isJsxText(node)) add(node.text)
    if (ts.isJsxAttribute(node) && UI_PROPERTIES.has(node.name.getText(source))) {
      if (node.initializer && ts.isStringLiteralLike(node.initializer)) add(node.initializer.text)
      if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        add(literalText(node.initializer.expression))
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/^['"]|['"]$/g, '')
      if (UI_PROPERTIES.has(name)) add(literalText(node.initializer))
    }
    // flash/toast 等动态提示不是 JSX 节点，但仍是用户可见文案。
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression.getText(source).split('.').pop()
      if (callee && /^(flash|showToast|toast|alert|confirm)$/.test(callee)) {
        add(literalText(node.arguments[0]))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return strings
}

const files = collectSourceFiles(RENDERER_DIR)
let parsedStrings: Array<{ file: string; text: string }> = []

beforeAll(() => {
  const deduped = new Set<string>()
  parsedStrings = files.flatMap((file) => {
    const rel = path.relative(RENDERER_DIR, file).replace(/\\/g, '/')
    const code = fs.readFileSync(file, 'utf8')
    return extractUserStrings(file, code).flatMap((text) => {
      const key = `${rel}\u0000${text}`
      if (deduped.has(key)) return []
      deduped.add(key)
      return [{ file: rel, text }]
    })
  })
}, 30_000)

const collectHits = (test: (text: string) => boolean): string[] =>
  parsedStrings.filter(({ text }) => test(text)).map(({ file, text }) => `${file}: ${text}`)

describe('术语统一防回退', () => {
  it('用户可见文案不得用「卡片」指代事项', () => {
    const hits = collectHits((text) => /卡片/.test(text))
    expect(hits, `以下用户可见文案仍在用「卡片」：\n${hits.join('\n')}`).toEqual([])
  })

  it('用户可见文案不得用「任务」指代事项', () => {
    const hits = collectHits((text) => /任务/.test(text) && !/子任务/.test(text))
    expect(hits, `以下用户可见文案仍在用「任务」：\n${hits.join('\n')}`).toEqual([])
  })

  it('用户可见文案不得用「待办」指代事项（单独状态名「待办」除外）', () => {
    const hits = collectHits((text) => /待办/.test(text) && text !== '待办' && !/待办状态/.test(text) && !/待办\//.test(text))
    expect(hits, `以下用户可见文案仍在用「待办」指代事项：\n${hits.join('\n')}`).toEqual([])
  })

  it('用户可见文案不应暗示事项可以没有项目', () => {
    const hits = collectHits((text) => /未归入项目/.test(text))
    expect(hits, `以下文案仍在使用“未归入项目”：\n${hits.join('\n')}`).toEqual([])
  })

  it('扫描器能覆盖多行 JSX、文案模板及 TS 元数据字段', () => {
    const sample = `const view = <button>\n  + 添加任务\n</button>; const TYPE_META = { task: { label: '任务' } }; flash(\`已转为待办「\${title}」\`)`
    const strings = extractUserStrings('fixture.tsx', sample)
    expect(strings).toContain('+ 添加任务')
    expect(strings).toContain('任务')
    expect(strings).toContain('已转为待办「 」')
  })
})
