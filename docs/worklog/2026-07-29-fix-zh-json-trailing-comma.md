# 修复 zh.json 尾随逗号导致 production 打包失败

## 起因

`wails3 task package`(对应 `bun run build`,即 `tsc && vite build --mode production`)
在 rolldown 的 `builtin:vite-json` 插件处报错:

```
[builtin:vite-json] plugin `builtin:vite-json` threw an error
Caused by:
    trailing comma at line 368 column 3
```

整个 `package` task 因此以 exit status 1 失败。

## 根因

`frontend/src/i18n/locales/zh.json` 中 `scm` 对象的最后一个属性
`mergeNothingTip`(原文件第 367 行)多了一个尾随逗号:

```diff
-    "mergeNothingTip": "...或此会话可能已合并过。",
+    "mergeNothingTip": "...或此会话可能已合并过。"
   },
```

对照 `en.json` 同位置(无尾随逗号)即可确认。这是 JSON 语法错误 ——
开发模式(dev / Vite ESM 加载)宽松通过,production 产物打包时
`vite-json` 严格解析才暴露。报错行号 368 column 3 指向尾随逗号后的 `}`,
定位时容易看错行,实际逗号在第 367 行末。

## 改法

删除该尾随逗号。

## 改了哪些文件

- `frontend/src/i18n/locales/zh.json`:删 `mergeNothingTip` 行末多余的 `,`。

## 验证

```bash
python3 -c "import json; json.load(open('src/i18n/locales/zh.json')); json.load(open('src/i18n/locales/en.json'))"
# both valid

bun run build   # ✓ built in 359ms
```

`en.json` / `zh.json` 均通过严格 JSON 解析;`bun run build`(即 `package`
task 失败的那一步)成功产出 `dist/`。

## 下一步

- 编辑 locale JSON 时留意尾随逗号(JSON 不允许,与 TS/JS 不同)。后续可考虑
  加一条 pre-commit 校验(`python3 -m json.tool` 或 `jq empty`)防止再犯。
