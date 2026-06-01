/**
 * A persistent chat session. Holds the conversation as COMPACT CONCLUSIONS —
 * one short line per turn — never raw page summaries. This is what keeps a long
 * conversation's token cost flat: the expensive page outline lives only in the
 * single in-flight orchestrator run and is discarded when the turn ends; only a
 * ~30-token conclusion survives into the session.
 *
 * A rolling window keeps the last N turns verbatim and folds anything older
 * into a single recap line, so history is bounded no matter how long the
 * conversation runs. No LLM summarization — purely mechanical.
 */

export interface SessionTurn {
  /** The user's message that started the turn. */
  user: string;
  /** The one-line conclusion: what was answered + where the browser ended up. */
  conclusion: string;
}

export class ChatSession {
  private turns: SessionTurn[] = [];
  /** Older turns folded into a single recap, once they fall out of the window. */
  private recap = "";
  /** Live browser state, updated by the host after each run. */
  private browserUrl = "";
  private browserTitle = "";

  constructor(private windowSize = 6) {}

  /** Record a completed turn, then fold anything beyond the window. */
  record(turn: SessionTurn): void {
    this.turns.push(turn);
    while (this.turns.length > this.windowSize) {
      const old = this.turns.shift()!;
      this.foldIntoRecap(old);
    }
  }

  /** Update what page the browser is currently showing (cheap, always current). */
  setBrowserState(url: string, title: string): void {
    this.browserUrl = url;
    this.browserTitle = title;
  }

  hasHistory(): boolean {
    return this.turns.length > 0 || this.recap.length > 0;
  }

  /**
   * Render the compact history block injected into the planner's first turn.
   * Bounded: a single recap line (if any) + the windowed turns. Returns "" when
   * there's nothing yet (a fresh conversation).
   */
  renderHistory(): string {
    if (!this.hasHistory()) return "";
    const lines: string[] = ["CONVERSATION SO FAR:"];
    if (this.recap) lines.push(`- (earlier) ${this.recap}`);
    for (const t of this.turns) {
      lines.push(`- user: "${truncate(t.user, 100)}" → ${t.conclusion}`);
    }
    return lines.join("\n");
  }

  /** A one-line note of what page the browser is currently on. */
  renderBrowserState(): string {
    if (!this.browserUrl || this.browserUrl === "about:blank") return "";
    const where = this.browserTitle
      ? `"${this.browserTitle}" (${shortHost(this.browserUrl)})`
      : shortHost(this.browserUrl);
    return `The browser is currently showing ${where}.`;
  }

  /**
   * Fold a turn that aged out of the window into the rolling recap line. The
   * recap is bounded; when it overflows we drop the OLDEST content (truncate
   * from the front) so recent-but-folded turns are preserved over ancient ones.
   */
  private foldIntoRecap(turn: SessionTurn): void {
    const piece = `${truncate(turn.user, 40)} → ${truncate(turn.conclusion, 50)}`;
    const joined = this.recap ? `${this.recap}; ${piece}` : piece;
    this.recap = truncateFront(joined, 400);
  }
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Keep the END of a string when it overflows (drop oldest folded content). */
function truncateFront(s: string, max: number): string {
  return s.length > max ? "…" + s.slice(s.length - (max - 1)) : s;
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
