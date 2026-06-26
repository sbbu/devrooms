import type { Theme } from './themes';

// Curated theme catalog — canonical, web-verified palettes. Each theme carries
// BOTH a dark and a light variant so it can follow the appearance (light/dark)
// without the user ever picking a mode. Each variant maps the theme's signature
// accent into the `cyan` slot (active/selection), its yellow into `yellow`
// (warning), red into `red`, green into `green`. The terminal object is the
// theme's published xterm/ANSI palette, so agent TUIs inherit it.
//
// The built-in `devrooms` theme lives in themes.ts and is always present even if
// this list is empty.
//
// Each variant's `terminal` block is the canonical published ANSI palette. A few
// UI accent/success slots are nudged darker/lighter from the strict canonical hex
// purely so base-colored text on the inverted-selection block and brand fill
// stays legible (WCAG) — most visible on light variants, where pastel accents
// would otherwise wash out under white text.
export const CURATED_THEMES: Theme[] = [
  {
    id: 'tokyo-night', name: 'Tokyo Night',
    dark: {
      ui: { base: '#1a1b26', surface: '#292e42', hairline: '#1f2335', hairline2: '#3b4261', fg: '#c0caf5', dim: '#a9b1d6', faint: '#565f89', cyan: '#7aa2f7', yellow: '#e0af68', red: '#f7768e', green: '#9ece6a' },
      terminal: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#283457', black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#9fe044', brightYellow: '#faba4a', brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#c0caf5' },
    },
    light: { // Tokyo Night Day
      ui: { base: '#e1e2e7', surface: '#d6d8e3', hairline: '#c4c8da', hairline2: '#a8aecb', fg: '#3760bf', dim: '#7782ab', faint: '#a1a6c5', cyan: '#2e7de9', yellow: '#8c6c3e', red: '#f52a65', green: '#587539' },
      terminal: { background: '#e1e2e7', foreground: '#3760bf', cursor: '#3760bf', cursorAccent: '#e1e2e7', selectionBackground: '#99a7df', black: '#e9e9ed', red: '#f52a65', green: '#587539', yellow: '#8c6c3e', blue: '#2e7de9', magenta: '#9854f1', cyan: '#007197', white: '#6172b0', brightBlack: '#a1a6c5', brightRed: '#f52a65', brightGreen: '#587539', brightYellow: '#8c6c3e', brightBlue: '#2e7de9', brightMagenta: '#9854f1', brightCyan: '#007197', brightWhite: '#3760bf' },
    },
  },
  {
    id: 'catppuccin', name: 'Catppuccin',
    dark: { // Mocha
      ui: { base: '#1e1e2e', surface: '#313244', hairline: '#45475a', hairline2: '#585b70', fg: '#cdd6f4', dim: '#a6adc8', faint: '#6c7086', cyan: '#cba6f7', yellow: '#f9e2af', red: '#f38ba8', green: '#a6e3a1' },
      terminal: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' },
    },
    light: { // Latte
      ui: { base: '#eff1f5', surface: '#e6e9ef', hairline: '#dce0e8', hairline2: '#ccd0da', fg: '#4c4f69', dim: '#6c6f85', faint: '#9ca0b0', cyan: '#8839ef', yellow: '#df8e1d', red: '#d20f39', green: '#2e7d20' },
      terminal: { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5', selectionBackground: '#ccd0da', black: '#bcc0cc', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#5c5f77', brightBlack: '#acb0be', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#6c6f85' },
    },
  },
  {
    id: 'gruvbox', name: 'Gruvbox',
    dark: {
      ui: { base: '#282828', surface: '#3c3836', hairline: '#504945', hairline2: '#665c54', fg: '#ebdbb2', dim: '#a89984', faint: '#928374', cyan: '#8ec07c', yellow: '#fabd2f', red: '#fb4934', green: '#b8bb26' },
      terminal: { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945', black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984', brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2' },
    },
    light: { // Gruvbox Light — faded accents for legibility on the cream base
      ui: { base: '#fbf1c7', surface: '#ebdbb2', hairline: '#d5c4a1', hairline2: '#bdae93', fg: '#3c3836', dim: '#7c6f64', faint: '#a89984', cyan: '#427b58', yellow: '#b57614', red: '#9d0006', green: '#79740e' },
      terminal: { background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7', selectionBackground: '#d5c4a1', black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64', brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#3c3836' },
    },
  },
  {
    id: 'nord', name: 'Nord',
    dark: {
      ui: { base: '#2e3440', surface: '#3b4252', hairline: '#434c5e', hairline2: '#4c566a', fg: '#eceff4', dim: '#d8dee9', faint: '#616e88', cyan: '#88c0d0', yellow: '#ebcb8b', red: '#bf616a', green: '#a3be8c' },
      terminal: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
    },
    light: { // Nord Light (Snow Storm base) — accents darkened for white-on-fill legibility
      ui: { base: '#e5e9f0', surface: '#dde4ee', hairline: '#d8dee9', hairline2: '#c2cad8', fg: '#2e3440', dim: '#4c566a', faint: '#7b88a1', cyan: '#5e81ac', yellow: '#a98b3d', red: '#b0444e', green: '#5f7a4a' },
      terminal: { background: '#e5e9f0', foreground: '#414858', cursor: '#7bb3c3', cursorAccent: '#e5e9f0', selectionBackground: '#d8dee9', black: '#3b4252', red: '#bf616a', green: '#96b17f', yellow: '#c5a565', blue: '#81a1c1', magenta: '#b48ead', cyan: '#7bb3c3', white: '#a5abb6', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#96b17f', brightYellow: '#c5a565', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#82afae', brightWhite: '#eceff4' },
    },
  },
  {
    id: 'dracula', name: 'Dracula',
    dark: {
      ui: { base: '#282a36', surface: '#44475a', hairline: '#343746', hairline2: '#3d404f', fg: '#f8f8f2', dim: '#6272a4', faint: '#4b4e63', cyan: '#bd93f9', yellow: '#f1fa8c', red: '#ff5555', green: '#50fa7b' },
      terminal: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
    },
    light: { // Alucard (Dracula's official light theme)
      ui: { base: '#fffbeb', surface: '#f4efd8', hairline: '#e6e0c4', hairline2: '#d2ccae', fg: '#1f1f1f', dim: '#6c664b', faint: '#a8a079', cyan: '#644ac9', yellow: '#846e15', red: '#cb3a2a', green: '#14710a' },
      terminal: { background: '#fffbeb', foreground: '#1f1f1f', cursor: '#1f1f1f', cursorAccent: '#fffbeb', selectionBackground: '#cfcfde', black: '#fffbeb', red: '#cb3a2a', green: '#14710a', yellow: '#846e15', blue: '#644ac9', magenta: '#a3144d', cyan: '#036a96', white: '#1f1f1f', brightBlack: '#6c664b', brightRed: '#d74c3d', brightGreen: '#198d0c', brightYellow: '#9e841a', brightBlue: '#7862d0', brightMagenta: '#bf185a', brightCyan: '#047fb4', brightWhite: '#2c2b31' },
    },
  },
  {
    id: 'solarized', name: 'Solarized',
    dark: {
      ui: { base: '#002b36', surface: '#073642', hairline: '#0a4250', hairline2: '#586e75', fg: '#839496', dim: '#657b83', faint: '#586e75', cyan: '#2aa198', yellow: '#b58900', red: '#dc322f', green: '#859900' },
      terminal: { background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
    },
    light: {
      ui: { base: '#fdf6e3', surface: '#eee8d5', hairline: '#e3ddc8', hairline2: '#93a1a1', fg: '#657b83', dim: '#839496', faint: '#93a1a1', cyan: '#1668a3', yellow: '#b58900', red: '#dc322f', green: '#5f7300' },
      terminal: { background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
    },
  },
  {
    id: 'rose-pine', name: 'Rosé Pine',
    dark: {
      ui: { base: '#191724', surface: '#1f1d2e', hairline: '#26233a', hairline2: '#403d52', fg: '#e0def4', dim: '#908caa', faint: '#6e6a86', cyan: '#9ccfd8', yellow: '#f6c177', red: '#eb6f92', green: '#3e8aa8' },
      terminal: { background: '#191724', foreground: '#e0def4', cursor: '#e0def4', cursorAccent: '#191724', selectionBackground: '#403d52', black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4', brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4' },
    },
    light: { // Rosé Pine Dawn — accents darkened for legibility on the near-white base
      ui: { base: '#faf4ed', surface: '#f2e9e1', hairline: '#dfdad9', hairline2: '#cecacd', fg: '#575279', dim: '#797593', faint: '#9893a5', cyan: '#357b86', yellow: '#9a6e1a', red: '#a8475f', green: '#286983' },
      terminal: { background: '#faf4ed', foreground: '#575279', cursor: '#575279', cursorAccent: '#faf4ed', selectionBackground: '#dfdad9', black: '#f2e9e1', red: '#b4637a', green: '#286983', yellow: '#ea9d34', blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e', white: '#575279', brightBlack: '#9893a5', brightRed: '#b4637a', brightGreen: '#286983', brightYellow: '#ea9d34', brightBlue: '#56949f', brightMagenta: '#907aa9', brightCyan: '#d7827e', brightWhite: '#575279' },
    },
  },
  {
    id: 'one', name: 'One',
    dark: { // One Dark
      ui: { base: '#282c34', surface: '#2c313a', hairline: '#3b4048', hairline2: '#4b5263', fg: '#abb2bf', dim: '#828997', faint: '#5c6370', cyan: '#61afef', yellow: '#e5c07b', red: '#e06c75', green: '#98c379' },
      terminal: { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451', black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#d19a66', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#d19a66', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
    },
    light: { // One Light — accents darkened for white-on-fill legibility
      ui: { base: '#fafafa', surface: '#ececed', hairline: '#dcdcdd', hairline2: '#c6c6c8', fg: '#383a42', dim: '#696c77', faint: '#a0a1a7', cyan: '#4078f2', yellow: '#b07d00', red: '#d23b30', green: '#3f8c3f' },
      terminal: { background: '#fafafa', foreground: '#383a42', cursor: '#4078f2', cursorAccent: '#fafafa', selectionBackground: '#e5e5e6', black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#fafafa', brightBlack: '#a0a1a7', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401', brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#ffffff' },
    },
  },
];
