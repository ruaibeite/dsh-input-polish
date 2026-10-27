/**
 * Smoke test for the browser half's entry shape.
 *
 * It cannot render React (no DOM), but it proves the three things that decide
 * whether the button ever appears in a running app:
 *   1. the bundle registers itself through `window.__ModuleLoader__.load` under
 *      the package id the host expects;
 *   2. it asks for nothing beyond React from the module table;
 *   3. `apply(ctx)` registers into `conversation.input.right` with a list-slot
 *      `id` and the component function.
 */
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  ❌ ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Minimal React stand-in: the factory only builds elements and calls hooks. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

const defs = []
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
define('window', { __ModuleLoader__: { load: (definition) => defs.push(definition) } })
define('document', {
  getElementById: () => null,
  createElement: () => ({ set id(v) {}, set textContent(v) {}, set type(v) {} }),
  head: { appendChild: () => {} },
})
define('navigator', { language: 'zh-CN' })
define('fetch', () => Promise.reject(new Error('not used in this test')))

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
new Function(source)()

console.log('== 1. 外壳 ==')
check('调用了 __ModuleLoader__.load 一次', defs.length === 1)
check('id 等于包名', defs[0]?.id === '@ruaibeite/dsh-input-polish', defs[0]?.id)

console.log('== 2. 工厂 ==')
const requested = []
const module = defs[0].factory((name) => {
  requested.push(name)
  if (name === 'react') return ReactStub
  throw new Error(`unexpected module: ${name}`)
})
check('只 require 了 react', requested.length === 1 && requested[0] === 'react', requested.join(', '))
check('导出 apply', typeof module.apply === 'function')
check('导出 inject 数组且只含 slots', Array.isArray(module.inject) && module.inject.length === 1 && module.inject[0] === 'slots')

console.log('== 3. 注册 ==')
const registrations = []
const injections = []
const ctx = {
  slots: {
    inject: (slot, run) => injections.push({ slot, run }),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
module.apply(ctx)
check('inject 到 conversation.input.right', injections.length === 1 && injections[0].slot === 'conversation.input.right', injections[0]?.slot)
injections[0].run()
check('注册了一次', registrations.length === 1)
const options = registrations[0]?.options ?? {}
check('槽位名正确', options.name === 'conversation.input.right', options.name)
check('list 槽位带 id', options.id === 'input-polish', options.id)
check('order 为 900（贴右）', options.order === 900, String(options.order))
check('注册了组件函数', typeof registrations[0]?.component === 'function')

console.log('== 4. 组件可调用（无 DOM 渲染能力，只验证不抛）==')
const component = registrations[0].component
const hooks = {
  sessionId: 'session-test',
  inputActions: { setDraft: () => {} },
  useInput: (selector) => selector({ draft: '把那个函数改快一点', phase: 'plain', occurrences: [] }),
}
let rendered
try {
  rendered = component(hooks)
} catch (error) {
  rendered = undefined
  failures.push(`组件调用抛错：${String(error?.message ?? error)}`)
}
check('返回一个 button 元素', rendered !== undefined && rendered.type === 'button', rendered === undefined ? undefined : rendered.type)
check('有草稿时可用（disabled=false）', rendered !== undefined && rendered.props.disabled === false)

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
