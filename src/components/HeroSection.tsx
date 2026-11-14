import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button, Card, Chip } from "@heroui/react";
import {
  ArrowRight,
  CheckCircle2,
  Play,
  RotateCcw,
  Terminal,
} from "lucide-react";
import BackgroundPaths from "@/components/kokonutui/background-paths";
import ParticleButton from "@/components/kokonutui/particle-button";
import {
  StatusIsland,
  type IslandTask,
} from "@/components/kokonutui/status-island";
import {
  GITHUB_RELEASES_URL,
  PIPELINE_STAGES,
} from "@/data/webdepData";

interface HeroSectionProps {
  onJumpToSection: (sectionId: string) => void;
}

export default function HeroSection({ onJumpToSection }: HeroSectionProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [deployCount, setDeployCount] = useState(184);
  const timerRef = useRef<number | null>(null);

  const currentStage = PIPELINE_STAGES[stageIndex];

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const stepNext = (index: number) => {
    if (index >= PIPELINE_STAGES.length - 1) {
      setRunning(false);
      return;
    }
    const nextIndex = index + 1;
    timerRef.current = window.setTimeout(() => {
      setStageIndex(nextIndex);
      stepNext(nextIndex);
    }, PIPELINE_STAGES[index].durationMs);
  };

  const handleRunSimulation = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    setDeployCount((c) => c + 1);
    setStageIndex(0);
    setRunning(true);
    stepNext(0);
  };

  const islandTasks: IslandTask[] = [
    {
      id: "webdep-deploy",
      label: `deploy#${deployCount} · ${currentStage.label}`,
      detail: running
        ? `Stage ${currentStage.step}/${PIPELINE_STAGES.length} running`
        : stageIndex === PIPELINE_STAGES.length - 1
          ? "Health check passed -> LIVE"
          : "Ready to simulate SSE run",
      status:
        running
          ? "running"
          : stageIndex === PIPELINE_STAGES.length - 1
            ? "done"
            : "running",
      progress: Math.round(((stageIndex + 1) / PIPELINE_STAGES.length) * 100),
    },
  ];

  const visibleLogs = PIPELINE_STAGES.slice(0, stageIndex + 1).flatMap(
    (s) => s.logs
  );

  return (
    <section
      id="top"
      className="relative overflow-hidden border-b border-border bg-background"
    >
      <BackgroundPaths
        angle={-28}
        className="pointer-events-none absolute inset-0 min-h-0! bg-transparent! opacity-45 dark:opacity-55"
        count={16}
        interactive={false}
        speed={0.55}
        spread={0.9}
      >
        {null}
      </BackgroundPaths>

      <div className="relative z-10 mx-auto max-w-6xl px-4 pt-12 pb-18 sm:px-6 lg:pt-18 lg:pb-24">
        <div className="grid items-start gap-10 lg:grid-cols-12 lg:gap-8">
          <div className="min-w-0 lg:col-span-6">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              initial={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <Chip color="accent" variant="soft">
                  <Chip.Label className="font-mono text-xs">
                    Single ~10 MB Rust Binary
                  </Chip.Label>
                </Chip>
                <Chip color="default" variant="soft">
                  <Chip.Label className="font-mono text-xs">
                    Linux + Windows · Zero Docker Required
                  </Chip.Label>
                </Chip>
              </div>

              <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.25rem] lg:leading-[1.08]">
                Self-hosted PaaS speed in{" "}
                <span className="text-[#2563eb] dark:text-[#4f8ef7]">
                  ~20 MB RAM
                </span>
                .
              </h1>

              <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Turn any Linux VPS or Windows server into a crisp deployment
                control plane for websites, 24/7 background services, isolated
                PostgreSQL clusters, Caddy TLS routes, and browser workspace tools
                — with zero container daemon bloat.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <ParticleButton
                  className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] dark:bg-[#4f8ef7] dark:text-[#07080d] dark:hover:bg-[#6ca0fa]"
                  icon={<Terminal className="size-4" />}
                  size="lg"
                  onClick={() => onJumpToSection("install")}
                >
                  Quick Install (./start.sh)
                </ParticleButton>

                <Button
                  size="lg"
                  variant="outline"
                  onPress={() => onJumpToSection("comparison")}
                >
                  Compare vs Coolify & Dokku
                  <ArrowRight className="size-4" strokeWidth={1.75} />
                </Button>

                <a
                  className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  href={GITHUB_RELEASES_URL}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  GitHub Releases
                </a>
              </div>

              <div className="mt-10 grid grid-cols-3 gap-4 border-t border-border pt-6">
                <div>
                  <p className="font-mono text-xl font-semibold text-foreground">
                    ~18.4 MB
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Idle control-plane RSS
                  </p>
                </div>
                <div>
                  <p className="font-mono text-xl font-semibold text-foreground">
                    ~2.0 ms
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    /api/overview cold P50
                  </p>
                </div>
                <div>
                  <p className="font-mono text-xl font-semibold text-foreground">
                    7 stages
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Live SSE deploy trace
                  </p>
                </div>
              </div>
            </motion.div>
          </div>

          <div id="hero-pipeline" className="min-w-0 lg:col-span-6">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              initial={{ opacity: 0, y: 16 }}
              transition={{
                duration: 0.5,
                delay: 0.08,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <Card
                className="overflow-hidden border border-border bg-card shadow-xl"
                variant="default"
              >
                <Card.Header className="flex flex-col gap-3 border-b border-border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full bg-emerald-500" />
                    <Card.Title className="font-mono text-xs font-medium text-foreground">
                      live-deploy-simulator · sse-stream
                    </Card.Title>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={running ? "secondary" : "primary"}
                      onPress={handleRunSimulation}
                    >
                      {running ? (
                        <>
                          <RotateCcw className="size-3.5" strokeWidth={1.75} />
                          Restart Run
                        </>
                      ) : (
                        <>
                          <Play className="size-3.5" strokeWidth={1.75} />
                          Simulate Deploy
                        </>
                      )}
                    </Button>
                  </div>
                </Card.Header>

                <Card.Content className="space-y-4 p-4">
                  <div className="min-w-0 max-w-full overflow-hidden">
                    <StatusIsland className="w-full max-w-full" tasks={islandTasks} />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {PIPELINE_STAGES.map((stage, idx) => {
                      const active = idx === stageIndex;
                      const done = idx < stageIndex || (!running && stageIndex === PIPELINE_STAGES.length - 1);
                      return (
                        <button
                          key={stage.id}
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                            active
                              ? "border-[#2563eb] bg-[#2563eb]/12 text-[#2563eb] dark:border-[#4f8ef7] dark:bg-[#4f8ef7]/15 dark:text-[#4f8ef7]"
                              : done
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : "border-border bg-background text-muted-foreground hover:text-foreground"
                          }`}
                          type="button"
                          onClick={() => {
                            if (timerRef.current) {
                              window.clearTimeout(timerRef.current);
                            }
                            setRunning(false);
                            setStageIndex(idx);
                          }}
                        >
                          {done && !active && (
                            <CheckCircle2 className="size-3" strokeWidth={2} />
                          )}
                          <span>
                            {stage.step}. {stage.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="rounded-lg border border-border bg-[#07080d] p-3 font-mono text-xs text-[#e2e8f0]">
                    <div className="mb-2 flex items-center justify-between text-[11px] text-[#94a3b8]">
                      <span>SSE /api/projects/billing-api/deploys/{deployCount}/logs</span>
                      <span>
                        Stage {currentStage.step}/{PIPELINE_STAGES.length}
                      </span>
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                      <AnimatePresence initial={false}>
                        {visibleLogs.map((line) => (
                          <motion.div
                            key={line}
                            animate={{ opacity: 1, x: 0 }}
                            className="leading-relaxed text-zinc-300"
                            initial={{ opacity: 0, x: -6 }}
                            transition={{ duration: 0.18 }}
                          >
                            {line}
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-border bg-background">
                    <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                      <span>webdep · overview.png</span>
                      <button
                        className="text-[#2563eb] hover:underline dark:text-[#4f8ef7]"
                        type="button"
                        onClick={() => onJumpToSection("panel-tour")}
                      >
                        Inspect all 8 screens
                      </button>
                    </div>
                    <img
                      alt="WebDep Overview Dashboard showing host telemetry and active processes"
                      className="block aspect-16/10 w-full object-cover object-top"
                      loading="eager"
                      src="./images/overview.png"
                    />
                  </div>
                </Card.Content>
              </Card>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
