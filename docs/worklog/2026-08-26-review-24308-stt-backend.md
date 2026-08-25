# 2026-08-26 Review #24308 宿主 STT 后端:进程纪律 / auth 硬门槛 / 容器解码范围 / 错误码稳定

## 起因

Task #24309:backend review #24308(#131 阶段 1 宿主 STT 后端,commits `b85739b`/`a4ac521`/`cc44670`/`8058431`)。
审四件事:进程纪律(§3.2)、/api/stt 鉴权硬门槛、whisper-server 容器解码范围(上游事实核查)、错误码稳定性。
附带反模式检查:类型补丁(字段加了没人消费)、测试断言锚定值。

## 核查结论(逐项)

### 1. 进程纪律(§3.2)—— PASS

- `sidecar.go`:`Setpgid` 独立进程组 ✓;stop = 组 SIGTERM → 3s grace → 组 SIGKILL,ESRCH 容忍 ✓;watcher 独占
  `cmd.Wait`(无双 Wait 竞态)✓;`shutdown.Swap` 幂等 ✓;health 超时路径 `sc.stop()` 先回收半启动进程 ✓。
- 实证测试到位:`TestStopSTTSidecar` 断言 `-pgid` 信号 0 = ESRCH(进程组真死);`TestStartSidecarHealthTimeout`
  用 `/usr/bin/false` 证不泄漏;`TestSidecarSelfHealsAfterDeath` 证自愈。
- Windows 编译失败(`Setpgid`/`syscall.Kill`)非本次回归:`internal/acp`、`internal/terminal` 同样失败,
  全仓本就不支持 Windows 构建,status quo 一致。
- **P2(记录不阻塞)**:崩溃孤儿无兜底——harness 层有 pgidFile 登记 + 启动清残留(`internal/acp/proc.go`),
  stt sidecar 没有参与该机制。宿主 app 被 SIGKILL 时 whisper-server 会孤儿存活(大模型可占 1.5GB 内存直到手动杀)。
  §3.2 字面管 harness,不算违规,但同类故障形态;建议后续把 sidecar pgid 登记进同一体系或加启动清扫。

### 2. /api/stt 鉴权硬门槛 —— PASS

- 端点注册在 `s.auth(mux)` 包裹的 mux 上,豁免清单仅 `/health`、`/pair`、manifest/icons —— `/api/stt` 不在其中。
- `TestSTTAuthGated` 真监听器 + 无凭证请求断言 401 ✓;bearer 走既有 constant-time 比较 ✓。

### 3. whisper-server 上游事实核查(§5.3 外部事实先验证)—— 事实前提全部成立,但解码范围有超卖

对照上游 `ggml-org/whisper.cpp`(master,`examples/server/server.cpp` + `common-whisper.cpp` + server README):

| 本项目假设 | 上游事实 | 结论 |
|---|---|---|
| CLI 旗标 `-m`/`--host`/`--port` | README help:`-m FNAME, --model FNAME`、`--host HOST [127.0.0.1]`、`--port PORT [8080]` | ✓ |
| `GET /health` 200 = 就绪 | server.cpp L1206:`/health` 存在,READY 时 200 `{"status":"ok"}` | ✓ |
| `POST /inference` multipart 字段名 `file` | L822 `req.has_file("file")` | ✓ |
| `response_format=json` → `{"text":...}` | L1152-1161 默认/else 分支顶层唯一字段 `text` | ✓ |
| 就绪轮询语义 | 上游先同步加载模型、后 `bind_to_port` —— 连接被拒→200 的轮询模型正确 | ✓ |
| 解码容器范围 | **不带 `--convert`(本项目未开)时,内存解码 = miniaudio + stb_vorbis:仅 WAV/MP3/FLAC/Vorbis;内存路径根本没有 ffmpeg 回退(`WHISPER_COMMON_FFMPEG` 只在文件路径重载里)** | ⚠ 部分不成立 |

- **P2(阶段 2 前必修)**:`extForMIME`/`mimeByFilename` 广告 `audio/webm → .webm`、`audio/m4a|mp4 → .m4a`,
  但上游引擎解不了 AAC(m4a)与 opus/webm(ogg 也仅 Vorbis,OGG-Opus 同样失败)。这两类上传会走到
  inference 才失败(上游 400 "failed to read audio data" → 本项目映射 500,信息不可读)。而**阶段 2 前端
  MediaRecorder 的默认产物恰是 audio/webm;codecs=opus** —— 正中不可解码点(worklog 已建议前端录 WAV,
  但后端应对不可解码容器给清晰 4xx 拒绝,而不是放行到引擎再 500)。

