import { useRef, useState } from "react";

const MODELS = ["Haiku 4.5", "Gemini 3 Flash"] as const;

export function Composer({
  onSend,
  centered = false,
  busy = false,
}: {
  onSend: (text: string, model: string) => void;
  centered?: boolean;
  busy?: boolean;
}) {
  const [value, setValue] = useState("");
  const [model, setModel] = useState<(typeof MODELS)[number]>(MODELS[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text, model);
    setValue("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  };

  return (
    <div
      className={`w-full ${centered ? "max-w-[720px]" : "max-w-[820px]"} mx-auto`}
    >
      <div className="rounded-panel bg-raised shadow-well transition-shadow duration-200 focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            grow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Ask anything, or describe a task…"
          className="block min-h-[60px] max-h-[280px] w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none [user-select:text]"
        />

        <div className="flex items-center justify-between px-3 pb-3 pt-1.5">
          {/* Model picker pill */}
          <div className="relative">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-overlay hover:text-ink"
            >
              {model}
              <svg width="10" height="10" viewBox="0 0 10 10" className="text-ink-faint">
                <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {pickerOpen && (
              <div className="absolute bottom-full left-0 mb-1.5 w-44 overflow-hidden rounded-well border border-line bg-overlay py-1 shadow-card">
                {MODELS.map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setModel(m);
                      setPickerOpen(false);
                    }}
                    className={`flex w-full items-center px-3 py-2 text-left text-[13px] transition-colors hover:bg-raised ${
                      m === model ? "text-ink" : "text-ink-muted"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send */}
          <button
            onClick={submit}
            disabled={!value.trim() || busy}
            aria-label="Send"
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition-all duration-150 enabled:hover:bg-overlay enabled:hover:text-ink disabled:opacity-30"
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M8 13V3M8 3L4 7M8 3l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {centered && (
        <p className="mt-3 text-center text-[12px] text-ink-faint">
          Goldie can browse the web for you — just ask.
        </p>
      )}
    </div>
  );
}
