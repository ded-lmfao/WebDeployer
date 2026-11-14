import { motion } from "motion/react";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

interface SignalRoute {
  id: string;
  d: string;
  color: string;
  delay: number;
  duration: number;
  label: string;
  sublabel: string;
  boxX: number;
  boxY: number;
  dotX: number;
  dotY: number;
}

const SIGNAL_ROUTES: SignalRoute[] = [
  {
    id: "caddy",
    d: "M 164 88 L 194 88 L 194 166 L 214 166",
    color: "#3b82f6",
    delay: 0.15,
    duration: 3.1,
    label: "Caddy :443",
    sublabel: "Auto HTTPS",
    boxX: 28,
    boxY: 62,
    dotX: 44,
    dotY: 82,
  },
  {
    id: "websites",
    d: "M 164 312 L 194 312 L 194 234 L 214 234",
    color: "#3b82f6",
    delay: 0.25,
    duration: 3.5,
    label: "Workloads",
    sublabel: "OS processes",
    boxX: 28,
    boxY: 286,
    dotX: 44,
    dotY: 306,
  },
  {
    id: "services",
    d: "M 436 88 L 406 88 L 406 166 L 386 166",
    color: "#22d3ee",
    delay: 0.2,
    duration: 3.3,
    label: "Axum :4600",
    sublabel: "Live SSE API",
    boxX: 436,
    boxY: 62,
    dotX: 452,
    dotY: 82,
  },
  {
    id: "postgres",
    d: "M 436 312 L 406 312 L 406 234 L 386 234",
    color: "#22d3ee",
    delay: 0.3,
    duration: 3.7,
    label: "PostgreSQL",
    sublabel: "pg_ctl clusters",
    boxX: 436,
    boxY: 286,
    dotX: 452,
    dotY: 306,
  },
];

function AnimatedLogoGeometry({ side }: { side: "left" | "right" }) {
  const color = side === "left" ? "#2f7df6" : "#29d0f6";
  const clipId = side === "left" ? "hero-wd-left" : "hero-wd-right";

  return (
    <g clipPath={`url(#${clipId})`} style={{ color }}>
      {/* Roof Chevron */}
      <motion.polygon
        animate={{ opacity: 1, y: 0 }}
        fill="currentColor"
        initial={{ opacity: 0, y: -6 }}
        points="72,4 13,60 25.5,60 72,16.5 118.5,60 131,60"
        transition={{ duration: 0.5, delay: 0.14, ease: EASE_OUT }}
      />

      {/* Dual Server Blades with subtle cutout slots */}
      <motion.g
        animate={{ opacity: 1 }}
        fill="currentColor"
        initial={{ opacity: 0 }}
        mask="url(#hero-wd-server-mask)"
        transition={{ duration: 0.45, delay: 0.24, ease: EASE_OUT }}
      >
        <rect height="12" rx="3" width="50" x="47" y="46" />
        <rect height="12" rx="3" width="50" x="47" y="64" />
      </motion.g>

      {/* Geometric W Base */}
      <g clipPath="url(#hero-wd-w-bounds)">
        <motion.rect
          animate={{ opacity: 1, scaleX: 1 }}
          fill="currentColor"
          height="8.5"
          initial={{ opacity: 0, scaleX: 0.4 }}
          rx="0.5"
          style={{ transformOrigin: side === "left" ? "7px 74px" : "137px 74px" }}
          transition={{ duration: 0.4, delay: 0.28, ease: EASE_OUT }}
          width="29"
          x="7"
          y="70"
        />
        <motion.rect
          animate={{ opacity: 1, scaleX: 1 }}
          fill="currentColor"
          height="8.5"
          initial={{ opacity: 0, scaleX: 0.4 }}
          rx="0.5"
          style={{ transformOrigin: side === "left" ? "7px 74px" : "137px 74px" }}
          transition={{ duration: 0.4, delay: 0.28, ease: EASE_OUT }}
          width="29"
          x="108"
          y="70"
        />

        <motion.polyline
          animate={{ pathLength: 1, opacity: 1 }}
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          points="12,68 47,124 83,79 97,98 114,68"
          stroke="currentColor"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit={6}
          strokeWidth="10"
          transition={{ duration: 0.72, delay: 0.22, ease: EASE_OUT }}
        />

        <motion.polyline
          animate={{ pathLength: 1, opacity: 1 }}
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          points="31,68 47,94 60,79 65,86"
          stroke="currentColor"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit={6}
          strokeWidth="9"
          transition={{ duration: 0.56, delay: 0.34, ease: EASE_OUT }}
        />

        <motion.polyline
          animate={{ pathLength: 1, opacity: 1 }}
          fill="none"
          initial={{ pathLength: 0, opacity: 0 }}
          points="132,68 97,124 82,102"
          stroke="currentColor"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit={6}
          strokeWidth="10"
          transition={{ duration: 0.62, delay: 0.3, ease: EASE_OUT }}
        />
      </g>
    </g>
  );
}

