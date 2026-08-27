# 前端 Review:f7bd54d STT 全链路移除(Task #26717)

## 起因

Review commit `f7bd54d refactor(stt): 移除语音听写全链路(#142)` 的**前端面**(frontend/src/):删除语音听写功能后是否残留死引用、i18n 奇偶是否同步、删除型改动是否干净切换。

## 审查方法与结论:**PASS**

移除型 PR 的风险方向与新增型相反——不是"字段没人消费"而是"消费端悬空"。逐项核对:

### 1. 零残留(grep 全量扫描)

- `frontend/src/` 下 `stt|dictat|transcri|whisper|AudioLines|voice-btn|voiceError|voiceErr|voiceDictate|voiceStop|voiceTranscri` **零命中**(表面命中均为子串误报:`la​stText`/`Li​stTerminals`/`Gue​stTip` 含 `stT`)。
- `sttClient.ts`/`sttClient.test.ts`/`Composer.voice.mount.test.tsx` 删除后,全仓(ts/tsx/js/json)无任何 import/引用残留。
- 重新生成 Wails bindings(`wails3 generate bindings`:2 Services / 124 Methods,与 commit message 声明一致),bindings 目录无 STT service。

### 2. Composer.tsx 干净切换

- 已删:`voiceError` state、听写 mirror ref、`insertAtCursor`/`toggleVoice`、键盘 Esc 分支、错误行 JSX、mic 按钮块、`sttClient` import——全部标识符 grep 零命中,无悬空 handler/state/effect 分支。
- **保留的 `Mic` 图标 import 不是残留**:逐点确认两处消费——`audio-btn` 音频**附件**按钮(L1011,`addAudios`)与附件 chip 文件名图标(L798)。音频附件是独立于听写的功能,diff 未触及。
- `AudioAttachment` 类型链路(选文件→chip→发送)完整未动。

### 3. CSS(移动端白名单)

`.compose-tools` 手机端规则从 `:not(image-btn):not(voice-btn)` 收敛为 `:not(image-btn)`。行为差分析:旧选择器在手机端**本就只放行** image-btn 与 voice-btn(audio-btn 之前就隐藏),voice-btn 删除后白名单收敛无行为增量;`.voice-btn.recording` 样式块全删,无孤儿类。

### 4. i18n 奇偶同步

脚本扁平化比对 en/zh 两棵树:**675/675 键完全同步**,`onlyEn`/`onlyZh` 双向为空;`voice*` 键(含嵌套 `voiceErr.*`)在两语言各删 11 行,无半删。

### 5. 门禁复跑(本 worktree 实测)

| 门禁 | 结果 |
|---|---|
| `bunx tsc --noEmit` | exit 0(worktree 无 node_modules/bindings,先 `bun install` + `wails3 generate bindings` 后复跑) |
| `bun test --isolate` | **373 pass / 0 fail**(46 files,7170 expect),与 commit message 声明一致 |

## 三端说明

本次为**删除型**改动,无新增 UI 面;三端共享同一前端,上述全量 grep + 门禁对三端同时成立。移动端唯一触点(CSS 白名单)已逐行为核对无增量。后端面(internal/stt、/api/stt、Info.plist、事件闭集)由后端 reviewer 负责,本次不覆盖。

## 下一步

无阻塞。STT 移除前端面收口干净,可与 `2e9c756`/`9b3f350` 的后端复核结论合并视作 #142 关闭依据。
