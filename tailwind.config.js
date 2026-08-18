import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Orb / agent-state palette — every value resolves from a CSS variable.
        aria: {
          idle: 'hsl(var(--aria-idle))',
          listening: 'hsl(var(--aria-listening))',
          thinking: 'hsl(var(--aria-thinking))',
          speaking: 'hsl(var(--aria-speaking))',
          acting: 'hsl(var(--aria-acting))',
          grid: 'hsl(var(--aria-grid))',
        },
        risk: {
          low: 'hsl(var(--risk-low))',
          medium: 'hsl(var(--risk-medium))',
          high: 'hsl(var(--risk-high))',
        },
        // Semantic status colours. `text-danger` and `text-success` were used
        // in components long before these existed, and rendered unstyled —
        // Tailwind silently drops a class it cannot resolve.
        success: 'hsl(var(--success))',
        danger: 'hsl(var(--danger))',
        'accent-purple': 'hsl(var(--accent-purple))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // Resolved through the CSS variables so the font stack is defined in
      // exactly one place — globals.css — rather than drifting between here
      // and the stylesheet, which is how Orbitron ended up named but unloaded.
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'aria-scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'aria-flicker': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.72' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'aria-scan': 'aria-scan 7s linear infinite',
        'aria-flicker': 'aria-flicker 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
};
