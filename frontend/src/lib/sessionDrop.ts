// sessionDrop.ts:切走丢弃的判定谓词(内存优化)。
// 唯一职责:决定"从 oldSession 切到 newSession 时,oldSession 的 items 缓存能否安全丢弃"。
// 抽成纯函数便于单测锁住安全不变量——尤其"prompting 时绝不丢"(会丢流式内容)。
//
// 安全不变量(§5.3):
//   1. 没有旧 session(首次打开)→ 不丢(无对象)。
//   2. 新旧相同(重复打开同一 session)→ 不丢(无意义且会丢当前内容)。
//   3. 旧 session 正在 prompting(流式回合进行中)→ 绝不丢(事件还在往缓存灌)。
//   其余(idle/empty/error,即空闲态)→ 可丢,切回时从 DB 重载(idx_messages_session 索引)。

/**
 * @param oldSession  切走前的 session id(null 表示之前无选中)
 * @param newSession  切向的 session id
 * @param oldStatus   oldSession 当前的状态("prompting" | "idle" | "empty" | "error" | ...)
 * @returns true 表示可安全丢弃 oldSession 的 items 缓存
 */
export function shouldDropOnSwitch(
  oldSession: string | null,
  newSession: string,
  oldStatus: string,
): boolean {
  return (
    oldSession !== null &&
    oldSession !== newSession &&
    oldStatus !== "prompting"
  );
}
