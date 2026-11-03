// The Pinglune brand. Shared by the SPA (client/src/brand.tsx) and the screens served by the Worker
// (src/views/layout.tsx). This module must not import anything, because the client bundles it.
export const BRAND_NAME = "Pinglune";
export const BRAND_TAGLINE = "イベントを受け取り、AIエージェントへ届ける。";

// The horizontal logo (client/public/brand): the color version for light backgrounds, the white one for dark
// backgrounds. The size is that of the SVGs' viewBox; CSS sets the height shown.
export const BRAND_LOGO_LIGHT = "/brand/pinglune-horizontal-color.svg";
export const BRAND_LOGO_DARK = "/brand/pinglune-horizontal-white.svg";
export const BRAND_LOGO_WIDTH = 440;
export const BRAND_LOGO_HEIGHT = 128;
