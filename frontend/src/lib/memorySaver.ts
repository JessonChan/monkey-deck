// 内存优化(切走丢弃)开关:localStorage 持久化 boolean,默认开启。
// 见 docs/worklog/2026-07-18-drop-session-items-on-switch.md。
//
// 开启:openSession 切走空闲 session 时清空其 itemsBySession 缓存(见 App.tsx),
// 降低 WebKit heap 随开过 session 数累积;切回时从 DB 重载(idx_messages_session 索引,毫秒级)。
// 关闭:保留所有已开会话缓存 —— 切换瞬开无重载,但内存随开过 session 数线性增长
// (对切换闪顿敏感 / 内存充裕的用户可关)。
//
// 读写模式对齐 notifySound:App 直接调 isMemorySaverEnabled(每次切换读最新值,无 stale closure);
// 设置面板经 settingsStore 响应式读写(面板需要响应式状态,行为层不需要)。

const STORAGE_KEY = "md:memory-saver";

// 默认开启:多数用户受益于内存回收。
export function isMemorySaverEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true; // 受限环境兜底:默认开。
  }
}

export function setMemorySaverEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* noop:隐私模式 / 受限存储 */
  }
}
