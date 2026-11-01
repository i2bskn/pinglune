import { BRAND_NAME } from "../../src/brand";

// The name for the header, as text until a logo exists. Decorative: the link around it is named by its
// screen-reader text.
export function BrandLogo() {
  return (
    <span className="brand-name" aria-hidden="true">
      {BRAND_NAME}
    </span>
  );
}
