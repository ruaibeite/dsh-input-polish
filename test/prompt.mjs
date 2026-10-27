/**
 * Unit tests for the host half's pure helpers.
 *
 * The model call and the HTTP route need a live host, so they are exercised by
 * hand against a running profile; everything that shapes the prompt, the route
 * lookup inputs and the model output is covered here.
 */
import { buildUserText, chunkText, flattenMessage, unwrap } from '../lib/index.js'

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

console.log('== 1. flattenMessage ==')
check('text block → role-prefixed line', flattenMessage({ role: 'user', content: [{ type: 'text', text: '你好' }] }) === 'user: 你好')
check('tool call → placeholder', flattenMessage({ role: 'assistant', content: [{ type: 'tool-call', name: 'read' }] }) === 'assistant: [called tool read]')
check('tool result → placeholder', flattenMessage({ role: 'assistant', content: [{ type: 'tool-result' }] }) === 'assistant: [tool result]')
check('no content → empty', flattenMessage({ role: 'user' }) === '')
check('null-safe', flattenMessage(null) === '')

console.log('== 2. buildUserText ==')
const withContext = buildUserText('改写这句', 'user: 上下文')
check('context comes first', withContext.startsWith('Recent conversation'))
check('draft is the last block', withContext.endsWith('Draft to rewrite:\n改写这句'))
const withoutContext = buildUserText('rewrite me', '')
check('no context header when empty', withoutContext === 'Draft to rewrite:\nrewrite me')

console.log('== 3. unwrap ==')
check('plain text untouched', unwrap('  keep me  ') === 'keep me')
check('markdown fence stripped', unwrap('```md\nfixed text\n```') === 'fixed text')
check('double quotes stripped', unwrap('"fixed text"') === 'fixed text')
check('cjk quotes stripped', unwrap('“fixed text”') === 'fixed text')
check('inner quotes kept', unwrap('say "hi" to me') === 'say "hi" to me')
check('empty stays empty', unwrap('') === '')

console.log('== 4. chunkText ==')
check('delta text', chunkText({ type: 'text', text: 'ab' }) === 'ab')
check('nested delta', chunkText({ type: 'delta', delta: { text: 'cd' } }) === 'cd')
check('other chunk → empty', chunkText({ type: 'finish', reason: { kind: 'stop' } }) === '')
check('null-safe chunk', chunkText(null) === '')

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
