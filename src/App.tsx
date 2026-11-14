import { useCallback, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import CapabilitiesBento from "@/components/CapabilitiesBento";
import ComparisonAndProsCons from "@/components/ComparisonAndProsCons";
import DocsAndInstallSection from "@/components/DocsAndInstallSection";
import HeroSection from "@/components/HeroSection";
import NavbarHeader from "@/components/NavbarHeader";
import PanelTourSection from "@/components/PanelTourSection";

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

  const handleThemeChange = useCallback(
    (next: ThemeMode) => {
      setTheme(next);
      syncDocumentTheme(next);
    },
    [syncDocumentTheme]
  );

  const handleJumpToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen overflow-x-clip bg-background text-foreground">
        <NavbarHeader
          theme={theme}
          onJumpToSection={handleJumpToSection}
          onThemeChange={handleThemeChange}
        />
        <main>
          <HeroSection onJumpToSection={handleJumpToSection} />
          <CapabilitiesBento />
          <PanelTourSection />
          <ComparisonAndProsCons />
          <DocsAndInstallSection />
        </main>
      </div>
    </MotionConfig>
  );
}
