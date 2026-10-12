# Changelog

## dsh-behavior-guard v0.1.0 — 2026-10-13

第一次公开。三个拦截面，一个钩子，零依赖。

### 拦三件事

- **未读直改**：`edit` / `write` 的目标文件本次会话没 `read` 过就拒绝。读工具白名单 `read` / `ops_inspect_local_file` / `read_image`；
  `write` 新建（磁盘上没有）直接放行并记为已知。状态按 agent 存 `WeakMap`，进程重启即清空。
- **破坏性命令**：`rm -rf`、`git reset --hard`、`git clean -f[d]`、force push、`Remove-Item … -Recurse … -Force`、
  `Stop-Process` / `taskkill /f`、`format` / `diskpart` 命中即拒，理由里给可逆替代。
- **清单停滞**：建过任务清单且还有未完成条目时，连续 15 次工具调用没更新它，就拒一次并要求先更新（计数随后归零）。

### 修过的坑（都是自测时当场撞上的）

- **write 自举**：第一版只把 `read` 过的路径记成"已知现状"，于是"`write` 新建文件 → 紧接着 `edit` 它"被自己拦了。
  改成新建也 `remember` 之后，同一会话里连续改一个文件才顺。拒绝消息里也补了这句说明。
- **按 agent 隔离**：起初想全局记路径，但子代理读过不等于主 agent 读过——改成 `WeakMap` 按 agent 存，
  主 agent 与每个子代理各有一份。

### 设计取舍

- `tools.guard` 只有两态（拒绝 / 放行），没有"询问"通道，所以只拦三类**行为层已写明正确做法、误伤概率最低**的动作；
  更宽的拦截会开始挡正常活，而挡正常活的守卫最后一定被关掉。
- 破坏性命令用正则匹配：防手滑，不防绕过（变量拼接、别名、子命令拼出来的写法拦不到），也不当安全边界用。
