import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

/**
 * Structural validation for n8n/workflows/*.json — see docs/N8N_WORKFLOWS.md
 * for the honest caveat: no live n8n instance was available in this dev
 * environment to actually import/run these, so this test (valid n8n export
 * shape + every HTTP node targets a real endpoint this app implements) plus
 * the manual smoke-test checklist in that doc is the realistic bar for
 * "tested" here.
 */

const WORKFLOWS_DIR = path.resolve(__dirname, "../../../../n8n/workflows");

// Every path an HTTP Request node in these workflows is allowed to target —
// each one must correspond to a real route file in apps/web/app/api. This
// list is intentionally exhaustive (not a prefix match) so a workflow
// referencing a made-up/dead endpoint fails this test immediately.
const REAL_ENDPOINT_PATHS = [
  "/api/webhooks/n8n/lead-intake",
  "/api/webhooks/n8n/crm-lead-call",
  "/api/webhooks/n8n/qualified-lead-whatsapp",
  "/api/webhooks/n8n/due-appointments",
  "/api/webhooks/n8n/no-answer-leads",
  "/api/webhooks/n8n/daily-summary",
];

const REAL_ROUTE_FILES: Record<string, string> = {
  "/api/webhooks/n8n/lead-intake": "app/api/webhooks/n8n/lead-intake/route.ts",
  "/api/webhooks/n8n/crm-lead-call": "app/api/webhooks/n8n/crm-lead-call/route.ts",
  "/api/webhooks/n8n/qualified-lead-whatsapp": "app/api/webhooks/n8n/qualified-lead-whatsapp/route.ts",
  "/api/webhooks/n8n/due-appointments": "app/api/webhooks/n8n/due-appointments/route.ts",
  "/api/webhooks/n8n/no-answer-leads": "app/api/webhooks/n8n/no-answer-leads/route.ts",
  "/api/webhooks/n8n/daily-summary": "app/api/webhooks/n8n/daily-summary/route.ts",
};

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

function extractHttpRequestUrls(workflow: { nodes: Array<{ type: string; parameters?: Record<string, unknown> }> }): string[] {
  return workflow.nodes
    .filter((n) => n.type === "n8n-nodes-base.httpRequest")
    .map((n) => n.parameters?.url as string)
    .filter(Boolean);
}

describe("n8n workflow JSON exports — structural validation", () => {
  const files = listWorkflowFiles();

  it("finds at least the 6 required workflows for Phase 6", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)("%s is valid n8n export JSON (name, nodes[], connections)", (file) => {
    const raw = readFileSync(file, "utf-8");
    const workflow = JSON.parse(raw);

    expect(typeof workflow.name).toBe("string");
    expect(workflow.name.length).toBeGreaterThan(0);
    expect(Array.isArray(workflow.nodes)).toBe(true);
    expect(workflow.nodes.length).toBeGreaterThan(0);
    expect(typeof workflow.connections).toBe("object");

    for (const node of workflow.nodes) {
      expect(typeof node.id).toBe("string");
      expect(typeof node.name).toBe("string");
      expect(typeof node.type).toBe("string");
      expect(node.type.startsWith("n8n-nodes-base.")).toBe(true);
      expect(Array.isArray(node.position)).toBe(true);
    }

    // Every node name referenced as a connection target must exist among
    // the workflow's own node names — no dangling/fabricated connections.
    const nodeNames = new Set(workflow.nodes.map((n: { name: string }) => n.name));
    for (const targets of Object.values(workflow.connections) as Array<
      { main?: Array<Array<{ node: string }>> } | Array<Array<{ node: string }>>
    >) {
      const branches = Array.isArray(targets) ? targets : (targets.main ?? []);
      for (const branch of branches) {
        for (const edge of branch) {
          expect(nodeNames.has(edge.node)).toBe(true);
        }
      }
    }
  });

  it.each(files)("%s's HTTP Request nodes only reference this app's own real endpoints, never a fabricated one", (file) => {
    const workflow = JSON.parse(readFileSync(file, "utf-8"));
    const urls = extractHttpRequestUrls(workflow);
    expect(urls.length).toBeGreaterThan(0);

    for (const url of urls) {
      const matched = REAL_ENDPOINT_PATHS.find((p) => url.includes(p));
      expect(matched, `URL "${url}" in ${path.basename(file)} does not match any real endpoint`).toBeTruthy();
      // The endpoint must also point at an APP_BASE_URL-relative path (own
      // app), never a hardcoded third-party/dead host.
      expect(url).toContain("$env.APP_BASE_URL");
    }
  });

  it("every real endpoint a workflow references actually exists as a route file", () => {
    for (const [urlPath, routeFile] of Object.entries(REAL_ROUTE_FILES)) {
      const full = path.resolve(WORKFLOWS_DIR, "../../apps/web", routeFile);
      expect(() => readFileSync(full), `missing route file for ${urlPath}: ${full}`).not.toThrow();
    }
  });
});
