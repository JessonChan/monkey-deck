# 2026-08-26 修复 #24308 review 缺口:webm/opus+m4a 容器 ffmpeg 转码 + /api/stt 4xx 分类 + sidecar 孤儿清扫

## 起因

Task #24310:落地 #24308(review worklog:2026-08-26-review-24308-stt-backend.md)挂出的
2 个 P2 + 1 个 P3 跟进项,阶段 2 前端接线(MediaRecorder 默认产物即 webm/opus)前必修:

1. **P2-容器解码范围超卖**:`extForMIME`/`mimeByFilename` 广告 webm/m4a,但 whisper-server
   内存解码(miniaudio+stb_vorbis)解不了 opus/webm、AAC/m4a、OGG-Opus → 走到 inference
   才 500,信息不可读。
2. **P2-错误码缝隙**:(25MB,32MB] 尺寸缝隙 payload 与 multipart part 标 `video/*` 的两条
   客户端错误路径都漏成 500。
3. **P2/P3-孤儿清扫**:宿主被 SIGKILL 时 whisper-server 孤儿存活(大模型可占 1.5GB);
   顺手清理 sidecar 死字段两枚 + `Models()`/`DefaultModelID()` 死导出。

## 设计/改法

### 1. ffmpeg 容器转码(internal/stt/transcode.go,新增)

- `needsTranscode` 门:webm/x-webm、mp4/m4a/x-m4a、aac/aacp、ogg/opus → 需转码。
  **ogg 也进转码集**:OGG-Vorbis 原生可解但 OGG-Opus 不行,不嗅探区分不了 codec,
  统一走 ffmpeg(ffmpeg 两者都能解)。
- `Transcribe` 在 ensureSidecar **之前**转码:ffmpeg `-i pipe:0 -vn -map 0:a:0 -ac 1
  -ar 16000 -c:a pcm_s16le -f wav -y <tmpfile>` → 读回 wav 字节、MIME 改写为
  `audio/wav` 再进 multipart。**输出走临时文件而非 pipe:1**:ffmpeg 对管道输出写不了
  正确的 RIFF 尺寸,临时文件最稳(§5.3 外部事实先验证:本机 ffmpeg 8.1.1 实测命令组
  产出合法 16kHz mono pcm_s16le WAV;垃圾输入 exit≠0 + "Invalid data found" stderr)。
- **无 ffmpeg 时**:ogg 透传(Vorbis 原生还有救);webm/m4a/aac 以 `ErrUnsupportedAudioType`
  拒绝,错误信息附安装提示——不再放行到引擎再 500。
