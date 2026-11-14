import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, Link } from "@heroui/react";
import {
  ArrowUpRight,
  Cpu,
  Database,
  Layers,
  LayoutDashboard,
  Menu,
  Scale,
  Terminal,
  X,
} from "lucide-react";
import ActionSearchBar, {
  type CommandItem,
} from "@/components/kokonutui/action-search-bar";
import CommandButton from "@/components/kokonutui/command-button";
import SwitchButton from "@/components/kokonutui/switch-button";
import { GITHUB_REPO_URL } from "@/data/webdepData";

interface NavbarHeaderProps {
  theme: "light" | "dark";
  onThemeChange: (next: "light" | "dark") => void;
  onJumpToSection: (sectionId: string) => void;
  onOpenDemo: () => void;
}

const NAV_LINKS = [
  { label: "Features", target: "capabilities" },
  { label: "Panel tour", target: "panel-tour" },
  { label: "Comparison", target: "comparison" },
  { label: "Install", target: "install" },
];

export default function NavbarHeader({
  theme,
  onThemeChange,
  onJumpToSection,
  onOpenDemo,
}: NavbarHeaderProps) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!commandOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen]);

  const commandItems = useMemo<CommandItem[]>(
    () => [
      {
        id: "cmd-demo",
        label: "Launch interactive panel demo",
        icon: <LayoutDashboard className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Interactive",
        keywords: ["panel", "demo", "sandbox", "theme", "accent", "color", "deploy"],
        shortcut: ["D"],
      },
      {
        id: "cmd-capabilities",
        label: "Architecture and resource footprint",
        icon: <Cpu className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Sections",
        keywords: ["ram", "rust", "benchmark", "metrics"],
        shortcut: ["1"],
      },
      {
        id: "cmd-tour",
        label: "Inspect all 8 dashboard screens",
        icon: <Layers className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Sections",
        keywords: ["screenshots", "ui", "overview", "websites", "postgres"],
        shortcut: ["2"],
      },
      {
        id: "cmd-comparison",
        label: "Compare against Coolify, Dokku, and Pterodactyl",
        icon: <Scale className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Evaluation",
        keywords: ["pros", "cons", "coolify", "dokku", "pterodactyl"],
        shortcut: ["3"],
      },
      {
        id: "cmd-install",
        label: "Install commands and .env reference",
        icon: <Terminal className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Documentation",
        keywords: ["start.sh", "cargo", "windows", "env", "postgres"],
        shortcut: ["4"],
      },
      {
        id: "cmd-github",
        label: "Open ded-lmfao/WebDep on GitHub",
        icon: <Database className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "External",
        keywords: ["repo", "source", "releases"],
        href: GITHUB_REPO_URL,
      },
    ],
    []
  );

  const handleSelectCommand = (item: CommandItem) => {
    setCommandOpen(false);
    if (item.id === "cmd-demo") {
      onOpenDemo();
      return;
    }
    const map: Record<string, string> = {
      "cmd-capabilities": "capabilities",
      "cmd-tour": "panel-tour",
      "cmd-comparison": "comparison",
      "cmd-install": "install",
    };
    const target = map[item.id];
    if (target) {
      onJumpToSection(target);
      return;
    }
    if (item.href) {
      window.open(item.href, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <a
            className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="#top"
          >
            <img
              alt="WebDep"
              className="size-7 rounded-md border border-border bg-card object-cover"
              decoding="async"
              height={28}
              src="./images/logo.png"
              width={28}
            />
            <span className="text-base font-medium tracking-tight text-foreground">
              WebDep
            </span>
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden items-center gap-1 md:flex"
          >
            {NAV_LINKS.map((item) => (
              <button
                key={item.target}
                className="rounded-lg px-3 py-1.5 text-sm font-normal text-muted-foreground transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={() => onJumpToSection(item.target)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              className="hidden h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-xs font-medium text-foreground transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-foreground/25 hover:bg-card sm:inline-flex"
              type="button"
              onClick={onOpenDemo}
              onFocus={() => void import("@/components/PanelDemo")}
              onMouseEnter={() => void import("@/components/PanelDemo")}
            >
              <LayoutDashboard className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
              Live demo
            </button>

            <CommandButton
              className="hidden sm:inline-flex"
              global
              shortcut="mod+k"
              onClick={() => setCommandOpen(true)}
            >
              Quick jump
            </CommandButton>

            <SwitchButton
              aria-label="Toggle color theme"
              showLabel={false}
              size="sm"
              theme={theme}
              onThemeChange={onThemeChange}
            />

            <Link
              className="hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-normal text-muted-foreground transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-foreground lg:inline-flex"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
              <ArrowUpRight className="size-4" strokeWidth={1.5} />
            </Link>

            <Button
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              className="md:hidden"
              isIconOnly
              size="sm"
              variant="outline"
              onPress={() => setMobileMenuOpen((prev) => !prev)}
            >
              {mobileMenuOpen ? (
                <X className="size-4" strokeWidth={1.5} />
              ) : (
                <Menu className="size-4" strokeWidth={1.5} />
              )}
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="border-t border-border bg-card px-6 py-4 md:hidden"
              exit={{ opacity: 0, y: -6 }}
              initial={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex flex-col gap-1">
                {NAV_LINKS.map((item) => (
                  <button
                    key={item.target}
                    className="flex h-9 items-center rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onJumpToSection(item.target);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                <div className="mt-2 flex items-center gap-2 border-t border-border pt-3">
                  <button
                    className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onOpenDemo();
                    }}
                  >
                    <LayoutDashboard className="size-4" strokeWidth={1.5} />
                    Live demo
                  </button>
                  <button
                    className="flex h-9 items-center justify-center rounded-lg border border-border bg-secondary px-3 text-sm font-medium text-foreground"
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setCommandOpen(true);
                    }}
                  >
                    Quick jump
                  </button>
                  <Link
                    className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
                    href={GITHUB_REPO_URL}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    GitHub
                    <ArrowUpRight className="size-4" strokeWidth={1.5} />
                  </Link>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <AnimatePresence>
        {commandOpen && (
          <motion.div
            animate={{ opacity: 1 }}
            aria-label="Quick jump search"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-20 backdrop-blur-sm sm:pt-24"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="dialog"
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => setCommandOpen(false)}
          >
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="w-full max-w-lg"
              exit={{ opacity: 0, scale: 0.98, y: -6 }}
              initial={{ opacity: 0, scale: 0.97, y: -8 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <ActionSearchBar
                autoFocus
                defaultOpen
                inline
                items={commandItems}
                label="Search sections, guides, and benchmarks"
                placeholder="Search sections or references"
                shortcut={false}
                onOpenChange={(open) => {
                  if (!open) setCommandOpen(false);
                }}
                onSelect={(item) => handleSelectCommand(item)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
