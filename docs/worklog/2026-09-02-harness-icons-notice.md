# 2026-09-02 harness 图标版权:改用目录内 NOTICE 声明(不做逐图标协议审计)

## 起因 / 为什么

- 上一轮(`2026-09-02-harness-icons-and-keyword-match.md`)把 46 枚图标内置,OPEN 项提到
  「按 §0.4 逐枚在 `THIRD_PARTY_LICENSES.md` §2 登记协议」待补。
- 用户评估后认为:逐图标核协议 + 移除不兼容(闭源/非 MIT/Apache)图标成本过高,且多数 agent
  图标属「指明产品来源」用途。改为**轻量方案**:在 `assets/harness-icons/` 下加一份说明文档,
  声明图标来自各项目官方源、仅作产品标识,权利方认为侵权可**提交 PR 移除**即可。

## 改法

- 新增 `assets/harness-icons/NOTICE.md`:图标取自各项目官网 / 开源仓库官方 logo,仅用于界面
  标识对应产品;所有权归各自项目方;权利方认为侵权可提交 PR 移除对应文件。
- `assets/harness-icons/README.md` 的「协议 / 署名」节原本写「均自 `references/` 下 MIT 借用」
  (与实际来源不符),改为指向 `NOTICE.md` 并更正来源说明。

## 改了哪些文件
- 新增:`assets/harness-icons/NOTICE.md`
- 修改:`assets/harness-icons/README.md`

## 验证
- 纯文档改动,无代码 / 构建影响。`go build ./...` 与前端 `bun run build` 不受影响(图标文件本身未动)。

## 下一步 / OPEN
- 上一轮 OPEN「§0.4 逐枚登记协议」以本方案替代:不再逐枚登记,统一靠 `NOTICE.md` 的 PR-移除机制。
- 图标文件(46 枚 + omp/opencode)保持不动。
