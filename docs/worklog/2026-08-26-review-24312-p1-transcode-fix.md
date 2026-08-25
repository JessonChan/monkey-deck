# 2026-08-26 Review #24312 三审:P1 修复(ffmpeg 临时文件输入 + wavHasAudioFrames + 白名单反转)真实性

## 起因

Task #24313:三审 #24312(修复 #24311 判 FAIL 的 P1,commits `cce0796`/`e8fd393`/`d7ed3da`)。
聚焦:**P1 真实性**与**回归形态**(断言锚定值 / 类型补丁反模式)。附带复核 P3-a/P3-b 与 worklog 验证声明。

## 核查结论

### 1. P1 修复真实性 —— **PASS(实证成立)**

- **输入临时文件**:`transcodeToWav` 先把 audio 全量写入已关闭的临时文件再 `-i in.Name()`(transcode.go:127-158),seekable 后 moov-at-end 正常解。**真 ffmpeg 8.1.1 矩阵实测 4/4 全绿**(trailing-moov m4a/faststart/webm/垃圾),与 #24310 review 复现 bug 时的同版本。
- **矩阵不是用生产自己的校验器自证**:`wavDataLen` 是独立 walker(文件注释明说 kept independent from wavHasAudioFrames),断言解码时长 60s±10%(data 字节数/32000);fixture 带 moov 位置守卫(`LastIndex(moov) >= LastIndex(mdat)`,防 faststart remux 静默使头条 case 失效)。锚定的是**物理量**(时长),不是「字段存在」。
- **产物零帧校验**:`wavHasAudioFrames` 按 RIFF chunk 遍历(含 word-aligned padding),data chunk=0 → 通用错误(不含 4xx 哨兵)。remote `handleSTT` switch 只把两个哨兵映 413/415(api_stt.go:60-63),截断错误正确落 default 500——「不可归因调用方」的分类与声明一致。
- **尺寸闸前移**:stat 后、`os.ReadFile` 前判 `ErrAudioTooLarge`(transcode.go:175-183),超限解码不再进内存。输入侧本身受 Transcribe 入口 25MB 闸约束,临时文件有界;两侧临时文件 `defer os.Remove` 全路径清理。
- **边界评估(记录,不动作)**:校验信任 data chunk 声明尺寸而非实际在场字节数——对该失败形态足够(输出是 seekable 文件,ffmpeg 会回写正确尺寸;被杀中途的写入 exit≠0 走更早的分支);畸形声明尺寸只会往「拒绝」方向错。32 位 int 溢出边角在本平台(darwin/arm64 + 25MB 上限)不可达。

### 2. 回归形态 —— **PASS(锚定到位)**

- **fakeffmpeg 内置回归哨兵**:输入改读 `-i` 后的文件——生产若退回 `pipe:0`,`os.ReadFile("pipe:0")` 失败 → exit 1 → 所有 happy-path 测试响亮失败。方向正确:fake 的契约假设对齐了真 ffmpeg 的实际行为(而非愿望行为)。
- **FAKE_WAV_EMPTY 补上旧模型盲区**:真 ffmpeg 的 exit-0-截断形态进入了 fake 契约。`TestTranscribeFFmpegSilentTruncation` 断言:err≠nil + **非**两个 4xx 哨兵(errors.Is 反向断言)+ 错误文案含 "no audio frames" + sidecar 未启动(hermetic)。
- **`TestWavHasAudioFrames` 锚定值**:odd-size chunk 的 word-aligned 步进(3 字节 LIST + 1 pad 后仍能找到 data)、zero-data/not-RIFF/too-short/no-data-chunk 四种 false 形态。
- **全链锚定**:`TestTranscribeTranscodesUnsupportedContainers` 的 want = `len(fakeWav(len(audio)))` —— 证明「输入临时文件字节数 → fake WAV data 长度 → multipart 字节数 → transcript 回显」整链贯通,非只测「转码发生过」。
- **P3-a 回归**:`TestTranscribeFFmpegBadPathIsServerError` 双形态(path 型缺失 / 裸名不在 PATH)断言非 415 + 点名坏路径 + 不启 sidecar。错误分类逐环核对:`*fs.PathError(ENOENT)`→`fs.ErrNotExist`、EACCES→`fs.ErrPermission`、`*exec.Error`→`exec.ErrNotFound`,均 errors.Is 可达;超时先于分类判(`tctx.Err()`)。
- **P3-b 反转**:`nativelyDecodable` 白名单语义正确,旧名 `needsTranscode`/`ExtensionsByType` 全仓 grep 零残留,死代码删除属实。
- **类型补丁反模式**:无。`ffmpegFn`/`ffmpegPath` 等新面均有真实消费点。

