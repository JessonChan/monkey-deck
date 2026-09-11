# 2026-09-10 release-ci-layer6-211

## 起因

v0.1.1 Release(tag 触发)两个打包 job 失败(CI 洋葱第六层,#211 用户直报):

- **(a) Linux job**:"EXTRA_TAGS 引用错误"。
- **(b) Windows job**:`makensis` 不在 PATH(尽管 release.yml 已有 `choco install nsis -y`)。

Orchestrator 前置核实已纠正 issue 的 `.goreleaser.yaml` 假设:打包机制是 Taskfile 链(release.yml Linux job → `wails3 task linux:package` → `build/linux/Taskfile.yml`),并把修法框定为「EXTRA_TAGS 未进上下文,补默认值或显式传参二选一」。**本文记录的实查结论进一步纠正了该假设**。

## 根因

### (a) Linux:不是「变量未进上下文」,是模板条件式语法错误

`build/linux/Taskfile.yml:64`(`build:native` 的 `BUILD_FLAGS` var)有两处畸形条件式:

```
{{if .EXTRA_TAGS ","}}   ← linux:64,production 分支与 DEV 分支各一处
```

Go text/template 里这会把 `,` 当**参数**传给字段 `.EXTRA_TAGS`,执行期报
`EXTRA_TAGS is not a method but has arguments`——即 CI 里的「EXTRA_TAGS 引用错误」。
**未传参调用即触发**(条件式本身的求值错误,与变量有没有值无关)。

关键证据链:

1. **真引擎复现**(/tmp 最小 Taskfile,原样拷贝 linux:64 字符串,wails3 task 运行):
   未传参调用 → 上述报错,exit 1;DEV 分支一处同报错(col 121)/production 分支一处(col 289)。
2. **孪生对照**:`build/darwin/Taskfile.yml:51`、`build/windows/Taskfile.yml:60` 同形位置均为正确形式
   `{{if .EXTRA_TAGS}},{{end}}` / `{{if .EXTRA_TAGS}},{{.EXTRA_TAGS}}{{end}}`。
3. **CI 旁证「未定义渲染空串」**:v0.1.1 Windows job 的模板链全程走通(go build 成功后
   才死在 makensis)——`windows:package` 调用链同样未传 EXTRA_TAGS,若 undefined 报错
   或渲染 `<no value>`,go build 的 `-tags` 会先炸。故「补默认空值声明」「显式传
   EXTRA_TAGS=\"\"」两个候选修法**都治不了这个语法错误**,且属死代码,不加。
4. **引入点**:`git blame` → ba8e224(2026-09-01 unified-installer-linux-release,
   手工对齐 darwin BUILD_FLAGS 补 `-X main.currentVersion` 时引入笔误)。

### (b) Windows:choco 装成功,但 NSIS 安装器不自写 PATH + job 进程环境不刷新

- `choco install nsis -y` 步骤本身成功(exit 0,无吞码、无 choco 源失败)。
- NSIS 官方安装器历来**不把自己加进 PATH**(NSIS 官方论坛 t-366110 确认),Chocolatey
  包装继承该行为;makensis 落在 `C:\Program Files (x86)\NSIS\makensis.exe`。
- choco 改的是**注册表级机器 PATH**;job 的进程环境在 runner 启动时捕获,后续 step
  不可见 → `windows:package` 里裸 `makensis` 查 PATH 失败。教科书级 choco+GHA 坑,
  标准修法就是 `GITHUB_PATH`。

### darwin 孪生核验:非同雷

- 语法正确(见上对照);且本地 `wails3 task darwin:build -dry` 未传参实跑通过,
  BUILD_FLAGS 渲染为 `-tags production -trimpath -buildvcs=false -ldflags="…"`。
  darwin 孪生**无需改动**。

## 决策与取舍

| 项 | 选择 | 理由 |
|---|---|---|
| 修法 a | 修 linux:64 两处条件式为孪生形式 | 唯一根因;补默认值/显式传参治不了语法错误且是死代码 |
| 修法 b | choco 后 `Add-Content $env:GITHUB_PATH "C:\Program Files (x86)\NSIS"` | 一行自修达意(KISS);不引第三方 NSIS action(少一个供应链面) |
| Windows 产物 | 保持 NSIS installer.exe,**不降级 portable zip** | NSIS 对安装器产物是必须的,PATH 修掉即绿,无降级理由 |
| checkout bump | 仅 v4→v5(4 处 job) | 任务指定仅升警告点名项;其余 action 不全量 bump |
| ci.yml / Go 代码 | 零改动 | 红线 |

## 实现(改了哪些文件)

- `build/linux/Taskfile.yml`(ce93a01):64 行两处 `{{if .EXTRA_TAGS ","}}` →
  `{{if .EXTRA_TAGS}},{{end}}` / `{{if .EXTRA_TAGS}},{{.EXTRA_TAGS}}{{end}}`;
  加 4 行英文注释防回归(§3.7)。
- `.github/workflows/release.yml`(07b07bf):`Install Wails3 CLI + NSIS` step 末尾追加
  GITHUB_PATH 导出(默认 shell=pwsh,用 `Add-Content` 避免 `>>` 编码坑)。
- `.github/workflows/release.yml`(89fde9c):checkout v4→v5 ×4(build-macos /
  build-windows / build-linux / release)。

## 验证

- **EXTRA_TAGS 链复现(真引擎)**:/tmp 最小 Taskfile + `wails3 task`:
  修前未传参调用 → `template: :1:289: executing "" at <.EXTRA_TAGS>: EXTRA_TAGS is
  not a method but has arguments`(exit 1);修后四态全绿——未传参 production 分支
  (`-tags production -trimpath …`)、传参 `EXTRA_TAGS=mytag1,mytag2`(`-tags
  production,mytag1,mytag2`)、DEV+OBFUSCATED 未传参(`-tags wails_obfuscated …`)、
  DEV+OBFUSCATED 传参(`-tags wails_obfuscated,x`)。
- **仓库级实跑解析**:`wails3 task -list-all` exit 0(四个 include 的 Taskfile 全部解析);
  `darwin:build -dry` exit 0(未传参,BUILD_FLAGS 正确渲染);`windows:package -dry`
  exit 0(go build + makensis 命令完整渲染);`linux:build -dry` 在本机 mac 走
  build:docker 分支、止于 wails-cross 镜像未建的 precondition(本机环境限制,非本次
  回归;CI ubuntu + gcc 走的 native 分支已由 /tmp 精确字符串复现覆盖)。
- **workflow YAML 解析**:ruby YAML.load_file 通过,4 job 结构完整,checkout@v4 残留 0。
- **改动面核对**:`git diff --stat` 仅上述两文件;ci.yml / Go / 前端零触碰(无 Go/
  前端改动,go build/vet、npm build 门不适用)。
- 附注:sum.golang.org 校验失败=网络抖动,按任务给定不处理。

## 下一步

- **Release 实跑绿留人**:push tag(如 v0.1.2)触发 Release workflow 三个打包 job 全绿
  (本任务不 push,红线不变)。
- 若 CI 日志里 Node20 警告还点名其他 action(setup-go/setup-bun/upload-artifact 等),
  下轮单独升,不做全量 bump。
- 上游 wails3 模板若同款 linux Taskfile 仍带畸形条件式,可顺手报上游(本文未核实上游
  alpha2.106 模板现状)。
