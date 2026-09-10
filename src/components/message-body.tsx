import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Messages are Markdown (the assistants are told to write it), rendered with
// GitHub-flavoured tables and lists. Headings are stepped down so a reply's
// "# Title" never outranks the page. Paragraphs keep single newlines, so a
// dictated message with line breaks still reads the way it was typed.
const MD: Components = {
  h1: ({ children }) => <h3 className="mb-1 mt-3 text-[17px] font-semibold text-zinc-50">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-3 text-[16px] font-semibold text-zinc-50">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-2 text-[15.5px] font-semibold text-zinc-100">{children}</h4>,
  h4: ({ children }) => <h5 className="mb-1 mt-2 text-[15px] font-semibold text-zinc-100">{children}</h5>,
  p: ({ children }) => <p className="whitespace-pre-wrap text-[15.5px] leading-7 text-zinc-100">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 text-[15.5px] leading-7 text-zinc-100">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 text-[15.5px] leading-7 text-zinc-100">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-indigo-300 underline underline-offset-2 hover:text-indigo-200">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-zinc-50">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-zinc-700 pl-3 text-zinc-300">{children}</blockquote>,
  hr: () => <hr className="my-3 border-zinc-800" />,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-black/40 p-3 text-[13.5px] leading-6 [&_code]:bg-transparent [&_code]:p-0">{children}</pre>
  ),
  code: ({ children }) => <code className="rounded bg-black/40 px-1 py-0.5 text-[13.5px]">{children}</code>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="my-2 w-full border-collapse text-[14px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-zinc-700 px-2 py-1.5 text-left font-semibold text-zinc-200">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-800 px-2 py-1.5 align-top text-zinc-200">{children}</td>,
};

export function Body({ text }: { text: string }) {
  // dir="auto" lets a Persian message align right without a language setting.
  return (
    <div className="space-y-2 break-words" dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

