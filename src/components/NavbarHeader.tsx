import { useMemo, useState } from "react";
import {
  Button,
  Chip,
  Link,
  Modal,
  Surface,
} from "@heroui/react";
import {
  ArrowUpRight,
  Cpu,
  Database,
  GitBranch,
  Layers,
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
}

const NAV_LINKS = [
  { label: "Features", target: "capabilities" },
  { label: "Panel Tour", target: "panel-tour" },
  { label: "Comparison", target: "comparison" },
  { label: "Docs & Install", target: "install" },
];

export default function NavbarHeader({
  theme,
  onThemeChange,
  onJumpToSection,
}: NavbarHeaderProps) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const commandItems = useMemo<CommandItem[]>(
    () => [
      {
        id: "cmd-pipeline",
        label: "Simulate 7-Stage Deploy Pipeline",
        icon: <GitBranch className="size-4 text-[#4f8ef7]" />,
        group: "Interactive",
        keywords: ["deploy", "pipeline", "simulate", "sse"],
        shortcut: ["1"],
      },
      {
        id: "cmd-capabilities",
        label: "Explore Architecture & Telemetry",
        icon: <Cpu className="size-4 text-emerald-500" />,
        group: "Sections",
        keywords: ["ram", "rust", "benchmark", "metrics"],
        shortcut: ["2"],
      },
      {
        id: "cmd-tour",
        label: "Inspect All 8 Dashboard Screens",
        icon: <Layers className="size-4 text-sky-500" />,
        group: "Sections",
        keywords: ["screenshots", "ui", "overview", "websites", "postgres"],
        shortcut: ["3"],
      },
      {
        id: "cmd-comparison",
        label: "Compare vs Coolify, Dokku & Pterodactyl",
        icon: <Scale className="size-4 text-amber-500" />,
        group: "Evaluation",
        keywords: ["pros", "cons", "coolify", "dokku", "pterodactyl"],
        shortcut: ["4"],
      },
      {
        id: "cmd-install",
        label: "Install Commands & .env Reference",
        icon: <Terminal className="size-4 text-zinc-400" />,
        group: "Documentation",
        keywords: ["start.sh", "cargo", "windows", "env", "postgres"],
        shortcut: ["5"],
      },
      {
        id: "cmd-github",
        label: "Open ded-lmfao/WebDep on GitHub",
        icon: <Database className="size-4 text-zinc-400" />,
        group: "External",
        keywords: ["repo", "source", "releases"],
        href: GITHUB_REPO_URL,
      },
    ],
    []
  );

  const handleSelectCommand = (item: CommandItem) => {
    setCommandOpen(false);
    const map: Record<string, string> = {
      "cmd-pipeline": "hero-pipeline",
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
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <a
              className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href="#top"
            >
              <img
                alt="WebDep Logo"
                className="size-8 rounded-lg border border-border bg-card object-cover"
                src="./images/logo.png"
              />
              <span className="font-semibold text-base tracking-tight text-foreground">
                WebDep
              </span>
            </a>
            <Chip className="hidden sm:inline-flex" color="accent" variant="soft">
              <Chip.Label className="font-mono text-[11px]">v2.0.4 · Rust</Chip.Label>
            </Chip>
          </div>

          <nav
            aria-label="Primary navigation"
            className="hidden items-center gap-1 md:flex"
          >
            {NAV_LINKS.map((item) => (
              <Button
                key={item.target}
                className="text-sm font-medium text-muted-foreground hover:text-foreground"
                size="sm"
                variant="ghost"
                onPress={() => onJumpToSection(item.target)}
              >
                {item.label}
              </Button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <CommandButton
              className="hidden sm:inline-flex"
              global
              shortcut="mod+k"
              onClick={() => setCommandOpen(true)}
            >
              Quick Jump
            </CommandButton>

            <SwitchButton
              aria-label="Toggle color theme"
              showLabel={false}
              size="sm"
              theme={theme}
              onThemeChange={onThemeChange}
            />

            <Link
              className="hidden h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted lg:inline-flex"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
              <ArrowUpRight className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
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
                <X className="size-4" strokeWidth={1.75} />
              ) : (
                <Menu className="size-4" strokeWidth={1.75} />
              )}
            </Button>
          </div>
        </div>

        {mobileMenuOpen && (
          <Surface
            className="border-t border-border px-4 py-3 md:hidden"
            variant="secondary"
          >
            <div className="flex flex-col gap-1">
              {NAV_LINKS.map((item) => (
                <Button
                  key={item.target}
                  className="justify-start text-sm"
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setMobileMenuOpen(false);
                    onJumpToSection(item.target);
                  }}
                >
                  {item.label}
                </Button>
              ))}
              <div className="mt-2 flex items-center gap-2 pt-2 border-t border-border">
                <Button
                  className="flex-1"
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setMobileMenuOpen(false);
                    setCommandOpen(true);
                  }}
                >
                  Quick Jump (Ctrl+K)
                </Button>
                <Link
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground"
                  href={GITHUB_REPO_URL}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  GitHub
                  <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
                </Link>
              </div>
            </div>
          </Surface>
        )}
      </header>

      <Modal isOpen={commandOpen} onOpenChange={setCommandOpen}>
        <Modal.Backdrop isDismissable>
          <Modal.Container placement="top" size="lg">
            <Modal.Dialog className="mt-12 border border-border bg-card text-foreground shadow-2xl">
              <Modal.Header className="flex items-center justify-between border-b border-border px-4 py-3">
                <Modal.Heading className="text-sm font-medium text-foreground">
                  Jump to section or reference
                </Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body className="p-3">
                <ActionSearchBar
                  defaultOpen
                  items={commandItems}
                  label="Search sections, guides, and benchmarks"
                  placeholder="Jump to pipeline, Coolify comparison, .env..."
                  shortcut={false}
                  onSelect={(item) => handleSelectCommand(item)}
                />
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
