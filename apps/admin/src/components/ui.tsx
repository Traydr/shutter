import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter((entry) => entry !== false && entry !== undefined).join(" ");
}

export function Panel({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cx("min-w-0 overflow-hidden rounded-lg border border-rule bg-panel", className)}
    >
      {children}
    </section>
  );
}

/** The strip at the top of a panel: a title, an aside in muted text, and actions pushed right. */
export function PanelHead({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-rule bg-panel-2 px-2.5 py-1.5">
      <h2 className="m-0 text-[13px] font-semibold leading-tight">{title}</h2>
      {aside === undefined ? null : <span className="text-ink-3">{aside}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export function Pill({
  tone = "muted",
  small = false,
  children,
}: {
  tone?: "ok" | "warn" | "muted";
  small?: boolean;
  children: ReactNode;
}) {
  const tones = {
    ok: "bg-brand-bg text-brand-ink before:bg-brand",
    warn: "bg-amber-bg text-amber before:bg-amber",
    muted: "bg-[#eceeec] text-ink-2 before:bg-ink-3",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold leading-none before:size-1.5 before:rounded-full before:content-['']",
        small ? "px-1.5 py-0.5 text-[10.5px]" : "px-2 py-[3px] text-[11px]",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function RouteClassChip({ routeClass }: { routeClass: "public" | "private" }) {
  return (
    <span
      className={cx(
        "inline-block rounded border px-1.5 py-[3px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.04em]",
        routeClass === "public"
          ? "border-[#b9d9cc] bg-[#f2faf6] text-brand-ink"
          : "border-rule text-ink-2",
      )}
    >
      {routeClass}
    </span>
  );
}

/** A `?` glyph that reveals its explanation on hover or focus. */
export function Hint({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  return (
    <span className="group relative ml-1.5 inline-flex flex-none align-[1px]">
      <button
        type="button"
        aria-label={text}
        className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full border border-[#b6bcb7] bg-transparent p-0 text-[9.5px] font-bold normal-case leading-none tracking-normal text-ink-3 hover:border-ink-2 hover:text-ink-2 focus:border-ink-2 focus:text-ink-2 focus:outline-none"
      >
        ?
      </button>
      <span
        role="tooltip"
        className={cx(
          "absolute top-[calc(100%+7px)] z-30 hidden w-[270px] rounded-md bg-[#1b211f] px-2.5 py-2 text-left text-[11.5px] font-normal normal-case leading-[1.45] tracking-normal text-white shadow-[0_8px_24px_#0004] group-hover:block group-focus-within:block",
          align === "left" ? "left-0" : "right-0",
        )}
      >
        {text}
      </span>
    </span>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 rounded-md border-l-[3px] border-brand bg-brand-bg px-3 py-2 text-[12.5px] text-brand-ink">
      {children}
    </p>
  );
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="m-0 rounded-md border-l-[3px] border-red bg-red-bg px-3 py-2 text-[12.5px] text-red [overflow-wrap:anywhere]"
    >
      {children}
    </p>
  );
}

export function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div className="m-0 rounded-md border border-[#f0d9b4] bg-amber-bg px-2.5 py-1.5 text-[12.5px] text-amber-ink">
      {children}
    </div>
  );
}

const BUTTON_TONES = {
  default: "border-rule bg-panel text-ink hover:bg-panel-2",
  primary: "border-brand bg-brand text-white hover:bg-brand-ink hover:border-brand-ink",
  danger: "border-red-rule bg-panel text-red hover:bg-red-bg",
  ghost: "border-transparent bg-transparent text-ink-2 hover:text-ink",
} as const;

export function Button({
  tone = "default",
  small = false,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: keyof typeof BUTTON_TONES;
  small?: boolean;
}) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border font-semibold leading-none disabled:cursor-default disabled:opacity-50",
        small ? "px-[7px] py-[3px] text-[11px]" : "px-2.5 py-1.5 text-[12px]",
        BUTTON_TONES[tone],
        className,
      )}
    />
  );
}

export const INPUT_CLASS =
  "w-full min-w-0 rounded-[5px] border border-[#c3c9c4] bg-panel px-2 py-[5px] text-[12.5px] text-ink disabled:bg-panel-2 disabled:text-ink-3";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(INPUT_CLASS, props.className)} />;
}

/** A labelled control: label row with an optional hint, the control, an optional note. */
export function Field({
  label,
  hint,
  note,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  note?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child component
    <label className={cx("m-0 grid min-w-0 gap-1", wide && "col-span-full")}>
      <span className="flex items-center text-[12px] font-semibold">
        {label}
        {hint === undefined ? null : <Hint text={hint} />}
      </span>
      {children}
      {note === undefined ? null : <small className="text-[11px] text-ink-3">{note}</small>}
    </label>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] font-semibold uppercase leading-none tracking-[.07em] text-ink-3">
      {children}
    </span>
  );
}

/** A UTC instant at minute precision; the full instant stays in the attributes. */
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value} className="whitespace-nowrap">
      {value.slice(0, 10)} {value.slice(11, 16)}
    </time>
  );
}

export function TimeOrNever({ value }: { value: string | undefined }) {
  return value === undefined ? <span className="text-ink-3">never</span> : <Time value={value} />;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-rule-2 bg-[#f1f3f1] px-1 font-mono text-[12px] [overflow-wrap:anywhere]">
      {children}
    </code>
  );
}

/** One-time credential display; the value never appears anywhere else. */
export function SecretReveal({ label, value }: { label: string; value: string }) {
  return (
    <Panel className="grid gap-1.5 border-[#f0d9b4] bg-amber-bg px-3 py-2.5">
      <h2 className="m-0 text-[13px] font-semibold text-amber-ink">{label}</h2>
      <span className="text-ink-2">
        This secret is shown once. Copy it now into the application's secret store.
      </span>
      <div className="rounded-md bg-[#13231e] px-2.5 py-2 font-mono text-[12px] text-[#e5fff7] [overflow-wrap:anywhere]">
        {value}
      </div>
    </Panel>
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="m-0 p-2.5 text-ink-3">{children}</p>;
}

export const TABLE_CLASS = "w-full border-collapse";
export const TH_CLASS =
  "whitespace-nowrap border-b border-rule px-2.5 py-1.5 text-left text-[10.5px] font-semibold uppercase leading-none tracking-[.07em] text-ink-3";
export const TD_CLASS =
  "border-b border-rule-2 px-2.5 py-1.5 align-middle [overflow-wrap:anywhere]";
