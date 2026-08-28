# elicitation 形状补收 + 空表可见婉拒(#158 / Task #28390)

## 起因

父 issue #28387。`UnstableCreateElicitation`(`internal/acp/elicitation.go`)的 schema 扁平化此前只认「显式 `type: string|boolean`」的 property,其余形状一律跳过。实测部分 harness 发的 form 不符合这个窄形状:

- **形状 (a)**:property 是 map 但**不带 `type`**,只带 `enum`(JSON Schema 里 type 可省略,string 是默认推断)→ 旧逻辑直接跳过;
- **形状 (b)**:property **本身就是选项数组**(裸数组,连 schema 对象都没有)→ 旧逻辑直接跳过。

两类形状全部不可渲染时 `elicitFields` 返回 `no renderable fields` → handler 直接给 harness 返 Decline。**harness 拿到 decline 会优雅降级(如 omp 命令直接 end_turn 零输出),但前端零反馈**——用户只看到命令静默空转,不知道发生了什么。这与 §3.3「不能裸跑:用户可见」精神相悖。

## 改法

### 1. `elicitField` 形状补收(主干不动)

形状识别按序:

| 形状 | 输入 | 产出 |
|---|---|---|
| 主干(不动) | `{type: string\|boolean, ...}`,string 可带 `enum` | 原逻辑原样 |
| **(a) #158** | map 无 `type` 但带**非空** `enum` | 合成 `Type=string` select(`synthSelect`),选项逐项 `fmt.Sprint`——非字符串项也保留,**选项齐**;顺带带出 map 里的 `title`/`description` |
| **(b) #158** | property 本身是 `[]any` 裸数组 | 合成 `Type=string` select,`Name=key`,选项逐项 `fmt.Sprint` 转字符串 |
| 其余(不动) | 非 map/数组、缺 type 无 enum、空 enum | 跳过(not renderable) |

要点:

- **选项用 `fmt.Sprint` 而非过滤**(形状 a/b 共用 `synthSelect`):JSON Schema 的 `enum` 可含任意 JSON 标量,`{enum:[1,2,3]}` 若按主干的「只收 string」过滤会得到空 Enum——空 select 无法作答,等价于没修。Sprint 对 string 恒等(`fmt.Sprint("a")=="a"`),数字/布尔变 `"1"`/`"true"`,仍是合法可选项。主干 `type:string+enum` 路径**保持原过滤行为不动**(§5.3 不变量:主干零回归)。
- **空 enum(`enum: []`)不合成**:零选项 select 不可作答,跳过让它汇入 fields==0 走婉拒链路,比渲染一个空下拉诚实。
- `url` 模式 decline、超时降级、ctx 取消路径**全部不动**。

### 2. fields==0 可见婉拒(维持 Decline + 推 notice)

`elicitFields` 报错分支(含 `empty properties` 与 `no renderable fields`):

1. **维持 Decline 返回**——harness 侧优雅降级行为不变(空 turn 仍由 empty-turn 检测兜住);
2. **新增 handler 回调 `OnElicitationUnrenderable func()`** + `SetElicitationUnrenderable`(mu 快照读、锁外调用、panic 恢复,与 `SetElicitationResolved` 同一套并发纪律——回调在 ACP reader goroutine 启动后才由 service 赋值);
3. `chat.go startLive` 接线:`SetElicitationUnrenderable(func(){ s.emit(EventStatus, StatusPayload{SessionID: se.ID, Status: "notice", Code: ErrCodeElicitationUnrenderable}) })`——session 闭包对齐 db sessionID(同 `onElicitation`);
4. 前端**零改动**:`chat:status` 的 `notice` 处理是既有通用路径(`App.tsx`:`s.code ? t('chat.notice.'+code) : detail`,蓝色 notice-bar,session 门控),i18n key 双语补齐即生效。

**错误码与文案**(code 驱动 i18n,Detail 留空——同 empty-turn 的不变量,防止英文 locale 看到后端中文):

- `ErrCodeElicitationUnrenderable = "elicitation_unrenderable"`(`internal/chat/chat.go`)
- zh:`chat.notice.elicitation_unrenderable` = 「表单不可渲染,已自动婉拒。」
- en:`"Form could not be rendered; declined automatically."`

**婉拒链路全图**:

