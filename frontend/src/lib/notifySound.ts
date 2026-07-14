// 对话结束提示音:localStorage 持久化开关 + Web Audio 合成短促提示音。
// AGENTS.md §5.3 成熟库优先 / KISS:用原生 Web Audio API 合成两声升调 chime,
// 零音频资源、零依赖,跨平台一致(Wails3 WebView 均支持 Web Audio)。
//
// 浏览器 autoplay 策略:AudioContext 必须在用户手势后才能发声。playNotifySound
// 仅在「用户发消息 → agent 回合自然结束」时触发,此时已有前置手势,ctx.resume() 可解锁。

const STORAGE_KEY = "md:notify-sound";

// 读取开关;默认开启(首次使用即生效,符合「回合结束提醒」的产品预期)。
export function isNotifySoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true; // 受限环境兜底:默认开。
  }
}

export function setNotifySoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* noop:隐私模式 / 受限存储 */
  }
}

// AudioContext 单例(懒创建;复用避免每次播音都重建图)。
let ctx: AudioContext | null = null;

// 播放短促两声升调 chime(880Hz → 1320Hz,sine 波),柔和提示「回合结束」。
// 全程 try/catch 静默失败——提示音是锦上添花,任何异常都不能打断主流程。
export function playNotifySound(): void {
  try {
    if (typeof AudioContext === "undefined") return;
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    // 整体淡入淡出包络,避免爆音(click pop)。
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    gain.connect(ctx.destination);
    const notes = [
      { f: 880, t: 0 },
      { f: 1320, t: 0.12 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.f, now + n.t);
      osc.connect(gain);
      osc.start(now + n.t);
      osc.stop(now + n.t + 0.18);
    }
  } catch {
    /* 静默失败 */
  }
}
