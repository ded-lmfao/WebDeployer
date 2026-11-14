import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Accordion, Link, Separator, Table, Tabs } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import {
  ENV_VARIABLES,
  FAQ_ITEMS,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  INSTALL_METHODS,
  SUPPORTED_RUNTIMES,
} from "@/data/webdepData";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

function CopyCommandBlock({
  command,
  verify,
  shellLabel,
}: {
  command: string;
  verify: string;
  shellLabel: string;
}) {
  const { isCopied, copyToClipboard } = useCopyToClipboard({ timeout: 2200 });

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-border bg-[#07080d] p-4 font-mono text-xs text-[#eef0f5]">
        <div className="mb-3 flex items-center justify-between border-b border-white/8 pb-2.5 text-xs text-[#7a8296]">
          <span>{shellLabel}</span>
          <button
            className="inline-flex h-7 min-w-18 items-center justify-center gap-1.5 rounded-md border border-white/12 bg-white/5 px-2.5 text-xs text-[#eef0f5] transition-colors duration-150 hover:bg-white/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onClick={() => copyToClipboard(command)}
          >
            <AnimatePresence initial={false} mode="wait">
              <motion.span
                key={isCopied ? "copied" : "copy"}
                animate={{ opacity: 1, y: 0 }}
                className="inline-flex items-center gap-1.5"
                exit={{ opacity: 0, y: -4 }}
                initial={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.14, ease: EASE_OUT }}
              >
                {isCopied ? (
                  <Check className="size-3.5 text-[#4cc38a]" strokeWidth={1.5} />
                ) : (
                  <Copy className="size-3.5" strokeWidth={1.5} />
                )}
                <span>{isCopied ? "Copied" : "Copy"}</span>
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
        <pre className="overflow-x-auto leading-relaxed text-[#a3a9b8]">
          <code>{command}</code>
        </pre>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{verify}</p>
    </div>
  );
}

