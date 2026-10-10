import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | {
      label: string;
      /** Shown on the right, e.g. a shortcut. */
      hint?: string;
      disabled?: boolean;
      /** Why it's disabled, or extra detail. */
      title?: string;
      danger?: boolean;
      checked?: boolean;
      onSelect?: () => void;
      submenu?: MenuEntry[];
    }
  | "separator";

export interface MenuRequest {
  x: number;
  y: number;
  /** Shown above the items, e.g. the deliverable's name. */
  heading?: string;
  items: MenuEntry[];
}

type Item = Exclude<MenuEntry, "separator">;
const usable = (e: MenuEntry): e is Item => e !== "separator" && !e.disabled;

/** Keep a box of `w`×`h` at (x, y) inside the window, flipping left or up when it would overflow. */
export function placeInView(x: number, y: number, w: number, h: number, flipFrom?: { left: number }): { left: number; top: number } {
  const pad = 6;
  let left = x;
  if (left + w > window.innerWidth - pad) left = flipFrom ? flipFrom.left - w : window.innerWidth - pad - w;
  let top = y;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - h);
  return { left: Math.max(pad, left), top: Math.max(pad, top) };
}

function MenuList(props: { items: MenuEntry[]; heading?: string; x: number; y: number; flipFrom?: { left: number }; onClose: () => void; onBack?: () => void; autoFocus: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(() => (props.autoFocus ? props.items.findIndex(usable) : -1));
  const [open, setOpen] = useState<{ index: number; x: number; y: number; left: number; keyboard: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    setPos(placeInView(props.x, props.y, el.offsetWidth, el.offsetHeight, props.flipFrom));
  }, [props.x, props.y, props.flipFrom]);

  // Focus once placed: a hidden element can't take focus.
  const placed = pos !== null;
  useEffect(() => {
    if (props.autoFocus && placed) ref.current?.focus();
  }, [props.autoFocus, placed]);

  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > .ctx-items > li > button") ?? [])];

  const openSub = (index: number, keyboard: boolean) => {
    const btn = buttons()[index];
    const r = btn?.getBoundingClientRect();
    if (r) setOpen({ index, x: r.right - 2, y: r.top - 5, left: r.left + 2, keyboard });
  };

  const choose = (index: number) => {
    const item = props.items[index];
    if (!usable(item)) return;
    if (item.submenu) return openSub(index, true);
    props.onClose();
    item.onSelect?.();
  };

  const step = (dir: 1 | -1) => {
    const n = props.items.length;
    for (let i = 1; i <= n; i++) {
      const j = (active + dir * i + n) % n;
      if (usable(props.items[j])) return setActive(j);
    }
  };

  return (
    <>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        tabIndex={-1}
        style={pos ? { left: pos.left, top: pos.top } : { left: props.x, top: props.y, visibility: "hidden" }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (open?.keyboard) return; // the submenu has the keys
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            step(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (active >= 0) choose(active);
          } else if (e.key === "ArrowRight") {
            const item = props.items[active];
            if (item && usable(item) && item.submenu) {
              e.preventDefault();
              openSub(active, true);
            }
          } else if (e.key === "ArrowLeft" && props.onBack) {
            e.preventDefault();
            props.onBack();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            (props.onBack ?? props.onClose)();
          } else if (e.key === "Tab") {
            e.preventDefault();
          }
        }}
      >
        {props.heading && <div className="ctx-heading">{props.heading}</div>}
        <ul className="ctx-items">
          {props.items.map((item, i) =>
            item === "separator" ? (
              <li key={i} className="ctx-sep" role="separator" />
            ) : (
              <li key={i}>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`${i === active ? "active" : ""} ${item.danger ? "danger" : ""}`}
                  disabled={item.disabled}
                  title={item.title}
                  aria-haspopup={item.submenu ? "menu" : undefined}
                  aria-expanded={item.submenu ? open?.index === i : undefined}
                  onMouseEnter={() => {
                    setActive(i);
                    if (item.submenu && !item.disabled) openSub(i, false);
                    else setOpen(null);
                  }}
                  onClick={() => choose(i)}
                >
                  <span className="ctx-check">{item.checked ? "✓" : ""}</span>
                  <span className="ctx-label">{item.label}</span>
                  {item.hint && <span className="ctx-hint">{item.hint}</span>}
                  {item.submenu && <span className="ctx-arrow">›</span>}
                </button>
              </li>
            ),
          )}
        </ul>
      </div>
      {open && (() => {
        const item = props.items[open.index];
        if (!usable(item) || !item.submenu) return null;
        return (
          <MenuList
            key={open.index}
            items={item.submenu}
            x={open.x}
            y={open.y}
            flipFrom={{ left: open.left }}
            autoFocus={open.keyboard}
            onClose={props.onClose}
            onBack={() => {
              setOpen(null);
              ref.current?.focus();
            }}
          />
        );
      })()}
    </>
  );
}

/** A right-click menu. Closes on a click outside, Escape, scrolling or resizing. */
export function ContextMenu(props: { request: MenuRequest; onClose: () => void }) {
  const { request, onClose } = props;
  useEffect(() => {
    const away = (e: Event) => {
      if (!(e.target as Element).closest?.(".ctx-menu")) onClose();
    };
    const close = () => onClose();
    // Escape reaches here only when focus isn't in the menu (the menu handles its own keys).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);
  return (
    <div className="ctx-layer">
      <MenuList items={request.items} heading={request.heading} x={request.x} y={request.y} onClose={onClose} autoFocus />
    </div>
  );
}

export interface PromptRequest {
  x: number;
  y: number;
  label: string;
  value: string;
  type?: "text" | "date";
  /** For dates. */
  min?: string;
  max?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}

/** A small floating input, for renaming or picking a date where the menu was. */
export function QuickPrompt(props: { request: PromptRequest; onClose: () => void }) {
  const { request, onClose } = props;
  const [value, setValue] = useState(request.value);
  const ref = useRef<HTMLFormElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    setPos(placeInView(request.x, request.y, el.offsetWidth, el.offsetHeight));
  }, [request]);
  const placed = pos !== null;
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    if (!placed || !input) return;
    input.focus();
    if (request.type !== "date") input.select();
  }, [placed, request.type]);
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  const trimmed = request.type === "date" ? value : value.trim();
  return (
    <form
      ref={ref}
      className="quick-prompt"
      style={pos ? { left: pos.left, top: pos.top } : { left: request.x, top: request.y, visibility: "hidden" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        onClose();
        request.onSubmit(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label>
        <span>{request.label}</span>
        <input type={request.type ?? "text"} value={value} min={request.min} max={request.max} onChange={(e) => setValue(e.target.value)} />
      </label>
      <div className="quick-prompt-actions">
        <button type="button" className="small secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="small primary" disabled={!trimmed}>
          {request.submitLabel ?? "Save"}
        </button>
      </div>
    </form>
  );
}
