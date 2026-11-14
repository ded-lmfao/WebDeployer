import { useMemo, useState } from "react";
import { Modal } from "@heroui/react";
import {
  Activity,
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

export default function PanelTourSection() {
  const [selectedId, setSelectedId] = useState<string>(PANEL_SCREENS[0].id);
  const [lightboxScreen, setLightboxScreen] = useState<PanelScreen | null>(null);

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
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-medium tracking-[-0.02em] text-foreground sm:text-4xl">
              Eight screens compiled inside the binary
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              Every view — from host metrics and SSE builds to isolated pg_ctl
              databases and Monaco editing — ships embedded via RustEmbed with
              no external Node server.
            </p>
          </div>
          <p className="font-mono text-xs text-muted-subtle tabular-nums">
            Screen {selectedIndex} / {PANEL_SCREENS.length}
          </p>
        </div>

        <div className="mt-10">
          <SmoothTab
            activeColor="bg-primary"
            activeTextColor="text-primary-foreground"
            className="w-full"
            items={tabItems}
            label="WebDep Dashboard Screens"
            value={selectedId}
            onChange={setSelectedId}
          />
        </div>
      </div>

      <Modal
        isOpen={Boolean(lightboxScreen)}
        onOpenChange={(open) => {
          if (!open) setLightboxScreen(null);
        }}
      >
        <Modal.Backdrop isDismissable>
          <Modal.Container placement="center" size="cover">
            <Modal.Dialog className="max-w-5xl rounded-2xl border border-border bg-card text-foreground">
              {lightboxScreen && (
                <>
                  <Modal.Header className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div>
                      <Modal.Heading className="text-base font-medium text-foreground">
                        {lightboxScreen.title}
                      </Modal.Heading>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {lightboxScreen.subtitle}
                      </p>
                    </div>
                    <Modal.CloseTrigger />
                  </Modal.Header>
                  <Modal.Body className="p-4">
                    <div className="overflow-hidden rounded-lg border border-border bg-[#07080d]">
                      <img
                        alt={lightboxScreen.title}
                        className="max-h-[78vh] w-full object-contain"
                        src={lightboxScreen.image}
                      />
                    </div>
                  </Modal.Body>
                </>
              )}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}