export default function DocsAndInstallSection() {
  const [installTab, setInstallTab] = useState<string>(INSTALL_METHODS[0].id);

  return (
    <>
      <section
        id="install"
        className="border-b border-border bg-surface-deep/40 py-20 lg:py-24"
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
              Install and configuration
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted-foreground">
              Fetch the prebuilt Linux binary, compile from Rust source, or run
              natively on Windows.
            </p>
          </motion.div>

          <motion.div
            className="mt-10 rounded-2xl border border-border bg-card p-6"
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.38, delay: 0.04, ease: EASE_OUT }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <Tabs
              selectedKey={installTab}
              variant="secondary"
              onSelectionChange={(k) => setInstallTab(String(k))}
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label="Installation methods">
                  {INSTALL_METHODS.map((method) => (
                    <Tabs.Tab
                      key={method.id}
                      className="text-muted-foreground transition-colors hover:text-foreground data-[selected=true]:text-foreground"
                      id={method.id}
                    >
                      <Tabs.Indicator />
                      {method.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>

              {INSTALL_METHODS.map((method) => (
                <Tabs.Panel key={method.id} className="pt-5" id={method.id}>
                  <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {method.note}
                    </p>
                    <span className="font-mono text-xs text-muted-subtle">
                      {method.platform}
                    </span>
                  </div>
                  <CopyCommandBlock
                    command={method.command}
                    shellLabel={
                      method.id === "windows-host" ? "cmd / powershell" : "bash"
                    }
                    verify={method.verify}
                  />
                </Tabs.Panel>
              ))}
            </Tabs>
          </motion.div>

          {/* .env Variables + Supported Runtimes */}
          <div className="mt-8 grid gap-6 lg:grid-cols-12">
            <motion.div
              className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-6 lg:col-span-7"
              initial={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.38, delay: 0.04, ease: EASE_OUT }}
              viewport={{ once: true, margin: "-40px" }}
              whileInView={{ opacity: 1, y: 0 }}
            >
              <h3 className="text-base font-medium text-foreground">
                Control-plane configuration (.env)
              </h3>
              <p className="mt-1 mb-5 text-xs text-muted-foreground">
                Auto-populated by start.sh or edited before first launch
              </p>
              <div className="overflow-hidden rounded-xl border border-border bg-background/40">
                <Table className="ink-table" variant="secondary">
                  <Table.ScrollContainer>
                    <Table.Content aria-label="WebDep .env variables">
                      <Table.Header>
                        <Table.Column
                          className="text-xs font-medium text-muted-foreground"
                          isRowHeader
                        >
                          Variable
                        </Table.Column>
                        <Table.Column className="text-xs font-medium text-muted-foreground">
                          Default
                        </Table.Column>
                        <Table.Column className="text-xs font-medium text-muted-foreground">
                          Purpose
                        </Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {ENV_VARIABLES.map((row) => (
                          <Table.Row key={row.name} id={row.name}>
                            <Table.Cell className="font-mono text-xs font-medium text-foreground">
                              {row.name}
                            </Table.Cell>
                            <Table.Cell className="font-mono text-xs text-muted-foreground">
                              {row.defaultValue}
                            </Table.Cell>
                            <Table.Cell className="text-xs text-muted-foreground">
                              {row.description}
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
              </div>
            </motion.div>

            <motion.div
              className="min-w-0 rounded-2xl border border-border bg-card p-6 lg:col-span-5"
              initial={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.38, delay: 0.09, ease: EASE_OUT }}
              viewport={{ once: true, margin: "-40px" }}
              whileInView={{ opacity: 1, y: 0 }}
            >
              <h3 className="text-base font-medium text-foreground">
                Supported runtimes
              </h3>
              <p className="mt-1 mb-4 text-xs text-muted-foreground">
                Detected from repository files or overridden per app
              </p>
              <div className="divide-y divide-border">
                {SUPPORTED_RUNTIMES.map((rt) => (
                  <div key={rt.name} className="py-3 first:pt-1 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {rt.name}
                      </span>
                      <span className="font-mono text-xs text-muted-subtle">
                        {rt.detection}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {rt.notes}
                    </p>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* FAQ Accordion */}
          <motion.div
            className="mt-16"
            initial={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.38, ease: EASE_OUT }}
            viewport={{ once: true, margin: "-40px" }}
            whileInView={{ opacity: 1, y: 0 }}
          >
            <h3 className="text-2xl font-medium tracking-[-0.015em] text-foreground">
              Frequently asked questions
            </h3>
            <div className="mt-5 rounded-2xl border border-border bg-card px-4 py-2 sm:px-6">
              <Accordion variant="default">
                {FAQ_ITEMS.map((faq) => (
                  <Accordion.Item key={faq.id} id={faq.id}>
                    <Accordion.Heading>
                      <Accordion.Trigger className="text-left text-sm font-medium text-foreground sm:text-base">
                        {faq.question}
                        <Accordion.Indicator />
                      </Accordion.Trigger>
                    </Accordion.Heading>
                    <Accordion.Panel>
                      <Accordion.Body className="text-sm leading-relaxed text-muted-foreground">
                        {faq.answer}
                      </Accordion.Body>
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            </div>
          </motion.div>
        </div>
      </section>

      <footer className="bg-background py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <img
              alt="WebDep"
              className="size-7 rounded-md border border-border bg-card object-cover"
              decoding="async"
              height={28}
              loading="lazy"
              src="./images/logo.png"
              width={28}
            />
            <div>
              <p className="text-sm font-medium text-foreground">
                WebDep (ded-lmfao/WebDep)
              </p>
              <p className="text-xs text-muted-foreground">
                Single-binary Rust PaaS &amp; native process orchestrator
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <Link
              className="transition-colors hover:text-foreground"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Source repository
            </Link>
            <Separator className="h-3" orientation="vertical" />
            <Link
              className="transition-colors hover:text-foreground"
              href={GITHUB_RELEASES_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Releases
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
