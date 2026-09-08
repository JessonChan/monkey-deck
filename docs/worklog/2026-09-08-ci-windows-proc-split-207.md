# CI Windows proc 平台拆分(#207):syscall Unix 专有符号致 Windows 编译炸

## 起因

CI 洋葱第三层(用户直报):#203 embed stub + #204 Linux GTK 依赖解掉后,Windows backend job 终于编到 syscall 层,直接炸——`syscall.Getpgid`/`Setpgid`/`syscall.Kill(-pgid)` 均为 Unix 专有符号,windows 无此符号,`GOOS=windows go build` 失败。

基线实测(拆分前)恰好 7 个错误,与调用点清单一一对应:

- `internal/acp/proc.go`:Setpgid@47、`Kill(-pgid,SIGTERM)`@68、`Kill(-pgid,SIGKILL)`@74、活性探测 `kill(-pgid,0)`@80、`Kill(pid,SIGKILL)`@367
- `internal/terminal/service.go`:`Getpgid`@286、`Kill(-pgid,SIGKILL)`@287

## 根因

进程组语义(Setpgid/kill -PGID/kill(-pgid,0))是 POSIX 概念,直接内联在 proc.go 与 terminal/service.go 里,没有平台边界。修法(用户拍板):**平台文件拆分**——proc.go 主体只调平台 helper,helper 按 build tag 落平台文件;unix 侧零语义改动,windows 首版允许单进程 kill 退化。

## 改法

### internal/acp(proc_unix.go / proc_windows.go 新增,proc.go 瘦身)

- **proc_unix.go(`!windows`)**:现进程组逻辑原样迁入,零语义改动——`setProcGroup`(Setpgid 建独立进程组)、`termGroup`/`killGroup`(SIGTERM→SIGKILL 两段整组回收)、`groupAlive`(kill(-pgid,0) 活性探测)、`isNoProcess`(ESRCH)。另抽 `probeAlive`/`killProcessHard` 两个 helper(见下方「规格外平台层」)。
- **proc_windows.go(`windows`)**:无进程组语义;所有 "group" helper 退化为按登记 pgid(= harness 主 PID,见 `newHarnessProcess`:`pgid = cmd.Process.Pid`,windows 上无 Setpgid 但该登记值本身就是主 PID,退化自洽)的单进程 `os.Process.Kill`。文件头注释注明首版限制:**无法整组回收(组内子孙成孤儿)、SIGTERM→SIGKILL 两段塌缩为一次 TerminateProcess**;TODO(#207) 后续评估 Job Objects。活性探测用 `OpenProcess(SYNCHRONIZE)+WaitForSingleObject(0)`(WAIT_TIMEOUT=存活);`isNoProcess` 用 `os.ErrProcessDone` 等价 ESRCH。
- **proc.go**:删掉内联实现,只留平台无关编排(`signalGroupDead` 的 TERM→3s 轮询→KILL 流程、harnessProcess、pgidFile 注册表、reaper),顶部加注释指明 helper 落点;`reapStrayHarnesses`@367 改调 `killProcessHard(p.pid)`。

### internal/terminal(proc_unix.go / proc_windows.go 新增,service.go 调用点抽 helper)

- **proc_unix.go**:kill 路径现逻辑原样迁入 `killProcessGroup(cmd)`——`Getpgid` 成功则 `Kill(-pgid,SIGKILL)` 按组收,失败降级单进程 `Kill`(交互式 shell 自身是组长,pgid==pid)。
- **proc_windows.go**:无进程组 + 无 PTY SIGHUP 通道,退化为只杀 shell 主进程(注释说明首版限制);PTY/SIGHUP 清理路径在 windows 天然 no-op。
- **service.go**:kill() 内联 syscall 块换成 `killProcessGroup(ts.cmd)`,`syscall` import 移除。

### 规格外平台层(交叉编译/GOROOT 实证,按兜底条款逐条处理)

1. **`IsAlive` 的 `p.Signal(syscall.Signal(0))` 探活(proc.go:158)**:windows **编译能过**(syscall.Signal 类型存在)但语义错——GOROOT `src/os/exec_windows.go` 实证 `signal()` 对任何非 Kill 信号返回 `EWINDOWS`,活进程也会被判死 → windows 上 health watcher 会把活 harness 误判为死、触发无谓重连。同法 helper 化:`probeAlive(p)`(unix:signal 0 原样;windows:pidAlive 走 OpenProcess 探测)。
2. **`syscall.ESRCH` / `syscall.WaitStatus`(无需拆分,实证安全)**:windows 侧两者都有 invented 定义——ESRCH Errno 存在;`WaitStatus.Signaled()` 恒 false、`Signal()` 恒 -1(`src/syscall/syscall_windows.go`)。故 `exitCodeSignal` 的 WaitStatus 断言在 windows 恒 ok=false→sig="",天然安全,留在 proc.go 不拆(可移植类型断言,非平台调用);`isNoProcess` 仍按平台拆(unix 原样比较 ESRCH,windows 用 ErrProcessDone)。
3. **creack/pty**:windows 交叉编译可过(上游有 stub),无需处理;终端功能本身在 windows 首版不可用属已知限制。
4. **`listHarnessProcs` 的 `ps -eo pid=,pgid=`**:windows 无 ps → exec 失败返回 nil → reaper 安全 no-op(宁漏杀不误杀),未拆分,记为首版限制。

### 纪律说明

- 触及的旧中文注释(setProcGroup/termGroup/killGroup/groupAlive 的 doc comment、IsAlive、terminal kill)随迁移顺手转英文(§3.7);未触及的(signalGroupDead、reapStrayHarnesses 等)保持原样。
- 前端零改动,无 UI 回归面(§4.7:后端改动验证一次即可,三端无涉)。

## 改了哪些文件

- `internal/acp/proc.go`(瘦身,helper 化)
- `internal/acp/proc_unix.go`、`internal/acp/proc_windows.go`(新增)
- `internal/terminal/service.go`(kill 路径抽 helper)
- `internal/terminal/proc_unix.go`、`internal/terminal/proc_windows.go`(新增)

## 验证

- **GOOS=windows 交叉编译**:`go build . ./internal/...` + `go vet . ./internal/...` 全过(拆分前 7 错 → 拆分后 0 错)。
- **darwin 本机**:`go build ./...` + `go vet ./...` + `go test ./...` 全绿;`internal/acp` + `internal/terminal` 再 `-count=1` 显式重跑过(proc_exit_test / proc_pgidfile_test / service_test 零回归,unix 侧行为不变由既有测试背书)。
- **改动面**:`git status` 仅 6 个 Go 文件;dist stub / `.rak-env` 等运行时文件均被 gitignore,未混入。
- CI 实跑绿留人(Windows backend job)。

## 下一步

- reviewer 走流程;按流程不 push、不关 issue。
- windows 真机/CI 实跑后如需整组回收,评估 Job Objects(TODO 已落在 proc_windows.go / terminal/proc_windows.go 文件头)。
