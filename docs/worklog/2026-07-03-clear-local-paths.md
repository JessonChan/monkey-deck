# 2026-07-03 清除本机绝对路径 + wails3 走 PATH + 测试迁 t.TempDir()

## 起因
仓库要可移植:别人克隆后应能直接跑,不需要来问作者"这个目录是什么"。
排查发现三项把本机绑死的硬编码,会真阻塞别人。

## 改法
- `Makefile:4`:`WAILS3 ?= /Users/jessonchan/go/bin/wailsight` → `wails3`(走 PATH)。
- `internal/acp/concurrent_test.go:25`:`cwd := "/tmp/wesight-study"` → `t.TempDir()`。
- `internal/acp/diag_disconnect_test.go:22`:`cwd := "/tmp/wesight-study"` → `t.TempDir()`。
- `internal/acp/proc_pgidfile_test.go:78-82`:夹具里的本机 omp 绝对路径
  (`bun /Users/jessonchan/.bun/bin/omp acp`)→ 通用占位(`/path/to/omp acp`);
  `isHarnessCmdline` 本身不动(本来就是子串匹配,但 fixture 不该写死作者机器,
  会吓到后来的人)。
- `internal/chat/study_test.go`:文件顶 `/tmp/xxx` const 全删,函数体改成
  `config.TestConfig(t.TempDir())` + DB/答案文件落 `t.TempDir()`;
  wesight cwd 改回相对 `references/wesight` + 找不到就 `t.Skip`
  (提示跑 `bash scripts/references.sh`)。

## 改了哪些文件
- `Makefile`
- `internal/acp/concurrent_test.go`
- `internal/acp/diag_disconnect_test.go`
- `internal/acp/proc_pgidfile_test.go`
- `internal/chat/study_test.go`
- `docs/worklog/2026-07-03-clear-local-paths.md`(本条)

## 验证
- `go build . ./internal/...` exit=0。
- `go test . ./internal/...` 10 packages ok,1 no tests。
- `gofmt -l` 干净(Makefile 是 gofmt 误报,它只该吃 .go)。

## 下一步
- 品牌标识项(`jessonchan`/`com.jessonchan.monkeydeck`)属 fork 成本,
  留给 fork 的人全局替换,不阻塞当前可移植性。
