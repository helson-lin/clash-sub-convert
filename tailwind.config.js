/** @type {import('tailwindcss').Config} */
export default {
  content: ["./pages/index.html"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      colors: {
        paper: "#F9F9F7",
        ink: "#2D2D2B",
        accent: "#CC7D5E",
      },
    },
  },
  plugins: [],
};
