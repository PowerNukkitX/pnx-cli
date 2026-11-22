// Builds the README banner (dark + light) around the official site mark.
//
//   node packages/cli/scripts/make-banner.mjs
//
// The icon's own paths are inlined, not linked: GitHub serves README images
// through a proxy that never resolves an SVG's external references, so a
// linked icon would render as an empty square. Fonts are system stacks for
// the same reason - an SVG shown as an image loads no web font.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const out = join(root, 'assets');
mkdirSync(out, { recursive: true });

const icon = readFileSync(join(here, '..', 'assets', 'icon.svg'), 'utf8');
const inner = icon.slice(icon.indexOf('>', icon.indexOf('<svg')) + 1, icon.lastIndexOf('</svg>'));

const W = 1280;
const H = 400;
const SANS = "'Segoe UI', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Cascadia Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace";

const themes = {
    dark: {
        bg: '#0a0a0a', grid: '#ffffff', gridOpacity: 0.045, glow: 0.32, title: '#fafafa', muted: '#a3a3a3',
        pill: '#111111', pillBorder: '#262626', mono: '#e5e5e5', ring: '#1f1f1f',
    },
    light: {
        bg: '#fafafa', grid: '#0a0a0a', gridOpacity: 0.06, glow: 0.22, title: '#0a0a0a', muted: '#525252',
        pill: '#ffffff', pillBorder: '#e5e5e5', mono: '#171717', ring: '#e5e5e5',
    },
};

function banner(t) {
    const iconSize = 208;
    const ix = 96;
    const iy = (H - iconSize) / 2;
    const tx = ix + iconSize + 64;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="PowerNukkitX CLI">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="${t.grid}" stroke-opacity="${t.gridOpacity}" stroke-width="1"/>
    </pattern>
    <radialGradient id="glow" cx="${(ix + iconSize / 2) / W}" cy="0.5" r="0.42">
      <stop offset="0" stop-color="#25d35c" stop-opacity="${t.glow}"/>
      <stop offset="1" stop-color="#25d35c" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#25d35c"/>
      <stop offset="1" stop-color="#00af37"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t.bg}" stop-opacity="0"/>
      <stop offset="1" stop-color="${t.bg}" stop-opacity="1"/>
    </linearGradient>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="24"/></clipPath>
    <clipPath id="icon"><rect x="${ix}" y="${iy}" width="${iconSize}" height="${iconSize}" rx="36"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="${t.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#grid)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <rect y="${H - 120}" width="${W}" height="120" fill="url(#fade)"/>
    <rect x="${ix - 6}" y="${iy - 6}" width="${iconSize + 12}" height="${iconSize + 12}" rx="42" fill="none" stroke="${t.ring}" stroke-width="2"/>
    <g clip-path="url(#icon)">
      <g transform="translate(${ix} ${iy}) scale(${iconSize / 200})">${inner}</g>
    </g>
    <text x="${tx}" y="${H / 2 - 30}" font-family="${SANS}" font-size="72" font-weight="800" letter-spacing="-2" fill="${t.title}">PowerNukkitX<tspan dx="22" fill="url(#accent)">CLI</tspan></text>
    <text x="${tx + 2}" y="${H / 2 + 18}" font-family="${SANS}" font-size="26" fill="${t.muted}">Create, run and look after Minecraft Bedrock servers.</text>
    <rect x="${tx}" y="${H / 2 + 50}" width="460" height="56" rx="12" fill="${t.pill}" stroke="${t.pillBorder}"/>
    <text x="${tx + 24}" y="${H / 2 + 86}" font-family="${MONO}" font-size="22" fill="${t.mono}"><tspan fill="#25d35c">$</tspan> npx @powernukkitx/cli init</text>
  </g>
</svg>
`;
}

for (const [name, theme] of Object.entries(themes)) {
    const file = join(out, `banner-${name}.svg`);
    writeFileSync(file, banner(theme));
    console.log('wrote', file);
}
