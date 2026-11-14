import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, Check, Play, RotateCcw } from "lucide-react";
import { PIPELINE_STAGES, TELEMETRY_STRIP } from "@/data/webdepData";
import { cn } from "@/lib/utils";

interface HeroSectionProps {
  onJumpToSection: (sectionId: string) => void;
}

type ConsoleView = "pipeline" | "preview";

export default function HeroSection({ onJumpToSection }: HeroSectionProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [deployCount, setDeployCount] = useState(184);
  const [activeView, setActiveView] = useState<ConsoleView>("pipeline");
  const timerRef = useRef<number | null>(null);

  const currentStage = PIPELINE_STAGES[stageIndex];
  const progressPct = Math.round(
    ((stageIndex + 1) / PIPELINE_STAGES.length) * 100
  );

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
    setActiveView("pipeline");
    setDeployCount((c) => c + 1);
    setStageIndex(0);
    setRunning(true);
    stepNext(0);
  };

  const visibleLogs = PIPELINE_STAGES.slice(0, stageIndex + 1).flatMap(
    (s) => s.logs
  );

  return (
    <section id="top" className="border-b border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 pt-16 pb-16 lg:pt-20 lg:pb-20">
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="min-w-0 lg:col-span-5"
            initial={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mb-5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-positive"
              />
              <span>Linux &amp; Windows · Single Rust binary</span>
            </div>

            <h1 className="text-4xl font-medium tracking-[-0.025em] text-foreground sm:text-5xl lg:text-[3.25rem] lg:leading-[1.06]">
              Native VPS deployment in ~20 MB RAM
            </h1>

            <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground sm:text-lg">
              WebDep turns a Linux or Windows server into a single-binary control
              plane for websites, 24/7 workers, and isolated PostgreSQL clusters
              without Docker.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={() => onJumpToSection("install")}
              >
                Install WebDep
              </button>

              <button
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-secondary px-5 text-sm font-medium text-foreground transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-muted/80 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={() => onJumpToSection("comparison")}
              >
                Compare platforms
                <ArrowRight className="size-4 text-muted-foreground" strokeWidth={1.5} />
              </button>
            </div>
          </motion.div>

          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="min-w-0 lg:col-span-7"
            id="hero-pipeline"
            initial={{ opacity: 0, y: 12 }}
            transition={{
              duration: 0.45,
              delay: 0.06,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              {/* Window chrome */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-deep/70 px-4 py-3">
                <div className="flex items-center gap-2.5 font-mono text-xs text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-positive"
                  />
                  <span className="text-foreground">:3000</span>
                  <span>·</span>
                  <span>deploy#{deployCount}</span>
                </div>

                <div className="flex items-center gap-2">
                  <div
                    aria-label="Hero product view"
                    className="inline-flex rounded-lg border border-border bg-background p-0.5"
                    role="tablist"
                  >
                    <button
                      aria-selected={activeView === "pipeline"}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
                        activeView === "pipeline"
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      role="tab"
                      type="button"
                      onClick={() => setActiveView("pipeline")}
                    >
                      Deploy trace
                    </button>
                    <button
                      aria-selected={activeView === "preview"}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
                        activeView === "preview"
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      role="tab"
                      type="button"
                      onClick={() => setActiveView("preview")}
                    >
                      Overview UI
                    </button>
                  </div>

                  {activeView === "pipeline" && (
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98]"
                      type="button"
                      onClick={handleRunSimulation}
                    >
                      {running ? (
                        <>
                          <RotateCcw className="size-3.5" strokeWidth={1.5} />
                          Restart
                        </>
                      ) : (
                        <>
                          <Play className="size-3.5" strokeWidth={1.5} />
                          Run deploy
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {activeView === "pipeline" ? (
                <div className="space-y-4 p-4 sm:p-5">
                  {/* Live status & progress */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-4 text-xs">
                      <span className="font-medium text-foreground">
                        {currentStage.label}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {currentStage.summary}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                        {currentStage.step}/{PIPELINE_STAGES.length}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-brand-accent transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>

                  {/* 7-stage selector */}
                  <div className="flex flex-wrap gap-1.5">
                    {PIPELINE_STAGES.map((stage, idx) => {
                      const active = idx === stageIndex;
                      const done =
                        idx < stageIndex ||
                        (!running && stageIndex === PIPELINE_STAGES.length - 1);
                      return (
                        <button
                          key={stage.id}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors duration-150",
                            active
                              ? "border-brand-accent bg-brand-accent/12 text-brand-accent"
                              : done
                                ? "border-border bg-secondary/60 text-foreground"
                                : "border-border bg-background text-muted-foreground hover:text-foreground"
                          )}
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
                            <Check
                              className="size-3.5 text-positive"
                              strokeWidth={1.5}
                            />
                          )}
                          <span>
                            {stage.step}. {stage.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* SSE terminal output */}
                  <div className="rounded-xl border border-border bg-[#07080d] p-4 font-mono text-xs text-[#eef0f5]">
                    <div className="mb-2.5 flex items-center justify-between border-b border-white/8 pb-2 text-[#7a8296]">
                      <span>
                        SSE /api/projects/billing-api/deploys/{deployCount}/logs
                      </span>
                      <span className="tabular-nums">
                        {running
                          ? "streaming"
                          : stageIndex === PIPELINE_STAGES.length - 1
                            ? "200 OK"
                            : "ready"}
                      </span>
                    </div>
                    <div className="h-52 space-y-1.5 overflow-y-auto pr-1 leading-relaxed">
                      <AnimatePresence initial={false}>
                        {visibleLogs.map((line) => (
                          <motion.div
                            key={line}
                            animate={{ opacity: 1, y: 0 }}
                            className="text-[#a3a9b8]"
                            initial={{ opacity: 0, y: 4 }}
                            transition={{
                              duration: 0.16,
                              ease: [0.22, 1, 0.36, 1],
                            }}
                          >
                            {line}
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3 sm:p-4">
                  <div className="overflow-hidden rounded-lg border border-border bg-[#07080d]">
                    <img
                      alt="WebDep Overview dashboard showing host telemetry, active workloads, and memory usage"
                      className="block aspect-16/10 w-full object-cover object-top"
                      loading="eager"
                      src="./images/overview.png"
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between px-1 text-xs text-muted-foreground">
                    <span className="font-mono">overview.png · embedded control plane</span>
                    <button
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                      type="button"
                      onClick={() => onJumpToSection("panel-tour")}
                    >
                      Inspect all 8 screens
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </div>

        {/* Baseline telemetry strip */}
        <div className="mt-14 grid grid-cols-2 gap-6 border-t border-border pt-8 lg:grid-cols-4">
          {TELEMETRY_STRIP.map((metric) => (
            <div key={metric.id} className="min-w-0">
              <p className="text-xs text-muted-foreground">{metric.label}</p>
              <p className="mt-1.5 font-mono text-2xl font-medium text-foreground tabular-nums">
                {metric.value}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-subtle">
                {metric.detail}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
