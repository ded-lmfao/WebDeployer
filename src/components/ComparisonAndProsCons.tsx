import { useState } from "react";
import { motion } from "motion/react";
import { Card, Chip, Table } from "@heroui/react";
import { AlertTriangle, Check, Minus } from "lucide-react";
import {
  COMPARISON_ROWS,
  CONS_ITEMS,
  DECISION_GUIDE,
  PROS_ITEMS,
  type ComparisonRow,
} from "@/data/webdepData";

type FilterCategory = "all" | ComparisonRow["category"];

const CATEGORY_FILTERS: { id: FilterCategory; label: string }[] = [
  { id: "all", label: "All Criteria (9)" },
  { id: "architecture", label: "Architecture & Host" },
  { id: "operations", label: "DX & Operations" },
  { id: "security", label: "Security & Databases" },
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
      className="border-b border-border bg-background py-20 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-3xl">
          <Chip color="accent" variant="soft">
            <Chip.Label className="font-mono text-xs">
              Honest Trade-Offs & Ecosystem Fit
            </Chip.Label>
          </Chip>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Pros, Cons, and how WebDep compares to Coolify, Dokku, and Pterodactyl.
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            Every orchestrator optimizes for a different constraint. WebDep trades
            multi-server container clustering and 100+ community app templates
            for extreme native speed, Windows compatibility, and ~20 MB idle RAM.
          </p>
        </div>

        {/* Pros & Cons two-column grid */}
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <Card className="h-full border border-emerald-500/25 bg-card p-6">
              <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">
                    Strengths (Pros)
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Where WebDep outperforms heavy container panels
                  </p>
                </div>
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Check className="size-4" strokeWidth={2} />
                </span>
              </div>

              <ul className="mt-5 space-y-4">
                {PROS_ITEMS.map((item) => (
                  <li key={item.title} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                      strokeWidth={2}
                    />
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
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.35, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <Card className="h-full border border-amber-500/25 bg-card p-6">
              <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">
                    Trade-offs & Limits (Cons)
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Known constraints to verify before choosing WebDep
                  </p>
                </div>
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-4" strokeWidth={2} />
                </span>
              </div>

              <ul className="mt-5 space-y-4">
                {CONS_ITEMS.map((item) => (
                  <li key={item.title} className="flex items-start gap-3">
                    <Minus
                      className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                      strokeWidth={2}
                    />
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
            </Card>
          </motion.div>
        </div>

        {/* Comparison Table */}
        <div className="mt-14">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-xl font-semibold text-foreground">
                Side-by-Side Comparison Matrix
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Filter dimensions across architecture, operations, and security.
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_FILTERS.map((cat) => {
                const active = filter === cat.id;
                return (
                  <button
                    key={cat.id}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? "border-[#2563eb] bg-[#2563eb] text-white dark:border-[#4f8ef7] dark:bg-[#4f8ef7] dark:text-[#07080d]"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                    type="button"
                    onClick={() => setFilter(cat.id)}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          <Card className="mt-5 overflow-hidden border border-border bg-card">
            <Table variant="primary">
              <Table.ScrollContainer>
                <Table.Content aria-label="WebDep comparison against Coolify, Dokku, and Pterodactyl">
                  <Table.Header className="bg-muted/70">
                    <Table.Column className="w-[22%] text-xs font-semibold text-foreground" isRowHeader>
                      Dimension
                    </Table.Column>
                    <Table.Column className="w-[21%] text-xs font-semibold text-[#2563eb] dark:text-[#4f8ef7]">
                      WebDep
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-semibold text-foreground">
                      Coolify
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-semibold text-foreground">
                      Dokku
                    </Table.Column>
                    <Table.Column className="w-[19%] text-xs font-semibold text-foreground">
                      Pterodactyl
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filteredRows.map((row) => (
                      <Table.Row key={row.feature} id={row.feature}>
                        <Table.Cell className="font-medium text-foreground">
                          {row.feature}
                        </Table.Cell>
                        <Table.Cell className="font-medium text-foreground">
                          {row.webdep}
                        </Table.Cell>
                        <Table.Cell className="text-muted-foreground">
                          {row.coolify}
                        </Table.Cell>
                        <Table.Cell className="text-muted-foreground">
                          {row.dokku}
                        </Table.Cell>
                        <Table.Cell className="text-muted-foreground">
                          {row.pterodactyl}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </Card>
        </div>

        {/* Decision Rules */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DECISION_GUIDE.map((item, idx) => (
            <Card
              key={item.platform}
              className={`border p-5 ${
                idx === 0
                  ? "border-[#2563eb]/45 bg-[#2563eb]/5 dark:border-[#4f8ef7]/45 dark:bg-[#4f8ef7]/5"
                  : "border-border bg-card"
              }`}
            >
              <span className="font-mono text-xs font-medium text-[#2563eb] dark:text-[#4f8ef7]">
                {item.platform}
              </span>
              <h4 className="mt-1.5 text-sm font-semibold text-foreground">
                {item.fit}
              </h4>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {item.reason}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
