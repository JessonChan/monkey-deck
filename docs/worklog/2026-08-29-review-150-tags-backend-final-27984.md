# Review #27984:#150 后端面终审(session 标签 0021 + store + binding)

日期:2026-08-29
状态:**APPROVE**(无阻塞项,2×P3 非阻塞记录在案)
审查对象:`0e0123e`(0021 迁移 + store.Tags/NormalizeTags/decodeTags + tags_test.go)、`d168f57`(chat.UpdateSessionTags binding),基线 `b24622c`;worklog `8c79dd3`。前端面(a060aba)不在本卡范围。

## 审查方法

反向追踪消费链(防「类型补丁」)+ 迁移 SQL 独立实证(sqlite3 探针,不依赖作者测试)+ JSON 解码边缘探针 + 全仓门复跑(build/vet/test/gofmt),不顺着 commit message 叙事走。

## 逐项验证(证据)

1. **迁移 0021(验收点①)**:`migrations/` 目录 glob 实证唯一 `0021_session_tags.sql`,无序号冲突;runner(`store.migrate`)按 `n > schema_version` 递增执行、embed 目录级通配自动纳入、零填充文件名字典序=数值序。**旧库升级安全独立实证**:sqlite3 探针 `CREATE TABLE t; INSERT 2 行; ALTER TABLE ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'` → 存量行全部回填 `'[]'`(NOT NULL 带常量默认的 ADD COLUMN 是 SQLite 文档保证 + 探针复核)。`TestMigration0021ColumnShape` 用 pragma_table_info 钉死 type=TEXT/notnull=1/default='[]'。**写 tags 不动 updated_at**:SQL 仅 `SET tags=?`(sessions.go:110),且测试断言 `after.UpdatedAt != got.UpdatedAt` 即 fail。
2. **损坏行降级(验收点②)**:`decodeTags`(sessions.go:61-73)三防线——空串返 `[]string{}`、Unmarshal 出错返空、nil(JSON `null`)返空;`scanSession` 扫临时 string 再解析,坏行不炸整条 session 读取。测试用裸 `db.Exec` 绕过写层直插 `not json`/`{"a":1}`/`[1,2]`/`null` 四形态 + 0013 前时代风格裸 INSERT 行(列缺省),全部断言「非 nil 空集」——毒行走的是写层之下的通道,非自证式。
3. **归一化规格(验收点③)**:`NormalizeTags`(sessions.go:38-56)逐条对照父 issue 规格:TrimSpace trim、trim 后空串丢(`"  api  "`→`api`、`"\tui\n"`→`ui`)、**大小写敏感**精确去重(`api/API/Api` 三存——Web 与 web 异名 ✓)、`MaxSessionTags=5` 截断保首现序(`a..g`→`a..e`)、去重不烧截断预算(`a,a,b,b,c,d,e,f`→`a..e`)、nil→空;幂等有专项测试(normalize(normalize(x))==normalize(x)),binding「归一化→落库→回传同一集合」的语义因此成立(store 层二次归一化是 no-op)。
4. **store 单测真实性(验收点④)**:全部锚定值断言(`reflect.DeepEqual` 对显式 want 集合),无「字段存在」式;JSON 往返经真 SQLite(newTestStore),ListSessions 与 GetSession 同走 `sessionColumns`/`scanSession` 双路径一致性有断言;脏输入落库干净、空集清空、updated_at 钉死均有。
5. **binding(验收点⑤)**:照 `UpdateSessionCustomTitle` 通路(薄透传 store,同文件同形);`?` 占位参数绑定、无字符串拼 SQL(全仓 grep 实证 sessions 表 SQL 只在 store 层且全部占位符);错误处理与文件内全部 12 个 UpdateSessionX 同约定(ExecContext err 直返,marshal err 有包装);**回传权威集合语义正确**:`normalized := store.NormalizeTags(tags)` → store 落库(幂等再归一化)→ 返回同一 `normalized`,截断场景(第 6 个标签)前端镜像 DB 不漂移。
6. **消费链反向追踪(「类型补丁」检查)**:`Session.Tags`(store.go:92)→ `scanSession` 三个 SELECT 站点(ListSessions/GetSession/SessionsByWorktreePath 全走 `sessionColumns`,25 列 ↔ 25 scan dest 逐一对齐,tags 尾插)→ wire `json:"tags"` → 生成 bindings Session model(`tags` 字段 + `$$createField24_0`)→ App.tsx/Sidebar 消费(前端面复核归前端卡);`MaxSessionTags`/`decodeTags`/`NormalizeTags` 各有真实调用点,无孤儿定义。CreateSession INSERT 不含 tags → DEFAULT '[]' 兜底 ✓。
7. **门复跑**:`wails3 generate bindings`(@v3.0.0-alpha2.106 与 go.mod 同版)重生成后 `UpdateSessionTags`(方法 ID 2041210794)与 model tags 字段在位——作者 regeneration 声明经独立重跑吻合;`bun run build:dev` 产 dist 后 `go build ./...` ✓、`go vet ./...` ✓、`go test ./...` 全包 ok(store 0.57s / chat 20.5s);gofmt 对本次触及的 sessions.go/tags_test.go/store.go 新增段全部干净。
8. **AGENTS.md 合规**:新注释英化(§3.7);单测全 mock/内存库不启真 harness(§5.1/§5.2,t.TempDir/:memory:);原子提交、docs 与代码分开(§6.2,四个 commit 各一职责);未触碰 `$MD_REF_DIR`(§0.2)。

## P3 非阻塞(记录在案,不要求本次修)

1. **`[null]`/`[""]` 手工损坏行解码出空串标签**:JSON 探针实证 `json.Unmarshal("[null]", &[]string{})` 无错返回 `[""]`——decodeTags 的降级防线只覆盖「解析失败」,不覆盖「解析成功但含 null/空串元素」,此类行会把一个空串标签送上 wire/UI。写层(NormalizeTags 丢空串)永远产不出该形态,需手改 DB 才触发,故不阻塞;后续如做 decodeTags 加固可在解析后顺带过滤空串,与 NormalizeTags 对称。
2. **CreateSession 返回的内存 Session `Tags == nil`**(wire `tags:null`,Go nil slice 序列化语义):与读路径恒非 nil 不自洽,但生成 binding 运行时 `$Create.Array` 对 null 显式返 `[]`(runtime/create.js:28-41 实证),前端不受影响;纯 wire 层面观感项,后续顺手在 CreateSession 初始化 `Tags: []string{}` 即可。

**附注(非本卡引入,不留 action)**:`gofmt -l` 标记的 `internal/store/messages.go`/`internal/chat/chat.go`/`internal/chat/turn_persist_test.go` 三文件格式漂移在基线 b24622c 已存在(git checkout 基线版复验同名),且漂移 hunk(EventQueue 对齐、doc comment 智能引号)与本改动零重叠——属旧账,按 §6.2 不夹带原则不在本卡顺手修。

## 结论

迁移序号唯一、旧库升级安全(SQLite 语义 + 独立探针双证)、写 tags 不动 updated_at;损坏行四形态 + 前置旧行全部降级空集不炸读取;归一化六条规格逐条与父 issue 对齐且有锚定值测试;binding 照既有通路、占位符绑定、回传权威集合语义经幂等性背书;消费链全链路通电无空壳。APPROVE。P1-2 无;P3 两条留档。issue #27982 保持开放待人复核,不 push。
