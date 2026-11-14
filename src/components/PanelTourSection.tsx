import { useMemo, useState } from "react";
import { Button, Card, Chip, Modal } from "@heroui/react";
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

  const tabItems = useMemo<SwipeTabItem[]>(
    () =>
      PANEL_SCREENS.map((screen) => ({
        id: screen.id,
        title: screen.title.split(" ")[0],
        icon: SCREEN_ICONS[screen.id as keyof typeof SCREEN_ICONS] ?? Activity,
        content: (
          <Card className="overflow-hidden border border-border bg-card shadow-lg">
            <div className="grid items-stretch lg:grid-cols-12">
              <div className="flex min-w-0 flex-col justify-between p-6 lg:col-span-5">
                <div>
                  <span className="font-mono text-xs uppercase tracking-wider text-[#2563eb] dark:text-[#4f8ef7]">
                    Screen · {screen.id}
                  </span>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                    {screen.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {screen.subtitle}
                  </p>

                  <ul className="mt-6 space-y-2.5 border-t border-border pt-5 text-sm text-foreground">
                    {screen.highlights.map((point) => (
                      <li key={point} className="flex items-start gap-2.5">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#2563eb] dark:bg-[#4f8ef7]" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                  <span className="font-mono text-xs text-muted-foreground">
                    {screen.image}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => setLightboxScreen(screen)}
                  >
                    <Maximize2 className="size-3.5" strokeWidth={1.75} />
                    Expand screenshot
                  </Button>
                </div>
              </div>

              <div className="min-w-0 border-t border-border bg-muted/30 p-3 sm:p-5 lg:col-span-7 lg:border-t-0 lg:border-l">
                <button
                  aria-label={`Expand ${screen.title} screenshot`}
                  className="group relative block w-full overflow-hidden rounded-lg border border-border bg-[#07080d] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onClick={() => setLightboxScreen(screen)}
                >
                  <img
                    alt={`${screen.title} view inside WebDep dashboard`}
                    className="block aspect-16/10 w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.01]"
                    loading="lazy"
                    src={screen.image}
                  />
                  <span className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/75 px-2.5 py-1 font-mono text-[11px] text-white opacity-90 transition-opacity group-hover:opacity-100">
                    <Maximize2 className="size-3" strokeWidth={1.75} />
                    Inspect full screen
                  </span>
                </button>
              </div>
            </div>
          </Card>
        ),
      })),
    []
  );

  return (
    <section
      id="panel-tour"
      className="border-b border-border bg-muted/20 py-20 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <Chip color="accent" variant="soft">
              <Chip.Label className="font-mono text-xs">
                Embedded Control Plane UI
              </Chip.Label>
            </Chip>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Explore all 8 screens compiled inside the binary.
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              Every view — from host metrics and SSE builds to isolated pg_ctl
              databases and Monaco editing — is embedded via RustEmbed with zero
              external Node server.
            </p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            Click tabs or swipe horizontally
          </p>
        </div>

        <div className="mt-10">
          <SmoothTab
            activeColor="bg-[#2563eb] dark:bg-[#4f8ef7]"
            activeTextColor="text-white dark:text-[#07080d]"
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
            <Modal.Dialog className="max-w-5xl border border-border bg-card text-foreground shadow-2xl">
              {lightboxScreen && (
                <>
                  <Modal.Header className="flex items-center justify-between border-b border-border px-5 py-3.5">
                    <div>
                      <Modal.Heading className="text-base font-semibold text-foreground">
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
