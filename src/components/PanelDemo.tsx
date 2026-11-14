import { ArrowLeft } from "lucide-react";

interface PanelDemoProps {
  onExit: () => void;
}

export default function PanelDemo({ onExit }: PanelDemoProps) {
  return (
    <div className="fixed inset-0 z-50 bg-[#0b101d]">
      <iframe
        title="WebDep Interactive Panel Demo"
        src="./demo-panel/index.html"
        className="h-full w-full border-0"
      />

      <button
        type="button"
        onClick={onExit}
        className="fixed right-4 bottom-4 z-[60] inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-[#111829]/90 px-3.5 py-2 text-xs font-medium text-[#eef1f7] shadow-[0_12px_32px_rgba(0,0,0,0.55)] backdrop-blur-md transition-colors duration-150 hover:border-[#4f8ef7]/60 hover:bg-[#182136] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4f8ef7]"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        Exit Demo
      </button>
    </div>
  );
}
