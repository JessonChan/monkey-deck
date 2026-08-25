# 2026-08-26 Review #24310 STT 修复:ffmpeg 真实参数 / 415 降级链 / pgid 重用保护

## 起因

Task #24311:backend review #24310(修复 #24308 review 缺口,commits `4f528e0`/`bd45e30`/`ea60a5c`/`bff78ce`)。
任务标题点名三处复审:**真实 ffmpeg 参数**、**415 降级链**、**pgid 重用保护**。附带反模式检查(类型补丁 / 断言锚定值)。

## 核查结论(逐项,全部实证)

### 1. ffmpeg 真实参数 —— **P1 缺陷:`-i pipe:0` 对 trailing-moov m4a 静默截断**

参数本身(`-vn -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le -f wav`,临时文件出防 RIFF 尺寸错)逐项核对无误,
webm/opus(阶段 2 MediaRecorder 关键路径)与 fragmented MP4(Chrome `audio/mp4;codecs=opus` 形态)经 pipe 转码均正常。

**但 `pipe:0` 不可 seek,MP4 家族 demuxer 需要 moov atom**:

- 实测(真 ffmpeg 8.1.1,与 worklog 验证同版本):600s AAC m4a(5.3MB,ffmpeg 默认 muxing 即 moov 在 mdat 后)
  经**生产同款 Go 路径**(`transcodeToWav`,os.Pipe stdin)→ **err=nil + 78 字节 WAV(`data` chunk 尺寸=0,零音频帧)**。
  即 `cmd.Run()` 成功返回、不触发任何哨兵,静默把空 WAV 推给 whisper-server("failed to read audio data" 400→500,或空 transcript 200)。
