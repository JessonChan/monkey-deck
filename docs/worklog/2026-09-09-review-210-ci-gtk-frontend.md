# 2026-09-09 #210 review:CI frontend job GTK dev 依赖(APPROVE)

## 起因

审 #29240 产出(两笔已落本卡分支 agent/reviewer/3424a9ed):
`ea1959a`(.github/workflows/ci.yml 单文件 +9/-0,frontend job setup-go 后插入
「Install Linux GTK/WebKit dev deps」步)+ `5706017`(worklog
`docs/worklog/2026-09-09-ci-frontend-gtk-210.md`)。反相核实,不信 summary 叙事,
以 `git show` 实际内容 + 本机复跑验证为准。

## 核查清单结果(6/6 通过)

| # | 核查项 | 结果 | 证据 |
|---|---|---|---|
| ① | 四包名与 backend #204 步逐字一致 | ✅ | `diff <(sed -n 56p) <(sed -n 95p)` 空 → IDENTICAL(`libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev libglib2.0-dev`) |
| ② | 步骤位置 checkout→setup-go→GTK 安装→绑定生成(:107)之前 | ✅ | ruby 解析 `jobs.frontend.steps` 逐项打印,顺序恰为 checkout / setup-go / GTK / setup-bun / Install deps / Generate bindings / Type check + build |
| ③ | backend job 与 release.yml 零改动,纯插入 | ✅ | hunk 上下文 `@@ -84,6 +84,15 @@` 落在 frontend job 段(:72 起);`git diff -U0` 删除行计数 = 0;`git log 923d29f..5706017 -- release.yml` = 0 条;`git diff --name-only` 全程仅 ci.yml + worklog 两文件 |
| ④ | YAML 语法有效 | ✅ | 本机 `ruby -ryaml -e 'YAML.safe_load(...)'` 解析通过(独立复跑,非沿用实现方结论);并断言新步无 `if` 键(单 ubuntu-24.04 leg、无 matrix,省门正确) |
| ⑤ | 无越界改动 | ✅ | 923d29f..5706017 name-only 仅 2 个预期文件;permissions/concurrency/既有步零触碰 |
| ⑥ | worklog 在案且内容属实 | ✅ | 逐条核对:「+9/-0 纯插入」「:87-95=注释 5 行+步骤 4 行」「包名逐字 IDENTICAL」「新步无 if」「release.yml 零触及」均与 git 事实相符;`.rak/` 确在 .gitignore:44 |

## 语义审查(backend 视角)

- 修法方向正确且与 #204 既有先例一致:frontend 绑定步 `go run wails3@版本`
  现构建 CLI,linux 下 cgo 链接 GTK4/WebKitGTK,裸 runner 无 dev 头;复制已被
  runner 实证过的 backend 包列表是最低风险路径。runner 失败事实系用户直报,
  按 ground-truth 纪律不再复跑探针。
- 省略 `if: matrix.goos == 'linux'` 正确:frontend job 无 matrix(ci.yml :72-75),
  门恒真,留着只是噪音;注释已说明取舍。
- 位置在 setup-bun 之前合理:环境依赖越早装,失败越早暴露;apt 步与 bun 无耦合。
- 非「类型补丁」:该步是同一 job 内 :107 绑定步的真实前置消费者,插入即生效,
  不存在「加了没人用」的通路。

## 结论

**APPROVE**。CI 实跑绿按任务口径留人观察,不在本卡范围。

## 下一步 / 留人

- 本卡停 completed-ready:不 push、不关 issue(#210)、不派后续。
- 留人:GitHub Actions frontend job 实跑绿确认。
