// Shared Astryx setup for both stacks (game dialogs + drydock designer). One
// source for the theme wrapper so the two entry points can't drift — both mount
// their React trees inside the same gothic theme / dark mode. Pair with
// `astryx.css` (reset + component styles) for the CSS half of the setup.

import { Theme } from "@astryxdesign/core/theme";
import { gothicTheme } from "@astryxdesign/theme-gothic/built";
import type { ReactNode } from "react";

/** Wrap a React tree in the Astryx gothic theme (dark). */
export const AstryxRoot = ({ children }: { children: ReactNode }) => (
  <Theme theme={gothicTheme} mode="dark">
    {children}
  </Theme>
);
