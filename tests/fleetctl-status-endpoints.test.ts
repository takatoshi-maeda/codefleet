import { describe, expect, it, vi } from "vitest";
import { resolveFleetEndpointsFromApi } from "../src/cli/commands/fleetctl.js";

describe("resolveFleetEndpointsFromApi", () => {
  it("queries the running api server endpoint first", async () => {
    const payload = {
      projectId: "acme/codefleet",
      self: {
        pid: 101,
        host: "127.0.0.1",
        port: 3290,
        endpoint: "http://127.0.0.1:3290",
      },
      peers: [],
      updatedAt: "2026-03-05T00:00:00.000Z",
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const resolved = await resolveFleetEndpointsFromApi(
      {
        apiServer: { state: "running", host: "127.0.0.1", port: 3290 },
        discoveredApiServers: [{ host: "127.0.0.1", port: 3390 }],
      },
      { fetchFn },
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3290/api/codefleet/endpoints");
    expect(resolved).toEqual(payload);
  });

  it("falls back to discovered peers when the first endpoint fails", async () => {
    const payload = {
      projectId: "acme/codefleet",
      self: {
        pid: 202,
        host: "127.0.0.1",
        port: 3390,
        endpoint: "http://127.0.0.1:3390",
      },
      peers: [
        {
          projectId: "acme/codefleet",
          instanceId: "cf-peer",
          pid: 203,
          host: "127.0.0.1",
          port: 3391,
          endpoint: "http://127.0.0.1:3391",
          startedAt: "2026-03-05T00:00:00.000Z",
          lastHeartbeat: "2026-03-05T00:00:05.000Z",
        },
      ],
      updatedAt: "2026-03-05T00:00:10.000Z",
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const resolved = await resolveFleetEndpointsFromApi(
      {
        apiServer: { state: "running", host: "127.0.0.1", port: 3290 },
        discoveredApiServers: [
          { host: "127.0.0.1", port: 3390 },
          { host: "127.0.0.1", port: 3390 },
        ],
      },
      { fetchFn },
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3390/api/codefleet/endpoints");
    expect(resolved).toEqual(payload);
  });

  it("returns null when no reachable endpoint returns valid payload", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invalid: true }), { status: 200 }));

    const resolved = await resolveFleetEndpointsFromApi(
      {
        apiServer: { state: "running", host: "127.0.0.1", port: 3290 },
        discoveredApiServers: [{ host: "127.0.0.1", port: 3390 }],
      },
      { fetchFn },
    );

    expect(resolved).toBeNull();
  });

  it("filters endpoint snapshot by expected projectId", async () => {
    const otherProject = {
      projectId: "other/repo",
      self: {
        pid: 1,
        host: "127.0.0.1",
        port: 3290,
        endpoint: "http://127.0.0.1:3290",
      },
      peers: [],
      updatedAt: "2026-03-05T00:00:00.000Z",
    };
    const expectedProject = {
      projectId: "wanted/repo",
      self: {
        pid: 2,
        host: "127.0.0.1",
        port: 3390,
        endpoint: "http://127.0.0.1:3390",
      },
      peers: [],
      updatedAt: "2026-03-05T00:00:01.000Z",
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(otherProject), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(expectedProject), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const resolved = await resolveFleetEndpointsFromApi(
      {
        discoveredApiServers: [
          { host: "127.0.0.1", port: 3290 },
          { host: "127.0.0.1", port: 3390 },
        ],
      },
      { fetchFn, expectedProjectId: "wanted/repo" },
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(resolved).toEqual(expectedProject);
  });
});
