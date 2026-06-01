import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { Message, type ActivityStep, type ChatMessage } from "./Message";
import type { ChatEvent } from "../../../electron/preload";

let idSeq = 0;
const nextId = () => `m${idSeq++}`;

/** Turn a streamed agent action into a human activity-trail line. */
function actionToStep(
  action: NonNullable<Extract<ChatEvent, { type: "action" }>["action"]>,
): ActivityStep | null {
  switch (action.type) {
    case "navigate":
      return { kind: "navigate", label: `Opening ${shortUrl(action.url ?? "")}` };
    case "click":
      return {
        kind: "click",
        label: action.reason ?? `Clicking element ${action.id}`,
      };
    case "type":
      return {
        kind: "type",
        label: action.reason ?? `Typing “${action.text ?? ""}”`,
      };
    case "scroll":
      return {
        kind: "scroll",
        label:
          action.reason ?? `Scrolling ${action.direction ?? "down"} for more`,
      };
    default:
      return null; // finish/answer aren't activity steps
  }
}

function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The assistant message id currently receiving events.
  const activeRef = useRef<string | null>(null);

  // Patch the in-flight assistant message.
  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  // Subscribe once to streamed agent events.
  useEffect(() => {
    return window.goldie.chat.onEvent((runId, event) => {
      const aId = activeRef.current;
      if (!aId || runId !== aId) return;

      switch (event.type) {
        case "thinking":
          patch(aId, (m) => ({ ...m, pending: true }));
          break;
        case "action": {
          const step = actionToStep(event.action);
          if (step) {
            patch(aId, (m) => ({
              ...m,
              activity: [...(m.activity ?? []), step],
            }));
          }
          break;
        }
        case "answer":
          patch(aId, (m) => ({ ...m, text: event.text, pending: false }));
          break;
        case "usage":
          patch(aId, (m) => ({ ...m, usage: event.usage }));
          break;
        case "error":
          patch(aId, (m) => ({
            ...m,
            text: event.message,
            error: true,
            pending: false,
          }));
          break;
        case "done":
          patch(aId, (m) => ({ ...m, pending: false }));
          activeRef.current = null;
          setBusy(false);
          break;
      }
    });
  }, []);

  const send = (text: string, model: string) => {
    const userMsg: ChatMessage = { id: nextId(), role: "user", text };
    const assistantId = nextId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      activity: [],
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    activeRef.current = assistantId;
    setBusy(true);
    void window.goldie.chat.send(assistantId, text, model);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <h1 className="mb-8 text-[24px] font-medium tracking-tight text-ink">
          What can I help with?
        </h1>
        <Composer onSend={send} centered busy={busy} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </div>
      </div>
      <div className="shrink-0 px-6 pb-6 pt-2">
        <Composer onSend={send} busy={busy} />
      </div>
    </div>
  );
}
