/** One agent activity step shown in the compact trail under an assistant turn. */
export interface ActivityStep {
  kind: "navigate" | "click" | "type" | "scroll" | "thinking";
  label: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  calls: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant-only: the live agent activity trail. */
  activity?: ActivityStep[];
  /** Assistant-only: still running. */
  pending?: boolean;
  /** Assistant-only: an error occurred. */
  error?: boolean;
  /** Assistant-only: token usage for this turn (for monitoring). */
  usage?: TokenUsage;
}

function ActivityTrail({ steps }: { steps: ActivityStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px] text-ink-faint">
          <Glyph kind={s.kind} />
          <span className="truncate">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

function Glyph({ kind }: { kind: ActivityStep["kind"] }) {
  const cls = "shrink-0 text-ink-ghost";
  if (kind === "navigate")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className={cls}>
        <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
        <path d="M1.8 7h10.4M7 1.8c1.5 1.6 1.5 9 0 10.4M7 1.8c-1.5 1.6-1.5 9 0 10.4" fill="none" stroke="currentColor" strokeWidth="0.9" />
      </svg>
    );
  if (kind === "click")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className={cls}>
        <path d="M4 2l7 4.5-3 .8 1.8 3.3-1.4.8L6.6 8l-2.6 1.8z" fill="currentColor" />
      </svg>
    );
  if (kind === "type")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className={cls}>
        <rect x="1.5" y="3.5" width="11" height="7" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    );
  if (kind === "scroll")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className={cls}>
        <path d="M7 2v10M3.5 8.5L7 12l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  // thinking
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" className={cls}>
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-well rounded-tr-md bg-raised px-3.5 py-2.5 text-[14px] leading-relaxed text-ink [user-select:text]">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {message.activity && <ActivityTrail steps={message.activity} />}
      {message.text ? (
        <div
          className={`whitespace-pre-wrap text-[14px] leading-relaxed [user-select:text] ${
            message.error ? "text-red-300/80" : "text-ink/90"
          }`}
        >
          {message.text}
        </div>
      ) : message.pending ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />
          Working…
        </div>
      ) : null}
      {message.usage && !message.pending && (
        <div className="mt-1.5 text-[11px] text-ink-ghost">
          {message.usage.input.toLocaleString()} in ·{" "}
          {message.usage.output.toLocaleString()} out
          {message.usage.cacheRead ? (
            <> · {message.usage.cacheRead.toLocaleString()} cached</>
          ) : null}{" "}
          · {message.usage.calls}{" "}
          {message.usage.calls === 1 ? "turn" : "turns"}
        </div>
      )}
    </div>
  );
}
