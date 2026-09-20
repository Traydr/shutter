export class CliError extends Error {}

/** Where a command writes. stdout carries only the result, so it stays safe to pipe. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const processOutput: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);

let unread = "";

/**
 * Prompt on stderr so stdout stays clean for piping. `hidden` suppresses echo
 * on a TTY. Input is read with a listener, never by iterating stdin: leaving a
 * `for await` over a stream destroys it, and the next prompt would find stdin
 * already closed. Piped input can carry several answers in one chunk, so what
 * follows the newline waits in `unread` for the next prompt.
 */
export function prompt(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  const raw = hidden && stdin.isTTY;
  return new Promise((resolve, reject) => {
    let value = "";
    const settle = (finish: () => void) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      finish();
    };
    const onEnd = () => settle(() => resolve(value));
    const take = (text: string) => {
      const chars = [...text];
      for (const [index, char] of chars.entries()) {
        if (raw && char === CTRL_C) return settle(() => reject(new CliError("interrupted")));
        if (char === "\r" || char === "\n") {
          if (raw) process.stderr.write("\n");
          const rest = chars.slice(index + 1);
          if (char === "\r" && rest[0] === "\n") rest.shift();
          unread = rest.join("");
          return settle(() => resolve(value));
        }
        if (raw && (char === DEL || char === "\b")) value = value.slice(0, -1);
        else value += char;
      }
    };
    const onData = (chunk: Buffer) => take(chunk.toString("utf8"));
    if (unread.includes("\n")) {
      const buffered = unread;
      unread = "";
      return take(buffered);
    }
    value = unread;
    unread = "";
    if (raw) stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    [],
  );
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
