// Design system from ui-ux-pro-max (design-system/offer-generator/MASTER.md):
// Minimalism & Swiss Style — professional blue primary (#2563EB), deal green
// accent (#059669), slate neutrals on #F8FAFC, Plus Jakarta Sans throughout.
// Components use Tailwind's blue/emerald/slate scales, which contain the
// system's exact hexes (blue-600, emerald-600, slate-50/900).
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
