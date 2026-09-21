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

function newFinalText(previous: string | undefined, current: string): string {
  if (!current || current === previous) return "";
  if (previous && current.startsWith(previous)) return current.slice(previous.length).trim();
  return current;
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

  consume(resultIndex: number, results: ArrayLike<DictationResultLike>): DictationUpdate {
    const final: string[] = [];
    const interim: string[] = [];

    for (let index = resultIndex; index < results.length; index += 1) {
      const result = results[index];
      const transcript = cleanTranscript(result[0]?.transcript ?? "");
      if (result.isFinal) {
        const addition = newFinalText(this.finalized.get(index), transcript);
        if (addition) final.push(addition);
        this.finalized.set(index, transcript);
      } else if (transcript) {
        interim.push(transcript);
      }
    }

    return { final: final.join(" "), interim: interim.join(" ") };
  }

  reset(): void {
    this.finalized.clear();
  }
}
