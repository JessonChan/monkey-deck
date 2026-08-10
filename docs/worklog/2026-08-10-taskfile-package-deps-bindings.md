# 2026-08-10 Taskfile package 补 deps:[bindings]

## 起因
Task #24270。`build` 与 `dev` 都声明了 `deps: [bindings]`,保证构建前先重新生成
前端 binding(Go 方法 → TS 类型,不入库);但 `package` 漏了。直接 `task package`
(尤其 CI / 新检出)会用到过期 / 缺失的 binding,打包出前端类型对不上的产物。

## 改法
`Taskfile.yml` 顶层 `package` 任务加一行 `deps: [bindings]`,与 `build`/`dev` 对齐。

## 改了哪些文件
- `Taskfile.yml`(package 任务 +1 行)

## 验证
- 人工核对缩进 / 字段顺序与 `build`(L17-21)、`dev`(L39-43)一致。
- 无 `task` CLI 可跑 `--list`;Taskfile 是纯 YAML 缩进改动,风险面极小。

## 下一步
无。纯构建配置对齐。
