import { type Extension, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import type { LanguageServerClient } from "@marimo-team/codemirror-languageserver";
import { fileUriToPath } from "./uri";

// marimo's built-in go-to-definition is disabled (definitionEnabled:false) in
// favour of this extension so we can: underline the symbol under the pointer
// while Cmd/Ctrl is held, jump to the right location (same-file scroll or open
// the target file at the line), and surface a "No definition found" tooltip
// when the server returns nothing — none of which marimo offers.

const DEFINITION_TIMEOUT_MS = 20_000;
const NOT_FOUND_TOOLTIP_MS = 2200;

// marimo keeps `request` protected; format.ts uses the same structural cast.
type RawDefClient = {
  request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
};

type Deps = {
  client: LanguageServerClient;
  documentUri: string;
  /** Open a different file and center the 1-based line. */
  onOpenFileAt: (path: string, line: number) => void;
  /** Center a 1-based line in the current pane (same-file target). */
  scrollToLine: (line: number) => void;
};

// ── underline-on-(Cmd/Ctrl)-hover ──────────────────────────────────────────
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-definition-link" });
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setLink)) {
        deco = e.value
          ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentLink(view: EditorView): { from: number; to: number } | null {
  const set = view.state.field(linkField, false);
  if (!set || set.size === 0) return null;
  let range: { from: number; to: number } | null = null;
  set.between(0, view.state.doc.length, (from, to) => {
    range = { from, to };
  });
  return range;
}

function clearLink(view: EditorView): void {
  if (currentLink(view)) view.dispatch({ effects: setLink.of(null) });
}

// ── transient "No definition found" tooltip ────────────────────────────────
const setNotFound = StateEffect.define<number | null>();
const notFoundField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    if (tip) tip = { ...tip, pos: tr.changes.mapPos(tip.pos) };
    for (const e of tr.effects) {
      if (e.is(setNotFound)) {
        tip =
          e.value == null
            ? null
            : {
                pos: e.value,
                above: true,
                create: () => {
                  const dom = document.createElement("div");
                  dom.className = "cm-lsp-no-definition";
                  dom.textContent = "No definition found";
                  return { dom };
                },
              };
      }
    }
    return tip;
  },
  provide: (f) => showTooltip.from(f),
});

function showNotFound(view: EditorView, pos: number): void {
  view.dispatch({ effects: setNotFound.of(pos) });
  setTimeout(() => {
    if (view.dom.isConnected && view.state.field(notFoundField, false)) {
      view.dispatch({ effects: setNotFound.of(null) });
    }
  }, NOT_FOUND_TOOLTIP_MS);
}

// ── definition lookup ──────────────────────────────────────────────────────
function offsetToLspPos(doc: Text, offset: number) {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

type LspRange = { start: { line: number; character: number } };

function firstLocation(
  result: unknown,
): { uri: string; range: LspRange } | null {
  const loc = Array.isArray(result) ? result[0] : result;
  if (!loc || typeof loc !== "object") return null;
  const o = loc as Record<string, unknown>;
  const uri = (o.uri ?? o.targetUri) as string | undefined;
  // LocationLink uses targetSelectionRange (the identifier); Location uses range.
  const range = (o.targetSelectionRange ?? o.targetRange ?? o.range) as
    | LspRange
    | undefined;
  if (typeof uri !== "string" || !range?.start) return null;
  return { uri, range };
}

async function goToDefinitionAt(
  view: EditorView,
  pos: number,
  deps: Deps,
): Promise<void> {
  const raw = deps.client as unknown as RawDefClient;
  let result: unknown;
  try {
    result = await raw.request(
      "textDocument/definition",
      {
        textDocument: { uri: deps.documentUri },
        position: offsetToLspPos(view.state.doc, pos),
      },
      DEFINITION_TIMEOUT_MS,
    );
  } catch {
    result = null;
  }
  const loc = firstLocation(result);
  if (!loc) {
    showNotFound(view, pos);
    return;
  }
  const line = loc.range.start.line + 1;
  const targetPath = fileUriToPath(loc.uri);
  if (targetPath === fileUriToPath(deps.documentUri)) {
    deps.scrollToLine(line);
  } else {
    deps.onOpenFileAt(targetPath, line);
  }
}

const hasModifier = (e: MouseEvent | KeyboardEvent): boolean =>
  e.metaKey || e.ctrlKey;

export function goToDefinitionExtension(deps: Deps): Extension {
  return [
    linkField,
    notFoundField,
    EditorView.domEventHandlers({
      mousemove(e, view) {
        if (!hasModifier(e)) return clearLink(view);
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const word = pos == null ? null : view.state.wordAt(pos);
        if (!word) return clearLink(view);
        const cur = currentLink(view);
        if (cur && cur.from === word.from && cur.to === word.to) return;
        view.dispatch({ effects: setLink.of({ from: word.from, to: word.to }) });
      },
      mouseleave(_e, view) {
        clearLink(view);
      },
      keyup(_e, view) {
        clearLink(view);
      },
      mousedown(e, view) {
        if (!hasModifier(e) || e.button !== 0) return;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        // Prevent the modifier-click from dropping a secondary cursor.
        e.preventDefault();
        clearLink(view);
        void goToDefinitionAt(view, pos, deps);
      },
    }),
  ];
}