export default function HeroWebDepSvg() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-[#080c15]">
      <svg
        aria-label="Animated WebDep control plane SVG diagram showing Caddy TLS, workloads, Axum API, and PostgreSQL nodes"
        className="block h-auto w-full select-none"
        fill="none"
        role="img"
        viewBox="0 0 600 400"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Blueprint grid */}
          <pattern
            height="32"
            id="hero-grid"
            patternUnits="userSpaceOnUse"
            width="32"
          >
            <path
              d="M 32 0 L 0 0 0 32"
              fill="none"
              stroke="#1e293b"
              strokeOpacity="0.45"
              strokeWidth="0.8"
            />
          </pattern>

          <radialGradient cx="50%" cy="50%" id="hero-grid-fade" r="55%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>

          <mask id="hero-grid-mask">
            <rect fill="url(#hero-grid-fade)" height="400" width="600" x="0" y="0" />
          </mask>

          <radialGradient cx="50%" cy="50%" id="hero-core-glow" r="50%">
            <stop offset="0%" stopColor="#2f7df6" stopOpacity="0.18" />
            <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#080c15" stopOpacity="0" />
          </radialGradient>

          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="hero-squircle-stroke"
            x1="214"
            x2="386"
            y1="114"
            y2="286"
          >
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="50%" stopColor="#2f7df6" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>

          {/* Exact logo-mark.svg clip & mask coordinates inside 144x144 */}
          <clipPath id="hero-wd-left">
            <rect height="144" width="72" x="0" y="0" />
          </clipPath>
          <clipPath id="hero-wd-right">
            <rect height="144" width="72" x="72" y="0" />
          </clipPath>
          <clipPath id="hero-wd-w-bounds">
            <rect height="74" width="144" x="0" y="70" />
          </clipPath>
          <mask id="hero-wd-server-mask">
            <rect fill="#ffffff" height="144" width="144" x="0" y="0" />
            <circle cx="55.5" cy="52" fill="#000000" r="2.7" />
            <rect fill="#000000" height="2.8" rx="1.4" width="15" x="75.5" y="50.6" />
            <circle cx="55.5" cy="70" fill="#000000" r="2.7" />
            <rect fill="#000000" height="2.8" rx="1.4" width="15" x="75.5" y="68.6" />
          </mask>
        </defs>

        {/* Masked background grid & ambient center glow */}
        <rect
          fill="url(#hero-grid)"
          height="400"
          mask="url(#hero-grid-mask)"
          width="600"
          x="0"
          y="0"
        />
        <circle cx="300" cy="200" fill="url(#hero-core-glow)" r="180" />

        {/* Concentric architectural orbital rings */}
        <motion.circle
          animate={{ rotate: 360 }}
          cx="300"
          cy="200"
          initial={{ rotate: 0 }}
          r="128"
          stroke="#1e293b"
          strokeDasharray="4 8"
          strokeOpacity="0.65"
          strokeWidth="1"
          style={{ transformOrigin: "300px 200px" }}
          transition={{ duration: 48, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
        />
        <motion.circle
          animate={{ rotate: -360 }}
          cx="300"
          cy="200"
          initial={{ rotate: 0 }}
          r="156"
          stroke="#1e293b"
          strokeDasharray="2 10"
          strokeOpacity="0.45"
          strokeWidth="1"
          style={{ transformOrigin: "300px 200px" }}
          transition={{ duration: 64, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
        />

        {/* Orthogonal circuit traces + animated signal packets */}
        {SIGNAL_ROUTES.map((route) => (
          <g key={route.id}>
            <motion.path
              animate={{ pathLength: 1, opacity: 1 }}
              d={route.d}
              initial={{ pathLength: 0, opacity: 0 }}
              stroke="#1e293b"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              transition={{ duration: 0.6, delay: route.delay, ease: EASE_OUT }}
            />
            <motion.path
              animate={{ strokeDashoffset: [-140, 0] }}
              d={route.d}
              initial={{ strokeDashoffset: 0 }}
              stroke={route.color}
              strokeDasharray="18 122"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity="0.85"
              strokeWidth="2"
              transition={{
                duration: route.duration,
                delay: route.delay + 0.35,
                ease: "linear",
                repeat: Number.POSITIVE_INFINITY,
              }}
            />

            {/* Endpoint junction dot on squircle edge */}
            <motion.circle
              animate={{ scale: 1, opacity: 1 }}
              cx={route.id === "caddy" || route.id === "websites" ? 214 : 386}
              cy={route.id === "caddy" || route.id === "services" ? 166 : 234}
              fill={route.color}
              initial={{ scale: 0, opacity: 0 }}
              r="3"
              transition={{ duration: 0.3, delay: route.delay + 0.3, ease: EASE_OUT }}
            />

            {/* Edge architecture node */}
            <motion.g
              animate={{ opacity: 1, y: 0 }}
              initial={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.45, delay: route.delay, ease: EASE_OUT }}
            >
              <rect
                fill="#0d1322"
                height="52"
                rx="10"
                stroke="#1e293b"
                strokeWidth="1"
                width="136"
                x={route.boxX}
                y={route.boxY}
              />
              <motion.circle
                animate={{ opacity: [0.45, 1, 0.45] }}
                cx={route.dotX}
                cy={route.dotY}
                fill={route.color}
                r="3.2"
                transition={{
                  duration: 2.2,
                  delay: route.delay,
                  ease: "easeInOut",
                  repeat: Number.POSITIVE_INFINITY,
                }}
              />
              <text
                fill="#e2e8f0"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                fontSize="11.5"
                fontWeight="600"
                x={route.boxX + 26}
                y={route.boxY + 23}
              >
                {route.label}
              </text>
              <text
                fill="#7a859e"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fontSize="10.5"
                x={route.boxX + 16}
                y={route.boxY + 40}
              >
                {route.sublabel}
              </text>
            </motion.g>
          </g>
        ))}

        {/* Central WebDep Squircle Shield with floating & hardware animations */}
        <motion.g
          animate={{ y: [0, -3.5, 0] }}
          transition={{
            duration: 5.5,
            ease: "easeInOut",
            repeat: Number.POSITIVE_INFINITY,
          }}
        >
          {/* Squircle backing */}
          <motion.rect
            animate={{ opacity: 1, scale: 1 }}
            fill="#0b1121"
            height="172"
            initial={{ opacity: 0, scale: 0.94 }}
            rx="36"
            style={{ transformOrigin: "300px 200px" }}
            transition={{ duration: 0.45, ease: EASE_OUT }}
            width="172"
            x="214"
            y="114"
          />

          {/* Outer animated gradient squircle border (matches docs/images/logo.png) */}
          <motion.rect
            animate={{ pathLength: 1, opacity: 1 }}
            fill="none"
            height="172"
            initial={{ pathLength: 0, opacity: 0 }}
            rx="36"
            stroke="url(#hero-squircle-stroke)"
            strokeWidth="2.5"
            transition={{ duration: 0.85, ease: EASE_OUT }}
            width="172"
            x="214"
            y="114"
          />

          {/* Exact WebDep 144x144 mark scaled cleanly inside the squircle */}
          <g transform="translate(238.08, 138.08) scale(0.86)">
            {/* Subtle hardware activity LEDs glowing behind blade cutouts */}
            <motion.circle
              animate={{ opacity: [0.35, 1, 0.35] }}
              cx="55.5"
              cy="52"
              fill="#10b981"
              r="2.4"
              transition={{
                duration: 1.6,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
            />
            <motion.circle
              animate={{ opacity: [1, 0.3, 1] }}
              cx="55.5"
              cy="70"
              fill="#38bdf8"
              r="2.4"
              transition={{
                duration: 2.1,
                delay: 0.4,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
            />
            <motion.rect
              animate={{ opacity: [0.25, 0.85, 0.25] }}
              fill="#38bdf8"
              height="2"
              rx="1"
              transition={{
                duration: 2.4,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
              width="13"
              x="76.5"
              y="51"
            />
            <motion.rect
              animate={{ opacity: [0.85, 0.25, 0.85] }}
              fill="#2f7df6"
              height="2"
              rx="1"
              transition={{
                duration: 2.4,
                delay: 0.7,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
              width="13"
              x="76.5"
              y="69"
            />

            <AnimatedLogoGeometry side="left" />
            <AnimatedLogoGeometry side="right" />

            {/* Live Emerald Telemetry Dot + Sonar Pulse */}
            <motion.circle
              animate={{ scale: [1, 2.5], opacity: [0.6, 0] }}
              cx="72"
              cy="131"
              fill="none"
              r="6"
              stroke="#10b981"
              strokeWidth="1.5"
              style={{ transformOrigin: "72px 131px" }}
              transition={{
                duration: 2.4,
                delay: 0.8,
                ease: "easeOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
            />
            <motion.circle
              animate={{ scale: 1, opacity: 1 }}
              cx="72"
              cy="131"
              fill="#10b981"
              initial={{ scale: 0, opacity: 0 }}
              r="6"
              style={{ transformOrigin: "72px 131px" }}
              transition={{ duration: 0.35, delay: 0.55, ease: EASE_OUT }}
            />
          </g>
        </motion.g>

        {/* Minimal bottom status strip */}
        <text
          fill="#64748b"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          fontSize="10.5"
          x="28"
          y="376"
        >
          webdep · single rust binary · zero docker
        </text>
        <g transform="translate(452, 367)">
          <circle cx="0" cy="5.5" fill="#10b981" r="3" />
          <text
            fill="#94a3b8"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
            fontSize="10.5"
            x="10"
            y="9"
          >
            ~20 MB daemon RSS
          </text>
        </g>
      </svg>
    </div>
  );
}
