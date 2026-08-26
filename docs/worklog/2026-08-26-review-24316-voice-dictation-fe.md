# 2026-08-26 Review #24316:#131 阶段2 前端语音听写(sttClient 分流/录音态/tracks/光标插入)

## 起因

Task #24316:frontend review #131 阶段 2 前端语音输入(main `2c73c33`/`3889d42`/`c8c6409`)。
重点:sttClient 分流 / 录音态 / tracks 释放 / 光标插入 / Info.plist / i18n / mock 测试;附反模式检查(类型补丁 / 断言锚定值)。

## 核查结论(逐项,全部实证)

### 1. sttClient 分流 —— PASS

- `transcribeAudio` 按 `isRemoteClient()` 分流:桌面 webview → `SttService.TranscribeAudio(b64, mime)`(base64,对齐图片附件惯例);远程/PWA → `POST /api/stt`(raw body,同源 cookie)。单调用点双传输,符合 §1.8 三端规则。
- **binding wire 对齐(本 worktree 重新 `wails3 gen bindings` 实证)**:生成 `frontend/bindings/.../internal/stt/service.js` 的 `TranscribeAudio(audioB64, mimeType)` 与 Go `internal/stt/stt.go:365 TranscribeAudio(audioB64, mimeType string) (string, error)` 参数序/语义一致。
- **Content-Type 带 codecs 参数不炸双路**:`pickRecorderMime` 可能产出 `audio/wav;codecs=pcm`;远程路后端 `api_stt.go` 用 `strings.HasPrefix(ct, "audio/")` 放行参数化 CT,`Transcribe` 内 `mime.ParseMediaType` 统一剥参;binding 路 Go 侧同样剥参。前端测试「params preserved; backend strips them」与实现互证。
- 错误分类双路对齐:binding 哨兵文本(`whisper-server not found`/`no STT model downloaded`/`audio too large`/`unsupported audio type`)↔ HTTP 503/413/415,`SttErrorKind` 六类在两路映射一致,测试矩阵锚定具体文本/状态码(非仅「字段存在」)。

### 2. 录音态 / 重入 —— PASS

- `voicePhaseRef`(idle/busy/recording)同步 ref 做重入不变量正确:「busy」覆盖全部异步过渡(startDictation await、stop→transcribe await),快速双击靠 ref 挡,不依赖会过期的 state 闭包——正是 §5.3「不变量而非形状假设」。
- 三态可视:`data-state={voiceState}`(E2E 友好)+ aria-label 随态切换 + react-tooltip(md-tip)+ 录音态红色停止块 + CSS 呼吸脉冲(box-shadow 动画,纯 CSS 轻量,§4.6;`prefers-reduced-motion` 关动画)。
- transcribing 态点击被 busy ref 吸收,不误启新录音。

### 3. tracks 释放 —— PASS(附 1×P3 见下)

逐路径核对 `startDictation`:`getUserMedia` 拒绝 → 无 stream 可漏;`MediaRecorder` 构造失败 → 显式 `stream.getTracks().forEach(t => t.stop())`;`rec.start()` 失败 → `release()`;`stop()` → `await onstop` 后 `release()`;`cancel()` → release;Composer 卸载 → `dictationRef.current?.cancel()`。happy-path 单测断言 `trackStop` 被调(锚定调用次数)。录音分片 `timeslice 250ms` 中途崩溃仍留已录音频。

### 4. 光标插入 —— **P2 缺陷:转写期间键入被静默清掉(本 review 修复)**

- 现象(受控挂载 + deferred mock 实证复现):点停止 → `await transcribeAudio`(whisper 推理数秒)期间 textarea **仍可编辑**;转写返回后 `insertAtCursor` 用的是**点停止那一刻渲染闭包里的旧 `value`**,`onChange(旧快照+转写)` 把用户刚打的字整体回滚清掉。复现终值 `"hello world fix the "`(用户中途键入的 `"bug now"` 丢失)。
- 根因:与 `voicePhaseRef` 注释自己点明的同一类闭包过期问题——`toggleVoice` 异步续体里的 `value` 是过期快照;`cursorRef` 已是 ref(新鲜),`value` 却还是闭包捕获。
- **修法(已落地)**:Composer 增加 `valueRef`(每次渲染镜像受控 value,仅事件/异步续体读、渲染期不读),`insertAtCursor` 改读 `valueRef.current`,光标 `Math.min(cursorRef.current, cur.length)` 夹紧。与代码库既有 ref 权威值模式(`cursorRef`/`navRef`)一致。
- **回归测试**(锚定值):`Composer.voice.mount.test.tsx` 新增「typing during transcription survives the transcript insert」——受控 Shell 包装(onChange 回灌)+ `transcribeGate` 把转写挂起,中途推进 value 模拟键入,放行后断言终值精确等于 `"fix the bug now hello world"`(键入与转写都存活)。修复前该测试失败(终值缺 `bug now`),修复后过。
- 桌面/远程/PWA 三端同一逻辑路径(纯逻辑修复,无视觉/断点/传输变化),§4.7 以逻辑层 mount 测试 + tsc/build 覆盖。

### 5. Info.plist —— PASS(运行时行为待真机)

