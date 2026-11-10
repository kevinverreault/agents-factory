# A Windows Terminal colour scheme for the TUI

The TUI colours only text. It never paints the terminal's background, so it works on any dark terminal. In a truecolour terminal such as Windows Terminal, the TUI uses the design system's hex values (`src/tui/theme.ts`). Elsewhere it falls back to the 16 ANSI colours.

This optional scheme gives the terminal the design system's dark background and foreground. It also sets the ANSI colours to the theme's 16-colour table, so the fallback matches the theme too. To use it:

1. Open Windows Terminal's settings (`ctrl+,`).
2. Click **Open JSON file**.
3. Add the scheme below to `schemes`.
4. Set `"colorScheme": "agents-factory"` on the profile you run the TUI in.

```json
{
  "name": "agents-factory",
  "background": "#1A1A1A",
  "foreground": "#FFFFFF",
  "cursorColor": "#9FCE7E",
  "selectionBackground": "#333333",
  "black": "#1A1A1A",
  "red": "#F07575",
  "green": "#53C67D",
  "yellow": "#FAB338",
  "blue": "#7FA7C9",
  "purple": "#D28C79",
  "cyan": "#7FC4B8",
  "white": "#FFFFFF",
  "brightBlack": "#999999",
  "brightRed": "#F07575",
  "brightGreen": "#9FCE7E",
  "brightYellow": "#FAB338",
  "brightBlue": "#7FA7C9",
  "brightPurple": "#D28C79",
  "brightCyan": "#7FC4B8",
  "brightWhite": "#FFFFFF"
}
```

| ANSI colour | Theme role | Design system source |
|---|---|---|
| black (background) | text on the active tab | `--color-background` 160 0% 10% |
| white / brightWhite | `fg` | `--color-on-background` 0 0% 100% |
| brightGreen | `accent` | `--color-accent` (sauge) 95 45% 65% |
| green | `ok` | `--color-success` 142 50% 55% |
| yellow | `warn` | `--color-warning` 38 95% 60% |
| red | `bad` | `--color-error-text` 0 80% 70% |
| purple (magenta) | `review` | TUI-only: terracotta lifted to 13 50% 65% |
| brightBlack (gray) | `dim`, `line` | TUI-only: 160 0% 60% |

Three things to know:

- **Lines in the 16-colour fallback:** `dim` and `line` both fall back to gray. In truecolour, rules and dividers use `--color-surface` (`#333333`).
- **Blue and cyan:** the theme doesn't use them. The scheme gives them muted values so other programs still look right.
- **Turning colour off:** set `NO_COLOR` to run the TUI in monochrome.
