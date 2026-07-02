// 相对时间文案(侧栏 session 尾部用)。
// 阶梯:<5min 刚刚;5-59min N分钟前;1-23h N小时前;1-31d N天前;1-11m N个月前;≥1y N年前。
// ts 为 0/无效返回空串;未来时间(时钟偏差)兜底为"刚刚"。
export function timeAgo(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const sec = diff / 1000;
  if (sec < 300) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(sec / 3600);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(sec / 86400);
  if (day < 32) return `${day}天前`;
  if (day < 365) return `${Math.floor(day / 30.4375)}个月前`;
  return `${Math.floor(day / 365)}年前`;
}

// 完整时间(供 session-time 的 tooltip 显示具体时刻)。
// 格式:YYYY-MM-DD HH:mm;ts 为 0/无效返回空串。
export function formatDateTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
