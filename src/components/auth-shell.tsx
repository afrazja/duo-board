import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
      <section className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-900/90 p-7 shadow-2xl shadow-black/30">
        <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-indigo-500 text-white">D</span>
          Duo Board
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-6 mt-2 text-sm leading-6 text-zinc-400">{subtitle}</p>
        {children}
        {footer && <div className="mt-6 border-t border-zinc-800 pt-5 text-center text-sm text-zinc-400">{footer}</div>}
      </section>
    </main>
  );
}

export const authInput = "mt-1.5 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3.5 py-3 text-sm outline-none focus:border-indigo-500";
export const authButton = "mt-2 w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-50";
