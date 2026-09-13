import { Link, type LinkProps } from "@tanstack/react-router";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { calendarDate, relativeTime } from "../features/spaces/summaries";

export function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter((entry) => entry !== false && entry !== undefined).join(" ");
}

// Buttons

const BUTTON_TONES = {
  default: "border-line-2 bg-bg text-fg hover:border-line-3 hover:bg-s2",
  primary: "border-btn-bg bg-btn-bg text-btn-fg hover:opacity-90",
  ghost: "border-transparent bg-transparent text-fg-2 hover:bg-s2 hover:text-fg",
  danger: "border-line-2 bg-bg text-red-fg hover:border-red hover:bg-red-bg",
} as const;

const BUTTON_SIZES = {
  md: "h-9 px-3.5 text-sm",
  sm: "h-[30px] px-2.5 text-[13px]",
} as const;

export type ButtonTone = keyof typeof BUTTON_TONES;

export function buttonClass(tone: ButtonTone = "default", size: keyof typeof BUTTON_SIZES = "md") {
  return cx(
    "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium leading-none disabled:cursor-default disabled:opacity-50",
    BUTTON_TONES[tone],
    BUTTON_SIZES[size],
  );
}

export function Button({
  tone = "default",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return <button {...rest} className={cx(buttonClass(tone, size), className)} />;
}

/** A router link that looks like a button. */
export function LinkButton({
  tone = "default",
  size = "md",
  className,
  ...rest
}: LinkProps & { tone?: ButtonTone; size?: keyof typeof BUTTON_SIZES; className?: string }) {
  return <Link {...rest} className={cx(buttonClass(tone, size), className)} />;
}

export function TextLink({ className, ...rest }: LinkProps & { className?: string }) {
  return <Link {...rest} className={cx("text-accent-fg hover:underline", className)} />;
}

// Inputs

export const INPUT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-line-2 bg-bg px-3 text-sm text-fg outline-none placeholder:text-fg-3 hover:border-line-3 focus:border-fg-3 focus:ring-[3px] focus:ring-s3 disabled:bg-s1 disabled:text-fg-2";
export const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono text-[13.5px]`;

export function Input({
  mono = false,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...rest} className={cx(mono ? MONO_INPUT_CLASS : INPUT_CLASS, className)} />;
}

export function Textarea({
  mono = false,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return (
    <textarea
      {...rest}
      className={cx(
        mono ? MONO_INPUT_CLASS : INPUT_CLASS,
        "h-auto min-h-0 resize-y py-2.5 leading-relaxed",
        className,
      )}
    />
  );
}

/** A labelled control with an optional sentence of help beneath it. */
export function Field({
  label,
  help,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child component
    <label className="grid min-w-0 gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {help === undefined ? null : <span className="text-[13px] text-fg-2">{help}</span>}
    </label>
  );
}

// Surfaces and text

export function Card({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cx("min-w-0 rounded-[10px] border border-line bg-s1", className)}>
      {children}
    </section>
  );
}

/** The strip at the foot of a form card: a sentence on the left, the action on the right. */
export function CardFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line pt-[18px] text-[13px] text-fg-2">
      {children}
    </div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">{children}</h1>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{children}</h2>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[13px]", className)}>{children}</span>;
}

// State

export type Tone = "ok" | "warn" | "off";

const DOT_TONES = { ok: "bg-accent", warn: "bg-warn", off: "bg-line-3" } as const;

export function Dot({ tone }: { tone: Tone }) {
  return <i className={cx("inline-block size-2 flex-none rounded-full", DOT_TONES[tone])} />;
}

/** One dot and one sentence: the whole status vocabulary of the app. */
export function StateLine({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-2", className)}>
      <Dot tone={tone} />
      <span className={cx("min-w-0", tone === "warn" && "text-warn-fg")}>{children}</span>
    </span>
  );
}

const NOTICE_TONES = {
  info: "border-line bg-s1 text-fg-2",
  warn: "border-warn/40 bg-warn/10 text-warn-fg",
  error: "border-red/40 bg-red-bg text-red-fg",
} as const;

export function Notice({
  tone = "info",
  children,
}: {
  tone?: keyof typeof NOTICE_TONES;
  children: ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cx(
        "rounded-lg border px-4 py-3 text-[13.5px] [overflow-wrap:anywhere]",
        NOTICE_TONES[tone],
      )}
    >
      {children}
    </p>
  );
}

/** One-time credential display; the value never appears anywhere else. */
export function SecretReveal({ label, value }: { label: string; value: string }) {
  return (
    <Card className="grid gap-2.5 border-warn/40 p-5">
      <h2 className="text-[15px] font-semibold">{label}</h2>
      <p className="text-[13.5px] text-fg-2">
        This is shown once. Copy it now into the application's secret store.
      </p>
      <CodeBlock>{value}</CodeBlock>
    </Card>
  );
}

export function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="m-0 whitespace-pre-wrap rounded-lg border border-line bg-bg px-4 py-3 font-mono text-[13px] leading-relaxed text-fg [overflow-wrap:anywhere]">
      {children}
    </pre>
  );
}

/** A URL or key template with each `{name}` picked out in the accent colour. */
export function Template({ value, className }: { value: string; className?: string }) {
  const parts = value.split(/(\{[^{}]*\})/u).filter((part) => part.length > 0);
  return (
    <span className={cx("font-mono text-[13px] [overflow-wrap:anywhere]", className)}>
      {parts.map((part, index) =>
        part.startsWith("{") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional text
          <b key={index} className="whitespace-nowrap font-medium text-accent-fg">
            {part}
          </b>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional text
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

// Time

/** "16 minutes ago"; the full instant stays in the attributes. Rendered on both sides, so hydration may differ by a minute. */
export function Ago({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value} suppressHydrationWarning>
      {relativeTime(value)}
    </time>
  );
}

/** "Aug 13, 2026"; the full instant stays in the attributes. */
export function Day({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {calendarDate(value)}
    </time>
  );
}

// Lists

/** A bordered stack of rows separated by hairlines. */
export function List({ children }: { children: ReactNode }) {
  return (
    <div className="grid divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-s1">
      {children}
    </div>
  );
}

const ROW_CLASS = "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-3.5";

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(ROW_CLASS, className)}>{children}</div>;
}

export function LinkRow({ className, ...rest }: LinkProps & { className?: string }) {
  return <Link {...rest} className={cx(ROW_CLASS, "hover:bg-s2", className)} />;
}

export function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="text-fg-3"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
