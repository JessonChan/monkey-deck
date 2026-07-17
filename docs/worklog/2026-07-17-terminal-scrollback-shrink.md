# 2026-07-17 终端内存:scrollback 5000 → 1000

## 起因
排查 monkey-deck 内存占用偏高时,定位到集成终端(xterm.js)是显著内存源。
逐项核查终端的内存来源,分三层:

1. **scrollback buffer**:`scrollback × cols × cellSize`,跟输出量线性相关(按需增长,撞上限后变环形)。
2. **xterm 实例基线**:`new Terminal()` + `open()` 一调即分配(renderer/viewport/input/selection/accessibility/字体测量等子系统),~5-10MB,与输出无关、与 option 无关。
3. **多终端累积**:`termRegistry` 全局 Map 只在显式关 tab 时 dispose,开过的终端全留着;且游离终端仍在后台收 PTY 数据继续灌 buffer。

## 根因(协议/选型调研)
本轮的核心问题是:**xterm 这个控件本身能给的内存旋钮有哪些?**

核查 xterm v6 `ITerminalOptions` 全字段(`node_modules/@xterm/xterm/typings/xterm.d.ts:26-322`),逐项分类:

- **唯一值得改的**:`scrollback`(默认 1000,我们早期设的 5000 = 5× 默认)。buffer 内存随 scrollback 线性增长,这是控件层面唯一有量级效果的内存杠杆。
- **必须保持 off(已是默认,不动)**:`screenReaderMode`(开了维护 ARIA 文本镜像,buffer 内容双份存储)、`minimumContrastRatio`(per-cell 计算并存储调整后颜色)、`allowTransparency`("can negatively impact performance")、`scrollOnEraseInDisplay`(开了会把清屏内容塞进 scrollback,越清越满)。
- **对 DOM renderer 不适用**:`customGlyphs` / `rescaleOverlappingGlyphs`(typings 明说 "doesn't work with the DOM renderer";我们没用 webgl/canvas addon,走 DOM renderer)。

**结论:xterm 控件层面,内存优化的有效旋钮只有 `scrollback` 这一个。** 实例基线、多终端累积、bundle 体积都不是 option 可解的,属上层架构范畴。

### 选型调研:xterm 有无替代品?
查 `references/` 同类项目 + 外部库,确认无更优替代:

- **orca**(最贴近同类:桌面 agent 客户端、多 session/worktree):同样用 `@xterm/xterm` + node-pty,**没换库**;选了 WebGL renderer,但为此写了大量配套(context-loss 恢复、glyph atlas 重建、Linux 软件渲染检测)。见 `references/orca/src/renderer/src/lib/pane-manager/pane-webgl-renderer.ts`。
- **VS Code**(集成终端金标准):xterm.js 的上游主要维护者,自己用 xterm.js。
- **openwork / wesight**:无集成终端。
- **hterm**:Google 的 Secure Shell 终端渲染器,几乎停维(Secure Shell Chrome app 已下架),比 xterm.js 更重,不算活选型。
- **wasm/Rust 终端**:wezterm/alacritty 是原生终端,term model 没有单独打包成 web 库。
- 业界所有正经 web 终端(Hyper/Tabby/ttyd/Gitpod/Theia/Codespaces)全部用 xterm.js。

**Web 终端领域 xterm.js 是事实唯一生产级选择,无"性能更好且可替代"的库。** 本轮只做控件层面唯一有效的 `scrollback` 收敛,不动 renderer(详见"下一步")。

## 改法
`frontend/src/lib/termRegistry.ts`,`new Terminal({...})` 的 `scrollback` 字段:
- `5000` → `1000`(对齐 xterm.js / VS Code 集成终端默认值)。
- 加注释说明取值依据(集成终端够用 + 相比 5000 收敛 5×)。

## 改了哪些文件
- `frontend/src/lib/termRegistry.ts`:`scrollback` 5000→1000,+注释。(+4/-1)

## 验证
- `cd frontend && npx tsc --noEmit`:通过(exit 0)。
- `cd frontend && bun test`:34 pass / 0 fail(64 expect calls)。
- 改动是单数字常量 + 注释,类型与现有调用点不变。

## 下一步(显式不做 / 留待决策)
本次只做 `scrollback` 这一项。其余终端内存杠杆**未做、需另定方向**:

- **代码分割 xterm(懒加载 TerminalPanel)**:xterm 占前端 bundle ~477KB(948KB 总量的一半),启动即全量 parse+JIT+常驻,哪怕用户从不开终端。本次用户判定"本身也没多少",**不做**。
- **registry 多终端回收策略**:游离终端不回收,开过的全累积。和"切回见历史/后台进程不死"的现有 UX 有张力,不是无脑删;需先定回收策略(如非 active session 的终端 N 分钟无 attach 则 dispose,或 cap 总 live 终端数)。**待决策**。
- **renderer 不动**:orca 的 WebGL 路线是为了渲染速度/CPU,不是省内存——它把开销挪到 GPU 字形图集内存 + 引入 context-loss 脆弱性(orca 为此写了几百行恢复逻辑)。我们 DOM renderer 对"内存 footprint"目标是对的,不换。

> 内存优化的整体上下文(WebKit 网页内容进程 2.9GB、itemsBySession 多 session 累积、消息列表虚拟化已决定不做)见本轮对话历史,不在此重述。
