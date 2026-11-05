import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /**
         * ⚠ LEFT EXACTLY AS IT WAS, ON PURPOSE. This is stock Tailwind `blue` under a
         * different name, and ~20 routes still reference `bg-primary-600` and friends.
         * Removing it in the same change that introduces the semantic tokens below would
         * turn a contained pilot into a portal-wide rewrite. It is the thing the token
         * layer is designed to replace, not something to replace in passing.
         */
        primary: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
          950: "#172554",
        },

        /**
         * The semantic layer, defined in src/app/globals.css. Names describe ROLE
         * ("the colour of subtle text") rather than appearance, which is what lets
         * `[data-theme="linear"]` restyle the portal by overriding variables instead of
         * editing components.
         *
         * ⚠ THE VARIABLES HOLD BARE RGB CHANNELS ("28 29 33"), NOT HEX, and that is what makes
         * `bg-surface-1/50` work. They were plain hex at first, which silently produced NO
         * background for every opacity modifier in the codebase — and there are a dozen of
         * those (`bg-gray-50/50`, `bg-primary-50/40`, `bg-black/50`). Channels plus
         * `<alpha-value>` is the only form Tailwind can compose an alpha into, so a token is
         * useless for those cases in any other format.
         *
         * ⚠ THE CONSEQUENCE: these variables cannot be used in raw CSS as `color: var(--ink)`.
         * It has to be `rgb(var(--ink))`. Two places rely on that — the `color-scheme` block in
         * globals.css and the overlay shadow — and both are written accordingly.
         */
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: {
          1: "rgb(var(--surface-1) / <alpha-value>)",
          2: "rgb(var(--surface-2) / <alpha-value>)",
          3: "rgb(var(--surface-3) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          muted: "rgb(var(--ink-muted) / <alpha-value>)",
          subtle: "rgb(var(--ink-subtle) / <alpha-value>)",
          tertiary: "rgb(var(--ink-tertiary) / <alpha-value>)",
        },
        hairline: {
          DEFAULT: "rgb(var(--hairline) / <alpha-value>)",
          soft: "rgb(var(--hairline-soft) / <alpha-value>)",
          strong: "rgb(var(--hairline-strong) / <alpha-value>)",
        },
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          hover: "rgb(var(--brand-hover) / <alpha-value>)",
          ink: "rgb(var(--brand-ink) / <alpha-value>)",
          subtle: "rgb(var(--brand-subtle) / <alpha-value>)",
          text: "rgb(var(--brand-text) / <alpha-value>)",
          "text-strong": "rgb(var(--brand-text-strong) / <alpha-value>)",
          border: "rgb(var(--brand-border) / <alpha-value>)",
          wash: "rgb(var(--brand-wash) / <alpha-value>)",
        },
        status: {
          active: "rgb(var(--status-active) / <alpha-value>)",
          pending: "rgb(var(--status-pending) / <alpha-value>)",
          idle: "rgb(var(--status-idle) / <alpha-value>)",
        },

        /**
         * Form and feedback, for the auth journey's seven screens.
         *
         * `danger` and `notice` rather than `red` and `blue`, for the same reason the
         * statuses above are named by state: the hue is a consequence of the meaning, and in
         * the Linear palette `notice` is deliberately NOT blue — it sits in the brand's
         * lavender family so the page keeps a single accent.
         */
        field: {
          border: "rgb(var(--field-border) / <alpha-value>)",
          placeholder: "rgb(var(--field-placeholder) / <alpha-value>)",
        },
        danger: {
          bg: "rgb(var(--danger-bg) / <alpha-value>)",
          border: "rgb(var(--danger-border) / <alpha-value>)",
          DEFAULT: "rgb(var(--danger-text) / <alpha-value>)",
          text: "rgb(var(--danger-text) / <alpha-value>)",
          "text-strong": "rgb(var(--danger-text-strong) / <alpha-value>)",
          "field-bg": "rgb(var(--danger-field-bg) / <alpha-value>)",
          "field-border": "rgb(var(--danger-field-border) / <alpha-value>)",
        },
        notice: {
          bg: "rgb(var(--notice-bg) / <alpha-value>)",
          border: "rgb(var(--notice-border) / <alpha-value>)",
          DEFAULT: "rgb(var(--notice-text) / <alpha-value>)",
          text: "rgb(var(--notice-text) / <alpha-value>)",
        },
        warn: {
          bg: "rgb(var(--warn-bg) / <alpha-value>)",
          border: "rgb(var(--warn-border) / <alpha-value>)",
          DEFAULT: "rgb(var(--warn-text) / <alpha-value>)",
          text: "rgb(var(--warn-text) / <alpha-value>)",
        },
        success: {
          bg: "rgb(var(--success-bg) / <alpha-value>)",
          border: "rgb(var(--success-border) / <alpha-value>)",
          DEFAULT: "rgb(var(--success-text) / <alpha-value>)",
          text: "rgb(var(--success-text) / <alpha-value>)",
        },

        /**
         * The categorical palette. Numbered rather than named on purpose: the moment one is
         * called `teal` somebody will reach for it because they want a teal thing, and the set
         * stops being "eight distinguishable hues" and becomes eight opinions.
         *
         * Usage is `text-series-2` for the label with `bg-series-2/10` and `border-series-2/25`
         * for its tint — one hue, three roles, composed by alpha.
         */
        series: {
          1: "rgb(var(--series-1) / <alpha-value>)",
          2: "rgb(var(--series-2) / <alpha-value>)",
          3: "rgb(var(--series-3) / <alpha-value>)",
          4: "rgb(var(--series-4) / <alpha-value>)",
          5: "rgb(var(--series-5) / <alpha-value>)",
          6: "rgb(var(--series-6) / <alpha-value>)",
          7: "rgb(var(--series-7) / <alpha-value>)",
          8: "rgb(var(--series-8) / <alpha-value>)",
        },
      },

      /**
       * Linear's display sizes carry measured negative tracking (-3px at 80px, -0.4px at
       * 22px) — it is most of what separates their headings from default Inter. Exposed as
       * named steps so a heading picks a pairing rather than hand-tuning a pixel value.
       */
      letterSpacing: {
        "display-tight": "-0.045em",
        "heading-tight": "-0.022em",
        "title-tight": "-0.018em",
      },
    },
  },
  plugins: [typography],
};

export default config;
