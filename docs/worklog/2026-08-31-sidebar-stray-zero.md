# Sidebar 项目行孤立 0(#28911)

## 起因

用户报告:项目行(session-list 区域)出现孤立的 `0` 字符。

## 根因

`frontend/src/components/Sidebar.tsx` session-list 空态守卫写成了:

```tsx
{(searching || activeTags.length) && list.length === 0 && (
  <div className="session-search-empty">{t("sidebar.noMatch")}</div>
)}
```

`searching=false` 且 `activeTags.length===0`(默认态:未搜索、无 tag 过滤)时,`(false || 0)` 求值为**数字 `0`**,`0 && …` 短路返回 `0`,React 把数字 `0` 渲染成文本节点 → 每个展开项目的 session-list 底部都多出一个孤立 `0`。经典 JSX falsy-number 陷阱:`&&` 守卫的左侧必须是 boolean,不能是可能为 `0` 的 number。

## 改法(一行根修)

```tsx
{(searching || activeTags.length > 0) && list.length === 0 && (
```

左侧恒为 boolean,`false` 渲染为空,`0` 不再漏进 JSX。

## 同 pattern 审计(全 frontend/src)

- `(a || b.length) && <jsx>` 模式:仅此一处(Sidebar.tsx:1013)。
- `*.length &&` / `*.size &&` / `*Count &&` 等可渲染数字守卫:`frontend/src/lib/virtualList.ts:59` 的 `while (j < items.length && …)` 是纯 JS 逻辑(布尔上下文,无渲染),不属此类。
- `Composer.tsx` 的 `fmtCost(o.value) && <span>`:返回 `string | null`,`null` 渲染为空,安全。
- `ChatView.tsx:1343` `summaryCopyText.trim() &&`:空串渲染为空,安全。
- `DiffPane.tsx`、`Composer.tsx` 其余计数守卫均显式 `> 0`,安全。

**结论:全仓仅此一处渲染路径受影响。**

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx` —— 1013 行守卫加 `> 0`(一行)。
- `frontend/src/components/Sidebar.stray-zero.mount.test.tsx` —— 新增回归测试(沿用 `Sidebar.expanded.mount.test.tsx` 的 mock 脚手架):①默认态(未搜索、无 tag)挂载断言 session-list 无孤立 `0` 文本节点;②搜索无命中时 noMatch 分支仍正常渲染且无 `0`。

## 验证

1. **先复现**:临时把 1013 行回退为旧写法 → 新测试 test 1 失败(`strayZeroNodes` 恰好找到 1 个孤立 `0` 文本节点),精确复现 bug。
2. **再修复**:恢复 `> 0` → 新测试 2/2 通过。
3. **回归**:Sidebar 全套 7 个测试文件 41 用例全过;frontend 全量 `bun test --isolate` 通过。
4. **构建**:`bun run build`(tsc + vite)干净通过(全新 worktree 需先 `wails3 task bindings` 生成 bindings——gitignore 的产物,非本改动引入)。

## 下一步

无遗留。该 pattern 已全仓审计,无同类隐患。
