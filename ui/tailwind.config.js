/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Design tokens resolve to process-vars (--pi-*) switched by data-theme.
        bg: "rgb(var(--pi-bg) / <alpha-value>)",
        fg: "rgb(var(--pi-fg) / <alpha-value>)",
        dim: "rgb(var(--pi-dim) / <alpha-value>)",
        faint: "rgb(var(--pi-faint) / <alpha-value>)",
        card: "rgb(var(--pi-card) / <alpha-value>)",
        input: "rgb(var(--pi-input) / <alpha-value>)",
        chip: "rgb(var(--pi-chip) / <alpha-value>)",
        border: "rgb(var(--pi-border) / <alpha-value>)",
        sidebar: "rgb(var(--pi-sidebar) / <alpha-value>)",
        bar: "rgb(var(--pi-bar) / <alpha-value>)",
        accent: "rgb(var(--pi-accent) / <alpha-value>)",
        ok: "rgb(var(--pi-ok) / <alpha-value>)",
        err: "rgb(var(--pi-err) / <alpha-value>)",
        conn: "rgb(var(--pi-conn) / <alpha-value>)",
        sys: "rgb(var(--pi-sys) / <alpha-value>)",
        model: "rgb(var(--pi-model) / <alpha-value>)",
        host: "rgb(var(--pi-host) / <alpha-value>)",
        pg: "rgb(var(--pi-pg) / <alpha-value>)",
        stream: "rgb(var(--pi-stream) / <alpha-value>)",
        evt: "rgb(var(--pi-evt) / <alpha-value>)",
        wh: "rgb(var(--pi-wh) / <alpha-value>)",
      },
      fontFamily: {
        mono: ["JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", "Monaco", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 12px -2px var(--glow)",
      },
    },
  },
  plugins: [],
};