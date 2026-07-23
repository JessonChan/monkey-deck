# 2026-07-23 fix:去掉 omp.svg 黑色圆角底(Task #22144)

## 起因
Task #22144:`omp.svg`(Oh My Pi harness 官方品牌 π 图标)带一块 `<rect ... fill="#0f0a14" />`
黑色圆角底,在深色主题侧栏里显一块突兀的暗色方块,需要去掉只保留彩色渐变 π。

## 改法
删掉 `<rect width="64" height="64" rx="12" fill="#0f0a14" />` 一行即可。SVG `viewBox="0 0 64 64"`
其余结构(渐变 defs + path)不变,π 图标本身仍居中铺满 64×64 画布,无 rect 后背景透明。

按 `assets/harness-icons/README.md` 约定,`assets/harness-icons/<id>.<ext>` 是唯一事实源,
`frontend/public/harness-icons/<id>.<ext>` 是等量镜像副本,改了源必须同步镜像,否则前端取不到图。

## 改了哪些文件
- `assets/harness-icons/omp.svg`:删 rect 行。
- `frontend/public/harness-icons/omp.svg`:同步删 rect 行(与源等量)。

## 验证
- `diff assets/harness-icons/omp.svg frontend/public/harness-icons/omp.svg` → 完全一致(镜像同步)。
- 纯 SVG 资源改动,不涉及 Go / TS 编译;无 build/vet 受影响面。

## 下一步
前端实测深/浅主题下侧栏 / 新建会话列表的 omp 图标显示是否如预期(透明背景)。
