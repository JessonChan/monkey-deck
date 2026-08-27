# 2026-08-27 #26384 复核:STT 全链路移除已在库,无需重做

## 起因

Task #26384 以「重做 STT 全链路移除:前次未 commit 即丢失(#142+#131)」再次下发。
核查结论:**前次工作并未丢失**——前一会话在 `wails3 generate bindings -d src` 事故后
已按其 worklog 记录完成恢复重放,并落了两个 commit:

- `f7bd54d` `refactor(stt): 移除语音听写全链路(#142)`(29 文件,+16/-4345)
- `2e9c756` `docs(worklog): #142 STT 全链路移除记录`

两 commit 均在 `agent/coder/c0f8c3c5` 分支 HEAD,工作树 clean。任务下发方所见状态滞后。

## 复核证据(本会话独立重跑,非引用前次声明)

- **残留核查**:全仓源码 `stt|STT|Stt|dictation|whisper|voiceState|voiceErr|voice-btn|
  AudioLines|startDictation|NSMicrophone`(go/ts/tsx/css/json/plist)→ 仅 `docs/worklog/`
  历史归档命中(§0.3 冻结);其余命中均为 `li**stt**`/`la**stt**`/`gue**stt**` 子串误报,
  零真实残留。`internal/stt/`、`internal/remote/api_stt*.go`、`sttClient.*`、
  `Composer.voice.mount.test.tsx` 均不存在;Go 源码无 `Transcriber`/`/api/stt`;
  `AttachEmbeddedRemote` 为 4 参形态。
- **bindings 面现场再生**:worktree 缺 `frontend/bindings`(不入库,预存在环境状态),
  `wails3 generate bindings` → **2 services / 124 methods**,生成树无 `internal/stt`
  ——与移除记录声明一致(3 services/132 → 2/124)。
- **Go gate**:`go build ./...` + `go vet ./...` + `go build -tags server` 全干净
  (仅本机预存在 ld macOS 版本告警);`go test -count=1 ./internal/...` **15 包全绿**。
  (根包首次编译报 `all:frontend/dist` 缺目录为 worktree 预存在问题,补 gitignore 的
  dist stub 后过,与历次 worklog 记录同款。)
- **前端 gate**:`bun install` + `bun run build`(tsc + vite production)零 TS 错误
  (chunk >500kB 警告既有);全量 `bun test --isolate` → **373 pass / 0 fail**
  (46 文件,7170 expect)——与移除记录的验证声明逐字一致。

## 结论

- 无代码改动、无新 commit 需要(工作树 clean;dist stub/bindings 为 gitignore 产物)。
- 本条目唯一作用:留档「该任务的重做诉求已被 f7bd54d+2e9c756 满足」,避免任务再被误重发。
- 唯一新增 commit 即本 worklog 文件。

## 下一步

- 无遗留。如后续需语音输入,按 `2026-08-27-remove-stt-fullchain-142.md`「下一步」重开独立 issue 设计。
