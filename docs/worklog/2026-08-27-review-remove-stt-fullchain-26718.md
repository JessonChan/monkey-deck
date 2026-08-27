# 2026-08-27 · Review:STT 全链路移除(#142 / Task #26718)

## 对象

- `f7bd54d` refactor(stt): 移除语音听写全链路(#142)——+16/−4345,29 文件
- 配套:`2e9c756`(落地 worklog)、`9b3f350`(#26384 复核记录)

## 结论:**PASS,移除完整,建议关 #142**

本次是**删除类改动**,审查方向与「类型补丁」反模式相反:不查「字段加了有没有人消费」,而查「**删掉了还有没有人引用**」。从每个历史消费方向反向追踪,全向干净:

| 消费方向 | 核对结果 |
|---|---|
| Go 源码引用 | ✅ 全仓 `*.go` 零 `stt`/`Transcriber`/`whisper` 残留(grep 命中均为 `persi​stT​urn`/`Li​stT​erminals` 等子串巧合) |
| `AttachEmbeddedRemote` 调用点 | ✅ 全仓恰 2 处(desktop + remote_test),均已 4 参;`remote_attach_server.go` no-op 双生子签名同步收窄,无用 `remote` import 一并删除 |
| 事件闭集 | ✅ `stt.EventProgress` 从 `remoteEventNames()` 移除;前端零 `stt` 订阅残留,闭集注释纪律("Keep in sync")完好 |
| bindings 面 | ✅ 现场 `wails3 generate bindings` 再生 → **2 Services / 124 Methods**,与 commit/worklog 声明(3/132 → 2/124)逐字一致;`main.go` 删 `application.NewService(sttSvc)` 后生成器自然不再见 internal/stt |
| 远程 API 面 | ✅ `/api/stt` mux 注册、handler、`Transcriber` 接口、`Options.Transcriber` 字段全删,server.go 包文档 bullet 同步;鉴权面收窄(少一个需 gate 的端点) |
| macOS 权限声明 | ✅ `Info.plist` + `Info.dev.plist` 的 `NSMicrophoneUsageDescription` 均删(唯一消费者是听写 getUserMedia;音频附件走文件选择器不受影响) |
| SQLite schema | ✅ STT 本无状态(sidecar + 磁盘模型文件),migrations/store 零涉及——无需迁移,正确 |
| i18n / CSS | ✅ voice* 键 en/zh 同删(lang parity 测试过);`.voice-btn` 规则 + pulse keyframes + reduced-motion 块删净,≤768px 选择器收窄为 `:not([image-btn])` 语义正确 |
| worklog 历史归档命中 | ✅ 仅 `docs/worklog/` 冻结历史提及,符合 §0.3 不回写约定 |

### 验证复现(Task #26718 环境,worktree 冷启动)

| 验证项 | 结果 |
|---|---|
| `go build ./...` + `go vet ./...` | ✅ 干净(仅本机预存在 ld macOS 26 SDK 告警,非本次引入) |
| `go build -tags server` | ✅ OK |
| `go test ./...` | ✅ **15 包全绿**(internal/remote 4.3s、internal/chat 20.9s 含 4 参 attach 路径) |
| `wails3 generate bindings` | ✅ 2 services / 124 methods,与声明一致 |
| `bun install` + `bun run build` | ✅ tsc + vite 过(>500kB chunk 告警为既有) |
| 全仓残留 grep(go/ts/tsx/json/plist/css) | ✅ 零真实残留 |

### 设计核对

- **干净切换符合交付契约**:无 deprecated 路径、无 shim、无「暂留但停用」——`internal/stt` 整包(含 pgid 清扫与两个假二进制 testdata)一次删净;worklog 已给出「重开需新 issue、勿直接 revert」的接口形态警告(4 参),方向正确。
- **三端矩阵定位准确**:能力整体下线非新增面,后端能力由 build + bindings 再生一次覆盖;前端按钮移除经同一 Composer 组件三端同步生效,无新断点/守卫分支——落地 worklog 已如实标注真 webview 冒烟为用户侧目视项。
- **踩坑记录有价值**:宽范围替换误扫相邻 `Token:` 行致 `tokenEqual` nil 解引用 panic(靠 stash 基线 10 次对照排除 flake)——与 #138 踩坑同族,「替换型范围逐行核对/相邻删除拆窄 CUT」的教训已沉淀。

## 复核记录

#26384(9b3f350)的既有复核结论与本次独立复现一致:源码零残留、bindings 2/124、4 参形态在位。本 review 在独立 worktree 冷环境(build 依赖缺失从零补装)复跑全部验证,结论可复现。
