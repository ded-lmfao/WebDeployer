import { useState } from "react";
import {
  Accordion,
  Card,
  Chip,
  Link,
  Separator,
  Table,
  Tabs,
} from "@heroui/react";
import { ArrowUpRight, Check, Copy, GitCommitHorizontal } from "lucide-react";
import ParticleButton from "@/components/kokonutui/particle-button";
import {
  CI_COMMIT_RULES,
  ENV_VARIABLES,
  FAQ_ITEMS,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  INSTALL_METHODS,
  SONAR_URL,
  SUPPORTED_RUNTIMES,
} from "@/data/webdepData";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

function CopyCommandBlock({
  command,
  verify,
}: {
  command: string;
  verify: string;
}) {
  const { isCopied, copyToClipboard } = useCopyToClipboard({ timeout: 2200 });

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-border bg-[#07080d] p-4 font-mono text-xs text-zinc-200">
        <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2 text-[11px] text-zinc-400">
          <span>shell · copyable command</span>
          <ParticleButton
            className="h-7 border border-white/15 bg-white/5 px-2.5 text-[11px] text-zinc-100 hover:bg-white/10"
            icon={
              isCopied ? (
                <Check className="size-3.5 text-emerald-400" />
              ) : (
                <Copy className="size-3.5" />
              )
            }
            size="sm"
            successLabel="Copied"
            variant="ghost"
            onClick={() => copyToClipboard(command)}
          >
            {isCopied ? "Copied" : "Copy"}
          </ParticleButton>
        </div>
        <pre className="overflow-x-auto leading-relaxed">
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
        className="border-b border-border bg-muted/20 py-20 sm:py-24"
      >
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <Chip color="accent" variant="soft">
              <Chip.Label className="font-mono text-xs">
                Documentation & Setup
              </Chip.Label>
            </Chip>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Deploy WebDep in under a minute.
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              Choose the prebuilt Linux binary launcher, build natively from Rust
              source, or run directly on Windows.
            </p>
          </div>

          <Card className="mt-8 border border-border bg-card p-5 sm:p-6">
            <Tabs
              selectedKey={installTab}
              variant="secondary"
              onSelectionChange={(k) => setInstallTab(String(k))}
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label="Installation methods">
                  {INSTALL_METHODS.map((method) => (
                    <Tabs.Tab key={method.id} id={method.id}>
                      <Tabs.Indicator />
                      {method.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>

              {INSTALL_METHODS.map((method) => (
                <Tabs.Panel key={method.id} className="pt-5" id={method.id}>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                      {method.note}
                    </p>
                    <Chip color="default" variant="soft">
                      <Chip.Label className="font-mono text-[11px]">
                        {method.platform}
                      </Chip.Label>
                    </Chip>
                  </div>
                  <CopyCommandBlock
                    command={method.command}
                    verify={method.verify}
                  />
                </Tabs.Panel>
              ))}
            </Tabs>
          </Card>

          {/* .env Variables + Supported Runtimes */}
          <div className="mt-10 grid gap-6 lg:grid-cols-12">
            <Card className="min-w-0 overflow-hidden border border-border bg-card p-5 lg:col-span-7">
              <h3 className="text-lg font-semibold text-foreground">
                Control-Plane Configuration (.env)
              </h3>
              <p className="mt-1 mb-4 text-xs text-muted-foreground">
                Auto-populated by start.sh or customized before first launch.
              </p>
              <Table variant="secondary">
                <Table.ScrollContainer>
                  <Table.Content aria-label="WebDep .env variables">
                    <Table.Header className="bg-muted/70">
                      <Table.Column className="text-xs font-semibold text-foreground" isRowHeader>
                        Variable
                      </Table.Column>
                      <Table.Column className="text-xs font-semibold text-foreground">
                        Default
                      </Table.Column>
                      <Table.Column className="text-xs font-semibold text-foreground">
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
            </Card>

            <div className="min-w-0 space-y-6 lg:col-span-5">
              <Card className="border border-border bg-card p-5">
                <h3 className="text-lg font-semibold text-foreground">
                  Supported Runtimes & Stacks
                </h3>
                <p className="mt-1 mb-4 text-xs text-muted-foreground">
                  Detected natively from repository files or overridden per app.
                </p>
                <div className="space-y-3">
                  {SUPPORTED_RUNTIMES.map((rt) => (
                    <div
                      key={rt.name}
                      className="rounded-lg border border-border bg-background/60 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {rt.name}
                        </span>
                        <span className="font-mono text-[11px] text-[#2563eb] dark:text-[#4f8ef7]">
                          {rt.detection}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {rt.notes}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          {/* CI Release Gate & Commit Keywords */}
          <Card className="mt-6 border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <GitCommitHorizontal
                  className="size-5 text-[#2563eb] dark:text-[#4f8ef7]"
                  strokeWidth={1.75}
                />
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Release Gate & Documentation Commit Rules
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Releases are blocked automatically if the SonarCloud gate
                    fails; documentation updates can opt out cleanly.
                  </p>
                </div>
              </div>
              <Link
                className="inline-flex items-center gap-1 font-mono text-xs text-[#2563eb] hover:underline dark:text-[#4f8ef7]"
                href={SONAR_URL}
                rel="noopener noreferrer"
                target="_blank"
              >
                SonarCloud Gate
                <ArrowUpRight className="size-3.5" strokeWidth={1.75} />
              </Link>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {CI_COMMIT_RULES.map((rule) => (
                <div
                  key={rule.pattern}
                  className="rounded-lg border border-border bg-background/70 p-3.5"
                >
                  <p className="font-mono text-xs font-medium text-foreground">
                    {rule.pattern}
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {rule.effect}
                  </p>
                  <p className="mt-2.5 rounded border border-border bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground">
                    {rule.example}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          {/* FAQ Accordion */}
          <div className="mt-14">
            <h3 className="text-2xl font-semibold tracking-tight text-foreground">
              Frequently Asked Questions
            </h3>
            <Card className="mt-4 border border-border bg-card p-2 sm:p-4">
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
            </Card>
          </div>
        </div>
      </section>

      <footer className="bg-background py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 sm:flex-row sm:items-center sm:px-6">
          <div className="flex items-center gap-3">
            <img
              alt="WebDep Logo"
              className="size-7 rounded-md border border-border object-cover"
              src="./images/logo.png"
            />
            <div>
              <p className="text-sm font-semibold text-foreground">
                WebDep (ded-lmfao/WebDep)
              </p>
              <p className="text-xs text-muted-foreground">
                Lightweight single-binary Rust PaaS & process orchestrator
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <Link
              className="hover:text-foreground"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Source Repository
            </Link>
            <Separator className="h-3" orientation="vertical" />
            <Link
              className="hover:text-foreground"
              href={GITHUB_RELEASES_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Releases
            </Link>
            <Separator className="h-3" orientation="vertical" />
            <Link
              className="hover:text-foreground"
              href={SONAR_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              SonarCloud Quality Gate
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
