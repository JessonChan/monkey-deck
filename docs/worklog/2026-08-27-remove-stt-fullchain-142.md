# 2026-08-27 移除 STT 全链路(#142,#131 产物整体下线)

## 起因

Task #26217(#142):移除 #131 落地的语音听写(STT)全链路。产品方向回调,「音频 → 文本」
能力(whisper.cpp sidecar + 模型管理 + Wails binding + `/api/stt` + Composer 听写按钮)
整链下线,不留 deprecated 路径(§ clean cutover)。

## 改法(整链逐段切除)

### Go 后端

- **删除 `internal/stt/` 整包**:`stt.go`(Service + binding 面 + Transcribe 管道)、
  `sidecar.go`(whisper-server 进程组管道)、`model.go`(ggml 目录 + 下载)、
  `transcode.go`(ffmpeg 容器转码)、`pgid.go`(sidecar 孤儿清扫)+ 全部测试 +
  `testdata/fakewhisper`、`testdata/fakeffmpeg` 假二进制。
- **删除 `internal/remote/api_stt.go` + `api_stt_test.go`**:`/api/stt` handler、
  `Transcriber` 接口、503/413/415 哨兵映射。
- **`internal/remote/server.go`**:Options 删 `Transcriber` 字段,Start 删
  `/api/stt` mux 注册,包文档删对应 bullet。
- **`internal/chat/remote.go`**:`AttachEmbeddedRemote` 去掉 `transcriber` 参数
  (恢复 4 参),Options 字面量删 `Transcriber:` 行。
- **`internal/chat/remote_test.go`**:唯一调用点改 4 参。
- **`main.go`**:删 `sttSvc` 构造 + `NewService` 注册 + attach 传参。
- **`remote_attach_desktop.go`**:签名去 `remote.Transcriber`,事件闭集删
  `stt.EventProgress`;**`remote_attach_server.go`**:no-op 签名同步收窄,
  `remote` import 随之删除。

### 前端

- **删除** `src/lib/sttClient.ts` + `.test.ts`(双传输分流/SttErrorKind/录音)、
  `src/components/Composer.voice.mount.test.tsx`。
- **`Composer.tsx`**:删听写全链——`sttClient` import、`valueRef` 镜像(仅听写
  插入消费)、`voiceState`/`voiceError`/`dictationRef`/`voicePhaseRef` 状态块与
  卸载释放 effect、Esc 关错误行分支、`insertAtCursor` + `toggleVoice`、voiceError
  内联错误行渲染、voice 按钮(含注释);lucide import 删 `AudioLines`/`Loader2`
  (均仅听写按钮消费;`Mic`/`Square` 仍被附件/停止按钮使用,保留)。
- **`index.css`**:删 `.voice-btn.recording` + pulse keyframes +
  `prefers-reduced-motion` 块;≤768px 规则从
  `:not([image-btn]):not([voice-btn])` 收窄为 `:not([image-btn])`(手机保留
  image-btn 的既有行为不变,voice-btn 入口已不存在)。
- **i18n(`en.json`/`zh.json`)**:删 `voiceDictateTip`/`voiceStopTip`/
  `voiceTranscribingTip` + `voiceErr` 六类,共 11 行/语言,奇偶保持一致
  (`lang.test.ts` 过)。
- **`build/darwin/Info.plist` + `Info.dev.plist`**:删
  `NSMicrophoneUsageDescription`(该 key 唯一用途就是听写的 getUserMedia;音频
  附件走文件选择器,不需要麦克风权限)。

### bindings

不入库(`.gitignore`),现场 `wails3 generate bindings` 再生:3 services/132
methods → **2 services/124 methods**(stt 的 1 service/8 methods 消失),生成
目录不再有 `internal/stt`。

## 踩坑记录

1. **`wails3 generate bindings -d src` 会清空目标目录**:在 `frontend/` 下误加
   `-d src` 把整个 `frontend/src/` 替换成了 bindings 输出,未提交的编辑全部丢失。
   恢复:`git checkout -- src/` 回到 HEAD 后按本次会话记录的原样重放全部编辑
   (重放后 post-edit 快照 tag 与首轮一致,字节级等价)。教训:`-d` 是「可整目录
   替换的输出根」,永远指向 `frontend/bindings`,不指向源码树。
2. **重放时漏掉「删除类」改动**:`git checkout` 恢复了被我删掉的 3 个文件,首轮
   构建以 `TS2307 Cannot find module .../internal/stt/service` 暴露,补删后过。
   教训:恢复现场后要按「新增/修改/删除」三类核对改动清单,删除类改动不会自己回来。
3. **宽范围替换连删相邻行**:`PUT 56.=58` 删 `Transcriber:` 时把上一行
   `Token: s.remoteTokenSnapshot,` 一起扫掉,`tokenEqual` 对 nil Token func 解引用
   → handler panic → 客户端 EOF → `TestRemoteAttachStartsWhenEnabled` 失败
   (stash 基线对照 10 次全过才确认非环境 flake,panic 栈定位到 `tokenEqual`)。
   修复时又险些再扫掉 `Sessions:` 行,靠 diff 全文核对补齐。与
   `2026-08-27-sidebar-scheduled-alarm-138.md` 记录的踩坑同族:**替换型范围必须
   逐行核对被替换行的原始内容**;相邻行删除宁可拆成多次窄 CUT。

## 验证

- **Go**:`go build ./...` + `go vet ./...` + `go build -tags server` 全干净
  (仅本机预存在 ld macOS 版本告警)。`go test -count=1 ./internal/...` 全绿;
  唯一一次 `TestRefreshTicker_OrLogic` 失败为已知环境性 flake(worklog
  #24310/#24308 均有记录),隔离 `-count=3` 复跑全过。internal/chat + remote
  定向 `-count=3` 复跑全过(覆盖 `AttachEmbeddedRemote` 4 参路径与 remote mux)。
- **前端**:`bun run build`(tsc + vite production)零 TS 错误(chunk >500kB
  警告为既有)。定向 `bun test --isolate Composer.mount.test.tsx lang.test.ts`
  → 40/40。全量 `bun test --isolate` → **373 pass / 0 fail**(46 文件)——删除
  的听写测试不再出现在失败集,无新增失败。
- **残留核查**:全仓 grep `stt|STT|Stt|dictation|whisper|voiceState|voiceErr|
  voice-btn|AudioLines|startDictation` → 仅 `docs/worklog/` 历史归档命中
  (§0.3 冻结不回写),源码零残留。
- **三端矩阵(§4.7/§5.6)**:本改动为**能力整体下线**,非新增面。后端 binding 面
  由 `go build` + 再生成 bindings 覆盖(2 services 实证);远程通道 `/api/stt`
  删除由 internal/remote 单测 + chat remote attach 测试覆盖。前端 Composer 为
  GUI/远程浏览器/PWA 三端同一组件,按钮移除三端同步生效,无新增断点/守卫分支;
  PWA ≤768px 规则收窄后 image-btn 保留行为不变。桌面 GUI 的真 webview 冒烟
  (确认工具行无空洞)属用户侧可目视项,自动化环境不可达,如实标注。

## 下一步

- 无遗留代码面。AGENTS.md §5.3 引用的 #24311 教训 bullet 为通用方法论,保留不删。
- 如后续需语音输入,建议重开独立 issue 重新设计(勿直接 revert 本提交:远程
  attach 签名等接口已按 4 参形态收敛)。