`Info.plist` 与 `Info.dev.plist` 两份同步补 `NSMicrophoneUsageDescription`,文案人话(用途 + 本地 whisper.cpp)。缺 key macOS 直接杀进程的坑已避。注意:WKWebView 的 `getUserMedia` 运行时可用性(权限弹窗、macOS 版本差异)只能真机验证——列入 #131 真机清单,代码层无可再查。

### 6. i18n —— PASS

en/zh 全键集合 diff 为空(脚本比对,非目测):`voice keys en: 9 zh: 9`(3 个 tip + `voiceErr` 6 类),en-only/zh-only 均空。文案人话、含可操作指引(§4.4:不裸露哨兵/协议串,kind → 本地化文案映射在 UI 层完成)。

### 7. mock 测试 —— PASS

- `sttClient.test.ts`:binding mock 先于 SUT import;桌面路断言 base64/mime 逐参数锚定;错误矩阵(binding 文本 5 例 + HTTP 状态 5 例 + Wails `{message}` 对象解包 + 网络拒绝 + 非 JSON body)全锚定 kind;`pickRecorderMime` 偏好序/回退/缺 MediaRecorder;`startDictation` micDenied 双路径 + happy path blob/释放断言。
- `Composer.voice.mount.test.tsx`:mock 整个 stt lib 锁 Composer 契约(录音态、光标插入锚定 `"foo hello world bar"`、三类失败、×/Esc 关闭、重入清理、disabled 门控)。断言全是锚定值,无「字段存在即过」。

### 8. 反模式检查

- **类型补丁**:无。新增导出逐个反向追踪消费端:`SttErrorKind` → `e.kind` → `voiceErr.*` i18n → 渲染;`SttError.detail` → 测试断言;`DictationHandle.stop/cancel` → toggleVoice/卸载清理;`pickRecorderMime` → `startDictation`;`blobToBase64` → 桌面 binding 路 + 自测。全链路通电。
- **断言锚定值**:两份测试均锚定具体字符串/调用参数(见 §7),无存在性断言。

### 9. 移动端(§4.7/M2 硬约束)

≤768px 保留 voice-btn(`:not([data-testid="voice-btn"])` 仅改移动媒体查询内规则,>768px 选择器不命中,桌面零改动)。触屏听写是合理保留(打字摩擦正是听写消除的)。

## 发现但不修(移交 coder,按优先级)

1. **P3「停止挂死」缝隙**:`startDictation` 的 `stopped` promise 只在 `onstop` resolve;若 `MediaRecorder.onerror` 致命错误后不派发 stop,`stop()` 永挂 → phase 卡 busy + tracks 漏到卸载。修法一行:`rec.onerror = () => resolve()`(部分 chunk 照常转写)。低概率但后果恰是「麦克风灯常亮」这条红线,建议下个 commit 顺手补 + FakeRecorder 加 onerror 旋钮。
2. **P3 零尺寸 blob 静默回 idle**:`blob.size === 0`(点停止早于首个 250ms 分片)直接回 idle 无任何反馈,与 noSpeech 有文案不一致(§4.4)。建议同样走 `noSpeech` 行。
3. **P3 双麦克风图标**:audioSupported 时附件 Mic 按钮与听写 Mic 按钮相邻且同图标(均 `Mic size=17`),语义不同易混。建议换听写图标或附件钮改 AudioLines。
4. **P3 录音中提交**:`submit()` 不检查录音态,Enter 发送后录音继续到点停止/卸载。可接受,记录在案。
5. **主分支既有红门(与本任务无关,已 stash 实证)**:`NewSessionModal.mount.test.tsx` 5 例失败——onConfirm 期望缺 `mcpServerIDs: []` 字段(近期 MCP 选择功能未同步测试期望)。main 的 `bun test --isolate` 当前非全绿,建议尽快补,否则所有前端任务的「测试过」声明都被污染。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`:P2 修复(valueRef 镜像 + insertAtCursor 读最新受控值;含英文注释说明动机)。
- `frontend/src/components/Composer.voice.mount.test.tsx`:新增 stale-closure 回归测试(受控 Shell + transcribeGate 机制)。
- `docs/worklog/2026-08-26-review-24316-voice-dictation-fe.md`:本文。

## 验证

- `bun test --isolate src/lib/ src/components/Composer.voice.mount.test.tsx src/components/Composer.mount.test.tsx src/components/Composer.usage.mount.test.tsx` → **199 pass / 0 fail**(修复前新回归测试复现失败,修复后过)。
- `bun run build:dev`(tsc + vite)→ 绿。
- `bun test --isolate` 全量 → 仅剩 5 例 NewSessionModal 既有失败(干净 HEAD 上同样失败,与本任务及本次修复无关)。
- 三端:修复为纯逻辑(无视觉/断点/传输分支变化),GUI/远程/PWA 同一代码路径;#131 语音功能本身的真机麦克风验证(macOS WebKit 权限弹窗等)维持原真机清单待办。

## 下一步

- coder 跟进 P3×4(onerror 兜底一行修 + 零 blob → noSpeech + 图标区分;录音中提交可不动作)。
- 修复主分支 NewSessionModal.mount.test 既有 5 红门(mcpServerIDs 期望对齐)。
- #131 真机清单:macOS 桌面 mic 权限弹窗 / 远程浏览器 / iOS·Android PWA 听写实测。