```
harness elicitation/create(form)
  → elicitFields 全跳过(fields==0)
  → slog.Warn(带 2KB 截断 schema dump) + notifyElicitationUnrenderable()
  → service emit chat:status{notice, elicitation_unrenderable} → 前端蓝色提示条(chat.notice.*)
  → 同时照旧返 Decline 给 harness → 命令空转结束 → empty-turn notice 兜底(非用户 decline,不置 elicitDeclined)
```

### 3. slog schema dump 截断 2KB(G-2 教训)

新增 `schemaDump(v, limit)` + `schemaDumpLimit=2048`:JSON marshal 后超限截断并追加 `…(truncated)` 标记。**日志里永不出现全量大 schema**。

## 改动文件

| 文件 | 改动 |
|---|---|
| `internal/acp/elicitation.go` | `elicitField` 形状 a/b + `synthSelect`;`schemaDump`/`schemaDumpLimit`;`notifyElicitationUnrenderable`/`SetElicitationUnrenderable`;err 分支接可见婉拒 |
| `internal/acp/handler.go` | `OnElicitationUnrenderable` 回调字段 |
| `internal/chat/chat.go` | `ErrCodeElicitationUnrenderable` 常量;`startLive` 接线 notice emit |
| `frontend/src/i18n/locales/zh.json` / `en.json` | `chat.notice.elicitation_unrenderable` 双语文案 |
| `internal/acp/elicitation_test.go` | 5 个新测试(见下) |

## 验证

### 单元/端到端测试(全绿)

- `TestElicitFieldsEnumOnlyMapSynthesizesSelect`——形状 (a):无 type 有 enum → string select,混合类型 enum(`"fast"/"ulw"/3`)选项齐(`3→"3"`),title/required 带出;
- `TestElicitFieldsBareArraySynthesizesSelect`——形状 (b):裸数组 `["alpha", 42, true]` → 非字符串项 Sprint 化(`"42"/"true"`);
- `TestElicitFieldsUnrenderableShapes`——空 enum / 裸标量 / null 仍不可渲染(汇入婉拒链路);
- `TestSchemaDumpTruncates`——小 schema 原样、超大 schema 截 ≤2KB+标记;
- `TestUnstableCreateElicitationUnrenderableDeclinesWithNotice`——端到端:8KB 不可渲染 schema → Decline 返回 + `OnElicitationUnrenderable` 到达 + slog 输出含 `(truncated)` 且总长有界;
- **既有主干零回归**:`TestElicitFieldsParsesOmpSelect`/`ParsesBoolean`/`RejectsInvalid`/`ResponseToSDK`/`FormDispatchAndRespond`/`UrlDeclines`/`TimeoutDeclines`/`CtxCancel` 全过。

### 门禁

- `go build ./...` ✅ `go vet ./...` ✅ `go test ./...` 0 fail ✅
- `cd frontend && bun run build:dev`(tsc + vite)✅(worktree 需先 `bun install` + `wails3 generate bindings`,bindings 属 gitignore 中间产物)
- `bun test`:405 pass / 10 fail——**与 base(434f5b5)逐位相同**(stash 后 base 全量跑同样 405/10),10 个失败全在 clipboard/CopyIconButton/ErrorCard(全量运行时的 happy-dom 环境串扰,单文件隔离跑全过,已实证与本改动无关);`locales.test` zh/en key 同步 ✅

### 三端说明(§4.7)

本改动为**后端 + i18n 文案**,前端渲染路径(`notice-bar` + `chat.notice.*` 翻译)是既有通用代码,零前端逻辑改动;binding/协议面未动(未改任何导出服务方法签名)。后端行为以 go test 统一验证一次;三端(桌面 GUI / 远程浏览器 / PWA)经同一 `chat:status` notice 通道消费,各端通道本身未改、无需单端回归(与 harness_empty_turn notice 同机制,后者已在三端在线)。实弹验证(真 harness 发出不可渲染 form 看蓝色提示条)依赖特定 harness 行为,留给遇到时人工确认。

## 下一步

- 10 个 bun 全量串扰失败(clipboard 族)与本次无关,建议另开任务排查(happy-dom 环境隔离或单文件拆分);
- 若后续 harness 实测出现新的 schema 形状(如嵌套 object 属性),再按需扩展 `elicitField`,维持「先形状矩阵后代码」。