- 边界:45KB(5s)m4a 过,177KB(20s)m4a 已断——大于 ffmpeg io 缓冲(~64-128KB)即断;faststart(moov 前置)与 fMP4 不受影响。
- **影响面**:voice memo / iTunes / 任何非 faststart 的常规 m4a 上传(恰是 #24310 声称修好的第二类容器)。
  webm 不受影响(流式容器无需 seek)→ 阶段 2 前端接线不受此 P1 阻塞,但「m4a 容器转码」的修复声明不成立。
- **修法方向(已实测验证)**:输入也走临时文件(`-i <tmpfile>` 替代 `pipe:0`,可 seek 后 moov-at-end 正常解,
  同一 5.3MB 文件出 19.2MB 合法 WAV)。代码已有输出临时文件机制,增量小。
  建议加一道兜底:校验产物 WAV 的 data chunk 非零/产物尺寸非平凡(exit-0 截断类故障最后一道网)。
- **测试盲区(修 P1 时必须一并补)**:fakeffmpeg 只镜像了「失败必 exit≠0」的假设契约,真 ffmpeg 的 exit-0-截断
  行为在 fake 的模型之外;worklog 的 §5.3 外部事实验证也只测了 webm/opus + 垃圾输入两端,漏了中间形态。
  回归测试需:fake 加「exit 0 + 空输出」旋钮模拟截断 + 产物校验断言;真机侧输入形态矩阵(m4a trailing-moov 大文件)进实测清单。

### 2. 415 降级链 —— 代码层 PASS,但被 P1 穿透 + 1×P3

- 哨兵链路逐环核对无误:`ErrAudioTooLarge`/`ErrUnsupportedAudioType` 全程 `%w` 携带(errors.Is 可判)→
  `handleSTT` 映 413/415 → (25MB,32MB] 尺寸缝隙由哨兵 413 兜住(测试覆盖)→ `video/*` part → 415(测试覆盖)→
  转码后 WAV 超限 → 413(测试覆盖)→ 非 audio MIME → 415(测试覆盖)。`maxSTTBody` 注释与实现一致。
- **穿透**:P1 的 exit-0 截断完全绕过这条链——链路的可信度取决于转码步的错误信号,而 ffmpeg 在该形态下不报错。
- **P3(基础设施故障误判客户端 415)**:`MD_FFMPEG` 指向不存在路径时,`fork/exec ... no such file or directory`
  这类 infra 故障被 `transcodeToWav` 一律包成 `ErrUnsupportedAudioType` → 415,错误文案还误导性地说
  "ffmpeg could not decode the audio"(已实证复现)。修法:discovery 时对 env 覆盖值过一遍
  `exec.LookPath` 校验(与 PATH 探测同待遇),或在错误分类处把 ENOENT/EACCES 归通用 500。超时已正确归 500。

### 3. pgid 重用保护 —— PASS

- 守卫语义与 harness 层(`internal/acp/proc.go` `KillAllHarnesses` + `isHarnessCmdline` 子串匹配)一致,
  独立实现避免 stt→acp 反向依赖(§2.1 分层,判断正确;acp 的命令白名单也确实覆盖不到 whisper-server):
  登记项只有当**该 pgid 组内存活进程的命令行包含登记命令**才整组 SIGKILL;ps 失败 / registry 损坏 fail-open
  (宁漏杀不误杀);ESRCH 容忍;扫完重置文件。
- 时序正确:`onSpawned` 在 watcher goroutine 起来之前调(先 register 后可能 onExit,无竞态序);
  watcher 独占 `cmd.Wait`,`onExit` 覆盖一切退出路径(stop / 崩溃 / health 超时回收),`pgidMu` 串行化读改写。
- 测试锚定到位:registry 精确内容断言、`kill(-pgid,0)=ESRCH`(先 reap 收尸的 zombie 坑有注释)、
  命令不匹配放行、Startup 接线真杀。spawnStraySidecar 用 /health 就绪闸等 exec 完成,规避 ps 快照竞态。
- 备注(不动作):同命令的第二实例会被启动清扫误杀(守卫是命令身份非实例身份)——并发实例本被 §1.8/§5.5 硬禁,
  acp 层同性质;ps 快照→kill 的 TOCTOU 与 harness 层同等接受。

### 4. 死代码清理(bff78ce)—— PASS

`stt.Models()`/`stt.DefaultModelID()`/`sidecar.serverPath`/`modelPath` 全仓 grep 零引用,删除后 build/test 全绿。

### 5. 反模式检查

- **类型补丁**:无。新字段(`ffmpegFn`/`ffmpegPath`/`pgidFile`/`pgidMu`/`sidecarEntry.PGID`/`Cmd`)逐个反向追踪
  均有真实消费点(非「存在即算」:ffmpegFn 进 ensureWav 决策、pgidFile 进 mutateSidecarEntries 读写、Cmd 进守卫匹配)。
- **断言锚定值**:合格。fake transcript 编码「ffmpeg stdin 字节数 + audio.wav 文件名」贯穿全链,单字符串断言证明
  转码先于推理;`FAKE_WAV_BYTES` 旋钮锚定解码超限;pgid 测试断言精确 registry 内容与 ESRCH。hermetic 注入点
  (`ffmpegFn` stub)防真机 ffmpeg 泄漏进单测,方向正确——但如上,fake 的契约假设本身就是 P1 盲区。

## 验证

- `go build ./...` / `go vet ./internal/stt ./internal/remote` / `go build -tags server`:干净
  (根包需补 `frontend/dist` 占位——worktree 预存在环境问题,#24308 review 同款;ld macOS 版本告警为本机预存在)。
- `go test -count=1 ./internal/...`:16 包全绿,零 FAIL/SKIP;`go test -race -count=1 ./internal/stt ./internal/remote`:绿。
- **外部事实验证(§5.3,本 review 的核心增量)**:真 ffmpeg 8.1.1 实测输入形态矩阵——
  webm/opus pipe ✓、fMP4 pipe ✓、faststart m4a pipe ✓、45KB 小 m4a pipe ✓、
  **trailing-moov m4a(177KB~5.3MB)pipe ✗(exit 0 + 78 字节空 WAV,经生产同款 Go 路径 `transcodeToWav` 复现)**、
  同文件改 `-i <tmpfile>` 文件输入 ✓(19.2MB 合法 WAV)、垃圾输入 exit≠0 + "Invalid data" stderr ✓。
- 三端矩阵:零前端改动;后端新面经真监听器 + stub Transcriber 的 remote 单测覆盖(§5.6 统一后端验证)。

## 结论

**FAIL(1×P1 必修,m4a 转码腿不成立;webm 腿 / 4xx 映射 / pgid 清扫 / 死代码四项 PASS)**:

1. **P1**:`transcodeToWav` 用 `-i pipe:0` 不可 seek,trailing-moov m4a/mp4(>~128KB,即常规真实文件)→
   ffmpeg exit 0 + 零音频帧 WAV,静默穿透全部错误链。修法:输入走临时文件 + 产物 WAV 非平凡校验;
   回归测试补「exit 0 + 空输出」形态。webm(阶段 2 关键路径)不受影响,故不阻塞前端接线,但 #24310 关闭前必须修。
2. **P3-a**:`MD_FFMPEG` 指向坏路径等 infra 故障被误判 415(客户端错误),应归 500。
3. **P3-b(记录)**:`needsTranscode` 之外的不可解码音频(amr/wma/3gp…)仍 fail-open 放行到引擎 500,
   与刚修的 P2 同类但频率低;可考虑白名单反转(natively-decodable 直传,其余有 ffmpeg 就转、没有就 415)作为后续。

## 下一步

- 开任务修 P1(输入临时文件化 + 产物校验 + 截断形态回归测试),顺带 P3-a(env 覆盖校验);
  修完建议本 review 的输入形态矩阵作为其验收清单。
- §5.3 教训回写:外部事实验证须覆盖**输入形态矩阵**(happy path + 垃圾两端之外,还有「合法但形态不利」的中间态),
  本 P1 正是只在两端取样而漏检的中间态。
