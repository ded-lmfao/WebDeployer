import { useMemo, useState } from "react";
import { Button, Link, Modal } from "@heroui/react";
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
  { label: "Panel tour", target: "panel-tour" },
  { label: "Comparison", target: "comparison" },
  { label: "Install", target: "install" },
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
        label: "Simulate 7-stage deploy pipeline",
        icon: <GitBranch className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Interactive",
        keywords: ["deploy", "pipeline", "simulate", "sse"],
        shortcut: ["1"],
      },
      {
        id: "cmd-capabilities",
        label: "Architecture and resource footprint",
        icon: <Cpu className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Sections",
        keywords: ["ram", "rust", "benchmark", "metrics"],
        shortcut: ["2"],
      },
      {
        id: "cmd-tour",
        label: "Inspect all 8 dashboard screens",
        icon: <Layers className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Sections",
        keywords: ["screenshots", "ui", "overview", "websites", "postgres"],
        shortcut: ["3"],
      },
      {
        id: "cmd-comparison",
        label: "Compare against Coolify, Dokku, and Pterodactyl",
        icon: <Scale className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Evaluation",
        keywords: ["pros", "cons", "coolify", "dokku", "pterodactyl"],
        shortcut: ["4"],
      },
      {
        id: "cmd-install",
        label: "Install commands and .env reference",
        icon: <Terminal className="size-4 text-muted-foreground" strokeWidth={1.5} />,
        group: "Documentation",
        keywords: ["start.sh", "cargo", "windows", "env", "postgres"],
        shortcut: ["5"],
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
      <header className="sticky top-0 z-40 w-full border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <a
            className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href="#top"
          >
            <img
              alt="WebDep"
              className="size-7 rounded-md border border-border bg-card object-cover"
              src="./images/logo.png"
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

        {mobileMenuOpen && (
          <div className="border-t border-border bg-card px-6 py-4 md:hidden">
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
                  className="flex h-9 flex-1 items-center justify-center rounded-lg border border-border bg-secondary px-3 text-sm font-medium text-foreground"
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
          </div>
        )}
      </header>

      <Modal isOpen={commandOpen} onOpenChange={setCommandOpen}>
        <Modal.Backdrop isDismissable>
          <Modal.Container placement="top" size="lg">
            <Modal.Dialog className="mt-12 rounded-2xl border border-border bg-card text-foreground">
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
                  placeholder="Search sections or references"
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
