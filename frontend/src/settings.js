/** Terminal settings: kept by Yonder (so they follow you to another browser), and in this browser. */
export const DEFAULTS = {
  theme: "slate",
  fontSize: 14,
  fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace',
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  confirmPaste: true,
  autoRecord: false,
  recordFormat: "both",
};

export const FONTS = [
  ['"Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace', "Cascadia Mono / Consolas"],
  ['Consolas, "DejaVu Sans Mono", monospace', "Consolas"],
  ['"JetBrains Mono", "Cascadia Mono", Consolas, monospace', "JetBrains Mono (if installed)"],
  ['"Fira Code", "Cascadia Mono", Consolas, monospace', "Fira Code (if installed)"],
  ['"Courier New", monospace', "Courier New"],
  ["monospace", "The browser's monospace"],
];

const ANSI_DARK = {
  black: "#1C2A35", red: "#E06C5A", green: "#5DBB7A", yellow: "#E8B10E", blue: "#6CA0F0", magenta: "#C58AE0", cyan: "#4FC1C9", white: "#C9D3DB",
  brightBlack: "#5F7180", brightRed: "#F28B7A", brightGreen: "#7FD69A", brightYellow: "#F5CB4A", brightBlue: "#92BBF7", brightMagenta: "#D9A9EE", brightCyan: "#7CD8DE", brightWhite: "#F4F7FA",
};

export const THEMES = {
  slate: { name: "Slate (dark)", dark: true, colors: { background: "#1C2A35", foreground: "#E6ECF1", cursor: "#E8B10E", cursorAccent: "#1C2A35", selectionBackground: "#4E5E6B", ...ANSI_DARK } },
  night: { name: "Night (black)", dark: true, colors: { background: "#0B0E11", foreground: "#D7DDE2", cursor: "#E8B10E", cursorAccent: "#0B0E11", selectionBackground: "#3A4651", ...ANSI_DARK, black: "#0B0E11" } },
  solarized: { name: "Solarized dark", dark: true, colors: {
    background: "#002B36", foreground: "#93A1A1", cursor: "#93A1A1", cursorAccent: "#002B36", selectionBackground: "#2A4A53",
    black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900", blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
    brightBlack: "#586E75", brightRed: "#CB4B16", brightGreen: "#93A1A1", brightYellow: "#839496", brightBlue: "#839496", brightMagenta: "#6C71C4", brightCyan: "#93A1A1", brightWhite: "#FDF6E3" } },
  paper: { name: "Paper (light)", dark: false, colors: {
    background: "#FBFBF8", foreground: "#1C2A35", cursor: "#2F6FD6", cursorAccent: "#FBFBF8", selectionBackground: "#C9DAF5",
    black: "#1C2A35", red: "#B3261E", green: "#2E7D32", yellow: "#8A6100", blue: "#1F5BB8", magenta: "#8E3BA8", cyan: "#0F7C86", white: "#7C8A96",
    brightBlack: "#4E5E6B", brightRed: "#D0402F", brightGreen: "#3C9142", brightYellow: "#A87900", brightBlue: "#2F6FD6", brightMagenta: "#A24FBF", brightCyan: "#17939E", brightWhite: "#1C2A35" } },
};

/** More themes: well-known terminal colour schemes, each in its authors' published colours. */
const t = (name, dark, bg, fg, cursor, sel, ansi, extra = {}) => {
  const k = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  return { name, dark, colors: { background: bg, foreground: fg, cursor, cursorAccent: bg, selectionBackground: sel,
    ...Object.fromEntries(k.map((x, i) => [x, ansi[i]])), ...extra } };
};
Object.assign(THEMES, {
  dracula: t("Dracula", true, "#282A36", "#F8F8F2", "#F8F8F2", "#44475A",
    ["#21222C", "#FF5555", "#50FA7B", "#F1FA8C", "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2",
     "#6272A4", "#FF6E6E", "#69FF94", "#FFFFA5", "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"]),
  nord: t("Nord", true, "#2E3440", "#D8DEE9", "#D8DEE9", "#434C5E",
    ["#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
     "#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"]),
  gruvbox: t("Gruvbox dark", true, "#282828", "#EBDBB2", "#EBDBB2", "#504945",
    ["#282828", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#A89984",
     "#928374", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"]),
  onedark: t("One Dark", true, "#282C34", "#ABB2BF", "#528BFF", "#3E4451",
    ["#282C34", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#ABB2BF",
     "#5C6370", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#FFFFFF"]),
  monokai: t("Monokai", true, "#272822", "#F8F8F2", "#F8F8F0", "#49483E",
    ["#272822", "#F92672", "#A6E22E", "#F4BF75", "#66D9EF", "#AE81FF", "#A1EFE4", "#F8F8F2",
     "#75715E", "#F92672", "#A6E22E", "#F4BF75", "#66D9EF", "#AE81FF", "#A1EFE4", "#F9F8F5"]),
  tokyonight: t("Tokyo Night", true, "#1A1B26", "#C0CAF5", "#C0CAF5", "#33467C",
    ["#15161E", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#A9B1D6",
     "#414868", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#C0CAF5"]),
  catppuccin: t("Catppuccin Mocha", true, "#1E1E2E", "#CDD6F4", "#F5E0DC", "#585B70",
    ["#45475A", "#F38BA8", "#A6E3A1", "#F9E2AF", "#89B4FA", "#F5C2E7", "#94E2D5", "#BAC2DE",
     "#585B70", "#F38BA8", "#A6E3A1", "#F9E2AF", "#89B4FA", "#F5C2E7", "#94E2D5", "#A6ADC8"]),
  classic: t("Classic (PuTTY)", true, "#000000", "#BBBBBB", "#BBBBBB", "#3A3A3A",
    ["#000000", "#BB0000", "#00BB00", "#BBBB00", "#0000BB", "#BB00BB", "#00BBBB", "#BBBBBB",
     "#555555", "#FF5555", "#55FF55", "#FFFF55", "#5555FF", "#FF55FF", "#55FFFF", "#FFFFFF"]),
  solarizedlight: t("Solarized light", false, "#FDF6E3", "#657B83", "#586E75", "#EEE8D5",
    ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5",
     "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]),
  githublight: t("GitHub light", false, "#FFFFFF", "#24292F", "#0969DA", "#CCE5FF",
    ["#24292F", "#CF222E", "#116329", "#4D2D00", "#0969DA", "#8250DF", "#1B7C83", "#6E7781",
     "#57606A", "#A40E26", "#1A7F37", "#633C01", "#218BFF", "#A475F9", "#3192AA", "#8C959F"]),
});