- ffmpeg 发现:`MD_FFMPEG` env 覆盖 > PATH(经 shellenv.Resolve 合并登录 shell PATH,
  与 MD_WHISPER_SERVER 同模式,Finder 启动场景 §5.4 #8);只缓存正向结果,装了不用重启。
- 转码后 WAV 仍受 `maxAudioBytes`(25MB)约束(压缩 25MB opus 解出来可达数百 MB),
  超限报 `ErrAudioTooLarge`。超时 2min、stderr 截断 2KB。
- 假二进制 `testdata/fakeffmpeg`(stdin 全读、输出 `fakewav:<n>`;`FAKE_WAV_BYTES`/
  `FAKE_WAV_FAIL` 环境旋钮)——单测全链路锚定断言:webm 进 → transcript 携带
  ffmpeg 输出字节数 + `audio.wav` 文件名。测试注入点 `ffmpegFn`(默认实现外可 stub),
  保证开发者真机装了 ffmpeg 也不泄漏进单测(hermetic)。
- `extForMIME` 移除不可达的 webm/m4a/mp4 分支(转码拦截后到不了映射,死代码)。

### 2. 校验哨兵 + /api/stt 4xx 分类

- stt 新哨兵:`ErrAudioTooLarge`(413 源)、`ErrUnsupportedAudioType`(415 源),
  `Transcribe` 校验拒绝统一 `%w` 携带(errors.Is 可判)。
- `handleSTT` 映射:`ErrAudioTooLarge→413`、`ErrUnsupportedAudioType→415`,与既有
  503 哨兵同一模式。`maxSTTBody` 保持 32MB(multipart envelope 余量),(25,32] 缝隙
  由哨兵 413 兜住,不再依赖两端尺寸对齐。
- ffmpeg 解码失败(垃圾字节标 webm)也归 `ErrUnsupportedAudioType`→415;基础设施
  故障(临时文件/超时)保持非哨兵 → 500。

### 3. sidecar pgid 登记 + 启动孤儿清扫(internal/stt/pgid.go,新增)

- 与 harness 层 pgidFile 机制同思路(internal/acp/proc.go),但**独立实现**:stt 依赖
  acp 会破坏分层(§2.1 ACP 层边界),且 acp 的 `KillAllHarnesses` 安全过滤按 harness
  命令匹配,whisper-server 根本不在其列——复用等于不回收。
- spawn 成功后立即登记 `{pgid, cmd}` 到 `CachesDir/stt-sidecar-pgids.json`(onSpawned
  在 watcher 起来**之前**调,杜绝「崩太快先 onExit 后 register」的竞态序);watcher
  在 Wait 返回后注销——覆盖一切退出路径(stop/崩溃/health 超时回收)。
- `ServiceStartup` 调 `killLeftoverSidecars`:对每个登记 pgid,**仅当该组内存活进程
  仍运行登记命令**才整组 SIGKILL(pgid 复用防误杀,同 acp 的安全过滤),随后重置文件。
- 测试:登记/注销生命周期、SIGKILL 崩溃路径注销、清扫杀对 + 命令不匹配放行 +
  Startup 接线真杀。坑:断言进程组 ESRCH 前必须先 `Wait()` 收尸——zombie 仍应答
  `kill(-pgid, 0)`;ps 快照前必须等 stray 完全 exec(用 /health 就绪闸)。

### 4. P3 死代码

- `sidecar.serverPath`/`modelPath`(赋值后无人读)、包级 `Models()`/`DefaultModelID()`
  (零外部引用)删除。

## 改了哪些文件

- 新增:`internal/stt/transcode.go`、`internal/stt/pgid.go`、`internal/stt/transcode_test.go`、
  `internal/stt/pgid_test.go`、`internal/stt/testdata/fakeffmpeg/main.go`
- 修改:`internal/stt/stt.go`(哨兵/ffmpegFn 字段/Transcribe 转码步/pgid 接线/extForMIME 收窄)、
  `internal/stt/sidecar.go`(onSpawned/onExit 钩子;删死字段)、`internal/stt/model.go`(删死导出)、
  `internal/stt/stt_test.go`(哨兵断言 + video/mp4 用例 + extForMIME 表更新)、
  `internal/remote/api_stt.go`(413/415 映射 + maxSTTBody 注释)、`internal/remote/api_stt_test.go`
  (413/415 用例)

## 验证

- `go build ./...`、`go vet ./...`、`go build -tags server`:全干净(仅本机预存在
  ld macOS 版本告警,与 #24308 验证记录一致)。
- `go test ./...`:16 包全绿;`go test -race -count=1 ./internal/stt ./internal/remote`:绿。
  期间一次 `TestRefreshTicker_OrLogic`(internal/chat,ticker 时序测试)在全量并行下
  抖动失败一次——隔离复跑通过、连续 3 次全包通过、本次零 chat 改动,判定环境性 flake。
- **外部事实验证(§5.3)**:真 ffmpeg 8.1.1 实测命令组(webm/opus stdin → 合法 WAV;
  垃圾 → exit≠0 + stderr 行)。
- 三端矩阵:零前端改动;后端新面经真监听器 + stub Transcriber 的 remote 单测覆盖
  (§5.6 统一后端验证),GUI/binding 路径与 remote 同一 `Transcribe` 管道。
- 原子提交 4 个:`4f528e0`(转码+哨兵)、`bd45e30`(remote 413/415)、`ea60a5c`
  (pgid 孤儿清扫)、`bff78ce`(死代码)。

## 下一步

- #131 阶段 2(前端接线)现在可以放心用 MediaRecorder 默认产物(audio/webm;codecs=opus)
  直传;前端录制 WAV 的建议不再是硬前提(后端已能转码)。真 whisper-server 实测时复核
  大文件(>10min 音频)转码耗时。
- `TestRefreshTicker_OrLogic` 的并行 flake 记录在案,若再现可单独开任务加固(放宽
  断言窗口或去并行)。
