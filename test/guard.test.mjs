// dsh-behavior-guard 的逻辑测试：不装插件，直接把 guard 函数拿出来喂假 exec。
// 用法：node test/guard.test.mjs（或 npm test）
import assert from 'node:assert'
import path from 'node:path'
import { apply } from '../lib/index.js'

const here = path.resolve(import.meta.dirname, '..')

let guard
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  inject: (_deps, cb) => {
    cb({
      effect: (fn) => {
        fn()
        return () => {}
      },
      tools: {
        guard: (fn) => {
          guard = fn
          return () => {}
        },
      },
    })
  },
}

apply(ctx, {})
assert.equal(typeof guard, 'function', 'guard 没挂上')

const agent = { id: 'a1' }
const ex = (name, args, ag = agent) => ({ name, arguments: args, agent: ag })
const ok = (label, e) => assert.equal(guard(e), undefined, label + ' 应放行')
const no = (label, e) => {
  const r = guard(e)
  assert.equal(typeof r, 'string', label + ' 应拒绝')
  return r
}

// 1) 未读直改
no('edit 未读文件', ex('edit', { file_path: 'D:/tmp/b.md' }))
ok('read 放行', ex('read', { file_path: 'D:/tmp/b.md' }))
ok('edit 读过的文件', ex('edit', { file_path: 'D:/tmp/b.md' }))
ok('反斜杠路径也算读过', ex('edit', { file_path: 'D:\\tmp\\b.md' }))

// 2) 新建放行 / 已存在未读拒绝
const notThere = path.join(process.env.TEMP, 'bg-not-there-' + Date.now() + '.md')
ok('write 新建文件', ex('write', { file_path: notThere }))
no('write 已存在且未读', ex('write', { file_path: path.join(here, 'package.json') }))

// 3) 破坏性命令
ok('git status', ex('ops_bash', { command: 'git status' }))
const r1 = no('rm -rf', ex('ops_bash', { command: 'rm -rf /tmp/x' }))
no('Remove-Item 递归强删', ex('pwsh', { command: 'Remove-Item "D:\\x" -Recurse -Force' }))
no('git reset --hard', ex('ops_bash', { command: 'git reset --hard HEAD~1' }))
no('git clean -fdx', ex('ops_bash', { command: 'git clean -fdx' }))
no('force push', ex('ops_bash', { command: 'git push origin main --force' }))
no('杀进程', ex('pwsh', { command: 'Stop-Process -Id 1234' }))
ok('删单个文件（非递归强制）', ex('ops_bash', { command: 'rm /tmp/one.txt' }))

// 4) 按 agent 隔离
no('另一个 agent 不算读过', ex('edit', { file_path: 'D:/tmp/b.md' }, { id: 'a2' }))

// 5) 清单停滞（15 次工具调用没更新就拦一次）
ok('建清单', ex('todo_write', { todos: [{ content: 'x', status: 'in_progress' }] }))
for (let i = 0; i < 14; i++) ok(`第 ${i + 1} 次调用放行`, ex('ops_bash', { command: `echo ${i}` }))
no('第 15 次调用被拦', ex('ops_bash', { command: 'echo 15' }))
ok('更新清单后重新计数', ex('todo_write', { todos: [{ content: 'x', status: 'completed' }] }))

console.log('behavior-guard 逻辑测试：全部通过（18 条断言）')
console.log('拒绝理由样例：' + r1)
console.log('日志条数：' + logs.length)
