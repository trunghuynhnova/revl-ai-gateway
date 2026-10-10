/** Build the site stylesheet with:
 *    npx tailwindcss@3.4.17 -c tailwind.config.cjs -i styles/tailwind.css -o revl-ai/assets/site.css --minify
 *  Run it again whenever a page under revl-ai/ gains or loses Tailwind classes. */
module.exports = {
  content: ['./revl-ai/*.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        brand: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8',
          500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(99,102,241,.25), 0 20px 60px -20px rgba(99,102,241,.45)',
      },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      },
      animation: {
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
      },
    },
  },
};
