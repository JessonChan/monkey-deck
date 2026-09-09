# 2026-09-09 #210 CI frontend job 补 GTK dev 依赖(A 案)

## 起因 / 根因

用户直报(任务 #29240,CI 洋葱第五层,#209 修法副作用):frontend job 的绑定生成步
(ci.yml `go run wails3@版本 generate bindings`)在 runner 上现构建 wails3 CLI,
CLI 链接 GTK(cgo),ubuntu-24.04 裸 runner 无 GTK dev 头 → CLI 构建失败。

注:#209 review worklog(2026-09-08)曾以 `GOOS=linux go list -deps` 探针判定
CLI「纯 Go 可编译」;runner 实跑失败(用户直报为准)推翻该结论,本任务不复议探针,
直接落用户拍板的 A 案。

## 改法(A 案,用户拍板)

复制 backend job(#204 落地)的「Install Linux GTK/WebKit dev deps」步进 frontend
job:位置在 setup-go 之后、setup-bun 之前(= 绑定生成步之前,越早装好环境依赖越快失败)。

- `run:` 块与 backend 步**逐字一致**:`sudo apt-get update` +
  `sudo apt-get install -y libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev libglib2.0-dev`。
- backend 的 `if: matrix.goos == 'linux'` 门**省略**:frontend job 无 matrix、单
  ubuntu-24.04,门恒真无意义;步骤注释说明该取舍。
- 修法 B(绑定生成挪 backend job + artifact 共享 bindings)未启用:A 无硬伤。

## 改了哪些文件

- `.github/workflows/ci.yml`:+9/-0,纯插入(frontend job :87-95 = 注释 5 行 + 步骤 4 行);
  backend job(:18-69)与 release.yml **零触及**(改动面单文件断言见验证)。
- `docs/worklog/2026-09-09-ci-frontend-gtk-210.md`:本条。

## 验证

本地无法完全模拟 runner(apt/cgo 实跑),按任务口径以 YAML 解析 + 步骤位置断言为验收基准:

- **YAML 语法**:ruby 2.6.10 / Psych 3.1.0 `YAML.safe_load` 解析通过。
- **步骤位置断言**(ruby 解析 `jobs.frontend.steps` 逐项比对):
  checkout → setup-go → **Install Linux GTK/WebKit dev deps** → setup-bun →
  Install deps → Generate bindings → Type check + build;既有步骤顺序与语义不变;
  新步无 `if` 键(断言证门已省)。
- **包名逐字 diff**:`sed -n '56p'`(backend 步)vs `sed -n '95p'`(frontend 步)
  → diff 无输出,IDENTICAL。
- **纯插入证明**:`git diff -U0` 零删除行;`git diff --stat` = ci.yml 单文件 +9/-0;
  `git status --porcelain` 不含 release.yml。
- **工作区卫生**:`.rak/` 经 `.gitignore:44` 忽略,git status 无运行时文件。
- CI 实跑绿留人(不 push 红线不变)。

## 下一步 / 留人

- coder 停,交 reviewer;流程 coder→reviewer→APPROVE 后 completed-ready。
- 不 push、不关 issue(#210);GitHub Actions frontend job 实跑绿确认留人。
