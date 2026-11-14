import { motion } from "motion/react";
import {
  Activity,
  Cpu,
  Database,
  FolderGit2,
  Globe,
  ShieldCheck,
} from "lucide-react";
import UptimeCard, {
  type UptimeService,
} from "@/components/kokonutui/uptime-card";
import {
  CAPABILITIES,
  RAM_FOOTPRINT_BENCHMARKS,
  type CapabilityItem,
} from "@/data/webdepData";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<CapabilityItem["iconName"], typeof Globe> = {
  globe: Globe,
  cpu: Cpu,
  database: Database,
  shield: ShieldCheck,
  folder: FolderGit2,
  activity: Activity,
};

const SUPERVISED_SERVICES: UptimeService[] = [
  {
    name: "webdep-control-plane (:3000)",
    incidents: {},
  },
  {
    name: "caddy-tls-router (:443)",
    incidents: {
      11: {
        status: "degraded",
        title: "Config reload on domain sync",
        minutes: 1,
        updates: [
          {
            time: "02:14 UTC",
            label: "Caddy Admin API updated",
            note: "Zero-drop route refresh for billing.example.com",
          },
        ],
      },
    },
  },
  {
    name: "pg_ctl-cluster-main (:5433)",
    incidents: {},
  },
];

const MAX_MB = 800;

export default function CapabilitiesBento() {
  return (
    <section
      id="capabilities"
      className="border-b border-border bg-background py-20 lg:py-24"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-medium tracking-[-0.02em] text-foreground sm:text-4xl">
            Everything needed to run a VPS without runtime bloat
          </h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            One self-contained Axum, Tokio, and SQLite WAL binary replaces
            shell scripts, PM2 wrappers, separate FTP daemons, and container
            stacks.
          </p>
        </div>

        {/* Data moments: proportional RAM chart + 30-day supervisor trace */}
        <div className="mt-10 grid items-stretch gap-6 lg:grid-cols-12">
          <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-6 lg:col-span-5">
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-base font-medium text-foreground">
                  Control-plane RAM footprint
                </h3>
                <span className="font-mono text-xs text-muted-subtle tabular-nums">
                  Idle / typical MB
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Midpoint RSS comparison against Docker and PHP panels
              </p>

              <div className="mt-6 space-y-4">
                {RAM_FOOTPRINT_BENCHMARKS.map((item) => {
                  const widthPct = Math.max(
                    3,
                    Math.min(100, (item.mb / MAX_MB) * 100)
                  );
                  return (
                    <div key={item.id} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span
                          className={cn(
                            "font-medium",
                            item.highlight
                              ? "text-foreground"
                              : "text-muted-foreground"
                          )}
                        >
                          {item.label}
                        </span>
                        <span
                          className={cn(
                            "font-mono tabular-nums",
                            item.highlight
                              ? "text-brand-accent"
                              : "text-muted-foreground"
                          )}
                        >
                          {item.displayValue}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-sm bg-secondary">
                        <div
                          className={cn(
                            "h-full rounded-sm transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                            item.highlight
                              ? "bg-brand-accent"
                              : "bg-foreground/20"
                          )}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <p className="font-mono text-xs text-muted-subtle">
                        {item.stack}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-6 flex justify-between border-t border-border pt-3 font-mono text-xs text-muted-subtle tabular-nums">
              <span>0 MB</span>
              <span>250 MB</span>
              <span>500 MB</span>
              <span>750 MB+</span>
            </div>
          </div>

          <div className="min-w-0 lg:col-span-7">
            <UptimeCard
              className="h-full"
              days={30}
              services={SUPERVISED_SERVICES}
              title="Process supervisor trace"
            />
          </div>
        </div>

        {/* Capabilities hairline matrix */}
        <motion.div
          className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3"
          initial={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          viewport={{ once: true, margin: "-40px" }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          {CAPABILITIES.map((cap) => {
            const Icon = ICON_MAP[cap.iconName];
            return (
              <div
                key={cap.id}
                className="flex flex-col justify-between bg-card p-6"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <Icon
                      className="size-4 text-muted-foreground"
                      strokeWidth={1.5}
                    />
                    <span className="font-mono text-xs text-muted-subtle">
                      {cap.eyebrow}
                    </span>
                  </div>

                  <h3 className="mt-4 text-base font-medium text-foreground">
                    {cap.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {cap.summary}
                  </p>
                </div>

                <ul className="mt-5 space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                  {cap.specs.map((spec) => (
                    <li key={spec} className="leading-relaxed">
                      {spec}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
