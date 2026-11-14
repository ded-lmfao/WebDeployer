"use client";

/**
 * @author: @dorianbaffier
 * @description: Command Button
 * @version: 2.0.0
 * @date: 2026-10-16
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 *
 * A button with its keyboard shortcut drawn as physical keycaps. The shortcut
 * works for real: pressing the keys anywhere on the page sinks each cap as
 * its key goes down and clicks the button when the combination matches.
 */

import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

type Modifier = "mod" | "ctrl" | "alt" | "shift";

interface ParsedShortcut {
  modifiers: Modifier[];
  key: string;
}

interface CommandButtonProps extends ComponentProps<"button"> {
  children?: ReactNode;
  /**
   * The shortcut, as `+`-joined parts: `mod` (⌘ on Mac, Ctrl elsewhere),
   * `ctrl`, `alt`, `shift` and one key, e.g. `"mod+k"`, `"shift+n"`, `"c"`.
   */
  shortcut?: string;
  /**
   * Listen for the shortcut on the whole page. Shortcuts without `mod`,
   * `ctrl` or `alt` are ignored while typing in a field.
   */
  global?: boolean;
}

const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;
const MODIFIERS = new Set<Modifier>(["mod", "ctrl", "alt", "shift"]);

const parseShortcut = (shortcut: string): ParsedShortcut => {
  const parts = shortcut
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers = parts.filter((part): part is Modifier =>
    MODIFIERS.has(part as Modifier)
  );
  const key = parts.find((part) => !MODIFIERS.has(part as Modifier)) ?? "k";
  return { modifiers, key };
};

const MAC_LABELS: Record<Modifier, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const PC_LABELS: Record<Modifier, string> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};
// aria-keyshortcuts takes KeyboardEvent.key names: Meta, not Command.
const ARIA_KEYS: Record<Modifier, [mac: string, pc: string]> = {
  mod: ["Meta", "Control"],
  ctrl: ["Control", "Control"],
  alt: ["Alt", "Alt"],
  shift: ["Shift", "Shift"],
};

const ariaKey = (key: string) => {
  if (key === "enter") {
    return "Enter";
  }
  if (key === "space") {
    return "Space";
  }
  return key.length === 1 ? key.toUpperCase() : key;
};

const keyLabel = (key: string) => {
  if (key === "enter") {
    return "↵";
  }
  if (key === "space") {
    return "Space";
  }
  return key.length === 1 ? key.toUpperCase() : key;
};

// Matches by physical key too, since Option on a Mac changes `event.key`
// (Option+K types "˚").
const isKey = (event: KeyboardEvent, key: string) => {
  const pressed = event.key.toLowerCase();
  if (key === "space") {
    return event.code === "Space";
  }
  return (
    pressed === key ||
    event.code === `Key${key.toUpperCase()}` ||
    event.code === `Digit${key}`
  );
};

const isModifierDown = (
  modifier: Modifier,
  event: KeyboardEvent,
  isMac: boolean
) => {
  switch (modifier) {
    case "mod":
      return isMac ? event.metaKey : event.ctrlKey;
    case "ctrl":
      return event.ctrlKey;
    case "alt":
      return event.altKey;
    case "shift":
      return event.shiftKey;
    default:
      return false;
  }
};

const matches = (
  event: KeyboardEvent,
  { modifiers, key }: ParsedShortcut,
  isMac: boolean
) => {
  if (!isKey(event, key)) {
    return false;
  }
  const wanted = {
    meta: modifiers.includes("mod") && isMac,
    ctrl: modifiers.includes("ctrl") || (modifiers.includes("mod") && !isMac),
    alt: modifiers.includes("alt"),
    shift: modifiers.includes("shift"),
  };
  return (
    event.metaKey === wanted.meta &&
    event.ctrlKey === wanted.ctrl &&
    event.altKey === wanted.alt &&
    event.shiftKey === wanted.shift
  );
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

function Keycap({ label, pressed }: { label: string; pressed: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 font-mono text-xs font-medium leading-none",
        "border border-border bg-secondary text-muted-foreground",
        "transition-[translate,background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "group-active/command:translate-y-px",
        pressed && "translate-y-px text-foreground"
      )}
      data-pressed={pressed || undefined}
    >
      {label}
    </kbd>
  );
}

export default function CommandButton({
  className,
  children = "Search",
  shortcut = "mod+k",
  global = true,
  ...props
}: CommandButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isMac, setIsMac] = useState(true);
  const [platformKnown, setPlatformKnown] = useState(false);
  const [held, setHeld] = useState<{ modifiers: Modifier[]; key: boolean }>({
    modifiers: [],
    key: false,
  });
  const parsed = parseShortcut(shortcut);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;

  // The platform is unknown on the server, so the caps render invisible and
  // fade in once it is read, instead of swapping ⌘ for Ctrl in view.
  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform;
    setIsMac(APPLE_PLATFORM.test(platform));
    setPlatformKnown(true);
  }, []);

  useEffect(() => {
    if (!global) {
      return;
    }
    const sync = (event: KeyboardEvent, isDown: boolean) => {
      const { modifiers, key } = parsedRef.current;
      const next = {
        modifiers: modifiers.filter((m) => isModifierDown(m, event, isMac)),
        key: isDown && isKey(event, key),
      };
      // Every key on the page lands here; only re-render when a cap moves.
      setHeld((current) =>
        current.key === next.key &&
        current.modifiers.join() === next.modifiers.join()
          ? current
          : next
      );
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const current = parsedRef.current;
      const needsModifier = current.modifiers.some((m) => m !== "shift");
      if (!needsModifier && isTyping(event.target)) {
        return;
      }
      sync(event, true);
      if (
        !event.repeat &&
        matches(event, current, isMac) &&
        !buttonRef.current?.disabled
      ) {
        event.preventDefault();
        buttonRef.current?.click();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => sync(event, false);
    const release = () =>
      setHeld((current) =>
        current.key || current.modifiers.length > 0
          ? { modifiers: [], key: false }
          : current
      );

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", release);
    };
  }, [global, isMac]);

  const labels = isMac ? MAC_LABELS : PC_LABELS;
  const keyshortcuts = [
    ...parsed.modifiers.map((m) => ARIA_KEYS[m][isMac ? 0 : 1]),
    ariaKey(parsed.key),
  ].join("+");

  return (
    <button
      aria-keyshortcuts={keyshortcuts}
      className={cn(
        "group/command inline-flex h-8 cursor-pointer items-center gap-2.5 rounded-lg py-1 pr-1.5 pl-3 text-xs font-medium",
        "border border-border bg-card text-foreground",
        "transition-[background-color,border-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
        "hover:bg-secondary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      ref={buttonRef}
      type="button"
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center gap-1 pb-0.5 transition-opacity duration-150 ease-out",
          !platformKnown && "opacity-0"
        )}
      >
        {parsed.modifiers.map((modifier) => (
          <Keycap
            key={modifier}
            label={labels[modifier]}
            pressed={held.modifiers.includes(modifier)}
          />
        ))}
        <Keycap label={keyLabel(parsed.key)} pressed={held.key} />
      </span>
    </button>
  );
}
