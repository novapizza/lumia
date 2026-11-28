import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* The browser extension can't import the app's colour roles (no build
   step), so it keeps its own copies for the time before the app has sent
   its theme: the popup's `:root` variables and DEFAULT_ROLES in
   background.js. The Drive pages' status roles (electron/browser-page.ts)
   are a third copy. This keeps all of them equal to src/index.css. */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')

/** --color-* values from src/index.css: dark = @theme, light = html.light
 *  over dark. */
function cssRoles(): Record<'dark' | 'light', Record<string, string>> {
  const css = read('../src/index.css')
  const block = (start: string) => {
    const i = css.indexOf(start)
    const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i))
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
    return out
  }
  const dark = block('@theme {')
  return { dark, light: { ...dark, ...block('html.light {') } }
}

/** The text between the `{` after `start` and its matching `}`. */
function braces(text: string, start: string): string {
  const from = text.indexOf('{', text.indexOf(start))
  assert.ok(from > 0, `${start} not found`)
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(from + 1, i)
  }
  throw new Error(`${start}: no closing brace`)
}

function check(name: string, got: Record<string, string>, want: Record<string, string>) {
  assert.ok(Object.keys(got).length > 0, `${name}: no roles found`)
  for (const [role, value] of Object.entries(got)) {
    assert.ok(role in want, `${name}: ${role} is not a role in src/index.css`)
    assert.equal(norm(value), norm(want[role]), `${name} ${role}`)
  }
}

test("the extension popup's fallback roles match src/index.css", () => {
  const css = cssRoles()
  const html = read('../extension/popup.html')
  const vars = (body: string) => {
    const out: Record<string, string> = {}
    // --icon-line is the popup's own (an icon's line width), not a role.
    for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) if (m[1] !== 'icon-line') out[m[1]] = m[2]
    return out
  }
  const dark = vars(braces(html, ':root {'))
  const light = vars(braces(braces(html, '@media (prefers-color-scheme: light)'), ':root {'))
  check('popup dark', dark, css.dark)
  check('popup light', { ...dark, ...light }, css.light)
})

test("the extension's DEFAULT_ROLES match src/index.css", () => {
  const css = cssRoles()
  const table = braces(read('../extension/background.js'), 'const DEFAULT_ROLES =')
  const roles = (body: string) => {
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/'([\w-]+)':\s*'([^']+)'/g)) out[m[1]] = m[2]
    return out
  }
  check('DEFAULT_ROLES dark', roles(braces(table, 'dark:')), css.dark)
  check('DEFAULT_ROLES light', roles(braces(table, 'light:')), css.light)
})

test("the Drive pages' status roles match src/index.css", () => {
  const css = cssRoles()
  const table = braces(read('../electron/browser-page.ts'), 'const STATUS:')
  const roles = (body: string) => {
    const out: Record<string, string> = {}
    for (const m of body.matchAll(/'([\w-]+)':\s*'([^']+)'/g)) out[m[1]] = m[2]
    return out
  }
  check('STATUS dark', roles(braces(table, 'dark:')), css.dark)
  check('STATUS light', roles(braces(table, 'light:')), css.light)
})
