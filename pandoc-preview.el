;;; pandoc-preview.el --- Live preview for documents via browser -*- lexical-binding: t; -*-

;; Version: 0.3
;; Package-Requires: ((emacs "28.1") (websocket "1.15"))
;; Keywords: preview, pandoc, pollen, markdown

;;; Commentary:

;; Live preview for multiple document types in external browser.
;; The TypeScript server is a generic render executor; all backend
;; logic (commands, arguments, watch patterns) is defined in Elisp.
;;
;; Architecture: Emacs creates a websocket server, Deno connects as
;; client.  All communication is bidirectional over this single channel.
;;
;; Usage: M-x pandoc-preview-start / pandoc-preview-stop

;;; Code:

(require 'websocket)
(require 'json)
(require 'cl-lib)
(require 'project)

(defvar pandoc-preview--ts-path nil)

(defvar pandoc-preview--port nil)
(defvar pandoc-preview--root nil)
(defvar pandoc-preview--server nil)
(defvar pandoc-preview--ws nil)
(defvar pandoc-preview--deno-process nil)
(defvar pandoc-preview--active-buffers nil)

(defvar-local pandoc-preview--active nil)
(defvar-local pandoc-preview--syncing nil)
(defvar-local pandoc-preview--sync-timer nil)

;;; Customization

(defgroup pandoc-preview nil
  "Live preview for document files."
  :group 'text
  :prefix "pandoc-preview-")

(defcustom pandoc-preview-browser-command nil
  "Browser executable.  nil = system default.  Examples: \"chromium\", \"firefox\"."
  :type '(choice (const nil) string)
  :group 'pandoc-preview)

(defcustom pandoc-preview-host "127.0.0.1"
  "Server bind address."
  :type 'string
  :group 'pandoc-preview)

(defcustom pandoc-preview-backends
  '(("\\.\\(pm\\|pmd\\|pp\\)\\'"
     :commands (("rm" "-rf" "compiled")
                ("raco" "pollen" "render"))
     :watch "\\.\\(pm\\|pmd\\|pp\\|ptree\\|rkt\\)$")
    ("\\.\\(md\\|markdown\\|mkd\\)\\'"
     :commands (("pandoc" "{in}" "-f" "markdown" "-t" "html5"
                 "--standalone" "--mathjax" "--highlight-style=tango"
                 "-o" "{out}"))
     :watch "\\.\\(md\\|markdown\\|mkd\\)$")
    ("\\.org\\'"
     :commands (("pandoc" "{in}" "-f" "org" "-t" "html5"
                 "--standalone" "--mathjax" "--highlight-style=tango"
                 "-o" "{out}"))
     :watch "\\.org$")
    ("\\.rst\\'"
     :commands (("pandoc" "{in}" "-f" "rst" "-t" "html5"
                 "--standalone" "--mathjax" "--highlight-style=tango"
                 "-o" "{out}"))
     :watch "\\.rst$")
    ("\\.\\(tex\\|latex\\)\\'"
     :commands (("pandoc" "{in}" "-f" "latex" "-t" "html5"
                 "--standalone" "--mathjax" "--highlight-style=tango"
                 "-o" "{out}"))
     :watch "\\.\\(tex\\|latex\\)$")
    ("\\.\\(adoc\\|asciidoc\\)\\'"
     :commands (("pandoc" "{in}" "-f" "asciidoc" "-t" "html5"
                 "--standalone" "--mathjax" "--highlight-style=tango"
                 "-o" "{out}"))
     :watch "\\.\\(adoc\\|asciidoc\\)$")
    ("\\.typ\\'"
     :commands (("typst" "compile" "{in}" "{out}"))
     :watch "\\.typ$"))
  "Alist of (REGEXP . PLIST) mapping file extensions to render specs.

PLIST keys:
  :commands - List of command specs.  Each spec is a list of strings.
              \"{in}\" is replaced with the input filename (basename).
              \"{out}\" is replaced with the output filename (basename with .html).
  :watch    - Regexp string for file watcher to monitor.

To add a new backend, just add an entry here.  No TypeScript changes needed.

Example custom backend:

  (\"\\\\.custom\\\\'\" :commands ((\"my-tool\" \"--render\" \"{in}\" \"-o\" \"{out}\"))
                       :watch \"\\\\.custom$\")"
  :type '(alist :key-type string :value-type plist)
  :group 'pandoc-preview)

;;; Internal functions

(defun pandoc-preview--ts ()
  (or pandoc-preview--ts-path
      (expand-file-name "pandoc-preview.ts"
                        (or (and load-file-name (file-name-directory load-file-name))
                            (and (locate-library "pandoc-preview")
                                 (file-name-directory (locate-library "pandoc-preview")))
                            (and buffer-file-name (file-name-directory buffer-file-name))))))

(defun pandoc-preview--supported-file-p (&optional buf)
  "Non-nil if BUF (default current) visits a supported file."
  (let ((f (buffer-file-name buf)))
    (and f (cl-loop for (regexp . _) in pandoc-preview-backends
                    thereis (string-match-p regexp f)))))

(defun pandoc-preview--detect-backend ()
  "Detect backend from current buffer's file extension.
Returns (BACKEND-NAME . PLIST)."
  (when-let* ((file buffer-file-name))
    (cl-loop for (regexp . plist) in pandoc-preview-backends
             when (string-match-p regexp file)
             return (cons (intern (car (split-string regexp "\\\\'"))) plist))))

(defun pandoc-preview--root ()
  "Project root via `project-current', fallback to file's directory."
  (or (when-let* ((proj (project-current)))
        (project-root proj))
      (and buffer-file-name (file-name-directory buffer-file-name))))

(defun pandoc-preview--build-commands (backend-plist in-file)
  "Build command list from BACKEND-PLIST for IN-FILE.
Replaces {in} with IN-FILE and {out} with IN-FILE with .html extension.
Returns a list of lists, each inner list is (EXE ARG...)."
  (let* ((out-file (concat (file-name-sans-extension in-file) ".html"))
         (raw-commands (plist-get backend-plist :commands)))
    (mapcar (lambda (cmd)
              (mapcar (lambda (arg)
                        (pcase arg
                          ("{in}" in-file)
                          ("{out}" out-file)
                          (_ arg)))
                      cmd))
            raw-commands)))

(defun pandoc-preview--send (msg)
  "Send MSG to Deno over the stored websocket connection."
  (when pandoc-preview--ws
    (condition-case nil
        (websocket-send-text pandoc-preview--ws (json-encode msg))
      (error nil))))

(defun pandoc-preview--open-browser (url)
  (cond
   (pandoc-preview-browser-command
    (start-process "pandoc-browser" nil pandoc-preview-browser-command url))
   ((fboundp 'browse-url-default-browser)
    (browse-url-default-browser url))
   (t (browse-url url))))

(defun pandoc-preview--sync (&rest _)
  (when (and pandoc-preview--active
             (not pandoc-preview--syncing)
             (pandoc-preview--supported-file-p))
    (when pandoc-preview--sync-timer
      (cancel-timer pandoc-preview--sync-timer))
    (setq pandoc-preview--sync-timer
          (run-at-time 0.15 nil
                       (lambda (buf)
                         (when (buffer-live-p buf)
                           (with-current-buffer buf
                             (when pandoc-preview--active
                               (setq pandoc-preview--syncing t)
                               (pandoc-preview--send
                                (list "sync"
                                      (expand-file-name buffer-file-name)
                                      (buffer-substring-no-properties (point-min) (point-max))))
                               (setq pandoc-preview--syncing nil)))))
                       (current-buffer)))))

(defun pandoc-preview--buffer-killed ()
  (when pandoc-preview--active
    (when pandoc-preview--sync-timer
      (cancel-timer pandoc-preview--sync-timer))
    (setq pandoc-preview--active nil)
    (setq pandoc-preview--active-buffers (delq (current-buffer) pandoc-preview--active-buffers))
    (remove-hook 'after-change-functions #'pandoc-preview--sync t)
    (remove-hook 'kill-buffer-hook #'pandoc-preview--buffer-killed t)))

;;; Commands

;;;###autoload
(defun pandoc-preview-start ()
  "Start real-time preview for current buffer."
  (interactive)
  (let ((backend-info (or (pandoc-preview--detect-backend)
                          (user-error "No backend for this file type"))))
    (when pandoc-preview--active
      (user-error "Already previewing"))
    (let ((root (pandoc-preview--root)))
      (unless root (user-error "No project root"))
      (setq pandoc-preview--root (expand-file-name root))
      (let* ((ts (pandoc-preview--ts))
             (port (+ 10000 (random 50000)))
             (process-buffer " *pandoc-preview-deno*")
             (backend-plist (cdr backend-info))
             (in-file (file-name-nondirectory (buffer-file-name)))
             (commands (pandoc-preview--build-commands backend-plist in-file))
             (watch-rx (or (plist-get backend-plist :watch)
                           (error "Backend missing :watch")))
             (file-abs (expand-file-name (buffer-file-name)))
             (backend-name (symbol-name (car backend-info))))

        (setq pandoc-preview--server
              (websocket-server
               port
               :host 'local
               :on-message
               (lambda (_ws frame)
                 (when (eq (websocket-frame-opcode frame) 'text)
                   (condition-case nil
                       (let* ((info (json-parse-string (websocket-frame-text frame)))
                              (msg-type (gethash "type" info)))
                         (pcase msg-type
                           ("server-ready"
                            (let ((http-port (gethash "port" info)))
                              (setq pandoc-preview--port http-port)
                              (pandoc-preview--open-browser
                               (format "http://%s:%s/" pandoc-preview-host http-port))))
                           ("render-error"
                            (message "[pandoc-preview] %s" (gethash "message" info "")))))
                     (error nil))))
               :on-open
               (lambda (ws)
                 (setq pandoc-preview--ws ws)
                 (pandoc-preview--send (list "init" pandoc-preview--root file-abs backend-name))
                 (pandoc-preview--send (list "render" commands watch-rx))
                 (pandoc-preview--sync))
               :on-close
               (lambda (_ws)
                 (setq pandoc-preview--ws nil)
                 (message "[pandoc-preview] Deno disconnected"))))

        (setq pandoc-preview--deno-process
              (let ((process-environment (cons "NO_COLOR=true" process-environment)))
                (start-process "pandoc-preview-deno" process-buffer
                               "deno" "run" "--allow-all" ts
                               "pandoc-preview" (format "%s" port))))

        (set-process-sentinel pandoc-preview--deno-process
                              (lambda (_proc event)
                                (message "[pandoc-preview] Deno: %s" (string-trim event))))

        (setq pandoc-preview--active t)
        (add-hook 'after-change-functions #'pandoc-preview--sync nil t)
        (add-hook 'kill-buffer-hook #'pandoc-preview--buffer-killed nil t)
        (push (current-buffer) pandoc-preview--active-buffers)
        (message "[pandoc-preview] Started [%s]" (car backend-info))))))

;;;###autoload
(defun pandoc-preview-stop ()
  "Stop preview for current buffer."
  (interactive)
  (when pandoc-preview--sync-timer
    (cancel-timer pandoc-preview--sync-timer)
    (setq pandoc-preview--sync-timer nil))
  (remove-hook 'after-change-functions #'pandoc-preview--sync t)
  (remove-hook 'kill-buffer-hook #'pandoc-preview--buffer-killed t)
  (setq pandoc-preview--active nil)
  (setq pandoc-preview--active-buffers (delq (current-buffer) pandoc-preview--active-buffers))
  (when (and (null pandoc-preview--active-buffers) pandoc-preview--deno-process)
    (pandoc-preview--send '("stop"))
    (sleep-for 0.3)
    (ignore-errors (delete-process pandoc-preview--deno-process))
    (let ((buf (get-buffer " *pandoc-preview-deno*")))
      (when buf (kill-buffer buf)))
    (when pandoc-preview--server
      (websocket-server-close pandoc-preview--server)
      (setq pandoc-preview--server nil))
    (setq pandoc-preview--ws nil)
    (setq pandoc-preview--deno-process nil)
    (setq pandoc-preview--port nil))
  (message "[pandoc-preview] Stopped"))

;;;###autoload
(defun pandoc-preview-open ()
  "Open browser to preview URL."
  (interactive)
  (if pandoc-preview--port
      (pandoc-preview--open-browser
       (format "http://%s:%s/" pandoc-preview-host pandoc-preview--port))
    (message "[pandoc-preview] Not started")))

;;;###autoload
(defun pandoc-preview-stop-all ()
  "Stop all previews."
  (interactive)
  (dolist (buf pandoc-preview--active-buffers)
    (when (buffer-live-p buf)
      (with-current-buffer buf (pandoc-preview-stop)))))

(defvar pandoc-preview-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-o") #'pandoc-preview-open)
    map))

;;;###autoload
(define-minor-mode pandoc-preview-mode
  "Toggle live preview for current buffer."
  :lighter " pandoc"
  :keymap pandoc-preview-mode-map
  (if pandoc-preview-mode (pandoc-preview-start) (pandoc-preview-stop)))

(provide 'pandoc-preview)
;;; pandoc-preview.el ends here
