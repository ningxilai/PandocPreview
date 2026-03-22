# 依赖

该包依赖于 [deno-bridge](https://github.com/manateelazycat/deno-bridge) 与 [EmacsWebsocket](https://github.com/ahyatt/emacs-websocket)，在使用前应当安装 Deno、Pandoc 与 Racket Pollen，如需其他后端，也应自行安装。

## 安装 deno-bridge

```bash
git clone --depth=1 -b master https://github.com/manateelazycat/deno-bridge ~/.emacs.d/site-lisp/deno-bridge/
```

并在 Emacs 配置中添加：

```elisp
(add-to-list 'load-path "~/.emacs.d/site-lisp/deno-bridge/")
(require 'deno-bridge)
```

# 扩展

如上文所述，该包的扩展非常简单，仅需要修改 `pandoc-preview-backends`。
