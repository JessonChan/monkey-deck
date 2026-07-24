# 切会话滚动位置残留修复:空 items 切换分支未复位 stick/FAB

日期:2026-07-24
分支:`md/d1bc33d6`(本地,未推送)
关联:issue #33 虚拟化后续;承接 `2026-07-24-fix-convergence-stick-flip.md`

## 起因(用户实测)

收敛期贴底误翻(stick-flip)修复后,用户仍报告:切换会话后视图「不在底部」,
甚至全新会话也浮着小圆球(FAB)。具体路径:
- 从 `d1bc33d6…` 切到 `c1b7c453…`,落点偏上、FAB 出现;
- 全新会话 D 同样出现。

用户强调这不是「记住上次位置」的问题——全新打开也复现。

## 根因

`ChatView.tsx` 主 `useLayoutEffect` 的切 session 分支,对 **items 为空** 的目标
(切走丢弃后重载中 / 首次加载中 / **全新空会话**)只做了:

```ts
pendingScrollRef.current = sessionId;
anchorRef.current = null; // 旧 session 的锚点不带过切换
```

**漏了复位 `stickToBottomRef` 与 `showScrollBtn`。**

于是从「已上翻」的 A(stick=false、FAB 可见)切到空 D 时,A 的滚动态残留:
- `showScrollBtn=true` → D 还没任何内容就浮着小圆球;
- `stickToBottomRef=false` → 待 items 到达、`applyInitialPosition` 补做定位前,
  视图停在错位且不会自动贴底。

`applyInitialPosition`(items 到达后)本会把 stick 复位为 true、隐藏 FAB,
但残留态在「切换瞬间 → items 到达」这段窗口里已可见;若用户快速连切多个会话,
或收敛瞬态再次翻转 stick,就稳定表现为「不在底部 + 小圆球」。

## 改法

空 items 切换分支补齐状态复位(与 `applyInitialPosition` 的贴底语义一致):

```ts
} else {
  pendingScrollRef.current = sessionId;
  anchorRef.current = null;
  stickToBottomRef.current = true;   // ← 新增
  setShowScrollBtn(false);           // ← 新增
}
```

不变量:切 session 时旧 session 的滚动态(锚点 / stick / FAB)**一律不带过切换**,
新 session 从「贴底看最新」的干净态起步,items 到达后再按记忆恢复或保持贴底。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:空 items 切换分支补 `stickToBottomRef=true` + `setShowScrollBtn(false)`。
- `frontend/src/components/ChatView.virtual.mount.test.tsx`:新增 4 个切会话场景测试
  (异步加载 / 缓存同帧到达 / 全新不足一屏 / **从已上翻的 A 切到空 D**)。

## 验证

- **TDD**:新测试「从已上翻的 A 切到全新空会话 D」在修复前失败
  (`expect(host.querySelector(".scroll-bottom-btn")).toBeNull()` 收到残留的 FAB 按钮),
  修复后通过。
- `tsc --noEmit`:OK。
- `bun test`:123 pass / 0 fail(较修复前 119 +4 个新测试)。
- `bun run build`:绿(仅既有的 chunk-size 警告)。

## 下一步

- 真机(macOS WebKit)复测:从已上翻的会话切到全新 / 加载中的会话,确认 FAB 不残留、落点贴底。
- 跨平台(WebView2 / WebKitGTK)抽检滚动落点一致性(§4.6)。
