import type { Message } from "../lib/board";

export type BoardMessage = Message & { kind?: "message" | "compare" };
export type Replies = { claude: BoardMessage[]; chatgpt: BoardMessage[] };
export interface BoardRow extends Replies {
  key: string;
  user?: BoardMessage;
  comparison?: Replies & { request: BoardMessage };
}

export function mergeMessages(previous: BoardMessage[], incoming: BoardMessage[]): BoardMessage[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Explicit reply links take precedence over arrival order, including follow-ups to replies. */
export function groupRows(messages: BoardMessage[]): BoardRow[] {
  const rows: BoardRow[] = [];
  const targets = new Map<string, Replies>();
  const questions = new Map<string, BoardRow>();
  let latest: Replies | undefined;
  for (const message of messages) {
    if (message.author === "user") {
      const original = message.kind === "compare" && message.reply_to ? questions.get(message.reply_to) : undefined;
      if (original) {
        original.comparison ??= { request: message, claude: [], chatgpt: [] };
        latest = original.comparison;
      } else {
        const row: BoardRow = { key: message.id, user: message, claude: [], chatgpt: [] };
        rows.push(row);
        questions.set(message.id, row);
        latest = row;
      }
      targets.set(message.id, latest);
      continue;
    }
    let target = message.reply_to ? targets.get(message.reply_to) : latest;
    if (!target) {
      const row: BoardRow = { key: message.id, claude: [], chatgpt: [] };
      rows.push(row);
      target = row;
    }
    target[message.author].push(message);
    targets.set(message.id, target);
  }
  return rows;
}

export function isFirstRound(row: BoardRow): boolean {
  return row.user?.addressed_to === "both" && row.user.kind !== "compare";
}

export function hasBothAnswers(replies: Replies): boolean {
  return replies.claude.length > 0 && replies.chatgpt.length > 0;
}

/** The speech queue receives exactly the replies that the page has revealed. */
export function playableMessages(rows: BoardRow[]): BoardMessage[] {
  return rows.flatMap((row) => {
    if (isFirstRound(row) && !hasBothAnswers(row)) return row.user ? [row.user] : [];
    return [
      ...(row.user ? [row.user] : []), ...row.claude, ...row.chatgpt,
      ...(row.comparison ? [row.comparison.request, ...row.comparison.claude, ...row.comparison.chatgpt] : []),
    ];
  }).sort((a, b) => a.seq - b.seq);
}

/** A labelled opening excerpt, never a generated conclusion or inferred agreement. */
export function openingExcerpt(body: string, maxWords = 85): string {
  const plain = body.replace(/```[\s\S]*?```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~`|]/g, "").replace(/\s+/g, " ").trim();
  const words = plain.split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : plain;
}
