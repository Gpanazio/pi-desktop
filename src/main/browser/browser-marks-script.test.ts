import assert from 'node:assert/strict'
import test from 'node:test'
import { MARKS_BINDING, PAGE_SCRIPT, SELECTOR_LIB } from './browser-marks-script'

// A tiny DOM: just what the selector builder reads.
interface FakeEl {
  tagName: string
  localName: string
  id: string
  attrs: Record<string, string>
  parentElement: FakeEl | null
  children: FakeEl[]
  getAttribute(name: string): string | null
}

function el(tag: string, props: { id?: string; testid?: string } = {}, children: FakeEl[] = []): FakeEl {
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    localName: tag,
    id: props.id ?? '',
    attrs: props.testid !== undefined ? { 'data-testid': props.testid } : {},
    parentElement: null,
    children,
    getAttribute(name) {
      return this.attrs[name] ?? null
    },
  }
  for (const child of children) child.parentElement = node
  return node
}

/** Matches the selector shapes the builder emits: `[data-testid="x"]`, `#id`, and `a > b:nth-of-type(n)` chains. */
function matches(root: FakeEl, selector: string): FakeEl[] {
  const all: FakeEl[] = []
  const walk = (node: FakeEl): void => {
    all.push(node)
    node.children.forEach(walk)
  }
  walk(root)
  const steps = selector.split(' > ')
  const stepMatches = (node: FakeEl, step: string): boolean => {
    const nth = /^(.*):nth-of-type\((\d+)\)$/.exec(step)
    const base = nth ? nth[1] : step
    if (nth) {
      const same = (node.parentElement?.children ?? []).filter((c) => c.tagName === node.tagName)
      if (same.indexOf(node) + 1 !== Number(nth[2])) return false
    }
    if (base.startsWith('[data-testid="')) return node.attrs['data-testid'] === base.slice(14, -2).replace(/\\3e /g, '>')
    if (base.startsWith('#')) return node.id === base.slice(1)
    return node.localName === base
  }
  return all.filter((node) => {
    let current: FakeEl | null = node
    for (let i = steps.length - 1; i >= 0; i--) {
      if (!current || !stepMatches(current, steps[i])) return false
      current = current.parentElement
    }
    return true
  })
}

const selectorFor = new Function(`${SELECTOR_LIB}; return piSelectorFor;`)() as (el: FakeEl, isUnique: (selector: string) => boolean) => string

function build(root: FakeEl, target: FakeEl): string {
  return selectorFor(target, (selector) => matches(root, selector).length === 1)
}

test('data-testid wins over an id', () => {
  const target = el('button', { id: 'go', testid: 'submit' })
  const root = el('html', {}, [el('body', {}, [target])])
  assert.equal(build(root, target), '[data-testid="submit"]')
})

test('a unique id is used; a repeated id is not', () => {
  const unique = el('div', { id: 'main' })
  const root = el('html', {}, [el('body', {}, [unique, el('p')])])
  assert.equal(build(root, unique), '#main')
  const first = el('div', { id: 'dup' })
  const second = el('div', { id: 'dup' })
  const root2 = el('html', {}, [el('body', {}, [first, second])])
  assert.equal(build(root2, second), 'div:nth-of-type(2)')
})

test('the shortest unique tag path is used, with nth-of-type only where siblings share a tag', () => {
  const h1 = el('h1')
  const link = el('a')
  const root = el('html', {}, [el('body', {}, [el('div', {}, [h1, el('p', {}, [link])])])])
  assert.equal(build(root, h1), 'h1')
  assert.equal(build(root, link), 'a')
  const li1 = el('li')
  const li2 = el('li')
  const root2 = el('html', {}, [el('body', {}, [el('ul', {}, [li1, li2])])])
  assert.equal(build(root2, li2), 'li:nth-of-type(2)')
})

test('a path climbs only until it is unique, and anchors at an ancestor with a testid', () => {
  const a1 = el('a')
  const a2 = el('a')
  const nav = el('nav', { testid: 'top-nav' }, [el('ul', {}, [el('li', {}, [a1])])])
  const footer = el('footer', {}, [el('ul', {}, [el('li', {}, [a2])])])
  const root = el('html', {}, [el('body', {}, [nav, footer])])
  assert.equal(build(root, a1), '[data-testid="top-nav"] > ul > li > a')
  assert.equal(build(root, a2), 'footer > ul > li > a')
})

test('the page script is plain text that exposes the binding it calls', () => {
  assert.ok(PAGE_SCRIPT.includes(MARKS_BINDING))
  assert.doesNotThrow(() => new Function(PAGE_SCRIPT))
})

test('the blocked-event handler ignores synthetic events, so a page cannot forge a mark with el.click()', () => {
  const body = /function onBlocked\(e\) \{([\s\S]*?)\n\}/.exec(PAGE_SCRIPT)?.[1] ?? ''
  const guard = body.indexOf('!e.isTrusted')
  assert.ok(guard >= 0)
  assert.ok(guard < body.indexOf('pick(e)'))
  assert.ok(guard < body.indexOf('preventDefault'))
})

test('an SVG element keeps its camelCase name, so the selector matches it', () => {
  const gradient = el('linearGradient')
  gradient.tagName = 'linearGradient'
  const root = el('html', {}, [el('body', {}, [el('svg', {}, [el('defs', {}, [gradient])])])])
  assert.equal(build(root, gradient), 'linearGradient')
})

test('a ">" in an attribute value is escaped, so " >>> " inside a value cannot split the frame chain', () => {
  const target = el('button', { testid: 'a >>> b' })
  const root = el('html', {}, [el('body', {}, [target])])
  const selector = build(root, target)
  assert.equal(selector, '[data-testid="a \\3e \\3e \\3e  b"]')
  assert.equal(selector.includes('>'), false)
  assert.equal(selector.split(' >>> ').length, 1)
})

test('the page script refuses a pick from a frame it cannot reach the top of, and shields foreign frames', () => {
  const pick = /function pick\(e\) \{([\s\S]*?)\n\}/.exec(PAGE_SCRIPT)?.[1] ?? ''
  assert.ok(pick.indexOf('chainComplete') >= 0 && pick.indexOf('chainComplete') < pick.indexOf("send({"))
  assert.ok(PAGE_SCRIPT.includes('function refreshShields'))
  assert.ok(PAGE_SCRIPT.includes('paddingLeft'), 'the frame offset adds the iframe padding')
})
