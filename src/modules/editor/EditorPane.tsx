import { usePreferencesStore } from "@/modules/settings/preferences";
import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { convertFileSrc } from "@tauri-apps/api/core";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  buildSharedExtensions,
  languageCompartment,
  lspCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { useDocument } from "./lib/useDocument";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (line: number) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  workspaceRoot?: string | null;
  onOpenFileAt?: (path: string, line: number) => void;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane(
    {
      path,
      workspaceRoot,
      onOpenFileAt,
      overrideLanguage,
      onDirtyChange,
      onSaved,
      onClose,
    },
    ref,
  ) {
    const { doc, onChange, save, reload } = useDocument({
      path,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
    const languageRef = useRef<string | null>(null);
    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    // Save path that optionally runs LSP formatting first (assigned below, once
    // lspFormatRef exists). The save keymaps call through this ref.
    const saveWithFormatRef = useRef<() => Promise<void>>(() =>
      Promise.resolve(),
    );

    const pathRef = useRef(path);
    pathRef.current = path;

    const pendingLineRef = useRef<number | null>(null);
    const statusRef = useRef(doc.status);
    statusRef.current = doc.status;

    // Center a 1-based line in the viewport. Shared by goto-line, the
    // pending-goto applied once a doc is ready, and same-file go-to-definition
    // (marimo moves the cursor but never scrolls it into view).
    const scrollToLine = useCallback((line: number) => {
      const view = cmRef.current?.view;
      if (!view) return;
      const target = Math.max(1, Math.min(line, view.state.doc.lines));
      const at = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
      view.focus();
    }, []);

    const applyPendingGoto = useCallback(
      (retries = 0) => {
        const line = pendingLineRef.current;
        if (line == null || statusRef.current !== "ready") return;
        // Right after a fresh open the view ref / content can still be settling,
        // so a cross-file go-to-definition would scroll a not-yet-ready view and
        // land on the top. Retry a few frames until the view exists.
        if (!cmRef.current?.view) {
          if (retries < 60)
            requestAnimationFrame(() => applyPendingGoto(retries + 1));
          return;
        }
        scrollToLine(line);
        pendingLineRef.current = null;
      },
      [scrollToLine],
    );

    useEffect(() => {
      if (doc.status === "ready") applyPendingGoto();
    }, [doc.status, applyPendingGoto]);

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        wrapCompartment.of(
          usePreferencesStore.getState().editorWordWrap
            ? EditorView.lineWrapping
            : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveWithFormatRef.current();
              onSavedRef.current?.();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        languageCompartment.of([]),
        lspCompartment.of([]),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void (async () => {
                await saveWithFormatRef.current();
                onSavedRef.current?.();
              })();
              return true;
            },
          },
          {
            // Format the document via the language server (VS Code's shortcut).
            key: "Shift-Alt-f",
            preventDefault: true,
            run: (view) => {
              void lspFormatRef.current?.(view);
              return true;
            },
          },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          editorWordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [editorWordWrap]);

    useEffect(() => {
      const ext =
        overrideLanguage || (path.split(".").pop()?.toLowerCase() ?? null);
      languageRef.current = ext;
      if (doc.status !== "ready") return;
      let cancelled = false;
      const resolve = async (): Promise<LanguageResult> => {
        const resolvePath = overrideLanguage
          ? `dummy.${overrideLanguage}`
          : path;
        return (
          (await resolveLanguage(resolvePath)) ?? { ext: [], name: "", id: "" }
        );
      };
      void resolve().then((result) => {
        if (cancelled) return;
        if (result.id) languageRef.current = result.id;
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(result.ext),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status, overrideLanguage]);

    const onOpenFileAtRef = useRef(onOpenFileAt);
    useEffect(() => {
      onOpenFileAtRef.current = onOpenFileAt;
    }, [onOpenFileAt]);
    const scrollToLineRef = useRef(scrollToLine);
    useEffect(() => {
      scrollToLineRef.current = scrollToLine;
    }, [scrollToLine]);
    const lspReleaseRef = useRef<(() => void) | null>(null);
    // Set when a ready LSP handle is installed; the format command and
    // format-on-save call through it, and it's cleared when the server goes away.
    const lspFormatRef = useRef<
      ((view: EditorView) => Promise<boolean>) | null
    >(null);
    saveWithFormatRef.current = async () => {
      const view = cmRef.current?.view;
      if (
        usePreferencesStore.getState().formatOnSave &&
        view &&
        lspFormatRef.current
      ) {
        // A formatter that fails or has nothing to do must not block the save.
        try {
          await lspFormatRef.current(view);
        } catch {
          // ignore — fall through to the plain save
        }
      }
      await saveRef.current();
    };
    // Holds the display label once a ready handle is installed; the onServerError
    // closure reads it so it always uses the most recent label without re-creating
    // the callback on every render.
    const lspDisplayLabelRef = useRef<string | null>(null);

    useEffect(() => {
      if (doc.status !== "ready" || !workspaceRoot) return;
      let cancelled = false;
      // Generation counter closes the rapid-flip double-resolve race: a newer
      // apply() cancels any in-flight older apply() before it can install.
      let generation = 0;

      const apply = async () => {
        const myGen = ++generation;
        const { resolveLspExtension } = await import("./lib/lsp/extension");
        const { useLspStatusStore } = await import("./lib/lsp/statusStore");
        // Let the status pill re-resolve this pane's server on demand (an
        // errored entry self-heals on the next acquire).
        useLspStatusStore.getState().setRestarter(path, () => void apply());
        const result = await resolveLspExtension({
          path,
          workspaceRoot,
          onOpenFileAt: (p, line) => onOpenFileAtRef.current?.(p, line),
          scrollToLine: (line) => scrollToLineRef.current(line),
          onServerError: (message) => {
            useLspStatusStore.getState().setStatus(path, {
              state: "error",
              label: lspDisplayLabelRef.current ?? "",
              hint: message,
            });
          },
          onReady: () => {
            if (cancelled || myGen !== generation) return;
            useLspStatusStore.getState().setStatus(path, {
              state: "running",
              label: lspDisplayLabelRef.current ?? "",
              hint: null,
            });
          },
        });
        if (cancelled || myGen !== generation) {
          if (result.kind === "ready") result.handle.release();
          return;
        }
        lspReleaseRef.current?.();
        lspReleaseRef.current = null;
        lspFormatRef.current = null;
        const view = cmRef.current?.view;
        if (result.kind === "ready") {
          lspReleaseRef.current = result.handle.release;
          lspFormatRef.current = result.handle.format;
          lspDisplayLabelRef.current = result.handle.status.display;
          useLspStatusStore.getState().setStatus(path, {
            state: "indexing",
            label: result.handle.status.display,
            hint: null,
          });
          view?.dispatch({
            effects: lspCompartment.reconfigure(result.handle.extension),
          });
        } else {
          if (result.kind === "missing-server") {
            useLspStatusStore.getState().setStatus(path, {
              state: "missing",
              label: result.status.display,
              hint: result.status.installHint,
            });
          } else {
            // disabled / unsupported: remove the pill immediately
            useLspStatusStore.getState().clearStatus(path);
          }
          view?.dispatch({ effects: lspCompartment.reconfigure([]) });
        }
      };
      void apply();

      // The LSP master toggle can flip at runtime: rebuild on change.
      const unsub = usePreferencesStore.subscribe((state, prev) => {
        if (state.lspEnabled !== prev.lspEnabled) {
          void apply();
        }
      });

      return () => {
        cancelled = true;
        unsub();
        lspReleaseRef.current?.();
        lspReleaseRef.current = null;
        lspFormatRef.current = null;
        void import("./lib/lsp/statusStore").then(({ useLspStatusStore }) => {
          useLspStatusStore.getState().clearStatus(path);
          useLspStatusStore.getState().clearRestarter(path);
        });
      };
    }, [path, doc.status, workspaceRoot]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        gotoLine: (line: number) => {
          pendingLineRef.current = line;
          applyPendingGoto();
        },
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
      }),
      [path, applyPendingGoto],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const isImage = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "ico",
      ].includes(ext);
      const isVideo = ["mp4", "webm", "ogg", "mov"].includes(ext);
      const isAudio = ["mp3", "wav", "flac", "aac", "m4a"].includes(ext);
      const isPdf = ext === "pdf";

      if (isImage || isVideo || isAudio || isPdf) {
        const assetUrl = convertFileSrc(path);
        return (
          <div className="flex h-full min-h-0 flex-col items-center justify-center bg-background p-4 overflow-auto">
            {isImage && (
              <img
                src={assetUrl}
                loading="lazy"
                decoding="async"
                className="max-w-full max-h-full object-contain rounded-md border border-border shadow-sm"
                style={{
                  backgroundImage:
                    "conic-gradient(#e5e7eb 0.25turn, #f3f4f6 0.25turn 0.5turn, #e5e7eb 0.5turn 0.75turn, #f3f4f6 0.75turn)",
                  backgroundSize: "20px 20px",
                }}
                alt={path.split("/").pop()}
              />
            )}
            {isVideo && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <video
                controls
                preload="metadata"
                className="max-w-full max-h-full"
                src={assetUrl}
              />
            )}
            {isAudio && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <audio
                controls
                preload="metadata"
                className="w-full max-w-md"
                src={assetUrl}
              />
            )}
            {isPdf && (
              <iframe
                src={assetUrl}
                className="w-full h-full border-none"
                title={path.split("/").pop()}
              />
            )}
          </div>
        );
      }

      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary" ? "Binary file" : "File too large"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col zoom-exempt">
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
      </div>
    );
  },
);
