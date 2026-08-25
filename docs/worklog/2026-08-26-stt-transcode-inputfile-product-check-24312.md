# 2026-08-26 #24312 修复 #24311 P1:m4a/mp4 管道转码静默空 WAV——输入临时文件化 + 产物非平凡校验 + 2×P3

## 起因

Task #24311 review 对 #24310(ffmpeg 转码 / 4xx 分类 / pgid 清扫)判 **FAIL**:

- **P1**:`transcodeToWav` 用 `-i pipe:0` 不可 seek,MP4 家族 demuxer 需 seek 到
  moov atom(常规 muxing 在文件末尾,非 faststart)→ trailing-moov m4a/mp4
  (大于 ffmpeg io 缓冲 ~128KB,即真实 voice memo 形态)→ **ffmpeg exit 0 +
  78 字节 WAV(data chunk=0,零音频帧)**,静默穿透全部错误哨兵,空 WAV 直达
  whisper-server("failed to read audio data" 或空 transcript)。webm/fMP4 是
  流式容器恰好不受影响——这也是当初只在「happy path + 垃圾输入」两端取样而漏检
  的原因(§5.3 教训)。
- **P3-a**:`MD_FFMPEG` 指向坏路径等 spawn 侧基础设施故障被一律包成
  `ErrUnsupportedAudioType` → 误导性 415(文案还说 "ffmpeg could not decode
  the audio")。
- **P3-b**:`needsTranscode` 之外的不可解码音频(amr/wma/3gp…)fail-open 放行到
  引擎 500。

## 改法

1. **P1(输入临时文件 + 产物校验)**:`transcodeToWav` 输入侧同样走临时文件
   (`-i <tmpfile>` 替代 `pipe:0`,可 seek 后 moov-at-end 正常解);产物 WAV 按
   RIFF chunk 遍历校验 **data chunk 非零**(`wavHasAudioFrames`)——exit-0
   截断类故障的最后一道网,报**通用错误(归 500)**:修复后残余的零帧产出无法
   归因于调用方音频,不当 4xx(与 P3-a 同理)。顺带把 decoded 尺寸闸从
   `ensureWav` 读入内存之后**前移到 stat**(读之前判 `ErrAudioTooLarge`),
   超限解码不再撑爆内存。
2. **P3-a(错误分类)**:spawn 侧故障(`fs.ErrNotExist` / `fs.ErrPermission` /
   `exec.ErrNotFound`——分别覆盖 path 型 override 缺失、不可执行、裸名不在
   PATH)保持通用错误 + 点名坏路径;真解码失败仍归 415。选 review 给的「错误
   分类」方案而非 discovery 校验:后者会把显式 env override 静默降级成 415
   "no ffmpeg found",仍是把配置故障误判客户端错误。
3. **P3-b(白名单反转)**:`needsTranscode`(已知坏名单,fail-open)→
   `nativelyDecodable`(白名单,fail-closed):仅 WAV/MP3/FLAC(引擎
   in-memory 解码器实际支持的形态)直传,其余 audio/* 有 ffmpeg 就转、没有就
   415(OGG 仍是无 ffmpeg 时唯一直传例外)。顺带删 `extForMIME` 的
   `mime.ExtensionsByType` 回退——反转后未知类型到不了该函数,死代码(§5.3)。
4. **fakeffmpeg 升级**(修 P1 时必补的盲区):输入改读 `-i` 后的文件(生产若
   退回 `pipe:0`,所有 happy-path 测试响亮失败——fake 的内置回归哨兵);输出写
   真 RIFF/WAVE(能被产物校验消费);新增 `FAKE_WAV_EMPTY` 旋钮(exit 0 + data
   chunk=0)模拟截断形态——真 ffmpeg 的 exit-0-截断行为此前在 fake 的
   「失败必 exit≠0」契约模型之外。
5. **真 ffmpeg 输入形态矩阵集成测试**(`-tags integration`,§5.1,CI/默认套件
   跳过):trailing-moov m4a(60s@64k≈480KB,fixture 带 moov 位置守卫)/
   faststart m4a / webm-opus / 垃圾输入,断言解码时长 60s±10%——即 review 的
   验收清单固化。

## 改了哪些文件

- `internal/stt/transcode.go`:P1 输入临时文件 + `wavHasAudioFrames` + stat
  尺寸闸;P3-a spawn 故障分类;P3-b `nativelyDecodable` 反转 + 文件头路由说明。
- `internal/stt/stt.go`:`!nativelyDecodable` 调用点 + Transcribe/extForMIME
  注释更新,删 ExtensionsByType 死代码。
- `internal/stt/testdata/fakeffmpeg/main.go`:文件输入 + 真 WAV 输出 +
  FAKE_WAV_EMPTY。
- `internal/stt/transcode_test.go`:`fakeWav` 镜像构造器;新增
  `TestTranscribeFFmpegSilentTruncation` / `TestWavHasAudioFrames` /
  `TestTranscribeFFmpegBadPathIsServerError`;`TestNeedsTranscode` →
  `TestNativelyDecodable`(反转期望);转码/无 ffmpeg 循环补 amr/wma/x-zebra。
- `internal/stt/transcode_integration_test.go`(新):真 ffmpeg 矩阵。
- `AGENTS.md`:§5.3「外部事实先验证」bullet 回写输入形态矩阵教训。

## 验证

- `go build ./...` / `go build -tags server` 干净(根包需补 `frontend/dist`
  占位——worktree 预存在环境问题,#24308/#24310 review 同款;ld macOS 版本
  告警为本机预存在)。`go vet ./internal/stt/`(含 `-tags integration`)干净。
- `go test -count=1 ./internal/...`:16 包全绿;`go test -race -count=1
  ./internal/stt ./internal/remote`:绿。
- **真 ffmpeg 8.1.1 输入形态矩阵(本任务验收清单)**:`go test -tags
  integration -run TestTranscodeRealFFmpeg` 4/4 全绿——trailing-moov m4a
  (moov@mdat 后,480KB)→ 60.0s 完整 WAV(**P1 修复实证**:同款文件经旧
  `pipe:0` 路径在 review 中复现为 78 字节空 WAV)、faststart ✓、webm/opus ✓、
  垃圾输入 → ErrUnsupportedAudioType ✓。
- 截断形态回归:FAKE_WAV_EMPTY(exit 0 + 零帧)→ 通用错误、sidecar 未启动
  (hermetic)✓;坏 MD_FFMPEG(path 缺失 / 裸名)→ 非 415 哨兵、点名坏路径 ✓。
- 三端矩阵(§4.7/§5.6):零前端改动;后端行为变化(转码路由/错误分类)经
  `go test ./internal/remote/` 覆盖(binding/event 通道无变化),无需三端
  重复验证。

## 下一步

- 无阻塞项。记录性备注(review P3-b 尾注已闭环):引擎对畸形 WAV 的 4xx
  透传之类引擎侧行为不在本层职责内。
