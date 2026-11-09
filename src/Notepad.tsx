import "./migrate";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Effect, EffectState } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { FilePlus2, Save, Trash2 } from "lucide-react";
import { WindowControls } from "./components/WindowControls";
import { initTheme } from "./theme";
import { useT } from "./i18n";
import "./Notepad.css";

interface Note {
  id: string;
  text: string;
  updated: number;
  /** Optional label colour; absent on notes saved before tags existed. */
  color?: string;
}

const TAG_COLORS = ["#ffd60a", "#0a84ff", "#30d158", "#ff375f", "#bf5af2"];

interface Notebook {
  notes: Note[];
  active: string;
}

const appWindow = getCurrentWebviewWindow();
const SAVE_DELAY_MS = 400;

const newNote = (): Note => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: "", updated: Date.now() });

function parseNotebook(raw: string): Notebook {
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object") {
      const { notes, active } = data as { notes?: unknown; active?: unknown };
      if (Array.isArray(notes)) {
        const clean = notes.filter(
          (n): n is Note => !!n && typeof n.id === "string" && typeof n.text === "string" && typeof n.updated === "number",
        );
        if (clean.length > 0) {
          const activeId = typeof active === "string" && clean.some((n) => n.id === active) ? active : clean[0].id;
          return { notes: clean, active: activeId };
        }
      }
    }
  } catch {
    // Empty or damaged file: start with a fresh note instead of failing.
  }
  const first = newNote();
  return { notes: [first], active: first.id };
}

const titleOf = (text: string, fallback: string) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 48) || fallback;

function NotepadWindow() {
  const t = useT();
  const [book, setBook] = useState<Notebook | null>(null);
  const [status, setStatus] = useState("");
  const bookRef = useRef<Notebook | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const statusTimer = useRef<number | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => initTheme(), []);

  useEffect(() => {
    appWindow.setEffects({ effects: [Effect.Acrylic], state: EffectState.Active, color: [10, 10, 15, 20] }).catch(() => {});
  }, []);

  const flash = useCallback((message: string) => {
    setStatus(message);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(""), 1800);
  }, []);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current || !bookRef.current) return;
    dirty.current = false;
    try {
      await invoke("notes_save", { content: JSON.stringify(bookRef.current) });
      flash(t("notepad.saved"));
    } catch {
      dirty.current = true;
      flash(t("notepad.error"));
    }
  }, [flash, t]);

  const update = useCallback(
    (next: Notebook) => {
      bookRef.current = next;
      setBook(next);
      dirty.current = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    invoke<string>("notes_load")
      .then((raw) => {
        const loaded = parseNotebook(raw);
        bookRef.current = loaded;
        setBook(loaded);
      })
      .catch(() => {
        const fresh = parseNotebook("");
        bookRef.current = fresh;
        setBook(fresh);
      });
  }, []);

  // Hiding the window suspends its webview, so anything pending must hit the disk first.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("blur", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flush]);

  const active = book?.notes.find((n) => n.id === book.active);

  const edit = (text: string) => {
    if (!book || !active) return;
    update({ ...book, notes: book.notes.map((n) => (n.id === active.id ? { ...n, text, updated: Date.now() } : n)) });
  };

  const tag = (color: string) => {
    if (!book || !active) return;
    const next = active.color === color ? undefined : color;
    update({ ...book, notes: book.notes.map((n) => (n.id === active.id ? { ...n, color: next } : n)) });
  };

  const add = useCallback(() => {
    const current = bookRef.current;
    if (!current) return;
    const note = newNote();
    update({ notes: [note, ...current.notes], active: note.id });
    window.setTimeout(() => editor.current?.focus(), 0);
  }, [update]);

  const remove = () => {
    if (!book || !active) return;
    const rest = book.notes.filter((n) => n.id !== active.id);
    if (rest.length === 0) {
      const fresh = newNote();
      update({ notes: [fresh], active: fresh.id });
    } else {
      update({ notes: rest, active: rest[0].id });
    }
  };

  const saveAs = useCallback(async () => {
    const current = bookRef.current;
    const note = current?.notes.find((n) => n.id === current.active);
    if (!note) return;
    try {
      const safe = titleOf(note.text, t("notepad.untitled")).replace(/[\\/:*?"<>|]/g, "_");
      const path = await save({
        defaultPath: `${safe}.txt`,
        filters: [
          { name: "Text", extensions: ["txt"] },
          { name: "Markdown", extensions: ["md"] },
        ],
      });
      if (!path) return;
      await invoke("notes_export", { path, content: note.text });
      flash(t("notepad.exported"));
    } catch {
      flash(t("notepad.error"));
    }
  }, [flash, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        add();
      } else if (key === "s") {
        e.preventDefault();
        void saveAs();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [add, saveAs]);

  const words = active ? (active.text.trim() ? active.text.trim().split(/\s+/).length : 0) : 0;

  return (
    <div className="np">
      <div className="np-titlebar" data-tauri-drag-region>
        <span className="np-title-text" data-tauri-drag-region>
          {t("notepad.title")}
        </span>
        <span className="np-status" data-tauri-drag-region>
          {status}
        </span>
        <WindowControls />
      </div>

      <div className="np-body">
        <aside className="np-sidebar">
          <div className="np-actions">
            <button className="np-btn" onClick={add} title={`${t("notepad.new")} (Ctrl+N)`}>
              <FilePlus2 size={15} />
              <span>{t("notepad.new")}</span>
            </button>
          </div>
          <ul className="np-list">
            {book?.notes.map((n) => (
              <li key={n.id}>
                <button
                  className={`np-item${n.id === book.active ? " active" : ""}`}
                  onClick={() => update({ ...book, active: n.id })}
                >
                  <span className="np-item-title">
                    {n.color && <span className="np-dot" style={{ background: n.color }} />}
                    {titleOf(n.text, t("notepad.untitled"))}
                  </span>
                  <span className="np-item-time">{new Date(n.updated).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="np-main">
          <div className="np-toolbar">
            <div className="np-tags">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  className={`np-tag${active?.color === c ? " on" : ""}`}
                  style={{ background: c }}
                  onClick={() => tag(c)}
                  aria-label={c}
                />
              ))}
            </div>
            <button className="np-icon-btn" onClick={() => void saveAs()} title={`${t("notepad.saveAs")} (Ctrl+S)`}>
              <Save size={15} />
              <span>{t("notepad.saveAs")}</span>
            </button>
            <button className="np-icon-btn danger" onClick={remove} title={t("notepad.delete")}>
              <Trash2 size={15} />
            </button>
          </div>
          <textarea
            ref={editor}
            className="np-editor"
            value={active?.text ?? ""}
            onChange={(e) => edit(e.target.value)}
            placeholder={t("notepad.placeholder")}
            spellCheck={false}
            autoFocus
          />
          <div className="np-footer">{words} words · {active?.text.length ?? 0} chars</div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <NotepadWindow />
  </StrictMode>,
);
