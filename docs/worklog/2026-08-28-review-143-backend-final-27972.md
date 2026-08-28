# Review #27972:#143 后端面终审(read basename 泛化 + 0020 迁移)

日期:2026-08-28
状态:**APPROVE**(无阻塞项,3×P3 非阻塞记录在案)
审查对象:`d72b116`(internal/permissions + internal/acp 测试)、`1f3c754`(0020 迁移 + migrations_test.go),基线 `bba6867`;worklog `3e28a42`。

## 审查方法

反向追踪消费链(防「类型补丁」)+ 迁移 SQL 独立实证(SQLite 边缘形状矩阵)+ 三包全量测试复跑,不顺着 commit message 叙事走。

## 逐项验证(证据)

1. **消费链通电(非空壳)**:`ExactMatchRule` → `handler.emitGlobalRule`(handler.go:593,快照回调指针防竞态)→ `OnGlobalRule` → `chat.persistGlobalPermissionRule`(chat.go:3587)→ `store.CreatePermissionRule` + 活跃 session 规则快照刷新;运行时消费点为引擎 `matchPaths`(permissions.go:107)。后端 `PathPattern` 全部读写点已枚举,无孤儿写入。
2. **引擎语义核实**:无 `/` pattern 分支(permissions.go:203-217)对无元字符 pattern 做**严格 basename 等值**(`notes.md` 不误命中 `notes.md.bak`);多 location 请求取首个 basename 仍自复现(首个 basename ∈ locations → matchPaths 命中)。`matchPath` 对 `""` location 的旧行为(空 pattern = 通配)在新代码下变为 `.`(近 no-op),严格更安全。
3. **迁移 SQL 正确性**:
   - 列名/默认值与 0009 schema 逐一比对通过;`command_pattern TEXT NOT NULL DEFAULT ''` 故 `= ''` 谓词完备;`validatePermissionRule`(chat.go:3687)把 level 锁定为小写三常量,`level='allow'` 谓词完备;`now()` 为 UnixMilli(store.go:157),与迁移 julianday 毫秒表达式口径一致。
   - 注册路径:`//go:embed migrations/*.sql` 目录级 embed,0020 自动纳入;runner 按 n > schema_version 递增执行,零填充文件名字典序 = 数值序。
   - **独立实证**(sqlite3 边缘矩阵,不依赖作者测试):basename 表达式对 UTF-8(`笔记.md`)、数据含 `%`(`50%.md`)、内嵌双斜杠(`/a//b/c.txt`→`c.txt`)全部正确;尾随 `/`(`//`、`/tmp/x/`)确实计算出空串——守卫是承重的,注释声称准确;glob 行(`docs/*.md`)不加守卫会改写成 `*.md`(静默扩大),守卫真实拦截。
4. **测试复跑**:`go test ./internal/permissions ./internal/acp ./internal/store` 全绿。断言均为**锚定值**(精确规则结构体、精确路径字符串),非「字段存在」式;迁移测试二次执行幂等断言在位。
5. **worklog 3e28a42 与代码一致**:硬性三场景、7 形状回放、真实库 0 条 read+allow+路径行(no-op 结论)均与实现吻合。
6. **AGENTS.md 合规**:新注释英化(§3.7);mock 单测不启真 harness(§5.1);原子提交、docs 与代码分开(§6.2)。

## P3 非阻塞(记录在案,不要求本次修)

1. **迁移作用域边界**:0020 改写**所有** `read+allow+含/精确路径` 行,无法区分「全局允许产物」与「用户自写精确 read 路径规则」——后者被静默泛化为 basename;目录前缀规则(如 `/etc`,search/glob 类请求的 location 可能是目录)改写后**丢失前缀语义**(不再匹配 `/etc/passwd`,只匹配名为 `etc` 的文件)。对 read 低危、且与 #143 产品方向一致,但 worklog 只记录了 glob 守卫的收窄理由,未记录这条边界;后续若做规则来源标记(author=global-allow/user)可一并收口。
2. **迁移测试缺口**:尾随 `/` 存量形状(守卫的立论场景,断言不被改写)与无 `/` 已是 basename 的形状均未入 7 形状矩阵——守卫分支目前只有我的实证背书,无回归测试锚定。
3. **Windows `filepath.Base` 分歧**:Windows 上 Base 按 `\` 切分;若 harness 上报正斜杠路径,`Base` 原样返回全路径 → read 规则退化为精确路径(自复现成立,仅失去跨项目泛化),优雅降级非正确性破坏;原生反斜杠路径下 basename 泛化正常(`matchPath` basename 分支对分隔符宽容)。

## 结论

两个提交语义正确、守卫有据、测试锚定值断言在位、迁移幂等且已独立实证;消费链全链路通电。APPROVE。P1-2 无;P3 三条留档。
