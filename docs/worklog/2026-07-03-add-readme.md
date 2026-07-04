# 2026-07-03 新增 README / MIT LICENSE / THIRD_PARTY_LICENSES

## 起因
仓库此前无 README、无 LICENSE、无第三方署名文件。新人/克隆者没有轻量入口,
也不满足 AGENTS.md §0.4 对借用代码的项目级署名要求。

## 改法
- 新增 `README.md`:定位(纯 ACP 桌面客户端)+ 特点(纯 ACP / 项目=目录 / 本地优先)
  + 致谢表(只链项目名 + 协议,不写"借鉴了什么")+ 获取参考库(指向 scripts/references.sh)
  + 开发入口。致谢只列有公开仓库、确有借鉴的 6 个;内部项目 RAK 与探索性项目
  (vscode/sim/DeepSeek-Reasonix)不入公开 README。
- 新增 `LICENSE`:MIT,Copyright (c) 2026 jessonchan。
- 新增 `THIRD_PARTY_LICENSES.md`:登记借用改写代码(§1)、原样保留的第三方脚手架
  文件(§2)、关键 import 依赖清单(§3)。经 grep 实证,项目里真正"借来改写"的只有
  `internal/titlegen/titlegen.go` 一处(移植自 wesight sessionTitle.ts,文件顶已带
  wesight MIT 声明);RAK 代码已全清(0 命中);go.mod 依赖属 import 非照搬,§0.4 不适用。

## 改了哪些文件
- `README.md`(新增)
- `LICENSE`(新增, MIT)
- `THIRD_PARTY_LICENSES.md`(新增)
- `docs/worklog/2026-07-03-add-readme.md`(本条)

## 验证
- README 致谢表 6 个项目链接 + 协议与 `scripts/references.sh` REFERENCES 表一致。
- THIRD_PARTY_LICENSES §1 经 `grep -rn "Copyright.*freestylefly\|wesight" internal/`
  实证只有 titlegen 一处;`grep "real-agent-kanban\|RAK" internal/ frontend/` 0 命中。
- LICENSE 为 MIT 标准全文,版权信息与 build/config.yml / .plist / .json 中
  的 `jessonchan` / `2026` 一致。

## 下一步
- 新增借用代码时按 §0.4 在文件顶保留版权声明 + 在 THIRD_PARTY_LICENSES §1 登记。
- 新增原样保留的第三方文件时登记到 §2。
