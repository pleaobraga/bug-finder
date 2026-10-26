import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Links and images never load anything: the app shows no remote content.
const components: Components = {
  a: ({ children }) => <span className="font-medium text-brand-700 underline decoration-dotted dark:text-brand-400">{children}</span>,
  img: ({ alt }) => <span className="text-muted">[{alt}]</span>,
  h1: ({ children }) => <h1 className="mb-3 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold">{children}</h3>,
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-4 border-line pl-3 text-muted">{children}</blockquote>,
  code: ({ children, className }) =>
    className ? (
      <code className={`${className} block overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs`}>{children}</code>
    ) : (
      <code className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    ),
  table: ({ children }) => <table className="my-3 w-full border-collapse text-sm">{children}</table>,
  th: ({ children }) => <th className="border border-line bg-raised px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
  input: ({ checked }) => <input type="checkbox" checked={checked} readOnly disabled className="mr-1.5 align-middle" />,
};

export function Markdown({ children, testId }: { children: string; testId?: string }) {
  return (
    <div className="text-sm" data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
