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
ok('改完再读回来（清掉第 5 面的未回读标记）', ex('read', { file_path: 'D:/tmp/b.md' }))

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

// 6) 判据证据（第 4 面）：todo 条目文本里写了判据命令，必须本会话真跑过，才准标成 completed。
//    没写判据形态的条目一律不管——拦太宽会把正常活挡死。
const agentC = { id: 'a3' }
ok('建一条带判据的清单', ex('todo_write', { todos: [{ content: '跑 node checks/all.mjs 到全绿', status: 'in_progress' }] }, agentC))
const r2 = no('没跑判据就标完成', ex('todo_write', { todos: [{ content: '跑 node checks/all.mjs 到全绿', status: 'completed' }] }, agentC))
ok('真跑了判据', ex('ops_bash', { command: 'cd D:/ws && node checks/all.mjs' }, agentC))
ok('跑过之后标完成放行', ex('todo_write', { todos: [{ content: '跑 node checks/all.mjs 到全绿', status: 'completed' }] }, agentC))
ok('没有判据形态的条目不受管', ex('todo_write', { todos: [{ content: '整理文档', status: 'completed' }] }, agentC))
no('npm test 同样受管', ex('todo_write', { todos: [{ content: 'npm test 要全绿', status: 'completed' }] }, agentC))
const agentD = { id: 'a4' }
no('别的 agent 跑过不算数', ex('todo_write', { todos: [{ content: '跑 node checks/all.mjs 到全绿', status: 'completed' }] }, agentD))
ok('它自己跑过就行', ex('ops_bash', { command: 'node checks/all.mjs --filter x' }, agentD))
ok('这回标完成放行', ex('todo_write', { todos: [{ content: '跑 node checks/all.mjs 到全绿', status: 'completed' }] }, agentD))

// 7) 收尾回读（第 5 面）：本会话改过的文件，改完没再读过，就不许把清单标完成。
const agentE = { id: 'a5' }
const edited = 'D:/tmp/edited.md'
ok('先读一次', ex('read', { file_path: edited }, agentE))
ok('edit 改它', ex('edit', { file_path: edited }, agentE))
ok('建一条清单', ex('todo_write', { todos: [{ content: '改完文档', status: 'in_progress' }] }, agentE))
no('改完没回读就标完成', ex('todo_write', { todos: [{ content: '改完文档', status: 'completed' }] }, agentE))
ok('把改过的文件读回来', ex('read', { file_path: edited }, agentE))
ok('回读之后标完成放行', ex('todo_write', { todos: [{ content: '改完文档', status: 'completed' }] }, agentE))
ok('只读不改的文件不拦', ex('read', { file_path: 'D:/tmp/untouched.md' }, agentE))
ok('write 新建（磁盘上没有）不算改过', ex('write', { file_path: path.join(process.env.TEMP, 'bg-fresh-' + Date.now() + '.md') }, agentE))

console.log('behavior-guard 逻辑测试：全部通过')
console.log('清单停滞拒绝理由样例：' + (logs.find((l) => l.includes('清单停滞')) ?? '（无）'))
console.log('判据证据拒绝理由样例：' + r2)
console.log('拒绝理由样例：' + r1)
console.log('日志条数：' + logs.length)
