/**
 * Unit tests for the host half's pure helpers.
 *
 * The model call and the HTTP route need a live host, so they are exercised by
 * hand against a running profile; everything that shapes the prompt, the
 * context selection and the model output is covered here.
 */
import {
  anchorsOf,
  buildUserText,
  chunkText,
  flattenMessage,
  scoreAgainst,
  selectContext,
  unwrap,
} from '../lib/index.js'

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

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

console.log('== 1. flattenMessage ==')
check('text block → role-prefixed line', flattenMessage(user('你好')) === 'user: 你好')
check('tool call → placeholder', flattenMessage({ role: 'assistant', content: [{ type: 'tool-call', name: 'read' }] }) === 'assistant: [called tool read]')
check('tool result → placeholder', flattenMessage({ role: 'assistant', content: [{ type: 'tool-result' }] }) === 'assistant: [tool result]')
check('no content → empty', flattenMessage({ role: 'user' }) === '')
check('null-safe', flattenMessage(null) === '')

console.log('== 2. anchorsOf ==')
const anchors = anchorsOf('把 `src/auth/login.ts` 里的 validateEmail 校验改严一点，"邮箱格式" 要卡住')
check('backticked path is an anchor', anchors.includes('src/auth/login.ts'))
check('identifier is an anchor (lowercased)', anchors.includes('validateemail'))
check('quoted phrase is an anchor', anchors.includes('邮箱格式'))
check('cjk bigram is an anchor', anchors.includes('邮箱'))
check('stopword-free：不再保留 “这个/可以”', !anchors.includes('这个') && !anchors.includes('可以'))
check('no anchors for empty draft', anchorsOf('').length === 0)

console.log('== 3. scoreAgainst ==')
check('matching message scores higher than unrelated', scoreAgainst(anchors, 'user: 登录表单的 validateEmail 在 src/auth/login.ts') > scoreAgainst(anchors, 'user: 数据库迁移跑完了吗'))
check('empty anchors score 0', scoreAgainst([], 'anything') === 0)
check('empty text scores 0', scoreAgainst(anchors, '') === 0)

console.log('== 4. selectContext：会话里夹着别的任务 ==')
// 前面 2 条是「登录表单」任务，后面 8 条是插进来的「数据库迁移」任务。
const mixed = [
  user('帮我把登录表单的校验改严一点，邮箱要校验格式'),
  assistant('好的，我改了 login form 的 validateEmail，路径 src/auth/login.ts'),
  user('数据库迁移的脚本先跑一遍'),
  assistant('跑完了，postgres 迁移文件在 db/migrations/0007.sql'),
  user('迁移失败了，回滚一下'),
  assistant('已回滚 postgres 到上一个版本'),
  user('那备份呢'),
  assistant('备份在 /backup/pg-20261027.dump'),
  user('顺便看下磁盘占用'),
  assistant('磁盘占用 42GB，主要是 postgres 数据目录'),
]
const draft = '把登录表单的 validateEmail 再严格一些'
const picked = selectContext(mixed, draft, { limit: 4, scan: 20 })
const pickedText = picked.map(flattenMessage).join('\n')
check('选中了更早的“登录表单”消息（尽管最新的是别的任务）', pickedText.includes('登录表单'), pickedText.slice(0, 80))
check('选中了那条实现的回复', pickedText.includes('validateEmail'))
check('保留最新两条（可能是即时追问的上下文）', pickedText.includes('磁盘占用'))
check('条数不超过 limit', picked.length <= 4, String(picked.length))
check('输出按时间顺序（最旧在前）', flattenMessage(picked[0]).includes('登录表单'), flattenMessage(picked[0]).slice(0, 40))

console.log('== 5. selectContext：边界 ==')
check('空数组 → 空', selectContext([], 'anything').length === 0)
check('全部无关时退回最近 limit 条', selectContext(
  [user('aaa'), user('bbb'), user('ccc'), user('ddd')],
  '完全无关的内容 zzz',
  { limit: 2, scan: 10 },
).length === 2)
const single = selectContext([user('唯一一条')], '唯一', { limit: 6, scan: 10 })
check('只有一条时保持一条', single.length === 1)
check('超长消息被裁剪（sessionContext 的 clip 在拼接处处理，这里只保证不抛）', selectContext(
  [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(50_000) }] }],
  'x'.repeat(10),
  { limit: 2, scan: 2 },
).length === 1)

console.log('== 6. buildUserText ==')
const withContext = buildUserText('改写这句', 'user: 上下文')
check('提到“可能是别的任务、可以忽略”', /other tasks/i.test(withContext) && /ignore it/i.test(withContext))
check('context 在前，草稿在后', withContext.indexOf('Conversation extract') < withContext.indexOf('Draft to rewrite:'))
check('草稿是最后一块', withContext.endsWith('Draft to rewrite:\n改写这句'))
const withoutContext = buildUserText('rewrite me', '')
check('无上下文时只有草稿', withoutContext === 'Draft to rewrite:\nrewrite me')

console.log('== 7. unwrap ==')
check('plain text untouched', unwrap('  keep me  ') === 'keep me')
check('markdown fence stripped', unwrap('```md\nfixed text\n```') === 'fixed text')
check('double quotes stripped', unwrap('"fixed text"') === 'fixed text')
check('cjk quotes stripped', unwrap('“fixed text”') === 'fixed text')
check('inner quotes kept', unwrap('say "hi" to me') === 'say "hi" to me')
check('empty stays empty', unwrap('') === '')

console.log('== 8. chunkText ==')
check('delta text', chunkText({ type: 'text', text: 'ab' }) === 'ab')
check('nested delta', chunkText({ type: 'delta', delta: { text: 'cd' } }) === 'cd')
check('other chunk → empty', chunkText({ type: 'finish', reason: { kind: 'stop' } }) === '')
check('null-safe chunk', chunkText(null) === '')

console.log(`\n结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
