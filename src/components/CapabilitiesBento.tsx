import { motion } from "motion/react";
import { Card, Chip } from "@heroui/react";
import {
  Activity,
  Cpu,
  Database,
  FolderGit2,
  Globe,
  ShieldCheck,
} from "lucide-react";
import AppleActivityCard, {
  type ActivityData,
} from "@/components/kokonutui/apple-activity-card";
import UptimeCard, {
  type UptimeService,
} from "@/components/kokonutui/uptime-card";
import {
  CAPABILITIES,
  TELEMETRY_STRIP,
  type CapabilityItem,
} from "@/data/webdepData";

const ICON_MAP: Record<CapabilityItem["iconName"], typeof Globe> = {
  globe: Globe,
  cpu: Cpu,
  database: Database,
  shield: ShieldCheck,
  folder: FolderGit2,
  activity: Activity,
};

const WEBDEP_ACTIVITIES: ActivityData[] = [
  {
    label: "CONTROL PLANE RAM",
    color: "#2563eb",
    colorEnd: "#4f8ef7",
    size: 186,
    current: 23.7,
    target: 512,
    unit: "MB",
  },
  {
    label: "API COLD P50 SPEED",
    color: "#10b981",
    colorEnd: "#34d399",
    size: 142,
    current: 2.0,
    target: 116.4,
    unit: "ms",
  },
  {
    label: "BINARY FOOTPRINT",
    color: "#f59e0b",
    colorEnd: "#fbbf24",
    size: 98,
    current: 10,
    target: 100,
    unit: "MB",
  },
];

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

export default function CapabilitiesBento() {
  return (
    <section
      id="capabilities"
      className="border-b border-border bg-background py-20 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <Chip color="accent" variant="soft">
            <Chip.Label className="font-mono text-xs">
              Architecture & Capabilities
            </Chip.Label>
          </Chip>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Everything needed to run a VPS — engineered without runtime bloat.
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            One self-contained Axum + Tokio + SQLite WAL binary replaces fragile
            shell scripts, PM2 wrappers, separate FTP daemons, and heavy PaaS
            container stacks.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TELEMETRY_STRIP.map((metric, idx) => (
            <motion.div
              key={metric.id}
              initial={{ opacity: 0, y: 12 }}
              transition={{
                duration: 0.35,
                delay: idx * 0.05,
                ease: [0.22, 1, 0.36, 1],
              }}
              viewport={{ once: true, margin: "-40px" }}
              whileInView={{ opacity: 1, y: 0 }}
            >
              <Card className="h-full border border-border bg-card p-5">
                <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                  {metric.label}
                </p>
                <p className="mt-2 font-mono text-2xl font-semibold text-foreground">
                  {metric.value}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {metric.detail}
                </p>
              </Card>
            </motion.div>
          ))}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-12">
          <Card className="min-w-0 overflow-hidden border border-border bg-card p-2 lg:col-span-5">
            <AppleActivityCard
              activities={WEBDEP_ACTIVITIES}
              className="p-4 sm:p-6"
              title="Verified Resource Budget"
              titleAs="h3"
            />
          </Card>

          <div className="min-w-0 lg:col-span-7">
            <UptimeCard
              className="h-full border border-border bg-card"
              days={30}
              services={SUPERVISED_SERVICES}
              title="Simulated Process Supervisor Health (Click any day bar)"
            />
          </div>
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((cap, idx) => {
            const Icon = ICON_MAP[cap.iconName];
            return (
              <motion.div
                key={cap.id}
                initial={{ opacity: 0, y: 14 }}
                transition={{
                  duration: 0.38,
                  delay: idx * 0.04,
                  ease: [0.22, 1, 0.36, 1],
                }}
                viewport={{ once: true, margin: "-40px" }}
                whileInView={{ opacity: 1, y: 0 }}
              >
                <Card className="flex h-full flex-col justify-between border border-border bg-card p-6 transition-colors hover:border-[#2563eb]/40 dark:hover:border-[#4f8ef7]/40">
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-muted/60 text-[#2563eb] dark:text-[#4f8ef7]">
                        <Icon className="size-5" strokeWidth={1.6} />
                      </div>
                      <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                        {cap.eyebrow}
                      </span>
                    </div>

                    <h3 className="mt-5 text-lg font-semibold text-foreground">
                      {cap.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {cap.summary}
                    </p>
                  </div>

                  <ul className="mt-5 space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                    {cap.specs.map((spec) => (
                      <li key={spec} className="flex items-start gap-2">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[#2563eb] dark:bg-[#4f8ef7]" />
                        <span>{spec}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
