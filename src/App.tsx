import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import CapabilitiesBento from "@/components/CapabilitiesBento";
import ComparisonAndProsCons from "@/components/ComparisonAndProsCons";
import DocsAndInstallSection from "@/components/DocsAndInstallSection";
import HeroSection from "@/components/HeroSection";
import NavbarHeader from "@/components/NavbarHeader";
import PanelTourSection from "@/components/PanelTourSection";

const PanelDemo = lazy(() => import("@/components/PanelDemo"));

type ThemeMode = "light" | "dark";

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }
  const saved = window.localStorage.getItem("webdep-site-theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return "dark";
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.location.hash === "#demo";
  });

  const syncDocumentTheme = useCallback((next: ThemeMode) => {
    const root = document.documentElement;
    root.classList.toggle("dark", next === "dark");
    root.setAttribute("data-theme", next);
    root.style.colorScheme = next;
    try {
      window.localStorage.setItem("webdep-site-theme", next);
    } catch {
      // Ignore storage failures under private browsing rules.
    }
  }, []);

  useEffect(() => {
    syncDocumentTheme(theme);
  }, [theme, syncDocumentTheme]);

  useEffect(() => {
    const handleHashChange = () => {
      setDemoMode(window.location.hash === "#demo");
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const handleThemeChange = useCallback(
    (next: ThemeMode) => {
      setTheme(next);
      syncDocumentTheme(next);
    },
    [syncDocumentTheme]
  );

  const handleOpenDemo = useCallback(() => {
    setDemoMode(true);
    if (window.location.hash !== "#demo") {
      window.location.hash = "demo";
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const handleExitDemo = useCallback(() => {
    setDemoMode(false);
    if (window.location.hash === "#demo") {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const handleJumpToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {demoMode ? (
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center bg-background font-mono text-xs text-muted-foreground">
              Loading WebDep Control Plane demo...
            </div>
          }
        >
          <PanelDemo onExit={handleExitDemo} />
        </Suspense>
      ) : (
        <div className="min-h-screen overflow-x-clip bg-background text-foreground">
          <NavbarHeader
            theme={theme}
            onJumpToSection={handleJumpToSection}
            onOpenDemo={handleOpenDemo}
            onThemeChange={handleThemeChange}
          />
          <main>
            <HeroSection
              onJumpToSection={handleJumpToSection}
              onOpenDemo={handleOpenDemo}
            />
            <CapabilitiesBento />
            <PanelTourSection onOpenDemo={handleOpenDemo} />
            <ComparisonAndProsCons />
            <DocsAndInstallSection />
          </main>
        </div>
      )}
    </MotionConfig>
  );
}
