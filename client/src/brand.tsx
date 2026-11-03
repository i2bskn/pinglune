import { BRAND_LOGO_DARK, BRAND_LOGO_HEIGHT, BRAND_LOGO_LIGHT, BRAND_LOGO_WIDTH } from "../../src/brand";

// The logo for the header: the color version, or the white one on dark backgrounds. Decorative: the link around it
// is named by its screen-reader text.
export function BrandLogo() {
  return (
    <picture className="brand-logo">
      <source srcSet={BRAND_LOGO_DARK} media="(prefers-color-scheme: dark)" />
      <img src={BRAND_LOGO_LIGHT} width={BRAND_LOGO_WIDTH} height={BRAND_LOGO_HEIGHT} alt="" />
    </picture>
  );
}
