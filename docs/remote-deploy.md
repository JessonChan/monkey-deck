# 远程访问公网部署(Caddy + SSH 隧道,M3)

> 目标:手机在外网经 `https://md.example.com`(示例域名)安全访问桌面进程内嵌的远程服务(§1.8)。
> 链路:`手机 ──TLS──> 公网机 Caddy(443) ──本机回环──> SSH 隧道 ──加密──> Mac(9260)`

## 0. 前置

- 一台有公网 IP 的服务器(下称「公网机」),域名 `md.example.com` 的 A 记录指向它
- 公网机放行 80/443(80 是 Let's Encrypt 签证书用的)
- Mac 上 app 的远程服务已开启(设置 → 远程),记下端口(默认示例用 9260)

## 1. 公网机:Caddyfile

```caddyfile
md.example.com {
    # Caddy 自动申请/续期 Let's Encrypt 证书(需要 80 端口可达)
    reverse_proxy 127.0.0.1:9260
}
```

就这些。说明:

- **WebSocket 自动透传**(`/wails/events` 无需额外配置)
- **无 Nginx 的 `proxy_read_timeout` 坑**:agent 一轮跑几十分钟也不会被掐
- 可选强化(需 xcaddy 自编译 `caddy-ratelimit` 插件):给 `/pair` 限速防爆破。不装也够——应用层配对码本身 10 分钟有效 + 错 5 次烧死 + 一次性
- 反代只连公网机**本机回环**,不暴露隧道端口到公网机网卡(`GatewayPorts` 保持默认关闭)

## 2. Mac → 公网机:SSH 反向隧道 + launchd 保活

### 2.1 免密登录

```bash
ssh-keygen -t ed25519 -f ~/.ssh/md_tunnel -N ""
ssh-copy-id -i ~/.ssh/md_tunnel.pub user@公网机IP
```

### 2.2 隧道命令(手动验证用)

```bash
ssh -i ~/.ssh/md_tunnel -N -R 127.0.0.1:9260:localhost:9260 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    user@公网机IP
```

- `-R 127.0.0.1:9260:localhost:9260`:公网机回环 9260 → Mac 的 9260,**只绑回环**(外网摸不到隧道口)
- `ServerAliveInterval`:防 NAT 空闲断连;`ExitOnForwardFailure`:端口被占时立即失败而非静默空转

### 2.3 launchd 常驻(断线自动重连)

`~/Library/LaunchAgents/com.monkeydeck.tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.monkeydeck.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-i</string><string>/Users/你的用户名/.ssh/md_tunnel</string>
    <string>-N</string>
    <string>-R</string><string>127.0.0.1:9260:localhost:9260</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>user@公网机IP</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/md-tunnel.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.monkeydeck.tunnel.plist
```

## 3. Mac:app 设置(关键,不做这步手机配不了对)

配对 cookie **按域名(origin)生效**:手机必须经 `md.example.com` 完成配对,凭证才落在这个域名上。而桌面端默认用局域网地址生成链接/二维码。所以:

设置 → 远程 → **公网地址** 填 `https://md.example.com` → 保存。

之后「配对新设备」的**二维码和「复制配对链接」都优先用公网地址**:

```
https://md.example.com/pair?sid=<一次性sid>   ← 手机在外网打开,输入 6 位码
```

## 4. 手机侧

1. 打开配对链接(或扫二维码)→ 输码页
2. 输入桌面端显示的 6 位配对码 → 配对成功,365 天免输
3. Android Edge/Chrome 在 HTTPS 下会提示「安装应用」——PWA 独立全屏、无地址栏
   (局域网 HTTP 下只有快捷方式,这是浏览器的安全策略,见 worklog 2026-08-23)

## 5. 安全模型(此链路下)

| 层 | 机制 |
|---|---|
| 传输 | 手机↔公网机 TLS(Caddy 证书);公网机↔Mac SSH 加密 |
| 配对 | 2-of-2:链接里的 sid × 手输的 6 位码,10 分钟/一次性/错 5 次烧死 |
| 会话 | 每设备独立会话,可单独踢;Regenerate token = 全踢 |
| 应急 | 泄露任何单一元素(链接/码/旧链接)均无法进入 |

## 6. 常见问题

- **证书签发失败**:检查 80 端口可达、DNS 已生效(`dig md.example.com`)
- **隧道通了但 502**:Mac 端远程服务没开,或端口与 `-R` 不一致
- **手机在家走局域网、在外走域名**:两个 origin 各自配对一次即可(同一台服务器,两个凭证)
