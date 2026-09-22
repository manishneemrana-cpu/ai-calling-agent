import { describe, it, expect } from "vitest";
import { extractSubdomain } from "@/lib/reseller/branding";

describe("extractSubdomain — white-label subdomain routing helper", () => {
  const base = "yourplatform.example";

  it("extracts the reseller slug from {slug}.<base>", () => {
    expect(extractSubdomain("acme.yourplatform.example", base)).toBe("acme");
  });

  it("returns null for the bare base domain", () => {
    expect(extractSubdomain("yourplatform.example", base)).toBeNull();
  });

  it("returns null for www.<base>", () => {
    expect(extractSubdomain("www.yourplatform.example", base)).toBeNull();
  });

  it("returns null for a host that isn't a subdomain of base at all (a custom domain candidate)", () => {
    expect(extractSubdomain("voice.clientdomain.com", base)).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractSubdomain("ACME.YourPlatform.Example", base)).toBe("acme");
  });

  it("handles a port suffix being stripped by the caller (host already has no port)", () => {
    expect(extractSubdomain("acme.yourplatform.example", base)).toBe("acme");
  });
});