### 3. 新发现 —— **P2:OGG 无 ffmpeg 直传例外是「假的」(mislabeled passthrough)**

#24311 P3-b 关闭时的设计声明「OGG 仍是无 ffmpeg 时唯一直传例外(原生 Vorbis 可能可解)」在实现中不成立:

- `Transcribe` 在 `ensureWav` 返回后**无条件** `mimeType = "audio/wav"`(stt.go:398-404),而 `ensureWav` 的 OGG 直传分支返回的是**原始 OGG 字节**——字节没换,标签换了。
- **活体探针实证**(fakewhisper 回显 multipart filename):无 ffmpeg 时 `Transcribe(…, "audio/ogg")` 的 transcript = `fake:ggml-base.en-q5_1.bin:17:audio.wav`——OGG 字节以 `audio.wav` 文件名送达引擎。
- 后果链:按项目自己文档化的外部事实(stt.go:411「whisper-server sniffs the container from the multipart part's filename extension」),WAV 扩展名 → WAV demuxer 解 OGG 字节 → 解码失败 → 不透明 inference 错误(非 200 → 通用 500)。**该例外想保住的 Vorbis 原生解码路径实际不可用**。
- 连带:`extForMIME` 的 `case "audio/ogg": return ".ogg"` 不可达(到达该函数的 mimeType 只剩 wav/mp3/flac)——注释写着 "must cover … plus audio/ogg",描述的是代码没兑现的意图。
- **测试锚定值反模式(本次漏报源)**:`TestTranscribeOggNoFFmpegPassthrough` 注释声称「the original bytes reach whisper under the .ogg name」,但 `fakeTranscript` helper 硬编码 `audio.wav` 作期望值——断言恰好锚定在**缺陷行为**上,绿测试掩盖了 mislabel。共享 helper 硬编码期望值 = 把锚定值钉死在当前(错)行为,和「断言存在而非断言值」是同族反模式。
- 归因:`audio, mimeType = wav, "audio/wav"` 这行早于 #24312(#24310 时代已如此),但 #24312 把 OGG 例外写进了设计声明 + extForMIME 注释 + 测试注释,「声称的直传」与「实际的改写」从它起正式背离——计入本次。
- **修法方向**(小改):`ensureWav` 返回有效 mimeType(或 transcoded bool),仅在真转码时 relabel;`fakeTranscript` 增加 filename 参数或该测试内联 `:audio.ogg` 期望;`extForMIME` 的 ogg case 随之复活。**频率低**(无 ffmpeg 主机 + OGG 上传),不阻塞 #24312 关闭,开跟进任务即可。

## 验证

- `go build ./...` / `go build -tags server`:干净(根包需补 `frontend/dist` 占位——worktree 预存在环境问题,历次 review 同款;ld macOS 版本告警为本机预存在)。
- `go vet ./internal/stt/`(含 `-tags integration`):干净。
- `go test -count=1 ./internal/...`:16 包全绿;`go test -race -count=1 ./internal/stt/`:绿。
- **真 ffmpeg 8.1.1 矩阵**:`go test -tags integration -run TestTranscodeRealFFmpeg` 4/4 PASS(trailing-moov/faststart/webm/垃圾)——P1 头条 case 独立复核成立。
- OGG mislabel:临时探针测试实证(运行后已删,仓库零残留)。
- 三端矩阵(§4.7/§5.6):零前端改动;后端行为(错误分类/路由)经 `go test ./internal/remote/` 覆盖,通道无变化。

## 结论

**PASS(1×P2 跟进项)**:#24311 的 P1 修复真实成立——输入临时文件 + 零帧产物校验 + fake 契约升级 + 真 ffmpeg 矩阵四件套齐备,回归断言锚定物理量与全链值,非存在性断言;P3-a/P3-b 实现与声明一致。**跟进任务**:修 OGG 无 ffmpeg 直传的 mimeType 无条件改写(P2,含 `fakeTranscript` 硬编码锚定值修正)。

## 下一步

- 开任务修 OGG passthrough relabel(ensureWav 返回有效 MIME + 测试锚 `.ogg` 文件名 + `extForMIME` ogg case 复活)。
- 教训沉淀:共享 test helper 里硬编码的期望值会把「断言锚定值」退化成「锚定当前行为」——helper 硬编码的期望必须与其声称验证的语义逐字对齐,否则比不断言更糟(给人已验证的错觉)。
