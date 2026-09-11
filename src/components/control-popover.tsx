"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** A labelled disclosure for secondary controls; Escape and outside click close it. */
export function ControlPopover({ label, children, buttonClass = "", panelClass = "", trigger, above = false }: {
  label: string; children: ReactNode; buttonClass?: string; panelClass?: string; trigger?: ReactNode; above?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, window.innerWidth - 32);
      setPosition({ width, left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)),
        top: above ? undefined : rect.bottom + 8, bottom: above ? window.innerHeight - rect.top + 8 : undefined,
        maxHeight: Math.max(120, above ? rect.top - 24 : window.innerHeight - rect.bottom - 24) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, above]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className="relative shrink-0">
    <button ref={button} type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={`min-h-10 rounded-lg border border-zinc-700 px-3 text-[13px] text-zinc-300 hover:border-zinc-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${buttonClass}`}>{trigger ?? label}</button>
    {open && <div id={id} role="region" aria-label={label} style={position} className={`fixed z-40 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl ${panelClass}`}>{children}</div>}
  </div>;
}
