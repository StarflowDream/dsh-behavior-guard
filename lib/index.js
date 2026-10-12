// dsh-behavior-guard — 把行为层里最容易忘的几条变成硬拦截。
//
// 为什么（2026-10-13）
// -------------------
// 行为层是软注入：第 36/37 条要求「改文件前先读它」，第 48/49 条要求「可能丢工作的动作先说清再确认」，
// 第 34/41/42 条要求「清单里每条做完就标、只用完全做成才算完成」。
// 我赶进度时能跳过它们，而跳过通常不会立刻报错——直到改错文件、删掉不该删的东西、或清单变成摆设。
// 这一层用 tools.guard 把它们挂成硬闸：跳过就当场被拒，理由写在拒绝消息里。
//
// 拦三件事
// --------
// 1) 未读直改：edit / write 的目标文件本会话没 read 过就拒绝；write 新建文件（磁盘上没有）放行，并记为已知。
// 2) 破坏性命令：shell 工具的命令命中「会丢工作」的写法就拒绝，理由里给可逆替代。
// 3) 清单停滞：建过 todo 清单且还有未完成条目时，连续 15 次工具调用没更新它，就拒一次并要求先更新。
//
// 为什么不拦更多
// --------------
// tools.guard 只有「放行 / 拒绝」两态，没有询问通道（本会话的审批是自动拒绝）。
// 拦太宽会把正常活也挡住，所以只拦行为层已经写明正确做法、误伤概率最低的三类。

import fs from 'node:fs'

const READ_TOOLS = new Set(['read', 'ops_inspect_local_file', 'read_image'])
const WRITE_TOOLS = new Set(['edit', 'write'])
const SHELL_TOOLS = new Set(['ops_bash', 'pwsh', 'ops_run_background'])

/** 距上次 todo_write 经过多少次工具调用就提醒一次（只在清单里还有未完成条目时累加）。 */
const TODO_STALL_CALLS = 15

/** 会丢工作的写法：命中即拒绝，理由里给可逆替代。 */
const DESTRUCTIVE = [
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, why: '递归强制删除' },
  { re: /git\s+reset\s+--hard/, why: 'git reset --hard（未提交的改动直接没了）' },
  { re: /git\s+clean\s+-[a-zA-Z]*[df]/, why: 'git clean（删掉未跟踪文件）' },
  { re: /git\s+push\b[^\n]*\s(-f|--force)\b/, why: 'force push（覆盖远端历史）' },
  { re: /Remove-Item[^\n]*-Recurse[^\n]*-Force|Remove-Item[^\n]*-Force[^\n]*-Recurse/, why: 'Remove-Item 递归强删' },
  { re: /\b(Stop-Process|taskkill\b[^\n]*\/f)/, why: '杀进程' },
  { re: /\b(format\s+[a-zA-Z]:|diskpart\b)/, why: '格式化 / 分区' },
]

const norm = (p) =>
  String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
    .trim()

const fileArgOf = (args) => args?.file_path ?? args?.path

/** 从 todo_write 的参数里数出还没完成的条数。 */
const openTodos = (args) => {
  const list = Array.isArray(args?.todos) ? args.todos : []
  return list.filter((t) => String(t?.status ?? '') !== 'completed').length
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return () => {}

  /** agent -> Set(本会话读过、或由本 agent 新建出来的路径)，按 agent 隔离；agent 没了条目自动回收。 */
  const readByAgent = new WeakMap()

  /** 记成「已知现状」：read 过的文件、以及刚被本 agent 新建出来的文件。 */
  const remember = (agent, p) => {
    let set = readByAgent.get(agent)
    if (set === undefined) {
      set = new Set()
      readByAgent.set(agent, set)
    }
    set.add(p)
  }
  /** agent -> { open, since }：清单里还剩几条未完成、距上次更新过了多少次工具调用。 */
  const todoByAgent = new WeakMap()

  const log = (kind, detail) => {
    try {
      ctx.logger?.info?.(`dsh-behavior-guard: 拦下 ${kind} —— ${detail}`)
    } catch {}
  }

  const guard = (exec) => {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const args = exec?.arguments ?? {}
    const agent = exec?.agent
    const perAgent = agent !== undefined && agent !== null

    if (READ_TOOLS.has(name)) {
      const p = norm(fileArgOf(args))
      if (p !== '' && perAgent) remember(agent, p)
      return undefined
    }

    if (name === 'todo_write') {
      if (perAgent) todoByAgent.set(agent, { open: openTodos(args), since: 0 })
      return undefined
    }

    if (perAgent) {
      const st = todoByAgent.get(agent)
      if (st !== undefined && st.open > 0) {
        st.since += 1
        if (st.since >= TODO_STALL_CALLS) {
          st.since = 0
          log('清单停滞', `${st.open} 条未完成、${TODO_STALL_CALLS} 次工具调用没更新`)
          return (
            `dsh-behavior-guard: 任务清单里还有 ${st.open} 条没完成，已经 ${TODO_STALL_CALLS} 次工具调用没更新过它。` +
            `先用 todo_write 把做完的标掉、或把不做的删掉，再继续——清单不更新，它就从进度表变成摆设。`
          )
        }
      }
    }

    if (WRITE_TOOLS.has(name)) {
      const raw = fileArgOf(args)
      const p = norm(raw)
      if (p === '') return undefined
      const read = perAgent ? readByAgent.get(agent) : undefined
      if (read !== undefined && read.has(p) === true) return undefined
      // 新建文件没有「现状」可读：只有 write、且磁盘上确实没有它，才放行。
      if (name === 'write' && typeof raw === 'string' && fs.existsSync(raw) === false) {
        // 刚新建出来的文件，「现状」就是我写下去的内容：记成已知，免得紧接着 edit 自己建的文件被拦。
        if (perAgent) remember(agent, p)
        return undefined
      }
      log('未读直改', `${name} ${raw}`)
      return (
        `dsh-behavior-guard: 这个文件本次会话还没读过（${raw}）。` +
        `先 read 它、看清现状再改——不知道现状就动手，等于赌旧内容还在。` +
        `（新建文件用 write 不受这条限制。）`
      )
    }

    if (SHELL_TOOLS.has(name)) {
      const command = String(args.command ?? args.script ?? '')
      if (command === '') return undefined
      for (const { re, why } of DESTRUCTIVE) {
        if (re.test(command) !== true) continue
        log('破坏性命令', why)
        return (
          `dsh-behavior-guard: 这条命令是「${why}」，可能把未提交的改动或别人的工作一起带走。` +
          `换成可逆写法（先备份 / 先 stash / 只删点名的那一个路径），或者先问过用户再动。` +
          `真要执行就把目标缩到明确的一个，别用通配。`
        )
      }
    }

    return undefined
  }

  try {
    ctx.inject(['tools'], (child) => {
      child.effect(() => child.tools.guard(guard))
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-behavior-guard: 硬闸没挂上（${String(error?.message ?? error)}）`)
  }

  return () => {}
}
