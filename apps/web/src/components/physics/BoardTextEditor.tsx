import { useMemo, useRef, useState } from "react";

import { itemMarkup } from "~/physics/boardRender";

export interface TextEdit {
  /** Present when editing an existing item. */
  readonly id?: string;
  readonly kind: "text" | "math";
  readonly x: number;
  readonly y: number;
  readonly value: string;
  readonly fontSize: number;
}

/**
 * In-place text and LaTeX entry anchored at a board point. Text commits on blur or
 * Ctrl/Cmd+Enter; math commits on Enter and shows the rendered result under the input as you
 * type. Escape discards.
 */
export function BoardTextEditor(props: {
  readonly edit: TextEdit;
  readonly view: { readonly x: number; readonly y: number; readonly k: number };
  readonly color: string;
  readonly onDone: (edit: TextEdit, value: string) => void;
  readonly onCancel: () => void;
}) {
  const { edit, view, color, onDone, onCancel } = props;
  const finished = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    onDone(edit, input.current?.value ?? "");
  };
  const [liveValue, setLiveValue] = useState(edit.value);
  const math = edit.kind === "math";
  const preview = useMemo(() => {
    if (!math || liveValue.trim() === "") return null;
    const item = {
      id: "preview",
      author: "user",
      kind: "math",
      latex: liveValue,
      x: 0,
      y: 0,
      fontSize: edit.fontSize,
    } as const;
    return itemMarkup(item);
  }, [edit.fontSize, liveValue, math]);

  return (
    <div
      className="absolute z-10 flex flex-col gap-1"
      style={{ left: view.x + edit.x * view.k, top: view.y + edit.y * view.k }}
    >
      <textarea
        ref={input}
        autoFocus
        rows={math ? 1 : Math.max(1, edit.value.split("\n").length)}
        defaultValue={edit.value}
        spellCheck={false}
        aria-label={math ? "LaTeX" : "Text"}
        placeholder={math ? "LaTeX" : undefined}
        className={`field-sizing-content min-w-24 resize-none border-white/25 border-b bg-transparent text-white outline-none placeholder:text-white/30 ${math ? "font-mono text-sm" : ""}`}
        style={math ? { color } : { color, fontSize: edit.fontSize * view.k, lineHeight: 1.4 }}
        onChange={(event) => setLiveValue(event.currentTarget.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            finished.current = true;
            onCancel();
          } else if (
            event.key === "Enter" &&
            (math ? !event.shiftKey : event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            finish();
          }
        }}
      />
      {preview ? (
        <svg
          aria-hidden
          overflow="visible"
          width={Math.max(80, liveValue.length * edit.fontSize * 0.7) * view.k}
          height={edit.fontSize * 3.5 * view.k}
          viewBox={`0 0 ${Math.max(80, liveValue.length * edit.fontSize * 0.7)} ${edit.fontSize * 3.5}`}
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      ) : null}
    </div>
  );
}
