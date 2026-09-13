import { useEffect, useState } from "react";
import { Button } from "./ui";

/** Copies a value to the clipboard and says so for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
