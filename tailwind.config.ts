import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0b0d10",
          panel: "#13171c",
          row: "#181d23",
        },
        line: "#222831",
        text: {
          primary: "#e6e9ee",
          muted: "#8a93a0",
          dim: "#5b6470",
        },
        accent: {
          green: "#3fb950",
          yellow: "#d29922",
          orange: "#db6d28",
          red: "#f85149",
          blue: "#58a6ff",
          purple: "#a371f7",
        },
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
