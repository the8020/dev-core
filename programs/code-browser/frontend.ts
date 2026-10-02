import type {
  CustomElementContext,
  CustomElementInstance,
} from "/p/the8020/uui/custom_element.ts";
import type { ScreenElementState } from "/p/the8020/uui/protocol.ts";
import { AnchoredPopover } from "/p/the8020/uui/services/shell/frontend/popover.ts";
// @ts-types="/p/the8020/uui/services/shell/frontend/components/code-editor/editor.ts"
import mountEditor from "/the8020/uui/shell/components/code-editor/editor.js";
// @ts-types="/p/the8020/uui/services/shell/frontend/components/code-editor/library.ts"
import {
  Compartment,
  Decoration,
  EditorView,
  StateEffect,
} from "/the8020/uui/shell/components/code-editor/vendor/library.js";

interface Configuration {
  path: string;
  files: string[];
  semantic: boolean;
  jump: {
    revision: number;
    line: number;
    column: number;
    restore: boolean;
    state?: ScreenElementState;
  };
  hover: { offset: number; text: string } | null;
}

export default function mount(
  context: CustomElementContext,
): CustomElementInstance {
  const { host, signal } = context;
  host.classList.add("code-browser-editor");
  const native = mountEditor(context);
  const view = native.editor;
  const toolbar = host.querySelector<HTMLElement>(".uui-code-toolbar")!;
  const files = document.createElement("div");
  files.className = "tab-list code-browser-files";
  files.setAttribute("role", "tablist");
  files.setAttribute("aria-label", "Open files");
  host.prepend(files);
  const findBar = document.createElement("div");
  findBar.className = "code-browser-find";
  findBar.hidden = true;
  toolbar.after(findBar);
  const find = document.createElement("input");
  find.type = "search";
  find.maxLength = 1000;
  find.className = "data-list-search";
  find.placeholder = "Find in file";
  find.setAttribute("aria-label", "Find in file (case insensitive)");
  const count = document.createElement("span");
  count.className = "uui-code-status";
  count.setAttribute("role", "status");
  findBar.append(find, count);
  const gotoBar = document.createElement("div");
  gotoBar.className = "code-browser-find";
  gotoBar.hidden = true;
  findBar.after(gotoBar);
  const line = document.createElement("input");
  line.type = "number";
  line.min = "1";
  line.required = true;
  line.className = "data-list-search";
  line.placeholder = "Line number";
  line.setAttribute("aria-label", "Go to line");
  gotoBar.append(line);
  const position = document.createElement("span");
  position.className = "uui-code-status code-browser-position";
  host.append(position);
  const matches = new Compartment();
  let found: { from: number; to: number }[] = [];
  let config = context.config as unknown as Configuration;
  let revision = -1;
  let filesKey = "";
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverOffset = -1;
  let hoverPath = "";
  let shownHover = "";
  let focusHover = false;
  let frame = 0;
  const button = (
    parent: HTMLElement,
    label: string,
    icon: string,
    click: () => void,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-secondary";
    button.title = label;
    button.setAttribute("aria-label", label);
    context.renderText(button, `[[icon=${icon}]]`);
    button.addEventListener("click", click, { signal });
    parent.append(button);
    return button;
  };
  const action = (
    name: string,
    offset = view.state.selection.main.head,
    focus = true,
  ) => {
    if (!config.semantic) return;
    if (name === "hover") {
      hoverOffset = offset;
      hoverPath = config.path;
      focusHover = focus;
    }
    context.send(name, offset);
  };
  const definition = button(
    toolbar,
    "Go to definition (F12)",
    "subdirectory_arrow_right",
    () => action("definition"),
  );
  const references = button(
    toolbar,
    "Find references (Shift+F12)",
    "manage_search",
    () => action("references"),
  );
  const info = button(
    toolbar,
    "Symbol information (F8)",
    "info",
    () => action("hover"),
  );
  const popup = new AnchoredPopover(info, "Symbol information", {
    alignment: "start",
    bounds: () =>
      view.coordsAtPos(
        Math.max(0, Math.min(hoverOffset, view.state.doc.length)),
      ) ?? info.getBoundingClientRect(),
  });
  const help = document.createElement("pre");
  help.className = "code-browser-symbol";
  popup.element.append(help);
  host.append(popup.element);
  function openFind() {
    findBar.hidden = false;
    const selection = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    if (selection && selection.length < 300 && !selection.includes("\n")) {
      find.value = selection;
    }
    highlight();
    find.focus();
    find.select();
  }
  function openLine() {
    gotoBar.hidden = false;
    line.max = String(view.state.doc.lines);
    line.value = String(
      view.state.doc.lineAt(view.state.selection.main.head).number,
    );
    line.focus();
    line.select();
  }
  button(toolbar, "Find in file (Ctrl+F)", "search", openFind);
  button(toolbar, "Go to line (Ctrl+G)", "format_list_numbered", openLine);
  const close = button(
    toolbar,
    "Close current file",
    "close",
    () => context.send("close-file", config.path),
  );
  function reveal(offset: number) {
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
  }
  function highlight() {
    const query = find.value;
    context.state.data = {
      ...context.state.data,
      find: query,
      findOpen: !findBar.hidden,
    };
    found = [];
    if (query) {
      const expression = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "giu",
      );
      for (const match of view.state.doc.toString().matchAll(expression)) {
        found.push({ from: match.index!, to: match.index! + match[0].length });
        if (found.length >= 5000) break;
      }
    }
    view.dispatch({
      effects: matches.reconfigure(
        EditorView.decorations.of(
          Decoration.set(
            found.map(({ from, to }) =>
              Decoration.mark({ class: "cm-selectionMatch" }).range(from, to)
            ),
          ),
        ),
      ),
    });
    count.textContent = query
      ? `${found.length === 5000 ? "First " : ""}${found.length} matches`
      : "";
  }
  function next(reverse: boolean) {
    if (!found.length) return;
    const cursor = view.state.selection.main;
    const match = reverse
      ? [...found].reverse().find((match) => match.from < cursor.from) ??
        found.at(-1)!
      : found.find((match) =>
        match.from >= cursor.to && match.from !== cursor.from
      ) ?? found[0]!;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: "center" }),
    });
    count.textContent = `${found.indexOf(match) + 1} of ${
      found.length === 5000 ? "first " : ""
    }${found.length}`;
  }
  button(
    findBar,
    "Previous match (Shift+Enter)",
    "arrow_upward",
    () => next(true),
  );
  button(findBar, "Next match (Enter)", "arrow_downward", () => next(false));
  button(findBar, "Close find", "close", () => {
    findBar.hidden = true;
    view.focus();
  });
  const go = () => {
    const number = line.valueAsNumber;
    if (
      !Number.isSafeInteger(number) || number < 1 ||
      number > view.state.doc.lines
    ) {
      line.reportValidity();
      return;
    }
    reveal(view.state.doc.line(number).from);
    gotoBar.hidden = true;
    view.focus();
  };
  button(gotoBar, "Go to line", "arrow_forward", go);
  find.addEventListener("input", highlight, { signal });
  find.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      next(event.shiftKey);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      findBar.hidden = true;
      view.focus();
    }
  }, { signal });
  line.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      go();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      gotoBar.hidden = true;
      view.focus();
    }
  }, { signal });
  const status = () => {
    const offset = view.state.selection.main.head;
    const current = view.state.doc.lineAt(offset);
    position.textContent = `Ln ${current.number}, Col ${
      offset - current.from + 1
    } · Read-only`;
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      matches.of([]),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) status();
      }),
    ]),
  });
  host.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    let command: (() => void) | undefined;
    if (modifier && event.key.toLowerCase() === "f") {
      command = event.shiftKey
        ? () => context.send("workspace-search")
        : openFind;
    }
    if (modifier && event.key.toLowerCase() === "p") {
      command = () => context.send("quick-open");
    }
    if (modifier && event.key.toLowerCase() === "g") command = openLine;
    if (event.key === "F12" && config.semantic) {
      command = () => action(event.shiftKey ? "references" : "definition");
    }
    if (event.key === "F8" && config.semantic) command = () => action("hover");
    if (event.altKey && event.key === "ArrowLeft") {
      command = () => context.send("navigate-back");
    }
    if (event.altKey && event.key === "ArrowRight") {
      command = () => context.send("navigate-forward");
    }
    if (command) {
      event.preventDefault();
      event.stopPropagation();
      command();
    }
  }, { signal, capture: true });
  view.contentDOM.addEventListener("pointermove", (event) => {
    clearTimeout(hoverTimer);
    if (!config.semantic || event.pointerType === "touch" || event.buttons) {
      return;
    }
    const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (
      offset == null || !view.state.wordAt(offset) ||
      (offset === hoverOffset && config.path === hoverPath)
    ) return;
    hoverTimer = setTimeout(() => action("hover", offset, false), 700);
  }, { signal });
  view.contentDOM.addEventListener(
    "pointerleave",
    () => clearTimeout(hoverTimer),
    { signal },
  );
  view.contentDOM.addEventListener("click", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !config.semantic) return;
    const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (offset !== null) {
      event.preventDefault();
      action("definition", offset);
    }
  }, { signal });

  function update() {
    config = context.config as unknown as Configuration;
    const changed = config.jump.revision !== revision;
    if (changed) {
      context.state.data = structuredClone(config.jump.state?.data ?? {});
      context.state.scroll = { ...config.jump.state?.scroll ?? { x: 0, y: 0 } };
    }
    if (changed && !config.jump.restore) {
      const lines = String(context.value ?? "").split("\n");
      const row = Math.min(config.jump.line, lines.length) - 1;
      const offset = lines.slice(0, row).reduce((sum, text) =>
        sum + text.length + 1, 0) +
        Math.min(config.jump.column - 1, lines[row]!.length);
      context.state.data = {
        ...context.state.data,
        selection: { anchor: offset, head: offset, reveal: true },
      };
    }
    if (String(context.value ?? "") !== view.state.doc.toString()) {
      view.dispatch({ effects: matches.reconfigure([]) });
    }
    native.update?.(context.config);
    definition.disabled = references.disabled = info.disabled = !config
      .semantic;
    close.disabled = !config.path;
    const key = JSON.stringify(config.files);
    if (filesKey !== key) {
      filesKey = key;
      files.replaceChildren();
      for (const path of config.files) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.role = "tab";
        tab.textContent = path.split("/").at(-1)!;
        tab.title = path;
        tab.setAttribute("aria-label", path);
        tab.setAttribute("aria-selected", String(path === config.path));
        tab.addEventListener("click", () => context.send("open-file", path), {
          signal,
        });
        files.append(tab);
      }
    }
    for (const tab of files.querySelectorAll("button")) {
      tab.setAttribute("aria-selected", String(tab.title === config.path));
      tab.tabIndex = tab.title === config.path ? 0 : -1;
    }
    if (changed) {
      revision = config.jump.revision;
      popup.hide();
      shownHover = "";
      find.value = typeof context.state.data?.find === "string"
        ? context.state.data.find
        : "";
      findBar.hidden = context.state.data?.findOpen !== true;
      highlight();
    }
    if (
      config.hover && config.hover.offset === hoverOffset &&
      config.path === hoverPath
    ) {
      const key = JSON.stringify(config.hover);
      if (key !== shownHover) {
        shownHover = key;
        help.textContent = config.hover.text;
        frame = requestAnimationFrame(() => {
          if (!signal.aborted) popup.show(focusHover);
        });
      }
    }
    status();
  }
  update();
  files.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...files.querySelectorAll("button")];
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const index = event.key === "Home"
      ? 0
      : event.key === "End"
      ? tabs.length - 1
      : (current + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) %
        tabs.length;
    event.preventDefault();
    event.stopPropagation();
    tabs[index]?.focus();
    tabs[index]?.click();
  }, { signal });
  return {
    update,
    captureState: () => {
      native.captureState?.();
      context.state.data = {
        ...context.state.data,
        find: find.value,
        findOpen: !findBar.hidden,
      };
    },
    setActive(active) {
      if (!active) popup.hide();
      native.setActive?.(active);
    },
    dispose() {
      clearTimeout(hoverTimer);
      cancelAnimationFrame(frame);
      popup.dispose();
      native.dispose?.();
    },
  };
}