### 4. 错误码稳定性 —— 大体 PASS,一处缝隙

- ✓ 哨兵稳定:`ErrServerNotFound`/`ErrNoModel`(`%w` 包装,errors.Is 可判)→ 503;nil Transcriber → 503;
  405 + `Allow: POST`;400(bad content-type / empty / 无 file 字段 / 坏 multipart);错误 JSON 信封统一;均有测试。
- **P2:客户端错误漏成 5xx 的两条路径**(根因同一:`handleSTT` 对 Transcribe 的校验拒绝没有 4xx 分类):
  1. **尺寸缝隙**:remote `maxSTTBody=32MB` > stt `maxAudioBytes=25MB` —— (25MB, 32MB] 的 payload 过了
     HTTP 层 413 检查,被 Transcribe 拒成 500("audio too large");同一客户端错误在 >32MB 是 413、在缝隙内是 500。
  2. multipart part 显式标 `video/mp4` 等非 audio Content-Type:过 `checkSTTPayload`(只查非空)→ Transcribe
     拒 "unsupported audio type" → 500。
  修法建议:stt 导出校验类哨兵(`ErrAudioTooLarge`/`ErrUnsupportedAudioType`)在 handleSTT 映 413/415,
  或把 maxSTTBody 对齐 25MB。

### 5. 反模式检查

- **类型补丁**:无承重性未消费字段。两个无害死字段:`sidecar.serverPath`/`sidecar.modelPath` 赋值后无人读(P3,
  顺手可删);`Models()`/`DefaultModelID()` 包外零引用的死导出(P3)。binding 面字段(STTStatus 等)测试有真实消费,
  阶段 2 UI 接线在计划内,不算补丁。
- **断言锚定值**:fake transcript 编码 `模型文件:字节数:文件名`,单字符串断言覆盖模型选择/字节透传/MIME→扩展名
  全链路;下载进度断言 Received/Total 对齐 payload 实长;状态 flags 断言具体值。✓ 正是要求的锚定式断言。

### 6. 其它(不阻塞)

- `ensureSidecar` 持 `s.mu` 跨 startSidecar + waitHealthy(≤30s):冷启动期间 `STTStatus`/`SetSTTModel` 会排队
  阻塞 —— 单飞语义正确,阶段 2 UI 轮询状态时需知晓此行为。
- stt 自开 store(同 DBPath、WAL + busy_timeout):与 chat 服务并发读写稀疏配置,模式成立。
- 下载 `.part` 原子 rename、短读校验、幂等、进度节流:实现与测试均到位。

## 验证

- `go build ./...` + `go vet ./...` + `go build -tags server`:干净(仅本机预存在 ld macOS 版本告警)。
- `go test ./...`:16 个 internal 包全绿;`go test -race -count=1 ./internal/stt ./internal/remote`:干净。
  (根包 `FAIL [setup failed]` 为 worktree 缺 `frontend/dist` embed 目录的预存在环境问题——补目录后根包无测试文件,与本次无关。)
- Windows/Linux 交叉编译核查:失败点与既有包(`internal/acp`/`internal/terminal`/wails linux alpha)一致,非本次回归。
- 三端矩阵:本任务零前端改动;后端新面经真实监听器 + 完整鉴权链的 remote 单测覆盖(等价 §5.6 统一后端验证),符合声明。

## 结论

**PASS(带 2 个 P2 跟进项,不阻塞阶段 1 合入)**:

1. P2-容器范围:webm/m4a 不可解码却在校验面放行 → 阶段 2 前端接线前必须修(MediaRecorder 默认产物即 webm/opus,
   正中雷区);建议校验期拒绝并给清晰 4xx,或收窄映射表(附注 ogg 仅 Vorbis)。
2. P2-错误码:(25MB,32MB] 尺寸缝隙与非 audio part Content-Type 漏成 500;建议 stt 导出校验哨兵 + handleSTT 映 4xx。
3. P3:sidecar 死字段两枚、`Models()`/`DefaultModelID()` 死导出,顺手清理;崩溃孤儿 pgid 登记可作为独立后续任务。

## 下一步

- 把 P2 两项开成任务(建议合并进「#131 阶段 2 前端接线」的前置清单,避免阶段 2 上线 webm 直传踩雷)。
- 真 whisper-server 实测时复核上游版本漂移(server.cpp 行号以 master 为准,本地 brew 版本可能略旧)。
