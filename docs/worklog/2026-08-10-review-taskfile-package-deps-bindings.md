# 2026-08-10 Review #24270 Taskfile package 补 deps:[bindings] (APPROVE, Task #24271)

**起因**:Task #24271 对 #24270(2 commit:`d029880` 功能 + `a8fabca` worklog)做
Frontend Reviewer 端到端验收。改动是 1 行 Taskfile YAML(顶层 `package` 任务加
`deps: [bindings]`),不触碰任何 `frontend/src/` 代码 —— 但 `bindings` 的产物
(`frontend/bindings/**/*`,Go 方法 → TS 类型)是前端消费的,故 binding 生成管道的
正确性在本审查范围内(Wails bindings correctness)。

## 复审范围

- `Taskfile.yml` 顶层 `package`(L23-27):新增 `deps: [bindings]`(L25),字段顺序
  与 `build`(L17-21)、`dev`(L39-43)一致:`summary` → `deps: [bindings]` → `cmds`。

## 正确性 ✅

### YAML 结构对齐 ✅

三任务逐字段比对,字段名 / 顺序 / 缩进(2 空格)字符级一致:

| 任务 | summary | deps | cmds |
|---|---|---|---|
| `build`(L17) | ✅ | `[bindings]`(L19) | `task: {{OS}}:build` |
| `package`(L23) | ✅ | `[bindings]`(L25,**本次新增**) | `task: {{OS}}:package` |
| `dev`(L39) | ✅ | `[bindings]`(L41) | `wails3 dev ...` |

Taskfile v3 `deps` 在 `cmds` 前并行执行,语义正确。✅

### 顶层 `bindings` 任务存在且可用 ✅

被引用的 `bindings` 任务定义在同文件 L34-37(`wails3 generate bindings`),
与 `build`/`dev` 引用的是同一任务,引用名拼写正确。✅

### 对前端 binding 产物的影响(本审查核心)✅

`bindings` 生成 `frontend/bindings/**/*`(TS 类型,不入库,前端 import)。本次
`deps: [bindings]` 确保打包前先跑一次 `wails3 generate bindings`。无论经此 dep
还是经下方 §观察#1 的 transitive 链,打包前 bindings 已是 fresh —— 前端类型对齐
有保障。✅

## 幂等性 / 无重复生成风险 ✅

`bindings`(顶层,无 flag)与 `common:generate:bindings`(build 链内,带
`-clean=true -ts -i -f`)是**两个不同任务**,但都跑 `wails3 generate bindings`。
顶层 dep 先跑(无 `-clean`,增量),build 链的 `common:generate:bindings` 后跑
(`-clean=true`,先删后生)→ **最终落盘的是带 `-clean` 的 production 版**,
顶层 dep 的输出被覆盖。两套都 `run` 概念上幂等,无冲突 / 无残留风险。✅

## 观察项(非阻塞,不改)

### #1 worklog 的动机表述偏强(package 本已 transitive 生成 binding)

worklog 起因段称「直接 `task package`(尤其 CI / 新检出)会用到过期 / 缺失的
binding」。**经全链路追踪,此前提不准确**:package 在改动前已 transitive 生成
bindings:

```
package(顶层)
  → cmds: task {{OS}}:package
    → darwin:package(build/darwin/Taskfile.yml)
      → deps: task build
        → darwin:build → cmds: task build:native
          → build:native deps: common:build:frontend
            → common:build:frontend deps: common:generate:bindings
              → wails3 generate bindings -f '{BUILD_FLAGS}' -clean=true -ts -i
                 (run: once;sources=**/*.go 等,generates=frontend/bindings/**/*)
```

故即便**不加**顶层 `deps:[bindings]`,production 打包链内的
`common:generate:bindings`(`-clean=true`,带 BUILD_FLAGS)也会先删后生,
fresh 且是 production-flavored。

**严重度:无(仅表述)**。改动本身正确且无害(见上),真正的价值是**与 build/dev
的纯一致性**(三者都挂顶层 `bindings` dep),而非「修了一个会导致 stale binding
打包的 bug」。worklog 把「一致性改进」写成了「修复缺失」,不影响改动可合入性,
仅记录以免后人误读为「以前 package 真的会打 stale binding」。

### #2 顶层 `bindings`(无 flag)与 `common:generate:bindings`(带 flag)并存

顶层 `bindings` 跑裸 `wails3 generate bindings`(无 `-clean`/`-ts`/`-f`),
`common:generate:bindings` 跑 `-clean=true -ts -i -f '{{.BUILD_FLAGS}}'`。两者
产物形状可能不同(production flag 下生成的内容更贴 production 构建)。本次不动
这个现状(build/dev 同款,既有设计),仅记录:package 经此 dep 会先产出一版
「裸版」binding,随后被 build 链的 `-clean` 版覆盖 —— 最终落盘正确,但裸版 dep
本身基本是 no-op precursor。**非本次范围,不改**。

## 验证(acceptance gate)

1. 改动是纯 YAML 缩进 + 1 行新增,无 Go / TS / CSS 变更 → 无需 `tsc` / 单测 /
   lint。
2. 人工核对 `Taskfile.yml` L17-27 / L39-43 结构一致(见上表)。
3. 全链路追踪确认 package 的 transitive binding 生成路径存在(§观察#1)→
   即使 dep 是 belt-and-suspenders,也不会引入「stale binding 打包」回归。

## Verdict:APPROVE

改动最小、聚焦、无害:1 行 `deps: [bindings]` 让顶层 `package` 与 `build`/`dev`
结构对齐;YAML 缩进 / 字段顺序字符级一致;`bindings` 任务引用正确;前端 binding
产物在打包前为 fresh(经 dep 或经 transitive 链);两套 bindings 任务幂等无冲突。
worklog 动机表述偏强(package 本已 transitive 生成 binding),但改动本身是合理的
一致性改进,不影响合入。建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-taskfile-package-deps-bindings.md`(本条,新增)。
