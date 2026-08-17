// Design system from ui-ux-pro-max (design-system/offer-generator/MASTER.md):
// Minimalism & Swiss Style — professional blue primary (#2563EB), deal green
// accent (#059669), slate neutrals on #F8FAFC, Plus Jakarta Sans throughout.
// Components use Tailwind's blue/emerald/slate scales, which contain the
// system's exact hexes (blue-600, emerald-600, slate-50/900).
export default {
  // ../shared is in here because the offer-status vocabulary carries its own
  // pill/dot classes (bg-sky-100, bg-rose-400…). Tailwind only emits classes it
  // finds as literal strings in `content`, so leaving that directory out makes
  // those pills silently render with no background — visible only at runtime.
  content: ["./index.html", "./src/**/*.{js,jsx}", "../shared/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
