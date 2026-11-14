import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  Database,
  FolderOpen,
  Globe,
  KeyRound,
  Maximize2,
  Server,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import SmoothTab, { type SwipeTabItem } from "@/components/kokonutui/smooth-tab";
import { PANEL_SCREENS, type PanelScreen } from "@/data/webdepData";

interface PanelTourSectionProps {
  onOpenDemo: () => void;
}

const SCREEN_ICONS = {
  overview: Activity,
  websites: Globe,
  services: Server,
  databases: Database,
  workspace: TerminalSquare,
  files: FolderOpen,
  settings: Settings2,
  login: KeyRound,
} as const;

export default function PanelTourSection({ onOpenDemo }: PanelTourSectionProps) {
  const [selectedId, setSelectedId] = useState<string>(PANEL_SCREENS[0].id);
  const [lightboxScreen, setLightboxScreen] = useState<PanelScreen | null>(null);

  useEffect(() => {
    if (!lightboxScreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightboxScreen(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxScreen]);

  const selectedIndex =
    PANEL_SCREENS.findIndex((s) => s.id === selectedId) + 1 || 1;

  const tabItems = useMemo<SwipeTabItem[]>(
    () =>
      PANEL_SCREENS.map((screen) => ({
        id: screen.id,
        title: screen.title.split(" ")[0],
        icon: SCREEN_ICONS[screen.id as keyof typeof SCREEN_ICONS] ?? Activity,
        content: (
          <div className="grid items-stretch lg:grid-cols-12">
            <div className="flex min-w-0 flex-col justify-between p-6 lg:col-span-5">
              <div>
                <span className="font-mono text-xs text-muted-subtle">
                  /{screen.id}
                </span>
                <h3 className="mt-2 text-2xl font-medium tracking-[-0.015em] text-foreground">
                  {screen.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {screen.subtitle}
                </p>

                <ul className="mt-6 space-y-2.5 border-t border-border pt-5 text-sm text-foreground">
                  {screen.highlights.map((point) => (
                    <li key={point} className="leading-relaxed">
                      {point}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                <span className="font-mono text-xs text-muted-subtle">
                  {screen.image.replace("./images/", "")}
                </span>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => setLightboxScreen(screen)}
                >
                  <Maximize2 className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  Expand
                </button>
              </div>
            </div>

            <div className="min-w-0 border-t border-border bg-surface-deep/50 p-3 sm:p-4 lg:col-span-7 lg:border-t-0 lg:border-l">
              <button
                aria-label={`Expand ${screen.title} screenshot`}
                className="group relative block w-full overflow-hidden rounded-lg border border-border bg-[#07080d] text-left transition-colors duration-150 hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={() => setLightboxScreen(screen)}
              >
                <img
                  alt={`${screen.title} view inside WebDep dashboard`}
                  className="block aspect-16/10 w-full object-cover object-top"
                  decoding="async"
                  loading="lazy"
                  src={screen.image}
                />
                <span className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-[#07080d]/85 px-2.5 py-1 font-mono text-xs text-[#eef0f5] transition-colors group-hover:border-white/30">
                  <Maximize2 className="size-3.5" strokeWidth={1.5} />
                  Full screen
                </span>
              </button>
            </div>
          </div>
        ),
      })),
    []
  );

  return (
    <section
      id="panel-tour"
      className="border-b border-border bg-surface-deep/40 py-20 lg:py-24"
    >
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
          initial={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          viewport={{ once: true, margin: "-40px" }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          <div className="max-w-2xl">
            <h2 className="text-3xl font-medium tracking-[-0.02em] text-foreground sm:text-4xl">
              Eight screens compiled inside the binary
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              Every view — from host telemetry and SSE builds to isolated pg_ctl
              databases and in-browser file editing — ships embedded via RustEmbed
              with no external Node server.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <p className="font-mono text-xs text-muted-subtle tabular-nums">
              Screen {selectedIndex} / {PANEL_SCREENS.length}
            </p>
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-primary/90"
              type="button"
              onClick={onOpenDemo}
              onFocus={() => void import("@/components/PanelDemo")}
              onMouseEnter={() => void import("@/components/PanelDemo")}
            >
              Open live panel demo
              <ArrowUpRight className="size-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </motion.div>

        <motion.div
          className="mt-10"
          initial={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.4, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
          viewport={{ once: true, margin: "-40px" }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          <SmoothTab
            activeColor="bg-primary"
            activeTextColor="text-primary-foreground"
            className="w-full"
            items={tabItems}
            label="WebDep Dashboard Screens"
            value={selectedId}
            onChange={setSelectedId}
          />
        </motion.div>
      </div>

      <AnimatePresence>
        {lightboxScreen && (
          <motion.div
            animate={{ opacity: 1 }}
            aria-label={`${lightboxScreen.title} screenshot`}
            aria-modal="true"
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85 p-4 backdrop-blur-sm sm:p-8"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            role="dialog"
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => setLightboxScreen(null)}
          >
            <motion.img
              alt={lightboxScreen.title}
              animate={{ opacity: 1, scale: 1 }}
              className="max-h-[90vh] max-w-[92vw] cursor-default rounded-xl border border-white/10 bg-[#07080d] object-contain shadow-2xl"
              decoding="async"
              exit={{ opacity: 0, scale: 0.97 }}
              initial={{ opacity: 0, scale: 0.97 }}
              src={lightboxScreen.image}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
