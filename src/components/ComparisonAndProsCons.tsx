import { useState } from "react";
import { motion } from "motion/react";
import { Table } from "@heroui/react";
import { Check, Minus } from "lucide-react";
import {
  COMPARISON_ROWS,
  CONS_ITEMS,
  DECISION_GUIDE,
  PROS_ITEMS,
  type ComparisonRow,
} from "@/data/webdepData";
import { cn } from "@/lib/utils";

type FilterCategory = "all" | ComparisonRow["category"];

const CATEGORY_FILTERS: { id: FilterCategory; label: string }[] = [
  { id: "all", label: "All criteria (9)" },
  { id: "architecture", label: "Architecture & host" },
  { id: "operations", label: "DX & operations" },
  { id: "security", label: "Security & databases" },
];

export default function ComparisonAndProsCons() {
  const [filter, setFilter] = useState<FilterCategory>("all");

  const filteredRows =
    filter === "all"
      ? COMPARISON_ROWS
      : COMPARISON_ROWS.filter((row) => row.category === filter);

  return (
    <section
      id="comparison"
      className="border-b border-border bg-background py-20 lg:py-24"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-3xl">
          <h2 className="text-3xl font-medium tracking-[-0.02em] text-foreground sm:text-4xl">
            Strengths, trade-offs, and comparison against Coolify, Dokku, and
            Pterodactyl
          </h2>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            Every orchestrator optimizes for a different constraint. WebDep
            trades multi-server container clustering and 100+ community app
            templates for native speed, Windows support, and ~20 MB idle RAM.
          </p>
        </div>

        {/* Pros & Cons two-column grid */}
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <motion.div
            className="rounded-2xl border border-border bg-card p-6"
            initial={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <div className="border-b border-border pb-4">
              <h3 className="text-base font-medium text-foreground">
                Strengths (Pros)
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Where WebDep outperforms container-based panels
              </p>
            </div>

            <ul className="mt-5 space-y-4">
              {PROS_ITEMS.map((item) => (
                <li key={item.title} className="flex items-start gap-3">
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                    <Check
                      className="size-4 text-positive"
                      strokeWidth={1.5}
                    />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {item.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            className="rounded-2xl border border-border bg-card p-6"
            initial={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.35, delay: 0.04, ease: [0.22, 1, 0.36, 1] }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <div className="border-b border-border pb-4">
              <h3 className="text-base font-medium text-foreground">
                Trade-offs & limits (Cons)
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Known constraints to check before adopting WebDep
              </p>
            </div>

            <ul className="mt-5 space-y-4">
              {CONS_ITEMS.map((item) => (
                <li key={item.title} className="flex items-start gap-3">
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                    <Minus
                      className="size-4 text-muted-foreground"
                      strokeWidth={1.5}
                    />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {item.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>

        {/* Comparison Table */}
        <div className="mt-16">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-xl font-medium tracking-[-0.015em] text-foreground">
                Side-by-side comparison matrix
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Filter dimensions across architecture, operations, and security
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_FILTERS.map((cat) => {
                const active = filter === cat.id;
                return (
                  <button
                    key={cat.id}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    )}
                    type="button"
                    onClick={() => setFilter(cat.id)}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card">
            <Table variant="primary">
              <Table.ScrollContainer>
                <Table.Content aria-label="WebDep comparison against Coolify, Dokku, and Pterodactyl">
                  <Table.Header className="border-b border-border bg-surface-deep/60">
                    <Table.Column
                      className="w-[22%] text-xs font-medium text-muted-foreground"
                      isRowHeader
                    >
                      Dimension
                    </Table.Column>
                    <Table.Column className="w-[21%] text-xs font-medium text-foreground">
                      WebDep
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-medium text-muted-foreground">
                      Coolify
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-medium text-muted-foreground">
                      Dokku
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-medium text-muted-foreground">
                      Pterodactyl
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filteredRows.map((row) => (
                      <Table.Row
                        key={row.feature}
                        className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-secondary/40"
                        id={row.feature}
                      >
                        <Table.Cell className="text-xs font-medium text-foreground sm:text-sm">
                          {row.feature}
                        </Table.Cell>
                        <Table.Cell className="text-xs font-medium text-foreground sm:text-sm">
                          {row.webdep}
                        </Table.Cell>
                        <Table.Cell className="text-xs text-muted-foreground sm:text-sm">
                          {row.coolify}
                        </Table.Cell>
                        <Table.Cell className="text-xs text-muted-foreground sm:text-sm">
                          {row.dokku}
                        </Table.Cell>
                        <Table.Cell className="text-xs text-muted-foreground sm:text-sm">
                          {row.pterodactyl}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </div>
        </div>

        {/* Decision Rules */}
        <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {DECISION_GUIDE.map((item, idx) => (
            <div key={item.platform} className="bg-card p-6">
              <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                {idx === 0 && (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-positive"
                  />
                )}
                <span className={idx === 0 ? "text-foreground" : undefined}>
                  {item.platform}
                </span>
              </div>
              <h4 className="mt-2 text-sm font-medium text-foreground">
                {item.fit}
              </h4>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {item.reason}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
