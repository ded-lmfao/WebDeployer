import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import HeroWebDepSvg from "@/components/HeroWebDepSvg";
import { TELEMETRY_STRIP } from "@/data/webdepData";

interface HeroSectionProps {
  onJumpToSection: (sectionId: string) => void;
  onOpenDemo: () => void;
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export default function HeroSection({
  onJumpToSection,
  onOpenDemo,
}: HeroSectionProps) {
  return (
    <section id="top" className="border-b border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 pt-16 pb-16 lg:pt-20 lg:pb-20">
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="min-w-0 lg:col-span-5">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="mb-5 flex items-center gap-2 font-mono text-xs text-muted-foreground"
              initial={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.34, ease: EASE_OUT }}
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-positive"
              />
              <span>Linux &amp; Windows · Single Rust binary</span>
            </motion.div>

            <motion.h1
              animate={{ opacity: 1, y: 0 }}
              className="text-4xl font-medium tracking-[-0.025em] text-foreground sm:text-5xl lg:text-[3.25rem] lg:leading-[1.06]"
              initial={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.38, delay: 0.04, ease: EASE_OUT }}
            >
              Native VPS control plane in ~20 MB RAM
            </motion.h1>

            <motion.p
              animate={{ opacity: 1, y: 0 }}
              className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground sm:text-lg"
              initial={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.38, delay: 0.08, ease: EASE_OUT }}
            >
              WebDep turns a Linux or Windows server into a single-binary control
              plane for websites, 24/7 workers, and isolated PostgreSQL clusters
              without Docker.
            </motion.p>

            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="mt-8 flex flex-wrap items-center gap-3"
              initial={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.38, delay: 0.12, ease: EASE_OUT }}
            >
              <button
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={() => onJumpToSection("install")}
              >
                Install WebDep
              </button>

              <button
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-secondary px-5 text-sm font-medium text-foreground transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-foreground/20 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onClick={onOpenDemo}
                onFocus={() => void import("@/components/PanelDemo")}
                onMouseEnter={() => void import("@/components/PanelDemo")}
              >
                Launch live demo
                <ArrowRight className="size-4 text-muted-foreground" strokeWidth={1.5} />
              </button>
            </motion.div>
          </div>

          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="min-w-0 lg:col-span-7"
            initial={{ opacity: 0, y: 12 }}
            transition={{
              duration: 0.44,
              delay: 0.08,
              ease: EASE_OUT,
            }}
          >
            <HeroWebDepSvg />
          </motion.div>
        </div>

        {/* Baseline telemetry strip */}
        <div className="mt-14 grid grid-cols-2 gap-6 border-t border-border pt-8 lg:grid-cols-4">
          {TELEMETRY_STRIP.map((metric, idx) => (
            <motion.div
              key={metric.id}
              animate={{ opacity: 1, y: 0 }}
              className="min-w-0"
              initial={{ opacity: 0, y: 8 }}
              transition={{
                duration: 0.34,
                delay: 0.14 + idx * 0.04,
                ease: EASE_OUT,
              }}
            >
              <p className="text-xs text-muted-foreground">{metric.label}</p>
              <p className="mt-1.5 font-mono text-2xl font-medium text-foreground tabular-nums">
                {metric.value}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-subtle">
                {metric.detail}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
