export interface DictationResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export interface DictationUpdate {
  final: string;
  interim: string;
}

function cleanTranscript(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function comparableWord(value: string): string {
  return value.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function words(value: string): string[] {
  return cleanTranscript(value).split(" ").filter(Boolean);
}

function withoutCommittedOverlap(committed: string, current: string): string {
  if (!committed) return current;
  const previousWords = words(committed);
  const currentWords = words(current);
  const limit = Math.min(previousWords.length, currentWords.length);
  let overlap = 0;

  for (let size = limit; size > 0; size -= 1) {
    const previousStart = previousWords.length - size;
    const matches = currentWords
      .slice(0, size)
      .every((word, offset) => comparableWord(word) === comparableWord(previousWords[previousStart + offset]));
    if (matches) {
      overlap = size;
      break;
    }
  }

  // A one-word result at a new index can be an intentional repeated word.
  // Growing mobile transcripts contain two or more words, so they still shed
  // their replayed prefix here.
  if (currentWords.length === 1 && overlap === 1) return current;
  return currentWords.slice(overlap).join(" ");
}

/**
 * Tracks final Web Speech results for one manual dictation session.
 *
 * Some mobile implementations replay finalized result indexes, especially
 * after the recognition service ends on a pause and is restarted. Keeping the
 * final value for each index prevents those replays from being appended to the
 * draft again.
 */
export class DictationResultTracker {
  private readonly finalized = new Map<number, string>();
  private committed = "";

  consume(resultIndex: number, results: ArrayLike<DictationResultLike>): DictationUpdate {
    const final: string[] = [];
    const interim: string[] = [];

    for (let index = resultIndex; index < results.length; index += 1) {
      const result = results[index];
      const transcript = cleanTranscript(result[0]?.transcript ?? "");
      if (result.isFinal) {
        if (this.finalized.get(index) === transcript) continue;
        const addition = withoutCommittedOverlap(this.committed, transcript);
        if (addition) {
          final.push(addition);
          this.committed = cleanTranscript(`${this.committed} ${addition}`);
        }
        this.finalized.set(index, transcript);
      } else if (transcript) {
        interim.push(transcript);
      }
    }

    return { final: final.join(" "), interim: interim.join(" ") };
  }

  reset(): void {
    this.finalized.clear();
    this.committed = "";
  }

  resume(): void {
    this.finalized.clear();
  }
}
