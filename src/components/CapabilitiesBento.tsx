import { motion } from "motion/react";
import {
  Activity,
  Cpu,
  Database,
  FolderGit2,
  Globe,
  Layers,
  ShieldCheck,
} from "lucide-react";
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

const STACK_LAYERS = [
  {
    layer: "Control Plane",
    tech: "Rust · Axum + Tokio",
    detail: "Embedded HTTP server, SSE log streaming, FIFO deploy queue, and CSRF/SameSite session protection.",
  },
  {
    layer: "State & Secrets",
    tech: "SQLite WAL + AES-256-GCM",
    detail: "Bundled SQLite engine with Argon2 passwords, WebAuthn Passkeys, TOTP 2FA, and encrypted vault.",
  },
  {
    layer: "Workloads & DBs",
    tech: "OS Processes + pg_ctl",
    detail: "Direct PID/tree supervision, managed Caddyfile auto-HTTPS, and isolated Postgres firewall sync.",
  },
  {
    layer: "Dashboard UI",
    tech: "RustEmbed · 10 Themes",
    detail: "Real-time CPU/RAM/network charts, scoped file explorer, code editor, and RBAC permission controls.",
  },
];

const MAX_MB = 800;
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export default function CapabilitiesBento() {
  return (
    <section
      id="capabilities"
      className="border-b border-border bg-background py-20 lg:py-24"
    >
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          className="max-w-2xl"
          initial={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.36, ease: EASE_OUT }}
          viewport={{ once: true, margin: "-40px" }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          <h2 className="text-3xl font-medium tracking-[-0.02em] text-foreground sm:text-4xl">
            Everything needed to run a VPS in one binary
          </h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            Replace PM2 wrappers, manual reverse proxy setups, and heavy container
            stacks with native OS process supervision.
          </p>
        </motion.div>

        {/* Benchmarks + Single-Binary Stack Breakdown */}
        <div className="mt-10 grid items-stretch gap-6 lg:grid-cols-12">
          <motion.div
            className="flex flex-col justify-between rounded-2xl border border-border bg-card p-6 lg:col-span-5"
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.38, delay: 0.04, ease: EASE_OUT }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-base font-medium text-foreground">
                  Control-plane RAM footprint
                </h3>
                <span className="font-mono text-xs text-muted-subtle tabular-nums">
                  Typical RSS
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Idle memory vs Docker and PHP control planes
              </p>

              <div className="mt-6 space-y-4">
                {RAM_FOOTPRINT_BENCHMARKS.map((item, idx) => {
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
                        <motion.div
                          className={cn(
                            "h-full origin-left rounded-sm",
                            item.highlight
                              ? "bg-brand-accent"
                              : "bg-foreground/20"
                          )}
                          initial={{ scaleX: 0 }}
                          style={{ width: `${widthPct}%` }}
                          transition={{
                            duration: 0.5,
                            delay: 0.1 + idx * 0.05,
                            ease: EASE_OUT,
                          }}
                          viewport={{ once: true, margin: "-40px" }}
                          whileInView={{ scaleX: 1 }}
                        />
                      </div>
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
          </motion.div>

          <motion.div
            className="flex flex-col justify-between rounded-2xl border border-border bg-card p-6 lg:col-span-7"
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.38, delay: 0.09, ease: EASE_OUT }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <div>
              <div className="flex items-center justify-between gap-4">
                <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
                  <Layers className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  Compiled inside one static binary
                </h3>
                <span className="font-mono text-xs text-muted-subtle">
                  Zero external runtime deps
                </span>
              </div>

              <div className="mt-5 divide-y divide-border">
                {STACK_LAYERS.map((row) => (
                  <div
                    key={row.layer}
                    className="grid gap-1.5 py-3.5 first:pt-1 last:pb-0 sm:grid-cols-12 sm:items-baseline sm:gap-4"
                  >
                    <div className="sm:col-span-4">
                      <p className="text-sm font-medium text-foreground">
                        {row.layer}
                      </p>
                      <p className="font-mono text-xs text-brand-accent">
                        {row.tech}
                      </p>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-8">
                      {row.detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 font-mono text-xs text-muted-subtle">
              <span>Linux (x86_64 &amp; aarch64) · Windows</span>
              <span>Bundled SQLite WAL · Single binary</span>
            </div>
          </motion.div>
        </div>

        {/* Capabilities hairline matrix */}
        <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((cap, idx) => {
            const Icon = ICON_MAP[cap.iconName];
            return (
              <motion.div
                key={cap.id}
                className="flex flex-col justify-between bg-card p-6"
                initial={{ opacity: 0, y: 8 }}
                transition={{
                  duration: 0.34,
                  delay: idx * 0.04,
                  ease: EASE_OUT,
                }}
                viewport={{ once: true, margin: "-40px" }}
                whileInView={{ opacity: 1, y: 0 }}
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

                <ul className="mt-5 space-y-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
                  {cap.specs.map((spec) => (
                    <li key={spec} className="leading-relaxed">
                      {spec}
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
