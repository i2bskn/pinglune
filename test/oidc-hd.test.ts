import { describe, expect, it } from "vitest";
import { parseGoogleHdSetting, passesGoogleHd } from "../src/oidc-hd";

describe("parseGoogleHdSetting", () => {
  it.each([undefined, "", "false"])("is off for %j", (value) => {
    expect(parseGoogleHdSetting(value)).toBe("off");
  });

  it("is on for true", () => {
    expect(parseGoogleHdSetting("true")).toBe("on");
  });

  // Read strictly, like OIDC_REQUIRE_EMAIL_VERIFIED: no trimming and no case folding.
  it.each(["1", "TRUE", " true", 0])("is invalid for %j", (value) => {
    expect(parseGoogleHdSetting(value)).toBe("invalid");
  });
});

describe("passesGoogleHd", () => {
  it("passes a gmail.com address without hd", () => {
    expect(passesGoogleHd("a@gmail.com", {})).toBe(true);
  });

  it("passes another address with hd", () => {
    expect(passesGoogleHd("a@example.com", { hd: "example.com" })).toBe(true);
  });

  it("does not compare hd with the domain of the email", () => {
    expect(passesGoogleHd("a@example.com", { hd: "other.example" })).toBe(true);
  });

  it.each([[{}], [{ hd: "" }], [{ hd: "  " }], [{ hd: true }], [{ hd: null }]])(
    "rejects another address with the claims %j",
    (claims) => {
      expect(passesGoogleHd("a@example.com", claims)).toBe(false);
    },
  );

  it.each([
    "a@googlemail.com",
    "a@gmail.com.example.com",
    // Split at the last @. The hook never passes such an address; this is a defense.
    "x@gmail.com@example.com",
    // Without @, not a Gmail address.
    "gmail.com",
  ])("does not treat %j as a Gmail address", (email) => {
    expect(passesGoogleHd(email, {})).toBe(false);
    expect(passesGoogleHd(email, { hd: "example.com" })).toBe(true);
  });
});
